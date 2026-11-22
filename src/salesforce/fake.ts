/**
 * A fake Salesforce, written for this demo. Nothing here talks to a network.
 *
 * It is the second adapter at the {@link SalesforceClient} seam, and it exists
 * to make four behaviours of the real thing reproducible:
 *
 * 1. **It echoes.** Every write — ours or a sales user's — appends a webhook
 *    to {@link FakeSalesforce.drainWebhooks}'s outbox, stamped with the fake's
 *    own clock and attributed to whoever made it. Our own writes come back
 *    attributed to the integration user, which is the echo the loop rule has
 *    to survive (design 9.2).
 * 2. **It can be unreachable**, which is the 6-hour outage of design 10.
 * 3. **It can tell us to slow down**, which is assumption A8's 429.
 * 4. **It can refuse a record's data**, which is the row failure of design 6.5.
 *
 * Its state lives in its own JSON file, so a demo that kills and restarts a
 * process finds the fake exactly as it left it — including whether it is down.
 * That is what makes the restart scenario real rather than simulated.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { StoreReadError, StoreWriteError } from "../domain/types.js";
import type { ObjectType } from "../domain/types.js";
import type { ChangedRecord, SalesforceClient } from "./client.js";
import {
  INTEGRATION_USER,
  SalesforceRejected,
  SalesforceThrottled,
  SalesforceUnreachable,
} from "./client.js";

/** A webhook the fake has emitted and we have not yet delivered. */
export interface EmittedWebhook {
  readonly eventId: string;
  readonly recordId: string;
  readonly objectType: ObjectType;
  /** The fake's own clock — a different clock from ours (design 7.6). */
  readonly occurredAtMs: number;
  readonly changedBy: string;
  readonly changedFields: Record<string, string | null>;
}

interface FakeRecord {
  objectType: ObjectType;
  values: Record<string, string | null>;
  systemModstampMs: number;
  lastModifiedBy: string;
  /** The external id we upserted on, when the record came from the portal. */
  externalId?: string;
}

interface FakeState {
  records: Record<string, FakeRecord>;
  outbox: EmittedWebhook[];
  nextSfId: number;
  nextEventId: number;
  /** True while the record API is unreachable (design 10). */
  down: boolean;
  /** This many of the next calls answer 429 instead of succeeding. */
  throttleNextCalls: number;
  /** Retry-After the fake reports with a 429, in ms. */
  throttleRetryAfterMs: number;
  /** Writes touching this field are refused as invalid data. */
  rejectField: string | null;
  /**
   * Values the fake rewrites on write, to reproduce Salesforce reformatting
   * what we sent. Used to show why canonical form is load-bearing (design 7.3).
   */
  reformat: Record<string, string>;
}

function emptyFakeState(): FakeState {
  return {
    records: {},
    outbox: [],
    nextSfId: 1,
    nextEventId: 1,
    down: false,
    throttleNextCalls: 0,
    throttleRetryAfterMs: 50,
    rejectField: null,
    reformat: {},
  };
}

/** Default on-disk location for the fake's state. */
export function defaultFakePath(dir = ".demo-state"): string {
  return join(dir, "salesforce.json");
}

/**
 * The fake. Construct one per process; it reads and writes its own file, so
 * two processes in sequence see one Salesforce.
 */
export class FakeSalesforce implements SalesforceClient {
  private state: FakeState;

  private constructor(
    private readonly path: string,
    state: FakeState,
    private readonly nowMs: () => number,
  ) {
    this.state = state;
  }

  /**
   * Open the fake's state, creating it if absent.
   *
   * @throws {StoreReadError} if the file exists but cannot be read or parsed.
   *   Fatal on purpose: silently starting from an empty Salesforce would make
   *   the demo's output a lie.
   */
  static open(path: string, nowMs: () => number = () => Date.now()): FakeSalesforce {
    if (!existsSync(path)) {
      const fake = new FakeSalesforce(path, emptyFakeState(), nowMs);
      fake.persist();
      return fake;
    }
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch (cause) {
      throw new StoreReadError(`cannot read fake Salesforce at ${path}`, cause);
    }
    try {
      return new FakeSalesforce(path, JSON.parse(raw) as FakeState, nowMs);
    } catch (cause) {
      throw new StoreReadError(`fake Salesforce at ${path} is not valid JSON`, cause);
    }
  }

