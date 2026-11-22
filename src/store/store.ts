/**
 * The durable store: what stands in for Postgres in this demo.
 *
 * The design assumes Postgres. The exercise says the program must run on
 * Node alone, so one JSON document on disk plays that part. Every
 * substitution is listed here, because a reviewer checking the code against
 * the design needs to know exactly which guarantees are real and which are
 * imitated:
 *
 * | Design (Postgres)            | Here                                            | Faithful? |
 * | ---------------------------- | ----------------------------------------------- | --------- |
 * | tables                       | keyed objects and arrays in one JSON document    | yes       |
 * | `BEGIN` / `COMMIT`           | {@link DurableStore.transaction} — mutate a deep | yes, for  |
 * |                              | clone, then write the file atomically; a throw   | one       |
 * |                              | discards the clone, so nothing is half-applied   | process   |
 * | durability across a restart  | `writeFileSync` to a temp path then `renameSync`,| yes — the |
 * |                              | which is atomic on POSIX                         | demo kills|
 * |                              |                                                  | a process |
 * | `SELECT ... FOR UPDATE`      | not needed: one process, one transaction at a    | imitated  |
 * |   (the per-record lock)      | time, so merges on a record cannot interleave    |           |
 * | `FOR UPDATE SKIP LOCKED`     | the `leaseOwner` / `leaseUntilMs` columns, which | yes — the |
 * |                              | the design uses anyway so a crashed sender's     | lease is  |
 * |                              | rows can be reclaimed                            | real      |
 * | partial unique index,        | an explicit check in {@link Tx.enqueueOutbound}  | imitated  |
 * |   one pending row per field  |                                                  |           |
 * | `LISTEN` / `NOTIFY`          | the demo calls the worker directly               | imitated  |
 * | monthly partitions, pruning  | not implemented; retention is a design concern   | absent    |
 *
 * What is *not* imitated is called out so nobody reads more into the demo than
 * it shows: there is no concurrency here, so this file cannot demonstrate that
 * the record-level lock serialises competing merges. It demonstrates the
 * rules, the ordering, and the durability.
 *
 * Errors are always surfaced. A read failure raises {@link StoreReadError} and
 * a write failure {@link StoreWriteError}, both carrying the underlying cause.
 * Nothing here catches an error in order to continue quietly: a swallowed
 * write failure would make a lost call look like a drained queue.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { StoreReadError, StoreWriteError } from "../domain/types.js";
import type {
  EchoFenceRow,
  FieldChangeRow,
  FieldVersionRow,
  InboundEventRow,
  ObservationRow,
  OutboundRow,
  RecordLinkRow,
  RecordRow,
  StoreState,
} from "./schema.js";
import { emptyState, fieldKey, recordKey } from "./schema.js";
import type { ObjectType, OutboundReason, Origin } from "../domain/types.js";

/** sha256, hex. Used for payload hashes and echo-fence value hashes. */
export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * The handle a transaction body uses. Every mutation goes through a named
 * method rather than raw object access, so the set of writes the design allows
 * is visible in one place.
 */
export class Tx {
  constructor(
    /** The deep clone being mutated. Discarded if the body throws. */
    readonly state: StoreState,
    private readonly nowMs: () => number,
  ) {}

  // ---------------------------------------------------------------- records

  /** The current values row, or undefined. */
  getRecord(objectType: ObjectType, portalId: string): RecordRow | undefined {
    return this.state.records[recordKey(objectType, portalId)];
  }

  /** Create an empty record and its link. Used by part 5 cases (b) and the portal's create path. */
  createRecord(objectType: ObjectType, portalId: string, sfId: string | null): RecordRow {
    const row: RecordRow = {
      objectType,
      portalId,
      values: {},
      updatedAtMs: this.nowMs(),
    };
    this.state.records[recordKey(objectType, portalId)] = row;
    this.state.recordLinks.push({
      objectType,
      portalId,
      sfId,
      createdAtMs: this.nowMs(),
      linkedAtMs: sfId === null ? undefined : this.nowMs(),
    });
    return row;
  }

  /** Set a field's current value. The single place a current value changes. */
  setCurrentValue(
    objectType: ObjectType,
    portalId: string,
    field: string,
    value: string | null,
  ): void {
    const row = this.getRecord(objectType, portalId);
    if (!row) {
      // Not a recoverable condition: the caller resolved the record before
      // calling, so this means a bug in the caller, not bad input.
      throw new StoreReadError(
        `no ${objectType} record ${portalId} to set ${field} on`,
      );
    }
    row.values[field] = value;
    row.updatedAtMs = this.nowMs();
  }

  // --------------------------------------------------------- field versions

  /**
   * The cached order key and Salesforce belief for one field, if any exists.
   *
   * Undefined means no change has ever won this field and we have never heard
   * Salesforce's value for it — which condition 8.3 reads as a disagreement,
   * not as agreement.
   */
  getFieldVersion(
    objectType: ObjectType,
    portalId: string,
    field: string,
  ): FieldVersionRow | undefined {
    return this.state.fieldVersions[fieldKey(objectType, portalId, field)];
  }

