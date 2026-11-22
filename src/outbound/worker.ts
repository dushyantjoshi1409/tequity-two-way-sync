/**
 * The sync worker: drains the durable queue to Salesforce under the rate
 * governor (design 6.2 to 6.5).
 *
 * Three things here are the reason a 6-hour outage and a process restart are
 * both survivable, and each is easy to get wrong:
 *
 * 1. **The sender reads each field's current value at send time**, never a
 *    value carried on the queue row. A city edit at 09:00 and another at
 *    11:00 during an outage then cost one call carrying the 11:00 value,
 *    instead of two calls with a window where Salesforce holds something we
 *    superseded two hours earlier (design 6.3).
 * 2. **A successful send updates `sfValue`.** Our own write is the most recent
 *    thing we know about Salesforce's state — more recent than a webhook
 *    describing an edit that happened before it. Appendix B traces the silent
 *    divergence that omitting this causes, and it is the bug that trace found.
 * 3. **An endpoint failure is not a row failure.** A refused connection says
 *    nothing about the row, so the row's attempt is given back and the circuit
 *    breaker counts it instead. Without that split, ten attempts at a
 *    five-minute backoff is under an hour, so every queued row would mark
 *    itself `failed` during the second hour of a six-hour outage — the backlog
 *    would destroy itself while waiting.
 */

import { fieldNames } from "../domain/fields.js";
import type { ObjectType } from "../domain/types.js";
import {
  SalesforceAuthFailed,
  SalesforceRejected,
  SalesforceServerError,
  SalesforceThrottled,
  SalesforceUnreachable,
} from "../salesforce/client.js";
import type { SalesforceClient } from "../salesforce/client.js";
import { sha256 } from "../store/store.js";
import type { DurableStore, Tx } from "../store/store.js";
import type { OutboundRow } from "../store/schema.js";
import { ECHO_FENCE_TTL_MS } from "../inbound/endpoint.js";
import type { RateGovernor } from "./governor.js";

/**
 * How long a claimed row is held before another sender may reclaim it.
 *
 * The design's value. Long enough that a slow call is not stolen from a live
 * sender, short enough that a crash costs at most this much delay on the rows
 * it was holding. The demo passes a much shorter one so the reclaim is visible
 * inside a few seconds, which is the same latitude the exercise grants for the
 * rate cap.
 */
export const LEASE_MS = 30_000;

/** Consecutive endpoint failures before the breaker opens (design 6.4). */
export const BREAKER_THRESHOLD = 5;

/** What one `runOnce` did, for the demo's printed output and for assertions. */
export interface DrainReport {
  readonly claimed: number;
  readonly sent: number;
  readonly skipped: number;
  readonly throttled: number;
  readonly endpointFailures: number;
  readonly rowFailures: number;
  readonly breakerOpen: boolean;
  readonly callsMade: number;
}

/** One record's worth of work, after coalescing. */
interface RecordBatch {
  readonly objectType: ObjectType;
  readonly portalId: string;
  readonly rows: OutboundRow[];
}

/**
 * The sender.
 *
 * One instance per process. In the design exactly one process sends at a time,
 * holding a Postgres advisory lock while others idle as standbys (ADR 0003),
 * because the 100 req/s cap is a single global budget and the cheapest correct
 * way to spend a global budget is from one place. The demo runs one process at
 * a time, so there is no lock here — {@link SyncWorker.reclaimExpiredLeases}
 * is the part of that design that *is* exercised, because it is what lets a
 * restarted process pick up what a killed one left behind.
 */
export class SyncWorker {
  private consecutiveEndpointFailures = 0;
  private breakerOpenUntilMs = 0;
  private stoppedReason?: string;

  constructor(
    private readonly store: DurableStore,
    private readonly salesforce: SalesforceClient,
    private readonly governor: RateGovernor,
    private readonly owner: string,
    private readonly nowMs: () => number = () => Date.now(),
    /** See {@link LEASE_MS}. Overridden by the demo so a reclaim is visible. */
    private readonly leaseMs: number = LEASE_MS,
  ) {}

  /** True while the breaker is open and we are probing rather than draining. */
  get isBreakerOpen(): boolean {
    return this.nowMs() < this.breakerOpenUntilMs;
  }

