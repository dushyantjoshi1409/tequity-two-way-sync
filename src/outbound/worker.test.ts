/**
 * Tests for the sync worker (design 6.2 to 6.5).
 *
 * These build queue rows and field versions directly rather than going through
 * the merge, so that what is being tested is the sender's own contract: what
 * it sends, when it sends it, and what it does with each failure. The settle
 * table of design 6.5 is the specification.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { StoreWriteError } from "../domain/types.js";
import type { ObjectType } from "../domain/types.js";
import {
  SalesforceAuthFailed,
  SalesforceRejected,
  SalesforceThrottled,
  SalesforceUnreachable,
} from "../salesforce/client.js";
import type { ChangedRecord, SalesforceClient } from "../salesforce/client.js";
import { FakeSalesforce } from "../salesforce/fake.js";
import { DurableStore } from "../store/store.js";
import { RateGovernor } from "./governor.js";
import { BREAKER_THRESHOLD, SyncWorker } from "./worker.js";

/** A Salesforce that records what it was asked to do and can be told to fail. */
class StubSalesforce implements SalesforceClient {
  readonly updates: { sfId: string; values: Record<string, string | null> }[] = [];
  readonly upserts: { portalId: string; values: Record<string, string | null> }[] = [];
  failWith: (() => Error) | null = null;

  async update(
    _objectType: ObjectType,
    sfId: string,
    values: Readonly<Record<string, string | null>>,
  ): Promise<void> {
    if (this.failWith) throw this.failWith();
    this.updates.push({ sfId, values: { ...values } });
  }

  async upsertByExternalId(
    _objectType: ObjectType,
    portalId: string,
    values: Readonly<Record<string, string | null>>,
  ): Promise<{ sfId: string; created: boolean }> {
    if (this.failWith) throw this.failWith();
    this.upserts.push({ portalId, values: { ...values } });
    return { sfId: `sf-for-${portalId}`, created: true };
  }

  async queryChangedSince(): Promise<readonly ChangedRecord[]> {
    if (this.failWith) throw this.failWith();
    return [];
  }
}

let dir: string;
let store: DurableStore;
let salesforce: StubSalesforce;
let governor: RateGovernor;
let worker: SyncWorker;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sync-worker-"));
  store = DurableStore.open(join(dir, "store.json"));
  salesforce = new StubSalesforce();
  governor = new RateGovernor({ ceilingPerSecond: 1000, floorPerSecond: 1 });
  worker = new SyncWorker(store, salesforce, governor, "test-owner", () => Date.now(), 1000);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Seed a record with current values, a Salesforce id, and a field version per
 * field whose `sfValue` differs — so the one condition says a call is owed.
 */
function seedOwed(
  portalId: string,
  values: Record<string, string | null>,
  sfId: string | null = `sf-${portalId}`,
): void {
  store.transaction((tx) => {
    tx.createRecord("Contact", portalId, sfId);
    for (const [field, value] of Object.entries(values)) {
      tx.setCurrentValue("Contact", portalId, field, value);
      tx.putFieldVersion({
        objectType: "Contact",
        portalId,
        field,
        occurredAtMs: 1000,
        originRank: 0,
        originEventId: "pc_1",
        origin: "portal",
        actor: "finance.user@client.example",
        sfValue: "something-else",
        sfObservedAtMs: 500,
      });
      tx.enqueueOutbound({
        objectType: "Contact",
        portalId,
        field,
        reason: "portal-edit",
        occurredAtMs: 1000,
      });
    }
  });
}

