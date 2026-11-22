/**
 * Tests for the webhook endpoint (design 5, and the echo rules of design 9).
 *
 * The merge itself is tested in `src/domain/merge.test.ts`. What is tested here
 * is the part of design 5 that lives *outside* the merge: claiming the event,
 * resolving which record a webhook is about, classifying our own echo, and the
 * status code each refusal earns. Those are rule seams too — the three resolve
 * cases and the L2/L3 echo classification are all stated rules — and a bug in
 * them is invisible to the merge tests.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { INTEGRATION_USER } from "../salesforce/client.js";
import { DurableStore } from "../store/store.js";
import { ECHO_FENCE_TTL_MS, receiveWebhook } from "./endpoint.js";

let dir: string;
let store: DurableStore;
/**
 * One clock for the store and the endpoint.
 *
 * They must share it: the store stamps `createdAtMs` and expires echo fences
 * with its own clock, and design 5 case (c)'s bound compares the endpoint's
 * clock against that stamp. In production both are the wall clock; a test that
 * moved only one of them would be measuring the gap between two clocks rather
 * than the rule.
 */
let now: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sync-endpoint-"));
  now = 10_000;
  store = DurableStore.open(join(dir, "store.json"), () => now);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A webhook body in the shape the exercise's sample uses. */
function body(over: Partial<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    eventId: "evt_1",
    recordId: "0031A00000001",
    objectType: "Contact",
    occurredAt: 1_000,
    changedBy: "sales.user@client.example",
    changedFields: { city: "Gurugram" },
    ...over,
  });
}

/** Advance the shared clock, then deliver. */
function deliverAt(at: number, raw: string) {
  now = at;
  return receiveWebhook(store, raw, () => now);
}

describe("receiveWebhook: the duplicate rule (design 8.1)", () => {
  test("a byte-identical redelivery is a counted duplicate, not an error", () => {
    const first = deliverAt(10_000, body());
    const second = deliverAt(10_001, body());

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(second.body.status, "duplicate");
    // Counted, not alerted: Salesforce did what A7 permits.
    assert.equal(second.body.reason, undefined);
  });

  test("the same eventId with a different payload is reported as the provider bug it is", () => {
    deliverAt(10_000, body());
    const conflicting = deliverAt(10_001, body({ changedFields: { city: "Noida" } }));

    // First write wins, and this one is distinguishable from an ordinary
    // duplicate — the design contrasts the two deliberately (design 8.1).
    assert.equal(conflicting.status, 200);
    assert.equal(conflicting.body.reason, "eventId-reused-with-different-payload");

    const values = store.read((tx) => tx.getRecord("Contact", resolvePortalId()));
    assert.equal(values?.values.city, "Gurugram");
  });
});

describe("receiveWebhook: resolving the record (design 5 cases (a), (b), (c))", () => {
  test("case (b): an unseen Salesforce record is minted and every field applied", () => {
    const res = deliverAt(10_000, body());

    assert.equal(res.status, 200);
    assert.equal(res.body.status, "applied");
    const record = store.read((tx) => tx.getRecord("Contact", resolvePortalId()));
    assert.equal(record?.values.city, "Gurugram");
  });

  test("case (c): a create echo arriving before we recorded the id defers with a 503", () => {
    // A portal-created record whose Salesforce id we do not have yet.
    store.transaction((tx) => tx.createRecord("Contact", "portal-1", null));

    const res = deliverAt(10_000, body({ changedBy: INTEGRATION_USER }));

    assert.equal(res.status, 503);
    assert.equal(res.body.reason, "create-echo-before-link");
    // Applied nothing: by the redelivery the link exists and it is case (a).
    assert.equal(store.read((tx) => tx.getRecord("Contact", "portal-1"))?.values.city, undefined);
  });

  test("case (c) is bounded: past 60 seconds it stops deferring and falls through to (b)", () => {
    // The regression this pins: the bound used to read `linkedAtMs`, which is
    // unset for exactly these unlinked rows, so the wait computed as 0 forever
    // and a create that never linked refused every later webhook of its type
    // with a permanent 503 (design 5 case (c) promises a 60-second bound).
    store.transaction((tx) => tx.createRecord("Contact", "portal-1", null));

    const deferred = deliverAt(10_000 + 59_000, body({ changedBy: INTEGRATION_USER }));
    assert.equal(deferred.status, 503, "still inside the bound");

    const fellThrough = deliverAt(
      10_000 + 61_000,
      body({ eventId: "evt_2", changedBy: INTEGRATION_USER }),
    );
    assert.equal(fellThrough.status, 200, "past the bound it stops deferring");

    // Recorded as an echo, not applied: past the bound case (c) stops
    // stalling, but L2 (design 9.2) still refuses to apply a webhook
    // describing our own write, whatever it carries. So the record is linked
    // and left for the reconciliation sweep the design names — which is the
    // point of the bound. A visible, repairable outcome beats a permanent 503.
    assert.equal(fellThrough.body.status, "echo");
    assert.ok(
      store.read((tx) => tx.findLinkBySfId("Contact", "0031A00000001")),
      "the fall-through linked the record rather than refusing forever",
    );
  });
});