  /**
   * True once a credential failure has stopped the sender (design 6.5).
   *
   * Deliberately not self-clearing, unlike the breaker: bad credentials are
   * fixed by a person, and retrying on a timer would spend the cap on calls
   * that cannot succeed and bury the page under noise.
   */
  get isStopped(): boolean {
    return this.stoppedReason !== undefined;
  }

  /**
   * Return rows a dead sender left `inflight` once their lease has expired.
   *
   * This is step 1 of the design's loop and the whole reason the row carries a
   * lease rather than a plain claim flag: a restart must be a non-event, with
   * no manual intervention and no reconciliation script.
   */
  reclaimExpiredLeases(): number {
    return this.store.transaction((tx) => {
      let reclaimed = 0;
      const now = this.nowMs();
      for (const row of tx.outboundRows()) {
        if (row.state === "inflight" && (row.leaseUntilMs ?? 0) < now) {
          row.state = "pending";
          row.leaseOwner = undefined;
          row.leaseUntilMs = undefined;
          row.nextAttemptAtMs = now;
          // The attempt is NOT given back here: a row that crashed us mid-send
          // still counts, which is what stops one poison row from crashing us
          // in a loop forever (design 6.2).
          reclaimed += 1;
        }
      }
      return reclaimed;
    });
  }

  /**
   * Claim one batch and send it.
   *
   * Returns a report rather than throwing, because every failure mode here is
   * expected and already has a rule: the caller's job is to print or assert on
   * the outcome, not to handle an exception.
   */
  async runOnce(maxRecords = 200): Promise<DrainReport> {
    this.reclaimExpiredLeases();

    if (this.isStopped) {
      // Stopped on a credential failure. Rows stay `pending` with their
      // attempts intact, so a person fixing the credentials and restarting
      // loses nothing (design 6.5).
      return this.emptyReport();
    }

    if (this.isBreakerOpen) {
      // Probe with a single request instead of claiming (design 6.4).
      return this.probe();
    }

    const batches = this.claim(maxRecords);
    const claimed = batches.reduce((n, b) => n + b.rows.length, 0);
    let sent = 0;
    let skipped = 0;
    let throttled = 0;
    let endpointFailures = 0;
    let rowFailures = 0;
    const callsBefore = this.governor.grantedCount;

    for (const batch of batches) {
      const outcome = await this.sendBatch(batch);
      switch (outcome) {
        case "sent":
          sent += batch.rows.length;
          break;
        case "skipped":
          skipped += batch.rows.length;
          break;
        case "throttled":
          throttled += batch.rows.length;
          break;
        case "endpoint-failure":
          endpointFailures += batch.rows.length;
          break;
        case "row-failure":
          rowFailures += batch.rows.length;
          break;
      }
    }

    return {
      claimed,
      sent,
      skipped,
      throttled,
      endpointFailures,
      rowFailures,
      breakerOpen: this.isBreakerOpen,
      callsMade: this.governor.grantedCount - callsBefore,
    };
  }

  /** A report in which nothing happened. */
  private emptyReport(): DrainReport {
    return {
      claimed: 0,
      sent: 0,
      skipped: 0,
      throttled: 0,
      endpointFailures: 0,
      rowFailures: 0,
      breakerOpen: this.isBreakerOpen,
      callsMade: 0,
    };
  }

  /** Drain until nothing is due, or `maxPasses` is reached. */
  async drain(maxPasses = 100): Promise<DrainReport> {
    let total: DrainReport = { ...this.emptyReport(), breakerOpen: false };
    for (let pass = 0; pass < maxPasses; pass += 1) {
      const report = await this.runOnce();
      total = {
        claimed: total.claimed + report.claimed,
        sent: total.sent + report.sent,
        skipped: total.skipped + report.skipped,
        throttled: total.throttled + report.throttled,
        endpointFailures: total.endpointFailures + report.endpointFailures,
        rowFailures: total.rowFailures + report.rowFailures,
        breakerOpen: report.breakerOpen,
        callsMade: total.callsMade + report.callsMade,
      };
      if (report.claimed === 0 && !report.breakerOpen) break;
      if (report.breakerOpen) break;
    }
    return total;
  }