  // ----------------------------------------------------------- test levers

  /** Take the record API down (design 10's outage) or bring it back up. */
  setDown(down: boolean): void {
    this.state.down = down;
    this.persist();
  }

  /** True while the record API is unreachable. */
  get isDown(): boolean {
    return this.state.down;
  }

  /** Make the next `calls` writes answer 429 with `Retry-After` (A8). */
  throttleNext(calls: number, retryAfterMs = 50): void {
    this.state.throttleNextCalls = calls;
    this.state.throttleRetryAfterMs = retryAfterMs;
    this.persist();
  }

  /** Make writes touching `field` fail as invalid data (a row failure). */
  rejectWritesTo(field: string | null): void {
    this.state.rejectField = field;
    this.persist();
  }

  /**
   * Make the fake rewrite a value on write, the way a real Salesforce
   * reformats a phone number. Used to show that canonical form is what keeps
   * the echo a no-op (design 7.3, 9.1).
   */
  reformatOnWrite(from: string, to: string): void {
    this.state.reformat[from] = to;
    this.persist();
  }

  // ------------------------------------------------------ the sales user's side

  /**
   * A sales user edits a record directly in Salesforce.
   *
   * `atMs` is the time Salesforce puts on the event. The caller passes it
   * explicitly so the demo can produce an out-of-order delivery deliberately
   * rather than hoping for one.
   */
  applyExternalEdit(args: {
    objectType: ObjectType;
    sfId?: string;
    changedFields: Record<string, string | null>;
    actor: string;
    atMs: number;
  }): { sfId: string; event: EmittedWebhook } {
    const sfId = args.sfId ?? this.mintSfId(args.objectType);
    const record = this.state.records[sfId] ?? {
      objectType: args.objectType,
      values: {},
      systemModstampMs: args.atMs,
      lastModifiedBy: args.actor,
    };
    for (const [field, value] of Object.entries(args.changedFields)) {
      record.values[field] = value;
    }
    record.systemModstampMs = args.atMs;
    record.lastModifiedBy = args.actor;
    this.state.records[sfId] = record;
    const event = this.emit(sfId, args.objectType, args.changedFields, args.actor, args.atMs);
    this.persist();
    return { sfId, event };
  }

  /**
   * Take every webhook the fake has emitted and not yet handed over.
   *
   * The demo delivers these to our endpoint, in whatever order it chooses —
   * which is how the out-of-order scenario is produced.
   */
  drainWebhooks(): readonly EmittedWebhook[] {
    const out = this.state.outbox;
    this.state.outbox = [];
    this.persist();
    return out;
  }

  /** What Salesforce currently holds, for the demo's final comparison. */
  recordValues(sfId: string): Readonly<Record<string, string | null>> | undefined {
    return this.state.records[sfId]?.values;
  }

  // -------------------------------------------------- the SalesforceClient seam

  /** @inheritDoc */
  async update(
    objectType: ObjectType,
    sfId: string,
    values: Readonly<Record<string, string | null>>,
  ): Promise<void> {
    this.guardCall(values);
    const record = this.state.records[sfId];
    if (!record) {
      // A 404 from the real thing. Deletes are out of scope (A15), so this is
      // unexpected by definition and is a row failure, not a retry.
      throw new SalesforceRejected(`no ${objectType} record ${sfId}`);
    }
    this.writeValues(record, values);
    record.systemModstampMs = this.nowMs();
    record.lastModifiedBy = INTEGRATION_USER;
    // Salesforce tells us about our own write, which is the echo (design 9.2).
    this.emit(sfId, objectType, record.values, INTEGRATION_USER, record.systemModstampMs, values);
    this.persist();
  }

  /** @inheritDoc */
  async upsertByExternalId(
    objectType: ObjectType,
    portalId: string,
    values: Readonly<Record<string, string | null>>,
  ): Promise<{ sfId: string; created: boolean }> {
    this.guardCall(values);
    const existing = Object.entries(this.state.records).find(
      ([, r]) => r.externalId === portalId && r.objectType === objectType,
    );
    // Idempotent by construction: keyed on OUR identifier, so a repeat updates
    // the record it created rather than making a second one (A5).
    const sfId = existing?.[0] ?? this.mintSfId(objectType);
    const record =
      existing?.[1] ??
      ({
        objectType,
        values: {},
        systemModstampMs: this.nowMs(),
        lastModifiedBy: INTEGRATION_USER,
        externalId: portalId,
      } satisfies FakeRecord);
    this.writeValues(record, values);
    record.systemModstampMs = this.nowMs();
    record.lastModifiedBy = INTEGRATION_USER;
    this.state.records[sfId] = record;
    this.emit(sfId, objectType, record.values, INTEGRATION_USER, record.systemModstampMs, values);
    this.persist();
    return { sfId, created: existing === undefined };
  }

