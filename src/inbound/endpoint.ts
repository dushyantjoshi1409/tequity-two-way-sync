/**
 * The webhook endpoint: one HTTP request becomes one database transaction
 * (design 5).
 *
 * Four properties of this module are deliberate and are the reason it looks
 * the way it does:
 *
 * 1. **The duplicate claim and the apply share one transaction.** Split them
 *    and a crash in between marks an event processed that was never applied —
 *    and Salesforce will never resend it, because assumption A7 only promises
 *    redelivery while we have not yet answered 200. This is the single most
 *    important line in the path.
 * 2. **No network call happens inside the transaction.** That keeps the
 *    endpoint fast and stops a Salesforce outage turning into held locks.
 * 3. **Fields are independent.** One event can apply `phone` while
 *    superseding `city`; the event's outcome is then `partial`.
 * 4. **The 200 is returned only after the commit.** We never answer
 *    "accepted, will process later", because that is a promise with no
 *    durable record of having been made.
 */

import { randomUUID } from "node:crypto";

import { applyChanges } from "../domain/merge.js";
import { canonicalise } from "../domain/canonical.js";
import { WebhookRejected } from "../domain/types.js";
import type { AppliedField, EventOutcome } from "../domain/types.js";
import { INTEGRATION_USER } from "../salesforce/client.js";
import { sha256 } from "../store/store.js";
import type { DurableStore, Tx } from "../store/store.js";
import { validateWebhook } from "./validate.js";
import type { ValidWebhook } from "./validate.js";

/** What the endpoint answers. Mirrors the status table in Appendix C.1. */
export interface WebhookResponse {
  readonly status: 200 | 400 | 500 | 503;
  readonly body: {
    readonly status: EventOutcome | "error";
    readonly reason?: string;
    readonly fields?: readonly AppliedField[];
    readonly retryAfterSeconds?: number;
  };
}

/** How long an unresolvable create echo may defer before we give up (design 5). */
const CREATE_ECHO_DEFER_LIMIT_MS = 60_000;

/** How long an echo fence stays valid (design 9.3). */
export const ECHO_FENCE_TTL_MS = 15 * 60 * 1000;

/**
 * Handle one webhook body.
 *
 * Signature verification is the caller's job (see `verifySignature`), because
 * it needs the raw bytes and the headers; this function owns everything from
 * validation inward.
 *
 * Never throws for bad input: every refusal comes back as a
 * {@link WebhookResponse} carrying the status and a specific reason, so the
 * caller — an HTTP server, or the demo — has one thing to print or return.
 * Unexpected failures become a 500, which asks Salesforce to retry, and that
 * retry is safe because of the event claim.
 */
export function receiveWebhook(
  store: DurableStore,
  rawBody: string,
  nowMs: () => number = () => Date.now(),
): WebhookResponse {
  let webhook: ValidWebhook;
  try {
    webhook = validateWebhook(rawBody);
  } catch (error) {
    if (error instanceof WebhookRejected) {
      return { status: error.status, body: { status: "error", reason: error.reason } };
    }
    // Not a validation problem, so not the sender's fault: ask for a retry
    // rather than discarding a real edit over our own bug.
    return {
      status: 500,
      body: { status: "error", reason: `unexpected-validation-failure: ${String(error)}` },
    };
  }

  try {
    return store.transaction((tx) => applyWebhook(tx, webhook, nowMs));
  } catch (error) {
    if (error instanceof WebhookRejected) {
      return { status: error.status, body: { status: "error", reason: error.reason } };
    }
    // The transaction rolled back, so nothing was half-applied. A 500 is
    // correct and the retry is safe: the event claim was rolled back with
    // everything else, so the redelivery will be treated as new.
    return {
      status: 500,
      body: { status: "error", reason: `apply-failed: ${String(error)}` },
    };
  }
}

/** The transaction body. Runs entirely inside `store.transaction`. */
function applyWebhook(
  tx: Tx,
  webhook: ValidWebhook,
  nowMs: () => number,
): WebhookResponse {
  // --- step 4 of design 5: claim the event, in this same transaction -------
  const claim = tx.claimEvent({
    eventId: webhook.eventId,
    objectType: webhook.objectType,
    sfId: webhook.recordId,
    occurredAtMs: webhook.occurredAtMs,
    payloadHash: sha256(JSON.stringify(webhook.changedFields)),
  });
  if (claim === "duplicate") {
    // Salesforce has done nothing wrong — A7 permits a second delivery — so
    // this is counted, not alerted, and nothing happens. Note that even if
    // this table were pruned, the strict `>` of design 7.2 would make the
    // re-apply a no-op anyway; suppression saves work, strictness is the
    // guarantee (design 8.1).
    return { status: 200, body: { status: "duplicate" } };
  }
  if (claim === "conflict") {
    // The same eventId with a different payload means the key we are trusting
    // is not unique. First write wins, and unlike an ordinary duplicate this
    // one IS alerted (design 8.1): a duplicate means Salesforce did what A7
    // permits, while this means every idempotence guarantee keyed on `eventId`
    // is suspect.
    process.emitWarning(
      `ALERT: eventId ${webhook.eventId} was reused with a different payload; ` +
        `first write wins and this delivery was discarded`,
    );
    return {
      status: 200,
      body: { status: "duplicate", reason: "eventId-reused-with-different-payload" },
    };
  }

  // --- step 5: resolve and lock the record --------------------------------
  const resolved = resolveRecord(tx, webhook, nowMs);
  if (resolved.kind === "defer") {
    return {
      status: 503,
      body: { status: "error", reason: resolved.reason, retryAfterSeconds: 5 },
    };
  }
  const portalId = resolved.portalId;

  // --- step 6: classify the whole event as echo or not (design 9.2, 9.3) --
  const isEcho = classifyEcho(tx, webhook, portalId);

  // --- step 7: the per-field rules live in the merge ----------------------
  const fields = applyChanges(tx, {
    objectType: webhook.objectType,
    portalId,
    origin: "salesforce",
    actor: webhook.changedBy,
    occurredAtMs: webhook.occurredAtMs,
    originEventId: webhook.eventId,
    rawChanges: webhook.changedFields,
    isEcho,
  });

  // --- step 8: record how the event turned out ----------------------------
  const outcome = summarise(fields, isEcho);
  tx.setEventOutcome(webhook.eventId, outcome);
  return { status: 200, body: { status: outcome, fields } };
}