  /** How many rows are still pending, for printed output. */
  pendingCount(): number {
    return this.store.read((tx) =>
      tx.outboundRows().filter((r) => r.state === "pending").length,
    );
  }

  // -------------------------------------------------------------- internals

  /**
   * Claim whole records, oldest-due first.
   *
   * Whole records, because all the fields owed on one record become one call
   * (design 6.3). Oldest-due first, because ordering by anything else can
   * starve a row that keeps losing to newer work.
   */
  private claim(maxRecords: number): RecordBatch[] {
    return this.store.transaction((tx) => {
      const now = this.nowMs();
      const due = tx
        .outboundRows()
        .filter((r) => r.state === "pending" && r.nextAttemptAtMs <= now);

      const byRecord = new Map<string, OutboundRow[]>();
      for (const row of due) {
        const key = `${row.objectType}:${row.portalId}`;
        const list = byRecord.get(key);
        if (list) list.push(row);
        else byRecord.set(key, [row]);
      }

      const ordered = [...byRecord.entries()]
        .sort((a, b) => {
          const aDue = Math.min(...a[1].map((r) => r.nextAttemptAtMs));
          const bDue = Math.min(...b[1].map((r) => r.nextAttemptAtMs));
          return aDue - bDue || a[0].localeCompare(b[0]);
        })
        .slice(0, maxRecords);

      const batches: RecordBatch[] = [];
      for (const [, rows] of ordered) {
        const first = rows[0];
        if (!first) continue;
        for (const row of rows) {
          row.state = "inflight";
          row.leaseOwner = this.owner;
          row.leaseUntilMs = now + this.leaseMs;
          row.attempts += 1; // incremented on CLAIM, not on failure
        }
        batches.push({
          objectType: first.objectType,
          portalId: first.portalId,
          rows,
        });
      }
      return batches;
    });
  }

  /**
   * Build and send one record's call, then settle every row in the batch.
   *
   * The values are read here, at send time, from the current-state table — not
   * from the queue rows, which carry no value at all.
   */
  private async sendBatch(
    batch: RecordBatch,
  ): Promise<"sent" | "skipped" | "throttled" | "endpoint-failure" | "row-failure"> {
    const plan = this.store.read((tx) => this.planCall(tx, batch));

    if (plan.kind === "nothing-owed") {
      // Design 10.3's claim-time filter: the sweep (or an earlier send) has
      // already brought Salesforce into line, so condition (d) says nothing is
      // owed and the row would spend a request to change nothing.
      this.settle(batch, (row) => {
        row.state = "sent";
        row.sentAtMs = this.nowMs();
        // `lastError` stays clear: this row succeeded by not needing a call,
        // and anyone querying `last_error` for trouble should not find
        // routine skips in it.
        row.lastError = undefined;
      });
      return "skipped";
    }

    // One token per request, retries included, because the cap counts the
    // calls we make (design 6.4).
    await this.governor.acquire();

    // Only the call itself is inside the try. A store failure is not an
    // endpoint failure: counting one toward the breaker would let a disk
    // problem stop us talking to a Salesforce that is perfectly healthy, and
    // would report the wrong cause to the caller. Store errors are surfaced,
    // never swallowed, so the write below is deliberately outside it.
    let assignedSfId: string | undefined;
    try {
      if (plan.sfId === null) {
        const { sfId } = await this.salesforce.upsertByExternalId(
          batch.objectType,
          batch.portalId,
          plan.values,
        );
        assignedSfId = sfId;
      } else {
        await this.salesforce.update(batch.objectType, plan.sfId, plan.values);
      }
    } catch (error) {
      return this.settleFailure(batch, error);
    }

    // The call landed. Recording the id it returned may still fail, and that
    // error propagates: the rows stay `inflight`, their lease expires, and
    // reclaim retries the upsert — which is safe precisely because it is
    // idempotent on our own `portalId` (A5, C.1).
    if (assignedSfId !== undefined) {
      const sfId = assignedSfId;
      this.store.transaction((tx) => tx.linkSfId(batch.objectType, batch.portalId, sfId));
    }

    // Success. The order of these three matters and they all happen AFTER the
    // response: a fence or an sfValue for a call that did not land would
    // suppress a real Salesforce change (design 6.3).
    this.consecutiveEndpointFailures = 0;
    this.governor.onSuccess();
    this.store.transaction((tx) => {
      const now = this.nowMs();
      // Only the batch's own rows, even on a create, where the call carried
      // every field. A field we sent but did not owe keeps its unknown
      // `sf_value`, which condition 8.3 reads as a disagreement — so the worst
      // case is one redundant call that confirms what Salesforce already has,
      // never a missed one. Erring toward an extra call is the safe direction.
      for (const row of batch.rows) {
        const value = plan.values[row.field] ?? null;
        const fv = tx.getFieldVersion(batch.objectType, batch.portalId, row.field);
        if (fv) {
          // (2) in the module docstring: our own write is now the most recent
          // thing we know about Salesforce's state.
          fv.sfValue = value;
          fv.sfObservedAtMs = now;
        }
        tx.addEchoFence({
          objectType: batch.objectType,
          portalId: batch.portalId,
          field: row.field,
          valueHash: sha256(String(value)),
          sentAtMs: now,
          expiresAtMs: now + ECHO_FENCE_TTL_MS,
        });
      }
      for (const live of tx.outboundRows()) {
        if (batch.rows.some((r) => r.id === live.id)) {
          live.state = "sent";
          live.sentAtMs = now;
          live.leaseOwner = undefined;
          live.leaseUntilMs = undefined;
        }
      }
    });
    return "sent";
  }