describe("receiveWebhook: our own write coming back (design 9.2, 9.3)", () => {
  test("L2: a webhook from the integration user is recorded, never applied", () => {
    // Link the record first, so this is an echo rather than case (c).
    store.transaction((tx) => {
      tx.createRecord("Contact", "portal-1", "0031A00000001");
      tx.setCurrentValue("Contact", "portal-1", "city", "Noida");
    });

    const res = deliverAt(10_000, body({ changedBy: INTEGRATION_USER }));

    assert.equal(res.status, 200);
    assert.equal(res.body.status, "echo");
    // Never applied: the value we hold is untouched by Salesforce's echo.
    assert.equal(store.read((tx) => tx.getRecord("Contact", "portal-1"))?.values.city, "Noida");
  });

  test("L3: an unexpired fence classifies an echo even when the actor does not (A6 false)", () => {
    store.transaction((tx) => {
      tx.createRecord("Contact", "portal-1", "0031A00000001");
      tx.setCurrentValue("Contact", "portal-1", "city", "Gurugram");
      tx.addEchoFence({
        objectType: "Contact",
        portalId: "portal-1",
        field: "city",
        valueHash: sha256OfGurugram(),
        sentAtMs: now - 1_000,
        expiresAtMs: now - 1_000 + ECHO_FENCE_TTL_MS,
      });
    });

    // A human actor, so L2 does not fire; the fence is what recognises it.
    const res = deliverAt(10_000, body({ changedBy: "someone.else@client.example" }));
    assert.equal(res.body.status, "echo");
  });
});

describe("receiveWebhook: the event's own outcome (design 5)", () => {
  test("an event whose every field already holds the incoming value is confirmed, not applied", () => {
    store.transaction((tx) => {
      tx.createRecord("Contact", "portal-1", "0031A00000001");
      tx.setCurrentValue("Contact", "portal-1", "city", "Gurugram");
    });

    const res = deliverAt(10_000, body());

    // Nothing changed, so the event must not read as one that changed
    // something — the same reason design 5 keeps it out of `field_change`.
    assert.equal(res.body.status, "confirmed");
  });

  test("an unknown field name earns a 400, which discards the event forever", () => {
    const res = deliverAt(10_000, body({ changedFields: { telephon: "x" } }));
    assert.equal(res.status, 400);
  });
});

/** The portal id minted for the sample record, whatever it was. */
function resolvePortalId(): string {
  const link = store.read((tx) => tx.findLinkBySfId("Contact", "0031A00000001"));
  assert.ok(link, "the webhook should have minted a link");
  return link.portalId;
}

/** The canonical hash of "Gurugram", as the sender would have recorded it. */
function sha256OfGurugram(): string {
  // Imported lazily to keep this helper beside its one use.
  return createHash("sha256").update("Gurugram").digest("hex");
}
