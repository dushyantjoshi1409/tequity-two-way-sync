/**
 * A self-contained world for one scenario: a fresh store, a fresh fake
 * Salesforce, and the glue that carries a webhook from one to the other.
 *
 * Each scenario gets its own directory under `.demo-state/`, so scenarios
 * cannot contaminate each other and any one of them can be re-run alone while
 * debugging.
 */

import { rmSync } from "node:fs";
import { join } from "node:path";

import { receiveWebhook } from "../inbound/endpoint.js";
import type { WebhookResponse } from "../inbound/endpoint.js";
import { signBody, verifySignature } from "../inbound/validate.js";
import { savePortalEdit } from "../portal/save.js";
import type { PortalSave, PortalSaveResult } from "../portal/save.js";
import { RateGovernor } from "../outbound/governor.js";
import type { GovernorClock } from "../outbound/governor.js";
import { SyncWorker } from "../outbound/worker.js";
import { FakeSalesforce, defaultFakePath } from "../salesforce/fake.js";
import type { EmittedWebhook } from "../salesforce/fake.js";
import { DurableStore, defaultStatePath } from "../store/store.js";

/** The shared secret Salesforce signs with (assumption A7). */
export const WEBHOOK_SECRET = "demo-shared-secret";

export interface WorldOptions {
  /** Scenario name; also the state directory. */
  readonly name: string;
  /** Requests per second the governor allows. The demo uses a low number. */
  readonly ceilingPerSecond?: number;
  /** Lease duration, shortened so a reclaim is visible. */
  readonly leaseMs?: number;
  /** Start from empty state. False when a scenario resumes after a restart. */
  readonly fresh?: boolean;
  /**
   * How long a clean run must last before the governor steps its rate back up
   * (design 6.4 uses 30 s). Most scenarios want this short so they do not
   * wait; the rate-cap scenario wants it long, because a fast recovery would
   * step the rate back to the ceiling before the scenario can observe that a
   * 429 halved it.
   */
  readonly recoveryStepMs?: number;
}

/** Everything a scenario needs. */
export class World {
  readonly store: DurableStore;
  readonly salesforce: FakeSalesforce;
  readonly governor: RateGovernor;
  readonly worker: SyncWorker;
  readonly dir: string;

  private constructor(options: WorldOptions, dir: string) {
    this.dir = dir;
    this.store = DurableStore.open(join(dir, "store.json"));
    this.salesforce = FakeSalesforce.open(defaultFakePath(dir));
    const clock: GovernorClock = {
      nowMs: () => Date.now(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    };
    this.governor = new RateGovernor({
      ceilingPerSecond: options.ceilingPerSecond ?? 1000,
      floorPerSecond: 1,
      increasePerStep: 5,
      recoveryStepMs: options.recoveryStepMs ?? 200,
      clock,
    });
    this.worker = new SyncWorker(
      this.store,
      this.salesforce,
      this.governor,
      `demo-${process.pid}`,
      () => Date.now(),
      options.leaseMs ?? 30_000,
    );
  }

  /** Build a world, wiping its directory first unless resuming. */
  static create(options: WorldOptions): World {
    const dir = join(".demo-state", options.name);
    if (options.fresh !== false) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch (cause) {
        // Reported rather than ignored: a scenario starting from stale state
        // would produce output that cannot be trusted.
        throw new Error(`cannot reset demo state at ${dir}: ${String(cause)}`);
      }
    }
    return new World(options, dir);
  }

  /** The store path, for a child process to open the same state. */
  get storePath(): string {
    return defaultStatePath(this.dir);
  }

  /**
   * Deliver one webhook to our endpoint, exactly as Salesforce would: serialise
   * it, sign the raw bytes, verify the signature, then hand the raw body to
   * the handler.
   *
   * The signature is verified here rather than skipped, so the demo exercises
   * design 5's step 2 even though it is not one of the four rules on show.
   */
  deliver(event: EmittedWebhook): WebhookResponse {
    const rawBody = JSON.stringify({
      eventId: event.eventId,
      recordId: event.recordId,
      objectType: event.objectType,
      occurredAt: new Date(event.occurredAtMs).toISOString(),
      changedBy: event.changedBy,
      changedFields: event.changedFields,
    });
    verifySignature(rawBody, signBody(rawBody, WEBHOOK_SECRET), WEBHOOK_SECRET);
    return receiveWebhook(this.store, rawBody);
  }

  /** Deliver a hand-built raw body, for the validation checks. */
  deliverRaw(rawBody: string): WebhookResponse {
    return receiveWebhook(this.store, rawBody);
  }

  /** A finance or customer-success user saves the portal form. */
  save(save: PortalSave): PortalSaveResult {
    return savePortalEdit(this.store, save);
  }

  /** The current values the portal would show. */
  portalValues(objectType: PortalSave["objectType"], portalId: string) {
    return this.store.read((tx) => ({ ...(tx.getRecord(objectType, portalId)?.values ?? {}) }));
  }

  /** Permanent history for one record, oldest first. */
  history(objectType: PortalSave["objectType"], portalId: string) {
    return this.store.read((tx) => tx.historyFor(objectType, portalId).map((r) => ({ ...r })));
  }

  /** Every outbound row, for printed output. */
  outbound() {
    return this.store.read((tx) => tx.outboundRows().map((r) => ({ ...r })));
  }
}