  /** Decide what to send for one record, or that nothing is owed. */
  private planCall(
    tx: Tx,
    batch: RecordBatch,
  ):
    | { kind: "call"; sfId: string | null; values: Record<string, string | null> }
    | { kind: "nothing-owed" } {
    const record = tx.getRecord(batch.objectType, batch.portalId);
    if (!record) {
      // The row references a record that does not exist. Not retryable, and
      // not silently ignorable either — it is a bug worth seeing.
      throw new Error(
        `outbound row for missing ${batch.objectType} ${batch.portalId}`,
      );
    }
    const values: Record<string, string | null> = {};
    let owed = false;
    for (const row of batch.rows) {
      const current = record.values[row.field] ?? null;
      const fv = tx.getFieldVersion(batch.objectType, batch.portalId, row.field);
      values[row.field] = current;
      if (fv?.sfValue === undefined || fv.sfValue !== current) owed = true;
    }
    if (!owed) return { kind: "nothing-owed" };
    const link = tx.findLinkByPortalId(batch.objectType, batch.portalId);
    // A record created in the portal has no Salesforce id yet, so it goes
    // through the external-id upsert, which is idempotent on OUR id (A5).
    const sfId = link?.sfId ?? null;
    if (sfId === null) {
      // A create must carry every field we hold, not only the owed ones.
      for (const field of fieldNames(batch.objectType)) {
        values[field] = record.values[field] ?? null;
      }
    }
    return { kind: "call", sfId, values };
  }