type Resolved =
  | { kind: "resolved"; portalId: string }
  | { kind: "defer"; reason: string };

/**
 * Design 5's three cases.
 *
 * Case (c) is the subtle one: the echo of a create *we* made can arrive before
 * we have recorded the Salesforce id that create returned. Treating it as a
 * new record would mint a second local record for one real contact, so instead
 * we answer 503 and ask Salesforce to tell us again in a moment, borrowing the
 * redelivery we already assume (A7) rather than adding a holding table or
 * making a Salesforce call inside the transaction.
 *
 * It is narrowed to the integration user on purpose. Deferring whenever *any*
 * create is in flight would delay legitimate Salesforce creates by five
 * seconds most of the time, spending the latency budget to fix a race that
 * only involves our own writes.
 */
function resolveRecord(tx: Tx, webhook: ValidWebhook, nowMs: () => number): Resolved {
  const link = tx.findLinkBySfId(webhook.objectType, webhook.recordId);
  if (link) return { kind: "resolved", portalId: link.portalId };

  if (webhook.changedBy === INTEGRATION_USER) {
    // Is there a create of ours still waiting for its Salesforce id?
    const unlinked = tx.state.recordLinks.find(
      (l) => l.objectType === webhook.objectType && l.sfId === null,
    );
    if (unlinked) {
      // The age of the link row, not `linkedAtMs`, which is unset for exactly
      // these unlinked rows and would make this bound unreachable.
      const waitedMs = nowMs() - unlinked.createdAtMs;
      if (waitedMs < CREATE_ECHO_DEFER_LIMIT_MS) {
        return { kind: "defer", reason: "create-echo-before-link" };
      }
      // Bounded: past the limit we stop deferring, log loudly, and fall
      // through to case (b), letting the unique index and a reconciliation
      // sweep catch the duplicate. A visible, repairable outcome beats a stall.
      process.emitWarning(
        `create echo for ${webhook.recordId} unresolvable after ${waitedMs}ms; treating as a Salesforce-side create`,
      );
    }
  }

  // Case (b): a record created in Salesforce that we have not seen. Mint an
  // id, link it, and let the merge apply every field as a first write. Outage
  // recovery reuses exactly this path (design 10.3).
  const portalId = randomUUID();
  tx.createRecord(webhook.objectType, portalId, webhook.recordId);
  return { kind: "resolved", portalId };
}

/**
 * Rules L2 and L3 of design 9.
 *
 * L2 (the actor check) is the primary rule and catches essentially every echo,
 * because every call we make is made as the one integration login. It is
 * load-bearing rather than tidy: the echo of our own write carries the time
 * Salesforce stored it, which is later than the edit that write overwrote, so
 * compared as a change it would win and launder our value back over a newer
 * edit from the other side (Appendix B).
 *
 * L3 (the fence) is the same guarantee keyed on the value rather than the
 * actor, so it still holds if assumption A6 is false.
 *
 * **One simplification against the design:** the design's fence is per field,
 * while `applyChanges` takes one classification for the event, so here an
 * event counts as an echo only if *every* changed field matches an unexpired
 * fence. That is strictly more conservative — it never classifies a real
 * change as an echo — and it preserves L3's guarantee for the single-field
 * writes the sender actually makes, since coalescing sends one record at a
 * time and the fence is written per field sent.
 */
function classifyEcho(tx: Tx, webhook: ValidWebhook, portalId: string): boolean {
  if (webhook.changedBy === INTEGRATION_USER) return true;

  const fields = Object.keys(webhook.changedFields);
  let matched = 0;
  for (const field of fields) {
    const raw = webhook.changedFields[field] ?? null;
    // Canonical form, because the fence stores the hash of what we SENT, and
    // Salesforce may have reformatted it on the way back (design 7.3).
    const canonical = canonicalise(webhook.objectType, field, raw);
    if (
      tx.consumeEchoFence(
        webhook.objectType,
        portalId,
        field,
        sha256(String(canonical)),
      )
    ) {
      matched += 1;
    }
  }
  return matched > 0 && matched === fields.length;
}

/** Collapse the per-field outcomes into the event's own outcome. */
function summarise(fields: readonly AppliedField[], isEcho: boolean): EventOutcome {
  if (isEcho) return "echo";
  if (fields.length === 0) return "applied";
  const kinds = new Set(fields.map((f) => f.outcome));
  if (kinds.size === 1) {
    const only = [...kinds][0];
    if (only === "applied") return "applied";
    if (only === "superseded") return "superseded";
    if (only === "restatement") return "restatement";
    if (only === "echo") return "echo";
    // `confirmed`: every field already held the incoming value, so nothing
    // changed. Recorded as `confirmed` rather than rounded up to `applied`,
    // for the same reason design 5 keeps it out of `field_change` — an event
    // that changed nothing must not read as one that changed something.
    if (only === "confirmed") return "confirmed";
    return "applied";
  }
  // Mixed outcomes are exactly what design 5's "fields are independent"
  // property produces, and the event records that honestly rather than
  // rounding to the best or worst field.
  return "partial";
}