  /** Insert or replace the winning order key for a field. */
  putFieldVersion(row: FieldVersionRow): void {
    this.state.fieldVersions[fieldKey(row.objectType, row.portalId, row.field)] = row;
  }

  // -------------------------------------------------------- history and log

  /** Append a permanent history row. Never updated, never deleted. */
  appendFieldChange(row: Omit<FieldChangeRow, "seq" | "appliedAtMs">): FieldChangeRow {
    const full: FieldChangeRow = {
      ...row,
      seq: this.state.nextSeq++,
      appliedAtMs: this.nowMs(),
    };
    this.state.fieldChanges.push(full);
    return full;
  }

  /** Append an operational observation: an echo, a confirmation, a restatement. */
  appendObservation(row: Omit<ObservationRow, "seq" | "observedAtMs">): void {
    this.state.observations.push({
      ...row,
      seq: this.state.nextSeq++,
      observedAtMs: this.nowMs(),
    });
  }

  /** Permanent history for one record, oldest first. */
  historyFor(objectType: ObjectType, portalId: string): readonly FieldChangeRow[] {
    return this.state.fieldChanges.filter(
      (c) => c.objectType === objectType && c.portalId === portalId,
    );
  }

  // ------------------------------------------------------- inbound dedupe

  /**
   * Claim an event id, in the same transaction as the apply (design 8.1).
   *
   * Returns `"claimed"` on the first sight of this event and `"duplicate"`
   * when we have seen it. `"conflict"` means the same id arrived with a
   * different payload, which is a provider bug worth alerting on, because the
   * key we are trusting is not unique.
   */
  claimEvent(
    row: Omit<InboundEventRow, "receivedAtMs" | "outcome">,
  ): "claimed" | "duplicate" | "conflict" {
    const existing = this.state.inboundEvents[row.eventId];
    if (existing) {
      return existing.payloadHash === row.payloadHash ? "duplicate" : "conflict";
    }
    this.state.inboundEvents[row.eventId] = {
      ...row,
      outcome: "rejected",
      receivedAtMs: this.nowMs(),
    };
    return "claimed";
  }

  /** Record how a claimed event turned out. */
  setEventOutcome(eventId: string, outcome: InboundEventRow["outcome"]): void {
    const row = this.state.inboundEvents[eventId];
    if (!row) {
      throw new StoreReadError(`event ${eventId} was never claimed`);
    }
    row.outcome = outcome;
  }

  // -------------------------------------------------------- outbound queue

  /**
   * Enqueue one outbound call.
   *
   * Stands in for the design's partial unique index on
   * `(object_type, portal_id, field) WHERE state = 'pending'`: at most one
   * pending row per field, so an echo arriving beside an already-queued repair
   * cannot pile up a second one (design 4, Appendix B step 5). Returns false
   * when a pending row already existed.
   */
  enqueueOutbound(args: {
    objectType: ObjectType;
    portalId: string;
    field: string;
    reason: OutboundReason;
    occurredAtMs: number;
  }): boolean {
    const already = this.state.outbound.some(
      (r) =>
        r.state === "pending" &&
        r.objectType === args.objectType &&
        r.portalId === args.portalId &&
        r.field === args.field,
    );
    if (already) return false;
    this.state.outbound.push({
      id: this.state.nextOutboundId++,
      objectType: args.objectType,
      portalId: args.portalId,
      field: args.field,
      reason: args.reason,
      occurredAtMs: args.occurredAtMs,
      state: "pending",
      attempts: 0,
      nextAttemptAtMs: this.nowMs(),
      createdAtMs: this.nowMs(),
    });
    return true;
  }

  /** Every outbound row, for the worker and for the demo's printed output. */
  outboundRows(): readonly OutboundRow[] {
    return this.state.outbound;
  }

  // ----------------------------------------------------------- echo fences

  /** Record that we just wrote this exact canonical value (design 9.3). */
  addEchoFence(row: EchoFenceRow): void {
    this.state.echoFences.push(row);
  }

  /**
   * Find and consume an unexpired fence for this field and value. Consuming it
   * is what stops one fence from masking a genuine later Salesforce change.
   */
  consumeEchoFence(
    objectType: ObjectType,
    portalId: string,
    field: string,
    valueHash: string,
  ): boolean {
    const now = this.nowMs();
    const i = this.state.echoFences.findIndex(
      (f) =>
        f.objectType === objectType &&
        f.portalId === portalId &&
        f.field === field &&
        f.valueHash === valueHash &&
        f.expiresAtMs > now,
    );
    if (i < 0) return false;
    this.state.echoFences.splice(i, 1);
    return true;
  }

  // ------------------------------------------------------- links, watermark

  /** The link for a Salesforce id, or undefined if we have never seen it (design 5 case (b)). */
  findLinkBySfId(objectType: ObjectType, sfId: string): RecordLinkRow | undefined {
    return this.state.recordLinks.find(
      (l) => l.objectType === objectType && l.sfId === sfId,
    );
  }