  /**
   * Apply the design 6.5 settle table.
   *
   * The split between an endpoint failure and a row failure is the one thing
   * in this method that must not be simplified — see (3) in the module
   * docstring.
   */
  private settleFailure(
    batch: RecordBatch,
    error: unknown,
  ): "throttled" | "endpoint-failure" | "row-failure" {
    const now = this.nowMs();

    if (error instanceof SalesforceThrottled) {
      // Slow down, and keep the work. Nothing is dropped: the row goes back to
      // pending with a later due time and its attempt restored, because being
      // throttled was not this row's fault.
      this.governor.onThrottled();
      const delay = error.retryAfterMs ?? this.backoffMs(batch);
      this.settle(batch, (row) => {
        row.state = "pending";
        row.attempts = Math.max(0, row.attempts - 1);
        row.nextAttemptAtMs = now + delay;
        row.leaseOwner = undefined;
        row.leaseUntilMs = undefined;
        row.lastError = `429: ${error.message}`;
      });
      return "throttled";
    }

    if (error instanceof SalesforceUnreachable || error instanceof SalesforceServerError) {
      // An endpoint failure says nothing about the row.
      this.consecutiveEndpointFailures += 1;
      if (this.consecutiveEndpointFailures >= BREAKER_THRESHOLD) {
        this.breakerOpenUntilMs = now + 30_000;
      }
      this.settle(batch, (row) => {
        row.state = "pending";
        row.attempts = Math.max(0, row.attempts - 1); // the attempt is given back
        row.nextAttemptAtMs = now + this.backoffMs(batch);
        row.leaseOwner = undefined;
        row.leaseUntilMs = undefined;
        row.lastError = `endpoint: ${String(error)}`;
      });
      return "endpoint-failure";
    }

    if (error instanceof SalesforceRejected) {
      // A row failure: a value the portal accepts and Salesforce refuses is a
      // schema disagreement a human must settle, so it is marked failed and
      // alerted rather than retried into the cap. The row is never deleted —
      // it keeps its lastError as the record that something needs a person.
      this.settle(batch, (row) => {
        row.state = "failed";
        row.leaseOwner = undefined;
        row.leaseUntilMs = undefined;
        row.lastError = `rejected: ${error.message}`;
      });
      process.emitWarning(
        `ALERT: Salesforce refused ${batch.objectType} ${batch.portalId}: ${error.message}`,
      );
      return "row-failure";
    }

    if (error instanceof SalesforceAuthFailed) {
      // Design 6.5's 401/403 row: keep the work, restore the attempt, and stop
      // the sender rather than letting every remaining row burn an attempt on
      // a call that cannot succeed. This one pages.
      this.stoppedReason = String(error);
      this.settle(batch, (row) => {
        row.state = "pending";
        row.attempts = Math.max(0, row.attempts - 1);
        row.nextAttemptAtMs = now;
        row.leaseOwner = undefined;
        row.leaseUntilMs = undefined;
        row.lastError = `auth: ${error.message}`;
      });
      process.emitWarning(
        `PAGE: Salesforce refused our credentials (${error.message}); sender stopped ` +
          `with work preserved`,
      );
      return "endpoint-failure";
    }

    // An error we did not anticipate. Treated as an endpoint failure, which is
    // the conservative choice because it keeps the work, and re-reported as a
    // warning so it cannot pass unnoticed. Never swallowed.
    this.consecutiveEndpointFailures += 1;
    this.settle(batch, (row) => {
      row.state = "pending";
      row.attempts = Math.max(0, row.attempts - 1);
      row.nextAttemptAtMs = now + this.backoffMs(batch);
      row.leaseOwner = undefined;
      row.leaseUntilMs = undefined;
      row.lastError = `unexpected: ${String(error)}`;
    });
    process.emitWarning(`unexpected send failure, work kept: ${String(error)}`);
    return "endpoint-failure";
  }

  /** Exponential backoff with jitter, capped at five minutes (design 6.4). */
  private backoffMs(batch: RecordBatch): number {
    const attempts = Math.max(...batch.rows.map((r) => r.attempts), 1);
    const base = Math.min(2 ** attempts * 1000, 300_000);
    return Math.floor(base * (0.5 + Math.random() * 0.5));
  }

  /** Mutate the live rows matching this batch, inside one transaction. */
  private settle(batch: RecordBatch, mutate: (row: OutboundRow) => void): void {
    this.store.transaction((tx) => {
      for (const live of tx.outboundRows()) {
        if (batch.rows.some((r) => r.id === live.id)) mutate(live);
      }
    });
  }

  /** The breaker's single probe: one cheap call to see whether the link is back. */
  private async probe(): Promise<DrainReport> {
    const callsBefore = this.governor.grantedCount;
    await this.governor.acquire();
    try {
      await this.salesforce.queryChangedSince("Contact", Number.MAX_SAFE_INTEGER, 1);
      // Closed. Resume at half rate and ramp, which is what the outage
      // arithmetic in design 10.4 charges for.
      this.consecutiveEndpointFailures = 0;
      this.breakerOpenUntilMs = 0;
      this.governor.resumeAtHalfRate();
    } catch (error) {
      this.breakerOpenUntilMs = this.nowMs() + 30_000;
      process.emitWarning(`breaker still open: ${String(error)}`);
    }
    return {
      claimed: 0,
      sent: 0,
      skipped: 0,
      throttled: 0,
      endpointFailures: 0,
      rowFailures: 0,
      breakerOpen: this.isBreakerOpen,
      callsMade: this.governor.grantedCount - callsBefore,
    };
  }
}
