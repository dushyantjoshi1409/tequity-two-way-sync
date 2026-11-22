/**
 * Row shapes for the durable store, one per table in part 4 of
 * `docs/design.md`. Field names mirror the SQL in `docs/design-appendix.md`
 * Appendix C.2 so the two can be read side by side.
 */

import type {
  EventOutcome,
  ObjectType,
  Origin,
  OutboundReason,
  OutboundState,
} from "../domain/types.js";

/** A row of `customer` or `contact`: the current values, and nowhere else. */
export interface RecordRow {
  readonly objectType: ObjectType;
  readonly portalId: string;
  /** field -> current canonical value. The single home of a current value. */
  values: Record<string, string | null>;
  updatedAtMs: number;
}

/**
 * A row of `field_version`: the winning order key for one field, plus what we
 * believe Salesforce holds.
 *
 * A cache, not a second source of truth — every column is derivable from
 * `fieldChanges` and `observations`, and rebuilding it is the repair for any
 * doubt (design 4).
 */
export interface FieldVersionRow {
  readonly objectType: ObjectType;
  readonly portalId: string;
  readonly field: string;
  /** The order key of the change that is currently winning. */
  occurredAtMs: number;
  originRank: number;
  originEventId: string;
  origin: Origin;
  actor: string;
  /**
   * What we believe Salesforce currently holds for this field. Updated by a
   * Salesforce observation **and by our own successful send** — a write of
   * ours is the most recent thing we know about Salesforce's state (design
   * 6.3; Appendix B traces the divergence that omitting it causes).
   * `undefined` until either has happened.
   */
  sfValue?: string | null;
  /** When we last learned `sfValue`. Guards against an old event overwriting a newer fact. */
  sfObservedAtMs?: number;
}

/** A row of `field_change`: permanent history. Append-only, never updated. */
export interface FieldChangeRow {
  readonly seq: number;
  readonly objectType: ObjectType;
  readonly portalId: string;
  readonly field: string;
  readonly oldValue: string | null;
  readonly newValue: string | null;
  readonly occurredAtMs: number;
  readonly origin: Origin;
  readonly originEventId: string;
  readonly actor: string;
  /** Only `applied` and `superseded` live here; both are permanent. */
  readonly outcome: "applied" | "superseded";
  readonly appliedAtMs: number;
}

/**
 * A row of `sync_observation`: an echo or a confirmation. Neither is an edit
 * by a person, so neither belongs in the client's history (design 4).
 */
export interface ObservationRow {
  readonly seq: number;
  readonly objectType: ObjectType;
  readonly portalId: string;
  readonly field: string;
  readonly observedValue: string | null;
  readonly occurredAtMs: number;
  readonly origin: Origin;
  readonly originEventId: string;
  readonly actor: string;
  readonly outcome: "echo" | "confirmed" | "restatement";
  readonly observedAtMs: number;
}

/** A row of `inbound_event`: the duplicate key (design 8.1). */
export interface InboundEventRow {
  readonly eventId: string;
  readonly objectType: ObjectType;
  readonly sfId: string;
  readonly occurredAtMs: number;
  /** sha256 of the raw body; a repeat with a different hash is a provider bug. */
  readonly payloadHash: string;
  outcome: EventOutcome;
  readonly receivedAtMs: number;
}

/**
 * A row of `outbound_change`: the durable queue.
 *
 * Note what is absent: the value to send. The sender reads the current value
 * at send time, so a row queued three hours into an outage cannot deliver a
 * value we have since superseded (design 6.3).
 */
export interface OutboundRow {
  readonly id: number;
  readonly objectType: ObjectType;
  readonly portalId: string;
  readonly field: string;
  readonly reason: OutboundReason;
  readonly occurredAtMs: number;
  state: OutboundState;
  attempts: number;
  nextAttemptAtMs: number;
  leaseOwner?: string;
  leaseUntilMs?: number;
  lastError?: string;
  readonly createdAtMs: number;
  sentAtMs?: number;
}

/** A row of `record_link`: identity across the two systems, and the per-record lock. */
export interface RecordLinkRow {
  readonly objectType: ObjectType;
  readonly portalId: string;
  /** Null until Salesforce assigns one — a portal-created record has no id yet. */
  sfId: string | null;
  /**
   * When this link row was minted, set for every row whether or not it has an
   * `sfId` yet.
   *
   * Distinct from {@link linkedAtMs} on purpose: design 5 case (c) bounds how
   * long we defer a create echo, and "how long has this create been waiting"
   * is the age of the row, not the time an id was attached — which is by
   * definition unset for exactly the unlinked rows that bound applies to.
   */
  readonly createdAtMs: number;
  /** When Salesforce's id was attached. Unset while `sfId` is null. */
  linkedAtMs?: number;
}

/** A row of `echo_fence`: "we just wrote this value; expect to hear it back" (design 9.3). */
export interface EchoFenceRow {
  readonly objectType: ObjectType;
  readonly portalId: string;
  readonly field: string;
  readonly valueHash: string;
  readonly sentAtMs: number;
  readonly expiresAtMs: number;
}

/** The whole durable state. One JSON document stands in for the database. */
export interface StoreState {
  records: Record<string, RecordRow>;
  fieldVersions: Record<string, FieldVersionRow>;
  fieldChanges: FieldChangeRow[];
  observations: ObservationRow[];
  inboundEvents: Record<string, InboundEventRow>;
  outbound: OutboundRow[];
  recordLinks: RecordLinkRow[];
  echoFences: EchoFenceRow[];
  /** objectType -> highest SystemModstamp we are confident we have seen. */
  watermarks: Record<string, number>;
  nextSeq: number;
  nextOutboundId: number;
}

/** An empty database. */
export function emptyState(): StoreState {
  return {
    records: {},
    fieldVersions: {},
    fieldChanges: [],
    observations: [],
    inboundEvents: {},
    outbound: [],
    recordLinks: [],
    echoFences: [],
    watermarks: {},
    nextSeq: 1,
    nextOutboundId: 1,
  };
}

/** Composite key for `records` and `recordLinks`. */
export function recordKey(objectType: ObjectType, portalId: string): string {
  return `${objectType}:${portalId}`;
}

/** Composite key for `fieldVersions`. */
export function fieldKey(
  objectType: ObjectType,
  portalId: string,
  field: string,
): string {
  return `${objectType}:${portalId}:${field}`;
}