  /** The link for one of our own ids. Its `sfId` is null until Salesforce assigns one. */
  findLinkByPortalId(objectType: ObjectType, portalId: string): RecordLinkRow | undefined {
    return this.state.recordLinks.find(
      (l) => l.objectType === objectType && l.portalId === portalId,
    );
  }

  /** Record the Salesforce id a create returned. */
  linkSfId(objectType: ObjectType, portalId: string, sfId: string): void {
    const link = this.findLinkByPortalId(objectType, portalId);
    if (!link) {
      throw new StoreReadError(`no link for ${objectType} ${portalId}`);
    }
    link.sfId = sfId;
    link.linkedAtMs = this.nowMs();
  }

  /** How many repairs this field has had in the last hour — rule L4 (design 9.4). */
  repairsInLastHour(objectType: ObjectType, portalId: string, field: string): number {
    const since = this.nowMs() - 60 * 60 * 1000;
    return this.state.outbound.filter(
      (r) =>
        r.reason === "repair" &&
        r.objectType === objectType &&
        r.portalId === portalId &&
        r.field === field &&
        r.createdAtMs >= since,
    ).length;
  }
}

/**
 * A file-backed store with transactions.
 *
 * Construct one per process. The demo constructs a fresh one in each child
 * process it spawns, which is exactly how it proves that a queued call
 * survives a restart: the second process reads the same file.
 */
export class DurableStore {
  private state: StoreState;

  private constructor(
    private readonly path: string,
    state: StoreState,
    private readonly nowMs: () => number,
  ) {
    this.state = state;
  }

  /**
   * Open the store at `path`, creating an empty one if absent.
   *
   * @throws {StoreReadError} if the file exists but cannot be read or parsed.
   *   Deliberately fatal: continuing with an empty store would silently
   *   discard every queued call, which is the failure this whole design exists
   *   to prevent.
   */
  static open(path: string, nowMs: () => number = () => Date.now()): DurableStore {
    if (!existsSync(path)) {
      const store = new DurableStore(path, emptyState(), nowMs);
      store.persist();
      return store;
    }
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch (cause) {
      throw new StoreReadError(`cannot read store at ${path}`, cause);
    }
    try {
      return new DurableStore(path, JSON.parse(raw) as StoreState, nowMs);
    } catch (cause) {
      throw new StoreReadError(`store at ${path} is not valid JSON`, cause);
    }
  }

  /**
   * Run `body` as one transaction.
   *
   * The body mutates a deep clone. On a clean return the clone is written to
   * disk atomically and becomes the live state; if the body throws, the clone
   * is dropped and the live state is untouched, so nothing is ever
   * half-applied. This is what lets the inbound path claim an event id and
   * apply the change together (design 5) — split across two commits, a crash
   * in between would mark an event processed that was never applied.
   *
   * The error is always re-thrown after the rollback. A transaction that
   * failed must never look like one that succeeded.
   */
  transaction<T>(body: (tx: Tx) => T): T {
    const draft = structuredClone(this.state);
    const tx = new Tx(draft, this.nowMs);
    // No try/catch around the body on purpose. The rollback IS the throw: if
    // `body` raises, this assignment never happens, `this.state` is never
    // replaced, and the draft is discarded by going out of scope. Catching
    // only to re-throw would add a line that reads like it handles something
    // and does not. The caller sees the original error and decides whether it
    // is a 400, a 500, or a failed send.
    const result: T = body(tx);
    const previous = this.state;
    this.state = draft;
    try {
      this.persist();
    } catch (error) {
      this.state = previous; // keep memory and disk in agreement
      throw error;
    }
    return result;
  }

  /** Read-only view, for assertions and printed output. */
  read<T>(body: (tx: Tx) => T): T {
    return body(new Tx(this.state, this.nowMs));
  }

  /**
   * Write the state atomically: temp file, then rename.
   *
   * @throws {StoreWriteError} on any failure, with the cause attached. A
   *   swallowed write failure here would be the worst bug in the program —
   *   the queue would look drained while the calls were never recorded.
   */
  private persist(): void {
    const tmp = `${this.path}.tmp`;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(tmp, JSON.stringify(this.state, null, 2), "utf8");
      renameSync(tmp, this.path);
    } catch (cause) {
      try {
        if (existsSync(tmp)) unlinkSync(tmp);
      } catch (cleanupFailure) {
        // Cleanup is best-effort, but it is still reported rather than
        // discarded: a stray temp file is worth knowing about.
        process.emitWarning(
          `could not remove temp store file ${tmp}: ${String(cleanupFailure)}`,
        );
      }
      throw new StoreWriteError(`cannot write store at ${this.path}`, cause);
    }
  }
}

/** Default on-disk location for the demo's state. */
export function defaultStatePath(dir = ".demo-state"): string {
  return join(dir, "store.json");
}
