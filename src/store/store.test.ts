/**
 * Tests for the durable store (design 4, and Appendix E's substitution table).
 *
 * Two of these are the ones that matter, because the design leans on them:
 * a transaction that throws leaves nothing half-applied, and state written by
 * one `DurableStore` is seen by a second one opening the same file — which is
 * what "pending calls survive our own process restarting" reduces to.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { StoreReadError } from "../domain/types.js";
import { DurableStore, sha256 } from "./store.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sync-store-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A store on a fresh path inside the test's temp directory. */
function openStore(name = "store.json"): DurableStore {
  return DurableStore.open(join(dir, name));
}

describe("DurableStore transactions", () => {
  test("commits a clean transaction", () => {
    const store = openStore();
    store.transaction((tx) => {
      tx.createRecord("Contact", "p1", "sf1");
      tx.setCurrentValue("Contact", "p1", "city", "Pune");
    });
    assert.equal(store.read((tx) => tx.getRecord("Contact", "p1")?.values["city"]), "Pune");
  });

  test("rolls back everything when the body throws", () => {
    const store = openStore();
    store.transaction((tx) => tx.createRecord("Contact", "p1", "sf1"));

    assert.throws(() =>
      store.transaction((tx) => {
        tx.setCurrentValue("Contact", "p1", "city", "Noida");
        tx.enqueueOutbound({
          objectType: "Contact",
          portalId: "p1",
          field: "city",
          reason: "portal-edit",
          occurredAtMs: 1,
        });
        throw new Error("something went wrong halfway");
      }),
    );

    // Neither half survived. This is what lets the inbound path claim an event
    // and apply the change together (design 5): a crash in between cannot
    // leave an event marked processed but unapplied.
    assert.equal(store.read((tx) => tx.getRecord("Contact", "p1")?.values["city"]), undefined);
    assert.equal(store.read((tx) => tx.outboundRows().length), 0);
  });

  test("re-throws the original error rather than masking it", () => {
    const store = openStore();
    const boom = new Error("the original");
    try {
      store.transaction(() => {
        throw boom;
      });
      assert.fail("expected the error to propagate");
    } catch (error) {
      assert.equal(error, boom, "a failed transaction must never look like a clean one");
    }
  });
});

describe("DurableStore durability", () => {
  test("a second store on the same file sees committed state", () => {
    const path = join(dir, "store.json");
    const first = DurableStore.open(path);
    first.transaction((tx) => {
      tx.createRecord("Contact", "p1", null);
      tx.enqueueOutbound({
        objectType: "Contact",
        portalId: "p1",
        field: "city",
        reason: "portal-edit",
        occurredAtMs: 7,
      });
    });

    // No shared memory: this is a different object reading the same bytes,
    // standing in for a different process (design 6.5).
    const second = DurableStore.open(path);
    const rows = second.read((tx) => tx.outboundRows());
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.state, "pending");
    assert.equal(rows[0]?.field, "city");
  });

  test("a corrupt store is fatal, not silently empty", () => {
    const path = join(dir, "broken.json");
    writeFileSync(path, "{ this is not json", "utf8");
    // Starting from an empty store would silently discard every queued call,
    // which is the failure the whole design exists to prevent.
    assert.throws(() => DurableStore.open(path), StoreReadError);
  });

  test("an absent store starts empty and writes itself", () => {
    const store = openStore("new.json");
    assert.equal(store.read((tx) => tx.outboundRows().length), 0);
    const reopened = DurableStore.open(join(dir, "new.json"));
    assert.equal(reopened.read((tx) => tx.outboundRows().length), 0);
  });
});

describe("Tx.claimEvent", () => {
  const base = {
    eventId: "evt_1",
    objectType: "Contact" as const,
    sfId: "sf1",
    occurredAtMs: 1000,
    payloadHash: sha256('{"city":"Pune"}'),
  };

  test("claims once, then reports a duplicate", () => {
    const store = openStore();
    store.transaction((tx) => {
      assert.equal(tx.claimEvent(base), "claimed");
      tx.setEventOutcome("evt_1", "applied");
    });
    store.transaction((tx) => {
      assert.equal(tx.claimEvent(base), "duplicate");
    });
  });

  test("reports a conflict when one eventId arrives with two payloads", () => {
    const store = openStore();
    store.transaction((tx) => {
      tx.claimEvent(base);
      tx.setEventOutcome("evt_1", "applied");
    });
    store.transaction((tx) => {
      // A provider bug: the key we are trusting is not unique. First write
      // wins, and this one deserves an alert rather than silence.
      assert.equal(
        tx.claimEvent({ ...base, payloadHash: sha256('{"city":"Noida"}') }),
        "conflict",
      );
    });
  });
});

describe("Tx.enqueueOutbound", () => {
  test("keeps at most one pending row per field", () => {
    const store = openStore();
    store.transaction((tx) => tx.createRecord("Contact", "p1", "sf1"));
    const row = {
      objectType: "Contact" as const,
      portalId: "p1",
      field: "city",
      reason: "repair" as const,
      occurredAtMs: 1,
    };
    store.transaction((tx) => {
      assert.equal(tx.enqueueOutbound(row), true);
      // Stands in for the design's partial unique index: an echo arriving
      // beside an already-queued repair must not pile up a second one
      // (Appendix B step 5).
      assert.equal(tx.enqueueOutbound(row), false);
    });
    assert.equal(store.read((tx) => tx.outboundRows().length), 1);
  });

  test("a second row is allowed once the first is no longer pending", () => {
    const store = openStore();
    store.transaction((tx) => tx.createRecord("Contact", "p1", "sf1"));
    const row = {
      objectType: "Contact" as const,
      portalId: "p1",
      field: "city",
      reason: "repair" as const,
      occurredAtMs: 1,
    };
    store.transaction((tx) => tx.enqueueOutbound(row));
    store.transaction((tx) => {
      const first = tx.outboundRows()[0];
      assert.ok(first);
      first.state = "sent";
      assert.equal(tx.enqueueOutbound(row), true);
    });
  });
});

describe("Tx.consumeEchoFence", () => {
  test("matches once and is then gone", () => {
    const store = openStore();
    const hash = sha256("Noida");
    store.transaction((tx) =>
      tx.addEchoFence({
        objectType: "Contact",
        portalId: "p1",
        field: "city",
        valueHash: hash,
        sentAtMs: Date.now(),
        expiresAtMs: Date.now() + 60_000,
      }),
    );
    store.transaction((tx) => {
      assert.equal(tx.consumeEchoFence("Contact", "p1", "city", hash), true);
      // Consuming it is what stops one fence masking a genuine later change.
      assert.equal(tx.consumeEchoFence("Contact", "p1", "city", hash), false);
    });
  });

  test("an expired fence does not match", () => {
    const store = openStore();
    const hash = sha256("Noida");
    store.transaction((tx) =>
      tx.addEchoFence({
        objectType: "Contact",
        portalId: "p1",
        field: "city",
        valueHash: hash,
        sentAtMs: Date.now() - 120_000,
        expiresAtMs: Date.now() - 60_000,
      }),
    );
    store.transaction((tx) => {
      assert.equal(tx.consumeEchoFence("Contact", "p1", "city", hash), false);
    });
  });
});