describe("SyncWorker sending", () => {
  test("coalesces every field owed on one record into one call", async () => {
    seedOwed("p1", { city: "Noida", phone: "+919876500001", full_name: "Asha" });
    const report = await worker.runOnce();
    assert.equal(salesforce.updates.length, 1, "three fields, one PATCH");
    assert.equal(report.callsMade, 1);
    assert.deepEqual(salesforce.updates[0]?.values, {
      city: "Noida",
      phone: "+919876500001",
      full_name: "Asha",
    });
  });

  test("sends the current value at send time, not a value from the queue row", async () => {
    seedOwed("p1", { city: "Noida" });
    // Something supersedes the queued edit before the sender gets to it, the
    // way a second edit during an outage would (design 6.3).
    store.transaction((tx) => tx.setCurrentValue("Contact", "p1", "city", "Kochi"));
    await worker.runOnce();
    assert.equal(
      salesforce.updates[0]?.values["city"],
      "Kochi",
      "the later value went, and only once",
    );
    assert.equal(salesforce.updates.length, 1);
  });

  test("a successful send records what Salesforce now holds", async () => {
    seedOwed("p1", { city: "Noida" });
    await worker.runOnce();
    const fv = store.read((tx) => tx.getFieldVersion("Contact", "p1", "city"));
    // Our own write is the most recent thing we know about Salesforce's state.
    // Appendix B is the race that omitting this breaks.
    assert.equal(fv?.sfValue, "Noida");
    assert.ok((fv?.sfObservedAtMs ?? 0) > 500);
  });

  test("a successful send writes an echo fence for what it sent", async () => {
    seedOwed("p1", { city: "Noida" });
    await worker.runOnce();
    assert.equal(store.read((tx) => tx.state.echoFences.length), 1);
    assert.equal(store.read((tx) => tx.state.echoFences[0]?.field), "city");
  });

  test("marks the row sent", async () => {
    seedOwed("p1", { city: "Noida" });
    await worker.runOnce();
    assert.deepEqual(
      store.read((tx) => tx.outboundRows().map((r) => r.state)),
      ["sent"],
    );
    assert.equal(worker.pendingCount(), 0);
  });

  test("a record with no Salesforce id goes out as an upsert on our own id", async () => {
    seedOwed("p1", { city: "Noida" }, null);
    await worker.runOnce();
    assert.equal(salesforce.updates.length, 0);
    assert.equal(salesforce.upserts.length, 1, "keyed on our id, so a repeat cannot duplicate");
    assert.equal(salesforce.upserts[0]?.portalId, "p1");
    assert.equal(
      store.read((tx) => tx.findLinkByPortalId("Contact", "p1")?.sfId),
      "sf-for-p1",
      "the id it returned was recorded",
    );
  });

  test("spends no call when nothing is owed", async () => {
    store.transaction((tx) => {
      tx.createRecord("Contact", "p1", "sf-p1");
      tx.setCurrentValue("Contact", "p1", "city", "Noida");
      // sfValue already equals the current value: design 10.3's claim-time
      // filter, which is what lets the outage sweep resolve rows for free.
      tx.putFieldVersion({
        objectType: "Contact",
        portalId: "p1",
        field: "city",
        occurredAtMs: 1000,
        originRank: 1,
        originEventId: "evt_1",
        origin: "salesforce",
        actor: "sales.user@client.example",
        sfValue: "Noida",
        sfObservedAtMs: 1000,
      });
      tx.enqueueOutbound({
        objectType: "Contact",
        portalId: "p1",
        field: "city",
        reason: "repair",
        occurredAtMs: 1000,
      });
    });
    const report = await worker.runOnce();
    assert.equal(report.callsMade, 0, "no request was spent");
    assert.equal(report.skipped, 1);
    assert.equal(worker.pendingCount(), 0);
  });
});

