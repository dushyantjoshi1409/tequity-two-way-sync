/**
 * Core vocabulary of the sync, mirroring `CONTEXT.md` and part 4 of
 * `docs/design.md`.
 *
 * The one distinction to carry while reading everything else: an **edit** is a
 * human action (one form save, one Salesforce field change), while a
 * **change** is a single field moving to a single new value. The sync reasons
 * only about changes, because the field — not the record — is what conflicts
 * and what carries history (ADR 0002).
 */

/** The two record kinds the exercise names. */
export type ObjectType = "Customer" | "Contact";

/** Which system an edit was made in. Carried on a change for its whole life. */
export type Origin = "salesforce" | "portal";

/**
 * Tiebreak rank inside the order key (design 7.2).
 *
 * Salesforce is 1 and the portal 0, so Salesforce wins an exact-millisecond
 * tie. That is the cheaper direction, not an arbitrary one: a losing portal
 * value costs nothing, while a losing Salesforce value obliges us to send a
 * repair write (design 8.3).
 */
export const ORIGIN_RANK: Readonly<Record<Origin, number>> = Object.freeze({
  portal: 0,
  salesforce: 1,
});

/**
 * The comparable value that decides which of two changes to one field is
 * current (design 7.2). Compared left to right: time, then rank, then event
 * id.
 */
export interface OrderKey {
  /**
   * On a webhook, the payload's `occurredAt`. On a portal save,
   * `clock_timestamp()` of the saving transaction — never a time supplied by
   * the caller, which could be forged (assumption A9).
   */
  readonly occurredAtMs: number;
  /** `ORIGIN_RANK[origin]`. */
  readonly originRank: number;
  /**
   * The webhook's `eventId`, or the portal change id. Breaks a shared
   * millisecond arbitrarily but **stably**, which matters because a
   * redelivered event must rank the same way the second time.
   */
  readonly originEventId: string;
}

/** What `applyChanges` decided about one field. */
export type FieldOutcome =
  /** Became the current value. Permanent history. */
  | "applied"
  /** A real edit that lost the order-key comparison. Permanent history. */
  | "superseded"
  /** Salesforce describing a write of ours. Operational log, not history. */
  | "echo"
  /** Salesforce restating a value we already hold. Operational log. */
  | "confirmed"
  /**
   * A field in the payload whose value equals the `sf_value` we already held,
   * so Salesforce did not actually change it (design 8.4). Not restamped, not
   * compared, not touched.
   */
  | "restatement";

/** How an inbound event as a whole was accounted for. */
export type EventOutcome =
  | "applied"
  | "duplicate"
  | "echo"
  | "superseded"
  | "partial"
  | "restatement"
  /** Every field already held the incoming value, so nothing changed. */
  | "confirmed"
  | "rejected";

/** Why a row is sitting in the outbound queue. */
export type OutboundReason = "portal-edit" | "repair" | "create" | "recovery";

/** Lifecycle of an outbound queue row (design 4, 6.5). */
export type OutboundState = "pending" | "inflight" | "sent" | "failed";

/** One field moving to one new value, attributed to one actor at one time. */
export interface Change {
  readonly field: string;
  /** Canonical form (design 7.3). Null means the field was cleared. */
  readonly value: string | null;
}

/** The input to `applyChanges` — one edit, which is one or more changes. */
export interface ApplyChangesInput {
  readonly objectType: ObjectType;
  /** Our own identifier. The caller has already resolved the record link. */
  readonly portalId: string;
  readonly origin: Origin;
  /** The identified human or integration account. Part of history, not metadata. */
  readonly actor: string;
  /** See {@link OrderKey.occurredAtMs}. */
  readonly occurredAtMs: number;
  /** See {@link OrderKey.originEventId}. */
  readonly originEventId: string;
  /** Raw, un-canonicalised values as they arrived. */
  readonly rawChanges: Readonly<Record<string, string | null>>;
  /**
   * True when this event is a notification about a write of ours (design 9.2
   * rule L2, or 9.3's fence). An echo never changes a current value.
   */
  readonly isEcho?: boolean;
}

/** What `applyChanges` did to one field. */
export interface AppliedField {
  readonly field: string;
  readonly outcome: FieldOutcome;
  readonly previousValue: string | null;
  readonly newValue: string | null;
  /** True when condition (d) of design 8.3 enqueued an outbound call. */
  readonly enqueuedOutbound: boolean;
}

/** Raised when a webhook cannot be accepted. Carries the HTTP status to use. */
export class WebhookRejected extends Error {
  constructor(
    message: string,
    /** 400 for "this will never work", 500 for "our bug, please retry". */
    readonly status: 400 | 500,
    /** Machine-readable reason, for the demo's printed output and for metrics. */
    readonly reason: string,
  ) {
    super(message);
    this.name = "WebhookRejected";
  }
}

/** Raised when the durable store cannot be read. Never swallowed. */
export class StoreReadError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "StoreReadError";
  }
}

/** Raised when the durable store cannot be written. Never swallowed. */
export class StoreWriteError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "StoreWriteError";
  }
}
