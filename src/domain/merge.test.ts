/**
 * Tests for {@link applyChanges} — the merge, design 5, 7 and 8.
 *
 * These are the traces the design argues over, not invented cases: the
 * brief's own different-fields scenario (7.4), the out-of-order webhook
 * (8.2), the echo (9.2), the full-record restatement (8.4), the one repair
 * condition (8.3), the repair breaker (9.4) and idempotence (8.1).
 *
 * Every test runs against a real {@link DurableStore} in its own temporary
 * directory, through {@link DurableStore.transaction}, because the properties
 * being checked are properties of what is *committed* — a test against a hand
 * built state object could pass while the rows that outlive a restart were
 * never written. Each store is removed afterwards, so no test can see
 * another's rows.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import { applyChanges } from "./merge.js";
import type { AppliedField, ApplyChangesInput, ObjectType } from "./types.js";
import { DurableStore } from "../store/store.js";
import type { FieldChangeRow, ObservationRow, OutboundRow } from "../store/schema.js";

/**
 * A fixed wall clock, so the one-hour window of design 9.4's breaker is
 * deterministic. The `occurredAtMs` values in these tests are small numbers
 * for readability; they are compared only against each other, never against
 * this.
 */
const NOW_MS = Date.UTC(2025, 4, 12, 10, 0, 0);

