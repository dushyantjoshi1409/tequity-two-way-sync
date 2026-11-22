/**
 * The seam at Salesforce.
 *
 * This is the one interface in the design with two real adapters: the live
 * HTTPS client against the client's org, and the fake in `./fake.ts` that the
 * demo runs against. Everything else in the codebase depends on this shape
 * rather than on either adapter (design 2, "Seams").
 *
 * Three operations, which is the entire surface the design depends on, and
 * **each is idempotent by design** (Appendix C.1). That is a requirement, not
 * an observation: a durable queue can only promise at-least-once delivery, so
 * a call that may be repeated must converge rather than double-apply.
 *
 * The error types below are the design's failure taxonomy, and the split
 * between them is what makes a 6-hour outage survivable (design 6.4):
 *
 * - {@link SalesforceUnreachable} and {@link SalesforceServerError} are
 *   **endpoint failures** — they say nothing about the row, so the row's
 *   attempt count is given back and the circuit breaker counts them.
 * - {@link SalesforceThrottled} is a slow-down signal: halve the rate, keep
 *   the work.
 * - {@link SalesforceRejected} is a **row failure** — the data in this
 *   particular record is wrong, so only this kind counts attempts toward
 *   giving up, and it alerts rather than retrying forever.
 */

import type { ObjectType } from "../domain/types.js";

/** The Salesforce login every call of ours is made as (design 9.2, rule L2). */
export const INTEGRATION_USER = "integration.user@tequity.example";

/** Salesforce could not be reached at all. An endpoint failure. */
export class SalesforceUnreachable extends Error {
  constructor(message = "salesforce is unreachable") {
    super(message);
    this.name = "SalesforceUnreachable";
  }
}

/** Salesforce answered 5xx. An endpoint failure — nothing about the row. */
export class SalesforceServerError extends Error {
  constructor(readonly status: number, message = `salesforce returned ${status}`) {
    super(message);
    this.name = "SalesforceServerError";
  }
}

/**
 * Salesforce told us to slow down (429 or `REQUEST_LIMIT_EXCEEDED`,
 * assumption A8). Carries `Retry-After` when Salesforce supplied one.
 */
export class SalesforceThrottled extends Error {
  constructor(readonly retryAfterMs: number | undefined, message = "slow down") {
    super(message);
    this.name = "SalesforceThrottled";
  }
}

/**
 * Salesforce refused this record's data (a 400-class validation error). A row
 * failure: a value the portal accepts and Salesforce will not is a schema
 * disagreement that needs a human, so retrying it blindly only burns the cap.
 */
export class SalesforceRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SalesforceRejected";
  }
}

/** One record as the changed-since query returns it (design A4). */
export interface ChangedRecord {
  readonly sfId: string;
  readonly objectType: ObjectType;
  /** Every field of the record — this query is inherently full-record. */
  readonly values: Readonly<Record<string, string | null>>;
  /**
   * The record's modification time, **not** the field's. This is why the
   * restatement rule has to be unconditional (design 10.3).
   */
  readonly systemModstampMs: number;
  readonly lastModifiedBy: string;
}

/** The three operations, and nothing else. */
export interface SalesforceClient {
  /**
   * Update an existing record with its current values.
   *
   * Idempotent because it sends the values we currently believe are right, so
   * sending it twice reaches the same state.
   *
   * @throws {SalesforceUnreachable} {@link SalesforceServerError}
   *   {@link SalesforceThrottled} {@link SalesforceRejected}
   */
  update(
    objectType: ObjectType,
    sfId: string,
    values: Readonly<Record<string, string | null>>,
  ): Promise<void>;

  /**
   * Create or update by **our** identifier (assumption A5).
   *
   * Idempotent because it is keyed on the `portalId` we chose, so a repeat
   * updates the record it created rather than making a second one. This is
   * the operation worth pushing the client for: without it, create is the one
   * call whose repeat is not safe.
   */
  upsertByExternalId(
    objectType: ObjectType,
    portalId: string,
    values: Readonly<Record<string, string | null>>,
  ): Promise<{ sfId: string; created: boolean }>;

  /**
   * Records changed since a watermark, oldest first (assumption A4). A read,
   * so trivially idempotent. Returns up to `pageSize` records.
   */
  queryChangedSince(
    objectType: ObjectType,
    sinceMs: number,
    pageSize: number,
  ): Promise<readonly ChangedRecord[]>;
}