describe("SyncWorker settle table (design 6.5)", () => {
  test("429: the work is kept, with its attempt restored and the rate halved", async () => {
    seedOwed("p1", { city: "Noida" });
    const rateBefore = governor.currentRate;
    salesforce.failWith = () => new SalesforceThrottled(10);
    const report = await worker.runOnce();

    assert.equal(report.throttled, 1);
    const row = store.read((tx) => tx.outboundRows()[0]);
    assert.equal(row?.state, "pending", "nothing was dropped");
    assert.equal(row?.attempts, 0, "being throttled is not the row's fault");
    assert.ok(governor.currentRate < rateBefore, "the governor halved its rate");
  });

  test("unreachable: the work is kept and the attempt is given back", async () => {
    seedOwed("p1", { city: "Noida" });
    salesforce.failWith = () => new SalesforceUnreachable();
    await worker.runOnce();
    const row = store.read((tx) => tx.outboundRows()[0]);
    assert.equal(row?.state, "pending");
    assert.equal(
      row?.attempts,
      0,
      "an endpoint failure says nothing about the row, so it must not count",
    );
  });

  test("repeated endpoint failures open the breaker rather than burning the backlog", async () => {
    salesforce.failWith = () => new SalesforceUnreachable();
    for (let i = 0; i < BREAKER_THRESHOLD; i += 1) {
      seedOwed(`p${i}`, { city: `City ${i}` });
      store.transaction((tx) => {
        for (const row of tx.outboundRows()) row.nextAttemptAtMs = 0;
      });
      await worker.runOnce();
    }
    assert.equal(worker.isBreakerOpen, true);
    // Every row is still queued. Without the endpoint/row split, ten attempts
    // at a five-minute cap is under an hour, so a six-hour outage would have
    // marked them all failed by its second hour (design 6.4).
    assert.equal(
      store.read((tx) => tx.outboundRows().every((r) => r.state === "pending")),
      true,
    );
  });

  test("a rejected record is failed and kept with its error, not retried forever", async () => {
    seedOwed("p1", { city: "Noida" });
    salesforce.failWith = () => new SalesforceRejected("INVALID_FIELD: city");
    const report = await worker.runOnce();
    assert.equal(report.rowFailures, 1);
    const row = store.read((tx) => tx.outboundRows()[0]);
    assert.equal(row?.state, "failed");
    assert.match(row?.lastError ?? "", /INVALID_FIELD/);
    assert.equal(worker.pendingCount(), 0, "it is not retried into the cap");
  });

  test("an unexpected error keeps the work rather than losing it", async () => {
    seedOwed("p1", { city: "Noida" });
    salesforce.failWith = () => new Error("something nobody anticipated");
    await worker.runOnce();
    const row = store.read((tx) => tx.outboundRows()[0]);
    assert.equal(row?.state, "pending", "the conservative choice is to keep the work");
    assert.match(row?.lastError ?? "", /unexpected/);
  });
});

describe("SyncWorker restart recovery", () => {
  test("reclaims a row whose lease expired, so a restart is a non-event", () => {
    seedOwed("p1", { city: "Noida" });
    store.transaction((tx) => {
      const row = tx.outboundRows()[0];
      assert.ok(row);
      row.state = "inflight";
      row.leaseOwner = "sender-that-died";
      row.leaseUntilMs = Date.now() - 1;
    });

    assert.equal(worker.reclaimExpiredLeases(), 1);
    const row = store.read((tx) => tx.outboundRows()[0]);
    assert.equal(row?.state, "pending");
    assert.equal(row?.leaseOwner, undefined);
  });

  test("leaves a live lease alone, so a slow call is not stolen", () => {
    seedOwed("p1", { city: "Noida" });
    store.transaction((tx) => {
      const row = tx.outboundRows()[0];
      assert.ok(row);
      row.state = "inflight";
      row.leaseOwner = "another-sender";
      row.leaseUntilMs = Date.now() + 60_000;
    });
    assert.equal(worker.reclaimExpiredLeases(), 0);
    assert.equal(store.read((tx) => tx.outboundRows()[0]?.state), "inflight");
  });

  test("a claimed row counts its attempt, so a poison row cannot loop forever", async () => {
    seedOwed("p1", { city: "Noida" });
    salesforce.failWith = () => new SalesforceRejected("bad data");
    await worker.runOnce();
    // Claimed increments; a row failure keeps it.
    assert.equal(store.read((tx) => tx.outboundRows()[0]?.attempts), 1);
  });
});