/** Run `body` against a store in its own temporary directory, then delete it. */
function withStore(body: (store: DurableStore) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "tequity-merge-test-"));
  try {
    body(DurableStore.open(join(dir, "store.json"), () => NOW_MS));
  } finally {
    // Always, even when the body threw: a leaked temp store would make the
    // next run of the suite depend on this one.
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The caller's job before a merge: resolve the record link (design 5). */
function createRecord(
  store: DurableStore,
  objectType: ObjectType,
  portalId: string,
  sfId: string | null = "003SFID",
): void {
  store.transaction((tx) => {
    tx.createRecord(objectType, portalId, sfId);
  });
}

/** One event, one transaction (design 5). */
function feed(store: DurableStore, input: ApplyChangesInput): AppliedField[] {
  return store.transaction((tx) => applyChanges(tx, input));
}

/** The committed current values for one record. */
function valuesOf(
  store: DurableStore,
  objectType: ObjectType,
  portalId: string,
): Record<string, string | null> {
  return store.read((tx) => {
    const record = tx.getRecord(objectType, portalId);
    assert.ok(record, `no ${objectType} record ${portalId}`);
    return { ...record.values };
  });
}

/** Committed permanent history for one record, oldest first. */
function historyOf(
  store: DurableStore,
  objectType: ObjectType,
  portalId: string,
): readonly FieldChangeRow[] {
  return store.read((tx) => [...tx.historyFor(objectType, portalId)]);
}

/** Committed operational log rows (echo, confirmed, restatement). */
function observationsOf(store: DurableStore): readonly ObservationRow[] {
  return store.read((tx) => [...tx.state.observations]);
}

/** Committed outbound queue rows, in insertion order. */
function outboundOf(store: DurableStore): readonly OutboundRow[] {
  return store.read((tx) => [...tx.outboundRows()]);
}

/**
 * The sender delivered everything pending (design 6.2). What we believe
 * Salesforce holds is set by the sender itself (design 6.3), which lives
 * outside this module, so these tests only clear the queue.
 */
function senderDelivers(store: DurableStore): void {
  store.transaction((tx) => {
    for (const row of tx.outboundRows()) {
      if (row.state === "pending") row.state = "sent";
    }
  });
}

/**
 * The sender exhausted its attempts and dead-lettered its rows (design 6.2,
 * 6.5): nothing is pending any more, and because nothing reached Salesforce,
 * what we believe Salesforce holds is unchanged.
 *
 * Used where a test needs the *disagreement* without the pending row, so that
 * what condition (d) does next is visible rather than collapsed into the one
 * pending row a field is allowed (design 4).
 */
function senderGivesUp(store: DurableStore): void {
  store.transaction((tx) => {
    for (const row of tx.outboundRows()) {
      if (row.state === "pending") row.state = "failed";
    }
  });
}

/** The result for one field, asserted to exist. */
function fieldResult(results: readonly AppliedField[], field: string): AppliedField {
  const found = results.find((r) => r.field === field);
  assert.ok(found, `no result for ${field}; got ${results.map((r) => r.field).join(", ")}`);
  return found;
}

describe("applyChanges: a Salesforce create stamps every field (design 5 case (b))", () => {
  test("applies each field in catalogue order, with the actor and the canonical value", () => {
    withStore((store) => {
      createRecord(store, "Contact", "c-1");

      const results = feed(store, {
        objectType: "Contact",
        portalId: "c-1",
        origin: "salesforce",
        actor: "sales.user",
        occurredAtMs: 1_000,
        originEventId: "evt_1",
        rawChanges: {
          // Deliberately not in catalogue order, and deliberately in the
          // spellings Salesforce would send.
          city: " Gurugram ",
          email: "ASHA@Client.example",
          full_name: " Asha   Mehta ",
          phone: "+91 98765 43210",
        },
      });

      // Fixed order (design: `sortFields`), so two runs over one payload
      // produce identical history.
      assert.deepEqual(
        results.map((r) => r.field),
        ["full_name", "phone", "email", "city"],
      );
      assert.deepEqual(
        results.map((r) => r.outcome),
        ["applied", "applied", "applied", "applied"],
      );
      assert.deepEqual(
        results.map((r) => r.previousValue),
        [null, null, null, null],
      );

      assert.deepEqual(valuesOf(store, "Contact", "c-1"), {
        full_name: "Asha Mehta",
        phone: "+919876543210",
        email: "asha@client.example",
        city: "Gurugram",
      });

      const history = historyOf(store, "Contact", "c-1");
      assert.equal(history.length, 4);
      for (const row of history) {
        assert.equal(row.outcome, "applied");
        assert.equal(row.actor, "sales.user");
        assert.equal(row.origin, "salesforce");
        assert.equal(row.originEventId, "evt_1");
        assert.equal(row.occurredAtMs, 1_000);
        assert.equal(row.oldValue, null);
      }
      assert.deepEqual(
        history.map((r) => r.field),
        ["full_name", "phone", "email", "city"],
      );
    });
  });

  test("records the order key and what Salesforce holds, for every field", () => {
    withStore((store) => {
      createRecord(store, "Contact", "c-1");
      feed(store, {
        objectType: "Contact",
        portalId: "c-1",
        origin: "salesforce",
        actor: "sales.user",
        occurredAtMs: 1_000,
        originEventId: "evt_1",
        rawChanges: { city: "Gurugram" },
      });

      const version = store.read((tx) => tx.getFieldVersion("Contact", "c-1", "city"));
      assert.ok(version);
      assert.equal(version.occurredAtMs, 1_000);
      assert.equal(version.originEventId, "evt_1");
      assert.equal(version.origin, "salesforce");
      assert.equal(version.actor, "sales.user");
      // Step (a): the event taught us Salesforce's state as well as winning.
      assert.equal(version.sfValue, "Gurugram");
      assert.equal(version.sfObservedAtMs, 1_000);
    });
  });
});

describe("applyChanges: different fields both survive (design 7.4, the brief's scenario)", () => {
  /**
   * The exercise's own scenario. Sales creates the contact in Salesforce;
   * finance corrects the city in the portal; sales then changes the phone in
   * Salesforce. The portal must end with the new phone **and** the finance
   * city, each with its own actor and time.
   *
   * No conflict rule is needed for this, which is the argument for ADR 0002:
   * the field, not the record, is the unit that conflicts.
   */
  function briefScenario(store: DurableStore): {
    create: AppliedField[];
    cityEdit: AppliedField[];
    phoneEdit: AppliedField[];
  } {
    createRecord(store, "Contact", "c-1");

    const create = feed(store, {
      objectType: "Contact",
      portalId: "c-1",
      origin: "salesforce",
      actor: "sales.user",
      occurredAtMs: 1_000,
      originEventId: "evt_1",
      rawChanges: {
        full_name: "Asha Mehta",
        phone: "+91 98765 43210",
        email: "asha@client.example",
        city: "Gurugram",
      },
    });

    const cityEdit = feed(store, {
      objectType: "Contact",
      portalId: "c-1",
      origin: "portal",
      actor: "finance.user",
      occurredAtMs: 2_000,
      originEventId: "chg_1",
      rawChanges: { city: "Noida" },
    });

    // The webhook names `phone` only (assumption A3), so `city` is never even
    // looked at.
    const phoneEdit = feed(store, {
      objectType: "Contact",
      portalId: "c-1",
      origin: "salesforce",
      actor: "sales.user",
      occurredAtMs: 3_000,
      originEventId: "evt_2",
      rawChanges: { phone: "+91 99999 00000" },
    });

    return { create, cityEdit, phoneEdit };
  }

  test("the record ends with the new phone and the finance city", () => {
    withStore((store) => {
      const { cityEdit, phoneEdit } = briefScenario(store);

      assert.equal(fieldResult(cityEdit, "city").outcome, "applied");
      assert.equal(fieldResult(phoneEdit, "phone").outcome, "applied");
      assert.deepEqual(valuesOf(store, "Contact", "c-1"), {
        full_name: "Asha Mehta",
        phone: "+919999900000",
        email: "asha@client.example",
        city: "Noida",
      });
    });
  });

  test("each field keeps its own actor and time", () => {
    withStore((store) => {
      briefScenario(store);

      const history = historyOf(store, "Contact", "c-1");
      assert.deepEqual(
        history.map((r) => [r.field, r.outcome, r.newValue, r.actor, r.occurredAtMs]),
        [
          ["full_name", "applied", "Asha Mehta", "sales.user", 1_000],
          ["phone", "applied", "+919876543210", "sales.user", 1_000],
          ["email", "applied", "asha@client.example", "sales.user", 1_000],
          ["city", "applied", "Gurugram", "sales.user", 1_000],
          // The history the client is paying for: the city was changed by
          // finance at 2000, and the phone by sales at 3000, and the phone
          // change did not disturb the city.
          ["city", "applied", "Noida", "finance.user", 2_000],
          ["phone", "applied", "+919999900000", "sales.user", 3_000],
        ],
      );
    });
  });

  test("the Salesforce phone edit leaves the city untouched", () => {
    withStore((store) => {
      const { phoneEdit } = briefScenario(store);

      // Fields are independent: the third event returns one row, for the one
      // field it named.
      assert.deepEqual(
        phoneEdit.map((r) => r.field),
        ["phone"],
      );

      const city = store.read((tx) => tx.getFieldVersion("Contact", "c-1", "city"));
      assert.ok(city);
      assert.equal(city.occurredAtMs, 2_000);
      assert.equal(city.actor, "finance.user");
      assert.equal(city.origin, "portal");
      // Still Salesforce's stale copy: our correction has not been sent yet.
      assert.equal(city.sfValue, "Gurugram");
    });
  });

  test("only the city owes Salesforce a call", () => {
    withStore((store) => {
      briefScenario(store);

      // The phone change came *from* Salesforce, so Salesforce already agrees
      // about it; the city is ours and Salesforce does not have it yet.
      assert.deepEqual(
        outboundOf(store)
          .filter((r) => r.state === "pending")
          .map((r) => [r.field, r.reason]),
        [["city", "portal-edit"]],
      );
    });
  });
});

describe("applyChanges: the repair breaker (design 9.4, rule L4)", () => {
  /**
   * Put `repairs` repair rows for one field into the queue, each already sent,
   * so they count towards the hour's total without holding the one pending
   * slot the field is allowed.
   *
   * This is what an argument looks like in the store: a value Salesforce
   * stores in a spelling our canonical form does not normalise, so every echo
   * reads as disagreement and each round trip queues another repair.
   */
  function recordSentRepairs(store: DurableStore, field: string, repairs: number): void {
    store.transaction((tx) => {
      for (let i = 0; i < repairs; i += 1) {
        tx.enqueueOutbound({
          objectType: "Contact",
          portalId: "c-1",
          field,
          reason: "repair",
          occurredAtMs: 100 + i,
        });
        for (const row of tx.outboundRows()) {
          if (row.state === "pending") row.state = "sent";
        }
      }
    });
    assert.equal(
      store.read((tx) => tx.repairsInLastHour("Contact", "c-1", field)),
      repairs,
    );
  }

  /**
   * A field the portal owns at 2000, which Salesforce last told us was
   * Gurugram at 500 — and with nothing pending, because the sender gave up.
   * Any call the next event owes is therefore a call that event raised.
   */
  function contestedField(store: DurableStore): void {
    createRecord(store, "Contact", "c-1");
    feed(store, {
      objectType: "Contact",
      portalId: "c-1",
      origin: "salesforce",
      actor: "sales.user",
      occurredAtMs: 500,
      originEventId: "evt_0",
      rawChanges: { city: "Gurugram" },
    });
    feed(store, {
      objectType: "Contact",
      portalId: "c-1",
      origin: "portal",
      actor: "finance.user",
      occurredAtMs: 2_000,
      originEventId: "chg_1",
      rawChanges: { city: "Noida" },
    });
    senderGivesUp(store);
    assert.deepEqual(
      outboundOf(store).filter((r) => r.state === "pending"),
      [],
    );
  }

  /** The Salesforce event that loses, leaving a disagreement behind. */
  function feedLosingSalesforceEdit(store: DurableStore): AppliedField[] {
    return feed(store, {
      objectType: "Contact",
      portalId: "c-1",
      origin: "salesforce",
      actor: "sales.user",
      occurredAtMs: 1_500,
      originEventId: "evt_1",
      rawChanges: { city: "Sector 44" },
    });
  }

  test("above six repairs in the hour, nothing more is enqueued for the field", () => {
    withStore((store) => {
      contestedField(store);
      recordSentRepairs(store, "city", 6);

      const results = feedLosingSalesforceEdit(store);

      // We keep serving our value and stop arguing: knowingly different on one
      // field beats spending the 100 req/s cap on an argument neither side can
      // win (design 9.4).
      assert.equal(fieldResult(results, "city").outcome, "superseded");
      assert.equal(fieldResult(results, "city").enqueuedOutbound, false);
      assert.deepEqual(
        outboundOf(store).filter((r) => r.state === "pending"),
        [],
      );
      // The losing edit is still history. The breaker stops the outbound call,
      // not the record of what happened.
      assert.equal(
        historyOf(store, "Contact", "c-1").filter((r) => r.outcome === "superseded").length,
        1,
      );
    });
  });

  test("at five repairs the breaker has not tripped yet", () => {
    withStore((store) => {
      contestedField(store);
      recordSentRepairs(store, "city", 5);

      // The boundary, asserted on purpose: the threshold is "more than 5
      // repairs already made", so the sixth is still sent. Without this, an
      // off-by-one would stop repairs a round trip early and look like
      // correct behaviour (design 9.4).
      assert.equal(fieldResult(feedLosingSalesforceEdit(store), "city").enqueuedOutbound, true);
      assert.deepEqual(
        outboundOf(store)
          .filter((r) => r.state === "pending")
          .map((r) => [r.field, r.reason]),
        [["city", "repair"]],
      );
    });
  });

  test("the breaker is per field: another field still syncs", () => {
    withStore((store) => {
      contestedField(store);
      recordSentRepairs(store, "city", 6);
      // The contested field is blocked.
      assert.equal(fieldResult(feedLosingSalesforceEdit(store), "city").enqueuedOutbound, false);

      // A contested field must not stop the rest of the record syncing: the
      // field, not the record, is the unit that conflicts (ADR 0002), and the
      // breaker counts per field.
      const results = feed(store, {
        objectType: "Contact",
        portalId: "c-1",
        origin: "portal",
        actor: "finance.user",
        occurredAtMs: 2_500,
        originEventId: "chg_2",
        rawChanges: { phone: "+919876543210" },
      });

      assert.equal(fieldResult(results, "phone").enqueuedOutbound, true);
      assert.deepEqual(
        outboundOf(store)
          .filter((r) => r.state === "pending")
          .map((r) => [r.field, r.reason]),
        [["phone", "portal-edit"]],
      );
    });
  });
});

describe("applyChanges: idempotence (design 8.1 layer 2)", () => {
  test("the identical Salesforce event twice applies once and changes nothing", () => {
    withStore((store) => {
      createRecord(store, "Contact", "c-1");
      const event: ApplyChangesInput = {
        objectType: "Contact",
        portalId: "c-1",
        origin: "salesforce",
        actor: "sales.user",
        occurredAtMs: 1_000,
        originEventId: "evt_1",
        rawChanges: { phone: "+91 98765 43210" },
      };

      const first = feed(store, event);
      const second = feed(store, event);

      assert.equal(fieldResult(first, "phone").outcome, "applied");
      // Harmlessness without the duplicate table (design 8.1 layer 2): the
      // table is only suppression and it falls to a prune, a restore or a
      // truncate. Here the event is deliberately *not* suppressed, and it
      // still does nothing — step (b) recognises Salesforce's own value and
      // the strict `>` of step (c) would refuse it anyway.
      assert.equal(fieldResult(second, "phone").outcome, "restatement");
      assert.equal(fieldResult(second, "phone").previousValue, "+919876543210");
      assert.equal(fieldResult(second, "phone").newValue, "+919876543210");

      assert.equal(valuesOf(store, "Contact", "c-1").phone, "+919876543210");
      assert.equal(
        historyOf(store, "Contact", "c-1").filter((r) => r.outcome === "applied").length,
        1,
        "exactly one applied row",
      );
      assert.deepEqual(outboundOf(store), []);
    });
  });

  test("the identical portal save twice applies once and confirms the second", () => {
    withStore((store) => {
      createRecord(store, "Contact", "c-1");
      const save: ApplyChangesInput = {
        objectType: "Contact",
        portalId: "c-1",
        origin: "portal",
        actor: "finance.user",
        occurredAtMs: 1_000,
        originEventId: "chg_1",
        rawChanges: { city: "Noida" },
      };

      const first = feed(store, save);
      const second = feed(store, save);

      // A portal replay cannot be a restatement — step (b) only applies to
      // Salesforce — so this is the strict `>` of design 7.2 doing the work on
      // its own: equal keys are not newer.
      assert.equal(fieldResult(first, "city").outcome, "applied");
      assert.equal(fieldResult(second, "city").outcome, "confirmed");
      assert.equal(valuesOf(store, "Contact", "c-1").city, "Noida");
      assert.equal(historyOf(store, "Contact", "c-1").length, 1);
      // The first save owes Salesforce the value; the replay adds no second
      // call, because at most one row per field may be pending (design 4).
      assert.equal(fieldResult(second, "city").enqueuedOutbound, false);
      assert.deepEqual(
        outboundOf(store).map((r) => [r.field, r.reason]),
        [["city", "portal-edit"]],
      );
    });
  });

  test("a re-save of the value already held does not take ownership of the field", () => {
    withStore((store) => {
      createRecord(store, "Contact", "c-1");
      feed(store, {
        objectType: "Contact",
        portalId: "c-1",
        origin: "salesforce",
        actor: "sales.user",
        occurredAtMs: 1_000,
        originEventId: "evt_0",
        rawChanges: { city: "Gurugram" },
      });

      // A portal user re-submits the value the field already holds — the form
      // saves every field, so this happens on any save that touched something
      // else. It is not an edit to this field.
      const resave = feed(store, {
        objectType: "Contact",
        portalId: "c-1",
        origin: "portal",
        actor: "finance.user",
        occurredAtMs: 5_000,
        originEventId: "chg_1",
        rawChanges: { city: "Gurugram" },
      });
      assert.equal(fieldResult(resave, "city").outcome, "confirmed");

      // Not in permanent history: `field_change` is the record of edits that
      // *changed* something, and no-op rows would make "who changed the city"
      // harder to answer.
      assert.equal(historyOf(store, "Contact", "c-1").length, 1);

      // And not restamped. This is the consequence worth testing: had the
      // re-save advanced the order key to 5000, the genuine Salesforce edit
      // below would lose to someone who re-submitted a value they did not
      // change.
      const version = store.read((tx) => tx.getFieldVersion("Contact", "c-1", "city"));
      assert.ok(version);
      assert.equal(version.occurredAtMs, 1_000);
      assert.equal(version.actor, "sales.user");

      const realEdit = feed(store, {
        objectType: "Contact",
        portalId: "c-1",
        origin: "salesforce",
        actor: "sales.user",
        occurredAtMs: 2_000,
        originEventId: "evt_1",
        rawChanges: { city: "Sector 44" },
      });
      assert.equal(fieldResult(realEdit, "city").outcome, "applied");
      assert.equal(valuesOf(store, "Contact", "c-1").city, "Sector 44");
    });
  });

  test("replaying a whole multi-field event changes nothing the second time", () => {
    withStore((store) => {
      createRecord(store, "Contact", "c-1");
      const event: ApplyChangesInput = {
        objectType: "Contact",
        portalId: "c-1",
        origin: "salesforce",
        actor: "sales.user",
        occurredAtMs: 1_000,
        originEventId: "evt_1",
        rawChanges: {
          full_name: "Asha Mehta",
          phone: "+919876543210",
          email: "asha@client.example",
          city: "Gurugram",
        },
      };

      feed(store, event);
      const before = valuesOf(store, "Contact", "c-1");
      const second = feed(store, event);

      assert.deepEqual(
        second.map((r) => r.outcome),
        ["restatement", "restatement", "restatement", "restatement"],
      );
      assert.deepEqual(valuesOf(store, "Contact", "c-1"), before);
      assert.equal(historyOf(store, "Contact", "c-1").length, 4);
      assert.deepEqual(outboundOf(store), []);
    });
  });
});

describe("applyChanges: the one repair condition (design 8.3, 9.1)", () => {
  test("a Salesforce change that applied owes nothing", () => {
    withStore((store) => {
      createRecord(store, "Contact", "c-1");

      const results = feed(store, {
        objectType: "Contact",
        portalId: "c-1",
        origin: "salesforce",
        actor: "sales.user",
        occurredAtMs: 1_000,
        originEventId: "evt_1",
        rawChanges: { city: "Gurugram" },
      });

      // `sf_value` and the current value are the same value, so there is
      // nothing to disagree about. We call Salesforce when, and only when, we
      // believe Salesforce disagrees with us.
      assert.equal(fieldResult(results, "city").enqueuedOutbound, false);
      assert.deepEqual(outboundOf(store), []);
    });
  });

  test("a portal edit to a field Salesforce has never mentioned is still owed", () => {
    withStore((store) => {
      createRecord(store, "Contact", "c-1", null);

      const results = feed(store, {
        objectType: "Contact",
        portalId: "c-1",
        origin: "portal",
        actor: "finance.user",
        occurredAtMs: 1_000,
        originEventId: "chg_1",
        rawChanges: { city: "Noida" },
      });

      // "Is distinct from" in SQL's sense (design 8.3): an `sf_value` we have
      // never learned is distinct from any current value, because not knowing
      // what Salesforce holds is itself a disagreement we owe a call about.
      // Treating the unknown as agreement would strand every portal-created
      // record — Salesforce would never be told the value at all.
      assert.equal(fieldResult(results, "city").enqueuedOutbound, true);
      assert.deepEqual(
        outboundOf(store).map((r) => [r.field, r.reason, r.state]),
        [["city", "portal-edit", "pending"]],
      );
    });
  });

  test("a Salesforce value superseded by a newer portal value owes a repair", () => {
    withStore((store) => {
      createRecord(store, "Customer", "cust-1");

      // Salesforce holds Active and we know it.
      feed(store, {
        objectType: "Customer",
        portalId: "cust-1",
        origin: "salesforce",
        actor: "sales.user",
        occurredAtMs: 1_000,
        originEventId: "evt_0",
        rawChanges: { status: "active" },
      });

      // Finance moves it on in the portal, which owes Salesforce a call...
      feed(store, {
        objectType: "Customer",
        portalId: "cust-1",
        origin: "portal",
        actor: "finance.user",
        occurredAtMs: 3_000,
        originEventId: "chg_1",
        rawChanges: { status: "prospect" },
      });
      assert.deepEqual(
        outboundOf(store).map((r) => [r.field, r.reason]),
        [["status", "portal-edit"]],
      );

      // ...and the sender gives up on it. The queue is now empty while the
      // disagreement stands, so the row asserted below is unambiguously the
      // one condition (d) raises for the superseded change.
      senderGivesUp(store);

      const results = feed(store, {
        objectType: "Customer",
        portalId: "cust-1",
        origin: "salesforce",
        actor: "sales.user",
        occurredAtMs: 2_000,
        originEventId: "evt_1",
        rawChanges: { status: "Churned" },
      });

      assert.equal(fieldResult(results, "status").outcome, "superseded");
      assert.equal(fieldResult(results, "status").enqueuedOutbound, true);
      assert.equal(valuesOf(store, "Customer", "cust-1").status, "Prospect");

      // Salesforce has no merge logic (design 7.1), so a webhook we reject is
      // not a no-op: it is the discovery that Salesforce holds a value we
      // rejected, and nobody else will fix that.
      assert.deepEqual(
        outboundOf(store)
          .filter((r) => r.state === "pending")
          .map((r) => [r.field, r.reason, r.occurredAtMs]),
        [["status", "repair", 2_000]],
      );
    });
  });

  test("a portal edit over a known Salesforce value is queued as a portal edit", () => {
    withStore((store) => {
      createRecord(store, "Contact", "c-1");
      feed(store, {
        objectType: "Contact",
        portalId: "c-1",
        origin: "salesforce",
        actor: "sales.user",
        occurredAtMs: 1_000,
        originEventId: "evt_1",
        rawChanges: { city: "Gurugram" },
      });

      const results = feed(store, {
        objectType: "Contact",
        portalId: "c-1",
        origin: "portal",
        actor: "finance.user",
        occurredAtMs: 2_000,
        originEventId: "chg_1",
        rawChanges: { city: "Noida" },
      });

      // The same condition on both paths (design 9.1) — only the reason
      // differs, because this call publishes an edit rather than ending a
      // disagreement we detected.
      assert.equal(fieldResult(results, "city").enqueuedOutbound, true);
      assert.deepEqual(
        outboundOf(store).map((r) => [r.field, r.reason]),
        [["city", "portal-edit"]],
      );
    });
  });

  test("the condition goes false once Salesforce agrees, which is why it terminates", () => {
    withStore((store) => {
      createRecord(store, "Contact", "c-1");
      feed(store, {
        objectType: "Contact",
        portalId: "c-1",
        origin: "salesforce",
        actor: "sales.user",
        occurredAtMs: 1_000,
        originEventId: "evt_1",
        rawChanges: { city: "Gurugram" },
      });
      feed(store, {
        objectType: "Contact",
        portalId: "c-1",
        origin: "portal",
        actor: "finance.user",
        occurredAtMs: 2_000,
        originEventId: "chg_1",
        rawChanges: { city: "Noida" },
      });
      assert.equal(outboundOf(store).length, 1);

      // The sender delivers Noida and the echo comes back. Design 9.1's
      // termination argument: the echo sets `sf_value` to the value we sent,
      // the condition goes false, and the loop dies for lack of anything left
      // to disagree about — no fuel after one hop.
      senderDelivers(store);
      const results = feed(store, {
        objectType: "Contact",
        portalId: "c-1",
        origin: "salesforce",
        actor: "integration.user",
        occurredAtMs: 3_000,
        originEventId: "evt_2",
        rawChanges: { city: "Noida" },
        isEcho: true,
      });

      assert.equal(fieldResult(results, "city").enqueuedOutbound, false);
      assert.deepEqual(
        outboundOf(store).filter((r) => r.state === "pending"),
        [],
      );
    });
  });
});

describe("applyChanges: a restatement does not clobber (design 8.4, 10.3)", () => {
  /**
   * The design's hazard, traced. During the outage finance sets `city` to
   * Noida at 15:00, unsent. At 16:00 a sales user changes the phone and the
   * full-record payload carries `city: "Gurugram"` — Salesforce's stale copy —
   * stamped with the *record's* modification time, 16:00.
   *
   * Compared as a change, 16:00 beats 15:00 and we would overwrite the finance
   * edit with an older value Salesforce was merely restating. That is exactly
   * the loss this exercise is about, caused by a payload shape.
   */
  function outageRestatement(store: DurableStore): AppliedField[] {
    createRecord(store, "Contact", "c-1");

    // Salesforce holds Gurugram, and we know it.
    feed(store, {
      objectType: "Contact",
      portalId: "c-1",
      origin: "salesforce",
      actor: "sales.user",
      occurredAtMs: 500,
      originEventId: "evt_0",
      rawChanges: { city: "Gurugram" },
    });

    // Finance corrects it in the portal. Nothing is sent: the outage is on.
    feed(store, {
      objectType: "Contact",
      portalId: "c-1",
      origin: "portal",
      actor: "finance.user",
      occurredAtMs: 1_000,
      originEventId: "chg_1",
      rawChanges: { city: "Noida" },
    });

    // A full-record payload: the phone really changed, the city is restated.
    return feed(store, {
      objectType: "Contact",
      portalId: "c-1",
      origin: "salesforce",
      actor: "sales.user",
      occurredAtMs: 2_000,
      originEventId: "evt_1",
      rawChanges: { city: "Gurugram", phone: "+919876543210" },
    });
  }

  test("the restated field is not restamped, not compared, not touched", () => {
    withStore((store) => {
      const results = outageRestatement(store);

      assert.equal(fieldResult(results, "city").outcome, "restatement");
      // The assertion this whole design exists for.
      assert.equal(valuesOf(store, "Contact", "c-1").city, "Noida");

      const version = store.read((tx) => tx.getFieldVersion("Contact", "c-1", "city"));
      assert.ok(version);
      assert.equal(version.occurredAtMs, 1_000, "not restamped");
      assert.equal(version.actor, "finance.user");
      assert.equal(version.origin, "portal");
    });
  });

  test("the real change in the same payload still applies", () => {
    withStore((store) => {
      const results = outageRestatement(store);

      // Fields are independent (design 5): one event may restate `city` and
      // apply `phone`.
      assert.equal(fieldResult(results, "phone").outcome, "applied");
      assert.equal(valuesOf(store, "Contact", "c-1").phone, "+919876543210");
    });
  });

  test("the restatement is logged as an observation, not as history", () => {
    withStore((store) => {
      outageRestatement(store);

      const restatements = observationsOf(store).filter(
        (o) => o.outcome === "restatement",
      );
      assert.equal(restatements.length, 1);
      assert.equal(restatements[0]?.field, "city");
      assert.equal(restatements[0]?.observedValue, "Gurugram");

      // History holds only the two real edits to `city` plus the applied
      // phone: no `superseded` row for the restatement, because nobody edited
      // the city at 16:00.
      assert.deepEqual(
        historyOf(store, "Contact", "c-1").map((r) => [r.field, r.outcome, r.newValue]),
        [
          ["city", "applied", "Gurugram"],
          ["city", "applied", "Noida"],
          ["phone", "applied", "+919876543210"],
        ],
      );
    });
  });

  test("Salesforce is still owed our value: one pending call for the field", () => {
    withStore((store) => {
      outageRestatement(store);

      // Condition (d) fires for `city` on every event in this trace, and the
      // one-pending-row-per-field rule (design 4, Appendix B step 5) collapses
      // them into the single call that will carry Noida when the outage ends.
      const pending = outboundOf(store).filter((r) => r.state === "pending");
      assert.deepEqual(
        pending.map((r) => [r.field, r.reason]),
        [["city", "portal-edit"]],
      );
    });
  });

  test("a restatement re-queues the repair when no call is pending (design 8.3)", () => {
    withStore((store) => {
      createRecord(store, "Contact", "c-1");
      feed(store, {
        objectType: "Contact",
        portalId: "c-1",
        origin: "salesforce",
        actor: "sales.user",
        occurredAtMs: 500,
        originEventId: "evt_0",
        rawChanges: { city: "Gurugram" },
      });
      feed(store, {
        objectType: "Contact",
        portalId: "c-1",
        origin: "portal",
        actor: "finance.user",
        occurredAtMs: 1_000,
        originEventId: "chg_1",
        rawChanges: { city: "Noida" },
      });

      // The sender exhausted its attempts during the outage and dead-lettered
      // the row, so nothing is pending for `city` any more.
      senderGivesUp(store);

      const results = feed(store, {
        objectType: "Contact",
        portalId: "c-1",
        origin: "salesforce",
        actor: "sales.user",
        occurredAtMs: 2_000,
        originEventId: "evt_1",
        rawChanges: { city: "Gurugram" },
      });

      // Skipping step (c) does not skip step (d): the field is still a
      // disagreement we owe Salesforce a call about, and the merge re-queues
      // it without any separate recovery path.
      assert.equal(fieldResult(results, "city").outcome, "restatement");
      assert.equal(fieldResult(results, "city").enqueuedOutbound, true);
      assert.equal(valuesOf(store, "Contact", "c-1").city, "Noida");
      assert.deepEqual(
        outboundOf(store)
          .filter((r) => r.state === "pending")
          .map((r) => [r.field, r.reason]),
        [["city", "repair"]],
      );
    });
  });

  test("a value we have never heard from Salesforce is a change, not a restatement", () => {
    withStore((store) => {
      createRecord(store, "Contact", "c-1");
      feed(store, {
        objectType: "Contact",
        portalId: "c-1",
        origin: "portal",
        actor: "finance.user",
        occurredAtMs: 1_000,
        originEventId: "chg_1",
        rawChanges: { city: "Noida" },
      });

      // No Salesforce observation has ever happened for this field, so there
      // is no `sf_value` to equal. The design is explicit that this is a
      // change (design 8.4) — treating an absent `sf_value` as "matches
      // everything" would make the first Salesforce edit after a portal create
      // disappear.
      const results = feed(store, {
        objectType: "Contact",
        portalId: "c-1",
        origin: "salesforce",
        actor: "sales.user",
        occurredAtMs: 2_000,
        originEventId: "evt_1",
        rawChanges: { city: "Gurugram" },
      });

      assert.equal(fieldResult(results, "city").outcome, "applied");
      assert.equal(valuesOf(store, "Contact", "c-1").city, "Gurugram");
    });
  });

  test("a portal edit matching sf_value is still compared, not skipped", () => {
    withStore((store) => {
      createRecord(store, "Contact", "c-1");
      feed(store, {
        objectType: "Contact",
        portalId: "c-1",
        origin: "salesforce",
        actor: "sales.user",
        occurredAtMs: 1_000,
        originEventId: "evt_0",
        rawChanges: { city: "Gurugram" },
      });
      feed(store, {
        objectType: "Contact",
        portalId: "c-1",
        origin: "portal",
        actor: "finance.user",
        occurredAtMs: 2_000,
        originEventId: "chg_1",
        rawChanges: { city: "Noida" },
      });

      // A portal user typing back the value Salesforce holds is a real edit by
      // a real person, with a real order key. Step (b) is about Salesforce
      // restating a *record* it did not change; it must not swallow a portal
      // save (design 8.4).
      const results = feed(store, {
        objectType: "Contact",
        portalId: "c-1",
        origin: "portal",
        actor: "finance.user",
        occurredAtMs: 3_000,
        originEventId: "chg_2",
        rawChanges: { city: "Gurugram" },
      });

      assert.equal(fieldResult(results, "city").outcome, "applied");
      assert.equal(valuesOf(store, "Contact", "c-1").city, "Gurugram");
    });
  });
});

describe("applyChanges: an echo changes nothing (design 9.2, Appendix B)", () => {
  /**
   * Finance sets the city in the portal; Salesforce then describes our own
   * write back to us, carrying the time *Salesforce* stored it — later than
   * the portal edit.
   */
  function portalEditThenEcho(store: DurableStore): AppliedField[] {
    createRecord(store, "Contact", "c-1");
    feed(store, {
      objectType: "Contact",
      portalId: "c-1",
      origin: "portal",
      actor: "finance.user",
      occurredAtMs: 1_000,
      originEventId: "chg_1",
      rawChanges: { city: "Noida" },
    });
    return feed(store, {
      objectType: "Contact",
      portalId: "c-1",
      origin: "salesforce",
      actor: "integration.user",
      occurredAtMs: 2_000,
      originEventId: "evt_1",
      rawChanges: { city: "Noida" },
      isEcho: true,
    });
  }

  test("the echo is recorded, never applied, and never compared", () => {
    withStore((store) => {
      const results = portalEditThenEcho(store);

      assert.equal(fieldResult(results, "city").outcome, "echo");
      assert.equal(valuesOf(store, "Contact", "c-1").city, "Noida");

      // An observation, not history: Salesforce describing a write of ours is
      // not an edit by a person (design 4).
      const echoes = observationsOf(store).filter((o) => o.outcome === "echo");
      assert.equal(echoes.length, 1);
      assert.equal(echoes[0]?.field, "city");
      assert.equal(echoes[0]?.actor, "integration.user");
      assert.equal(echoes[0]?.observedValue, "Noida");
    });
  });

  test("the echo does not restamp the field, so a portal edit still owns it", () => {
    withStore((store) => {
      portalEditThenEcho(store);

      const version = store.read((tx) => tx.getFieldVersion("Contact", "c-1", "city"));
      assert.ok(version);
      // Load-bearing, and the reason L2 is not an economy measure: the echo
      // carries the time Salesforce stored our value, which is later than the
      // edit that write overwrote. Compared as a change it would win, and it
      // would launder our value back over a newer edit from the other side
      // (design 9.2, Appendix B).
      assert.equal(version.occurredAtMs, 1_000);
      assert.equal(version.origin, "portal");
      assert.equal(version.actor, "finance.user");
      // It is still an observation of Salesforce's state: step (a) learns from
      // it even though step (c) refuses to compare it.
      assert.equal(version.sfValue, "Noida");
      assert.equal(version.sfObservedAtMs, 2_000);
    });
  });

  test("the echo creates no outbound work: nothing is left to disagree about", () => {
    withStore((store) => {
      createRecord(store, "Contact", "c-1");

      // Design 9.1's three-line termination trace, step by step.
      //
      //   portal sets city = Noida  -> sf_value unknown      -> 1 outbound row
      //   we PATCH Noida, 2xx       -> sf_value := "Noida"
      //   Salesforce echoes Noida   -> sf_value = current     -> 0 rows. Dead.
      feed(store, {
        objectType: "Contact",
        portalId: "c-1",
        origin: "portal",
        actor: "finance.user",
        occurredAtMs: 1_000,
        originEventId: "chg_1",
        rawChanges: { city: "Noida" },
      });
      assert.deepEqual(
        outboundOf(store).map((r) => [r.field, r.reason, r.state]),
        [["city", "portal-edit", "pending"]],
      );

      // The sender delivers it, so the queue is empty when the echo lands.
      senderDelivers(store);

      const results = feed(store, {
        objectType: "Contact",
        portalId: "c-1",
        origin: "salesforce",
        actor: "integration.user",
        occurredAtMs: 2_000,
        originEventId: "evt_1",
        rawChanges: { city: "Noida" },
        isEcho: true,
      });

      // No fuel after one hop — not because a rule caught the loop, but
      // because there is nothing left to disagree about.
      assert.equal(fieldResult(results, "city").enqueuedOutbound, false);
      assert.deepEqual(
        outboundOf(store).filter((r) => r.state === "pending"),
        [],
      );
    });
  });

  test("an echo carrying a different value still never changes the value", () => {
    withStore((store) => {
      createRecord(store, "Contact", "c-1");
      feed(store, {
        objectType: "Contact",
        portalId: "c-1",
        origin: "portal",
        actor: "finance.user",
        occurredAtMs: 1_000,
        originEventId: "chg_1",
        rawChanges: { city: "Noida" },
      });

      // Not a case the design expects — our own write should echo the value we
      // sent — but "never applied" must hold without depending on the value,
      // or the guarantee would be an accident of the happy path.
      const results = feed(store, {
        objectType: "Contact",
        portalId: "c-1",
        origin: "salesforce",
        actor: "integration.user",
        occurredAtMs: 9_000,
        originEventId: "evt_1",
        rawChanges: { city: "Gurugram" },
        isEcho: true,
      });

      assert.equal(fieldResult(results, "city").outcome, "echo");
      assert.equal(valuesOf(store, "Contact", "c-1").city, "Noida");
      assert.equal(historyOf(store, "Contact", "c-1").length, 1);
    });
  });
});

describe("applyChanges: an older webhook after a newer one (design 8.2)", () => {
  /**
   * The design's own trace. `evt_B` (11:30:09) is applied; `evt_A`
   * (11:30:04) arrives second, describing a **past** state of Salesforce.
   */
  function feedNewerThenOlder(store: DurableStore): AppliedField[] {
    createRecord(store, "Contact", "c-1");
    feed(store, {
      objectType: "Contact",
      portalId: "c-1",
      origin: "salesforce",
      actor: "sales.user",
      occurredAtMs: 9_000,
      originEventId: "evt_B",
      rawChanges: { phone: "+919876543210" },
    });
    return feed(store, {
      objectType: "Contact",
      portalId: "c-1",
      origin: "salesforce",
      actor: "sales.user",
      occurredAtMs: 4_000,
      originEventId: "evt_A",
      rawChanges: { phone: "+919000000001" },
    });
  }

  test("the older value is superseded and the current value stays put", () => {
    withStore((store) => {
      const results = feedNewerThenOlder(store);

      assert.equal(fieldResult(results, "phone").outcome, "superseded");
      assert.equal(valuesOf(store, "Contact", "c-1").phone, "+919876543210");
    });
  });

  test("the superseded edit is kept with its own actor and time", () => {
    withStore((store) => {
      feedNewerThenOlder(store);

      const history = historyOf(store, "Contact", "c-1");
      assert.deepEqual(
        history.map((r) => [r.outcome, r.newValue, r.occurredAtMs, r.actor]),
        [
          ["applied", "+919876543210", 9_000, "sales.user"],
          // The brief is explicit that the fact of an earlier edit stays on
          // record (design 7.5), so the loser is history, not a discard.
          ["superseded", "+919000000001", 4_000, "sales.user"],
        ],
      );
    });
  });

  test("no outbound call is enqueued — the bug step (a)'s guard prevents", () => {
    withStore((store) => {
      feedNewerThenOlder(store);

      // This is the assertion design 8.2 exists for. A repair rule that
      // compared the *incoming* value against ours would fire here and waste
      // a call, because `evt_A` describes a past Salesforce state, not its
      // current one. Step (a) refuses to let the older event overwrite the
      // newer fact, so condition (d) sees no disagreement.
      assert.deepEqual(outboundOf(store), []);

      const version = store.read((tx) => tx.getFieldVersion("Contact", "c-1", "phone"));
      assert.ok(version);
      assert.equal(version.sfValue, "+919876543210");
      assert.equal(version.sfObservedAtMs, 9_000);
    });
  });
});