  /** @inheritDoc */
  async queryChangedSince(
    objectType: ObjectType,
    sinceMs: number,
    pageSize: number,
  ): Promise<readonly ChangedRecord[]> {
    // A read, but it still fails when the API is unreachable.
    if (this.state.down) throw new SalesforceUnreachable();
    return Object.entries(this.state.records)
      .filter(([, r]) => r.objectType === objectType && r.systemModstampMs > sinceMs)
      .sort((a, b) => a[1].systemModstampMs - b[1].systemModstampMs)
      .slice(0, pageSize)
      .map(([sfId, r]) => ({
        sfId,
        objectType: r.objectType,
        // Inherently full-record, and stamped with the RECORD's modification
        // time, not each field's — which is why the restatement rule has to be
        // unconditional (design 10.3).
        values: { ...r.values },
        systemModstampMs: r.systemModstampMs,
        lastModifiedBy: r.lastModifiedBy,
      }));
  }

  // -------------------------------------------------------------- internals

  /** The failure levers, checked in the order the real API would hit them. */
  private guardCall(values: Readonly<Record<string, string | null>>): void {
    if (this.state.down) throw new SalesforceUnreachable();
    if (this.state.throttleNextCalls > 0) {
      this.state.throttleNextCalls -= 1;
      this.persist();
      throw new SalesforceThrottled(this.state.throttleRetryAfterMs);
    }
    const rejected = this.state.rejectField;
    if (rejected !== null && Object.prototype.hasOwnProperty.call(values, rejected)) {
      throw new SalesforceRejected(
        `INVALID_FIELD: ${rejected} is not acceptable to Salesforce`,
      );
    }
  }

  /** Apply values, applying any configured reformatting. */
  private writeValues(
    record: FakeRecord,
    values: Readonly<Record<string, string | null>>,
  ): void {
    for (const [field, value] of Object.entries(values)) {
      const rewritten = value !== null ? this.state.reformat[value] : undefined;
      record.values[field] = rewritten ?? value;
    }
  }

  private mintSfId(objectType: ObjectType): string {
    const prefix = objectType === "Contact" ? "003" : "001";
    return `${prefix}1A0000${String(this.state.nextSfId++).padStart(4, "0")}`;
  }

  /**
   * Append a webhook to the outbox.
   *
   * `changedOnly` lets a write report just the fields it touched, which is
   * assumption A3's changed-fields-only shape. Passing the whole record
   * instead produces the full-record shape of design 8.4, and the demo uses
   * both.
   */
  private emit(
    sfId: string,
    objectType: ObjectType,
    allValues: Record<string, string | null>,
    changedBy: string,
    atMs: number,
    changedOnly?: Readonly<Record<string, string | null>>,
  ): EmittedWebhook {
    const source = changedOnly ?? allValues;
    const changedFields: Record<string, string | null> = {};
    for (const field of Object.keys(source)) {
      changedFields[field] = allValues[field] ?? null;
    }
    const event: EmittedWebhook = {
      eventId: `evt_${this.state.nextEventId++}`,
      recordId: sfId,
      objectType,
      occurredAtMs: atMs,
      changedBy,
      changedFields,
    };
    this.state.outbox.push(event);
    return event;
  }

  /**
   * Write the fake's state atomically.
   *
   * @throws {StoreWriteError} with the cause attached. Surfaced rather than
   *   swallowed: if the fake's state did not persist, a later step of the demo
   *   would be reasoning about a Salesforce that does not exist.
   */
  private persist(): void {
    const tmp = `${this.path}.tmp`;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(tmp, JSON.stringify(this.state, null, 2), "utf8");
      renameSync(tmp, this.path);
    } catch (cause) {
      throw new StoreWriteError(`cannot write fake Salesforce at ${this.path}`, cause);
    }
  }
}