describe("SyncWorker: a credential failure stops the sender (design 6.5)", () => {
  test("the work is kept, the attempt is restored, and the sender stops", async () => {
    // Through the real fake, so the credential path is proved against the
    // adapter the demo uses rather than only against a stub.
    const fake = FakeSalesforce.open(join(dir, "salesforce.json"));
    const worker = new SyncWorker(store, fake, governor, "test-owner", () => Date.now(), 1000);
    seedOwed("portal-1", { city: "Noida" });
    fake.failAuth(true);

    const report = await worker.runOnce();

    assert.equal(report.sent, 0);
    assert.equal(worker.isStopped, true);
    const rows = store.read((tx) => tx.outboundRows());
    assert.deepEqual(
      rows.map((r) => [r.state, r.attempts]),
      [["pending", 0]],
      "pending with its attempt given back: a credential failure is not the row's fault",
    );
  });

  test("a stopped sender claims nothing further, so the queue cannot burn down", async () => {
    seedOwed("portal-1", { city: "Noida" });
    seedOwed("portal-2", { city: "Delhi" });
    salesforce.failWith = () => new SalesforceAuthFailed();

    await worker.runOnce();
    const callsAfterFirst = governor.grantedCount;

    // Without the stop, every remaining row would spend an attempt — and the
    // whole queue would reach `failed` against a credential that cannot work.
    const second = await worker.runOnce();
    assert.equal(second.claimed, 0);
    assert.equal(governor.grantedCount, callsAfterFirst, "no further requests spent");
    assert.deepEqual(
      store
        .read((tx) => tx.outboundRows())
        .map((r) => r.state)
        .sort(),
      ["pending", "pending"],
    );
  });
});

describe("SyncWorker: a store failure is not an endpoint failure", () => {
  test("it propagates instead of being counted toward the breaker", async () => {
    // A create: the send returns an id, and recording that id is a store
    // write. Before the fix that write sat inside the send's try-block, so a
    // disk problem was reported as an endpoint failure and could open the
    // circuit breaker against a Salesforce that was perfectly healthy.
    seedOwed("portal-1", { city: "Noida" }, null);

    const realTransaction = store.transaction.bind(store);
    const patched = store as unknown as { transaction: typeof realTransaction };
    patched.transaction = ((body) => {
      // Armed only once the send has landed, so this is precisely the
      // `linkSfId` write and not the claim or the reclaim.
      if (salesforce.upserts.length > 0) throw new StoreWriteError("disk full");
      return realTransaction(body);
    }) as typeof realTransaction;

    await assert.rejects(() => worker.runOnce(), /disk full/);

    patched.transaction = realTransaction;
    assert.equal(salesforce.upserts.length, 1, "the send did land");
    assert.equal(worker.isBreakerOpen, false, "a disk problem must not open the breaker");
  });
});

describe("SyncWorker: a row Salesforce refuses, through the real fake", () => {
  test("it is marked failed and alerted, not retried into the cap", async () => {
    // Uses FakeSalesforce rather than the stub, so the lever the fake
    // advertises for "it can refuse a record's data" is actually exercised and
    // the 400-class path is proved end to end against the adapter the demo
    // uses (design 6.5's `400`-class row).
    const fake = FakeSalesforce.open(join(dir, "salesforce.json"));
    const fakeWorker = new SyncWorker(store, fake, governor, "test-owner", () => Date.now(), 1000);
    seedOwed("portal-1", { city: "Noida" });
    fake.rejectWritesTo("city");

    const report = await fakeWorker.runOnce();

    assert.equal(report.rowFailures, 1);
    const rows = store.read((tx) => tx.outboundRows());
    assert.equal(rows[0]?.state, "failed");
    assert.match(String(rows[0]?.lastError), /INVALID_FIELD: city/);
    // Never deleted: the row keeps its error as the record that a human is needed.
    assert.equal(rows.length, 1);
  });
});
