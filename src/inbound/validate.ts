/**
 * Webhook validation: turning bytes from the internet into something the
 * merge can be trusted with, or a clear refusal.
 *
 * The one judgement encoded here is design 5's 400-versus-500 split, and it
 * matters because **a 400 discards the event forever** while a 500 asks
 * Salesforce to send it again:
 *
 * - An unknown *field name* earns a 400. No amount of retrying will make
 *   `telephon` a field.
 * - A *value* we merely failed to handle does **not** earn a 400. That is our
 *   bug, and throwing the event away because of our bug would lose a real
 *   edit — so it is a 500 and Salesforce retries it.
 *
 * Every rejection names exactly what was wrong. An unparseable body, a missing
 * `eventId`, an unknown `objectType` and an unknown field are four different
 * messages, not one generic "bad request", because the first thing anybody
 * debugging a webhook asks is *which* part was wrong.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

import { fieldSpec } from "../domain/fields.js";
import { WebhookRejected } from "../domain/types.js";
import type { ObjectType } from "../domain/types.js";

/** A webhook that has been validated and is safe to merge. */
export interface ValidWebhook {
  readonly eventId: string;
  readonly recordId: string;
  readonly objectType: ObjectType;
  readonly occurredAtMs: number;
  readonly changedBy: string;
  readonly changedFields: Readonly<Record<string, string | null>>;
}

/** Raised when the signature does not verify. Distinct from a 400: retrying cannot help. */
export class SignatureInvalid extends Error {
  readonly status = 401 as const;
  constructor(message = "X-Signature did not verify") {
    super(message);
    this.name = "SignatureInvalid";
  }
}

const OBJECT_TYPES: readonly string[] = ["Customer", "Contact"];

/**
 * Verify the HMAC-SHA256 signature over the **raw bytes** of the body
 * (assumption A7).
 *
 * Over the raw bytes, never over re-serialised JSON: `JSON.parse` followed by
 * `JSON.stringify` can reorder keys and change spacing, which would make a
 * valid signature fail and an attacker's reordering succeed.
 *
 * @throws {SignatureInvalid}
 */
export function verifySignature(rawBody: string, signatureHex: string, secret: string): void {
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(signatureHex, "hex");
  } catch (cause) {
    // A signature header that is not even hex is a failed signature, not a
    // crash. Reported as such rather than allowed to propagate as a TypeError.
    throw new SignatureInvalid(`signature is not valid hex: ${String(cause)}`);
  }
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    throw new SignatureInvalid();
  }
}

/** Sign a body the way Salesforce would. Used by the demo and the tests. */
export function signBody(rawBody: string, secret: string): string {
  return createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
}

/**
 * Parse and validate a raw webhook body.
 *
 * @throws {WebhookRejected} with status 400 and a specific `reason` for every
 *   way the payload can be wrong in a way time will not fix.
 */
export function validateWebhook(rawBody: string): ValidWebhook {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch (cause) {
    throw new WebhookRejected(
      `body is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
      400,
      "malformed-json",
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new WebhookRejected("body must be a JSON object", 400, "not-an-object");
  }
  const body = parsed as Record<string, unknown>;

  const eventId = body["eventId"];
  if (typeof eventId !== "string" || eventId.length === 0) {
    throw new WebhookRejected("eventId is required", 400, "missing-eventId");
  }
  const recordId = body["recordId"];
  if (typeof recordId !== "string" || recordId.length === 0) {
    throw new WebhookRejected("recordId is required", 400, "missing-recordId");
  }
  const objectType = body["objectType"];
  if (typeof objectType !== "string" || !OBJECT_TYPES.includes(objectType)) {
    throw new WebhookRejected(
      `objectType must be one of ${OBJECT_TYPES.join(", ")}, got ${JSON.stringify(objectType)}`,
      400,
      "unknown-objectType",
    );
  }
  const changedBy = body["changedBy"];
  if (typeof changedBy !== "string" || changedBy.length === 0) {
    throw new WebhookRejected("changedBy is required", 400, "missing-changedBy");
  }

  const occurredAtMs = parseOccurredAt(body["occurredAt"]);

  const changedFieldsRaw = body["changedFields"];
  if (
    typeof changedFieldsRaw !== "object" ||
    changedFieldsRaw === null ||
    Array.isArray(changedFieldsRaw)
  ) {
    throw new WebhookRejected(
      "changedFields must be an object",
      400,
      "bad-changedFields",
    );
  }
  const entries = Object.entries(changedFieldsRaw as Record<string, unknown>);
  if (entries.length === 0) {
    // An event that names no field tells us nothing and cannot be applied.
    throw new WebhookRejected(
      "changedFields must name at least one field",
      400,
      "empty-changedFields",
    );
  }

  const changedFields: Record<string, string | null> = {};
  for (const [field, value] of entries) {
    if (!fieldSpec(objectType as ObjectType, field)) {
      // An unknown field name can never become valid, so this is a 400 and the
      // event is discarded. The message names the field and the object type,
      // because that is what the person reading the alert needs.
      throw new WebhookRejected(
        `${objectType} has no field ${JSON.stringify(field)}`,
        400,
        "unknown-field",
      );
    }
    if (value !== null && typeof value !== "string") {
      throw new WebhookRejected(
        `field ${field} must be a string or null, got ${typeof value}`,
        400,
        "bad-field-type",
      );
    }
    changedFields[field] = value;
  }

  return {
    eventId,
    recordId,
    objectType: objectType as ObjectType,
    occurredAtMs,
    changedBy,
    changedFields,
  };
}

/**
 * `occurredAt` must be a parseable instant (assumption A11: UTC, millisecond
 * resolution). Accepts an ISO string or an epoch-millisecond number, because
 * the demo uses numbers and a real Salesforce sends ISO.
 */
function parseOccurredAt(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const ms = Date.parse(value);
    if (!Number.isNaN(ms)) return ms;
  }
  throw new WebhookRejected(
    `occurredAt must be an ISO-8601 instant or epoch ms, got ${JSON.stringify(value)}`,
    400,
    "bad-occurredAt",
  );
}
