/**
 * Tests for webhook validation (design 5).
 *
 * The point of these is the 400/500 split and the specificity of the reasons.
 * A 400 discards the event forever, so every one of them has to be a payload
 * that time will not fix, and each has to name which part was wrong.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { WebhookRejected } from "../domain/types.js";
import { SignatureInvalid, signBody, validateWebhook, verifySignature } from "./validate.js";

const SECRET = "test-secret";

/** A payload that validates, so each test can break exactly one thing. */
function goodBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    eventId: "evt_1",
    recordId: "0031A00000Abc",
    objectType: "Contact",
    occurredAt: "2026-11-02T11:30:04.000Z",
    changedBy: "sales.user@client.example",
    changedFields: { phone: "+919876543210" },
    ...overrides,
  });
}

/** Assert that validation refuses a body with a 400 and a named reason. */
function assertRejected(body: string, reason: string): void {
  try {
    validateWebhook(body);
    assert.fail(`expected ${reason} to be rejected`);
  } catch (error) {
    assert.ok(error instanceof WebhookRejected, `expected WebhookRejected, got ${error}`);
    assert.equal(error.status, 400);
    assert.equal(error.reason, reason);
  }
}

describe("validateWebhook", () => {
  test("accepts the sample payload from the exercise", () => {
    const valid = validateWebhook(goodBody());
    assert.equal(valid.eventId, "evt_1");
    assert.equal(valid.objectType, "Contact");
    assert.equal(valid.occurredAtMs, Date.parse("2026-11-02T11:30:04.000Z"));
    assert.deepEqual(valid.changedFields, { phone: "+919876543210" });
  });

  test("accepts epoch milliseconds as well as ISO, because the demo uses them", () => {
    const valid = validateWebhook(goodBody({ occurredAt: 1762083004000 }));
    assert.equal(valid.occurredAtMs, 1762083004000);
  });

  test("names each way the payload can be wrong, separately", () => {
    assertRejected("{not json", "malformed-json");
    assertRejected("[]", "not-an-object");
    assertRejected(goodBody({ eventId: undefined }), "missing-eventId");
    assertRejected(goodBody({ recordId: "" }), "missing-recordId");
    assertRejected(goodBody({ objectType: "Invoice" }), "unknown-objectType");
    assertRejected(goodBody({ changedBy: undefined }), "missing-changedBy");
    assertRejected(goodBody({ occurredAt: "soon" }), "bad-occurredAt");
    assertRejected(goodBody({ changedFields: {} }), "empty-changedFields");
    assertRejected(goodBody({ changedFields: [] }), "bad-changedFields");
  });

  test("an unknown field name is a 400, because no retry will fix it", () => {
    assertRejected(goodBody({ changedFields: { telephon: "x" } }), "unknown-field");
  });

  test("a field of the wrong type is a 400 and says which field", () => {
    try {
      validateWebhook(goodBody({ changedFields: { phone: 42 } }));
      assert.fail("expected rejection");
    } catch (error) {
      assert.ok(error instanceof WebhookRejected);
      assert.equal(error.reason, "bad-field-type");
      assert.match(error.message, /phone/, "the message names the offending field");
    }
  });

  test("a field that exists on the other object type is still unknown here", () => {
    // `city` is a Contact field, not a Customer one. A10-style config errors
    // should not slip through as valid.
    assertRejected(
      goodBody({ objectType: "Customer", changedFields: { city: "Pune" } }),
      "unknown-field",
    );
  });

  test("null clears a field and is accepted", () => {
    const valid = validateWebhook(goodBody({ changedFields: { city: null } }));
    assert.deepEqual(valid.changedFields, { city: null });
  });
});

describe("verifySignature", () => {
  test("accepts a signature over the raw bytes", () => {
    const body = goodBody();
    assert.doesNotThrow(() => verifySignature(body, signBody(body, SECRET), SECRET));
  });

  test("rejects a signature made with the wrong secret", () => {
    const body = goodBody();
    assert.throws(
      () => verifySignature(body, signBody(body, "other"), SECRET),
      SignatureInvalid,
    );
  });

  test("rejects when the body was altered after signing", () => {
    const signature = signBody(goodBody(), SECRET);
    // Re-serialising can reorder keys and change spacing, which is exactly why
    // the signature covers raw bytes rather than parsed JSON.
    const tampered = goodBody({ changedFields: { phone: "+910000000000" } });
    assert.throws(() => verifySignature(tampered, signature, SECRET), SignatureInvalid);
  });

  test("a signature header that is not hex fails rather than crashing", () => {
    assert.throws(() => verifySignature(goodBody(), "zzzz", SECRET), SignatureInvalid);
  });
});
