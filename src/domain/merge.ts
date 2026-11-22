/**
 * The merge: what one edit does to one record's fields (design 5, 7, 8).
 *
 * This is the module the exercise is about. Everything else moves data to and
 * from it.
 *
 * **The shape is the design's and must not be rearranged.** Per field, in this
 * order: **learn**, then **restatement**, then **decide**, then **repair**.
 *
 * - **(a) learn** records what Salesforce holds *before* anything is decided
 *   and *regardless* of what is decided. A webhook we reject is not a no-op:
 *   it is the discovery that Salesforce holds a value we rejected, and since
 *   Salesforce has no merge logic (design 7.1) nobody else will fix that. This
 *   separation is what collapses the whole repair rule into the single
 *   condition of step (d).
 * - **(b) restatement** skips a field whose value equals the `sf_value` we
 *   already held, because a full-record payload restates unchanged fields with
 *   a fresh record-level timestamp (design 8.4).
 * - **(c) decide** takes the first case that applies — echo, then a value
 *   equal to the one we already hold, then the order-key comparison — and only
 *   here can a current value change.
 * - **(d) repair** is one condition, checked after every field whatever
 *   happened to it: if we believe Salesforce disagrees with us, we owe
 *   Salesforce a call (design 8.3, 9.1).
 *
 * What a caller must know:
 *
 * - **The caller owns the transaction.** `applyChanges` never begins or commits
 *   one. The design requires the duplicate claim and the apply to share a
 *   transaction (design 5, 8.1): split across two commits, a crash in between
 *   marks an event processed that was never applied, and Salesforce will never
 *   resend it.
 * - **The caller has already resolved the record link** and created the record
 *   row (design 5's cases (a) and (b)). Called for a record that does not
 *   exist, the store raises `StoreReadError`, which is deliberately allowed to
 *   propagate: it means a bug in the caller, not bad input, and the
 *   transaction must roll back rather than half-apply.
 * - **Fields are independent.** One event may apply `phone` and supersede
 *   `city`; the event's own outcome is then `partial` (design 5), which the
 *   caller derives from the returned rows.
 * - **An unknown field name raises `WebhookRejected` (400).** Validation should
 *   have caught it first; this is the backstop, and it aborts the whole event
 *   rather than applying some fields and rejecting others, because the caller's
 *   transaction is what makes that all-or-nothing.
 * - **No network call happens here**, which is what keeps the inbound
 *   endpoint's p99 at 200 ms and stops a Salesforce outage becoming held
 *   database locks (design 5).
 */

import { canonicalise } from "./canonical.js";
import { sortFields } from "./fields.js";
import { isStrictlyNewer, makeOrderKey } from "./orderKey.js";
import type {
  AppliedField,
  ApplyChangesInput,
  FieldOutcome,
  OrderKey,
  OutboundReason,
} from "./types.js";
import type { FieldVersionRow } from "../store/schema.js";
import type { Tx } from "../store/store.js";

/**
 * Apply one edit's changes to one record, and return what happened to each
 * field.
 *
 * @param tx an open transaction, owned by the caller.
 * @param input one edit — see {@link ApplyChangesInput}.
 * @returns one {@link AppliedField} per field in `rawChanges`, in catalogue
 *   order.
 * @throws {WebhookRejected} 400, when a field name is not in the catalogue.
 * @throws {StoreReadError} when the record was not resolved before the call.
 */
export function applyChanges(tx: Tx, input: ApplyChangesInput): AppliedField[] {
  // Fixed order, so two runs over the same payload produce identical history.
  // (The record-level lock is what serialises competing merges; this only
  // makes the output deterministic.)
  const fields = sortFields(input.objectType, Object.keys(input.rawChanges));

  const applied: AppliedField[] = [];
  for (const field of fields) {
    applied.push(applyOneField(tx, input, field));
  }
  return applied;
}

/**
 * One field through the four steps. Separate from the loop so the four steps
 * read in order and nothing can accidentally be hoisted between fields.
 */
function applyOneField(
  tx: Tx,
  input: ApplyChangesInput,
  field: string,
): AppliedField {
  const { objectType, portalId } = input;

  // `field` came from Object.keys(rawChanges), so the entry exists; the `??`
  // satisfies noUncheckedIndexedAccess and never hides a missing field.
  const raw = input.rawChanges[field] ?? null;

  // Canonical **before** comparing or storing (design 7.3). Without this, one
  // formatting difference between the two systems reads as a change and the
  // sync becomes a generator of its own traffic (design 9.1).
  const value = canonicalise(objectType, field, raw);

  const versionBefore = tx.getFieldVersion(objectType, portalId, field);
  const currentBefore = currentValueOf(tx, input, field);

  // ---------------------------------------------------------------- (a) learn
  //
  // Unconditional, before anything is decided. An event we reject still
  // teaches us Salesforce's state, and that is what lets step (d) be one
  // condition instead of a case analysis (design 5, 8.3).
  //
  // The snapshot is taken here, before step (a) moves anything, because step
  // (b) must compare against the `sf_value` we held *before* this event.
  const sfValueHeldBefore = versionBefore?.sfValue;
  let sfValue = versionBefore?.sfValue;
  let sfObservedAtMs = versionBefore?.sfObservedAtMs;

  if (input.origin === "salesforce") {
    if (sfObservedAtMs === undefined || input.occurredAtMs > sfObservedAtMs) {
      sfValue = value;
      sfObservedAtMs = input.occurredAtMs;
    }
    // else: leave `sfValue` alone — we already know a LATER Salesforce state.
    //
    // This guard is why design 8.2 is correct and not merely plausible.
    // Without it, an out-of-order event would set `sf_value` to a *past*
    // Salesforce value, condition (d) would read a disagreement that does not
    // exist, and we would spend a repair call arguing with Salesforce about a
    // value it no longer holds.
  }
  // A portal edit teaches us nothing about Salesforce: only a Salesforce
  // observation, or our own successful send (design 6.3, outside this module),
  // may move `sf_value`.

  // --------------------------------------------------------- (b) restatement
  //
  // A field whose canonical value equals the `sf_value` we already held is
  // Salesforce *restating* a value, not changing it — so step (c) is skipped
  // entirely: not restamped, not compared, not touched (design 8.4).
  //
  // Why this is not an optimisation. A `SystemModstamp` is a **record's**
  // modification time, not a field's, so a full-record payload restates every
  // unchanged field with a fresh timestamp. Compared as changes, those
  // restatements would beat a portal edit made during an outage and overwrite
  // it with Salesforce's stale value — exactly the data loss this design
  // exists to prevent (design 8.4, 10.3).
  //
  // Two conditions beyond the value match:
  //
  // - Only for `origin === "salesforce"`. A portal user typing back the value
  //   Salesforce holds is a real edit by a real person with a real order key.
  // - Only when `sfValueHeldBefore` is defined. An absent `sf_value` (the
  //   design's SQL NULL) means we have never heard Salesforce's value for this
  //   field, so the incoming value is a change, not a restatement.
  const isRestatement =
    input.origin === "salesforce" &&
    sfValueHeldBefore !== undefined &&
    value === sfValueHeldBefore;

  // -------------------------------------------------------------- (c) decide
  let outcome: FieldOutcome;
  let newKey: OrderKey | undefined;

  const incoming = makeOrderKey(input.occurredAtMs, input.origin, input.originEventId);
  const stored = storedKeyOf(versionBefore);

  if (isRestatement) {
    // Step (c) is skipped. Step (d) still runs — the field may well be a
    // disagreement we owe Salesforce a call about, and in the outage trace of
    // design 8.4 it is precisely the repair we already owed.
    outcome = "restatement";
    tx.appendObservation({
      objectType,
      portalId,
      field,
      observedValue: value,
      occurredAtMs: input.occurredAtMs,
      origin: input.origin,
      originEventId: input.originEventId,
      actor: input.actor,
      outcome: "restatement",
    });
  } else if (input.isEcho === true) {
    // L2, the actor rule (design 9.2): a webhook describing a write of ours is
    // recorded, never compared, never applied.
    //
    // Load-bearing, not an economy measure. L1 guarantees the loop stops; L2
    // guarantees it stops on the *right value*. The echo of our own write
    // carries the time Salesforce stored it, which is later than the edit that
    // write overwrote — so compared as a change it would win, and it would
    // launder our value back over a newer edit from the other side. Appendix B
    // traces exactly that overwrite race.
    //
    // Note what is *not* consulted here: the value. "Never applied" must hold
    // whatever the echo carries, or the guarantee would depend on Salesforce
    // echoing precisely what we sent.
    outcome = "echo";
    tx.appendObservation({
      objectType,
      portalId,
      field,
      observedValue: value,
      occurredAtMs: input.occurredAtMs,
      origin: input.origin,
      originEventId: input.originEventId,
      actor: input.actor,
      outcome: "echo",
    });
  } else if (value === currentBefore) {
    // A change whose canonical value already equals the current value changes
    // nothing — not the value, not the order key, and not history. Checked
    // **before** the order-key comparison, for two reasons:
    //
    // 1. `field_change` is the client's record of edits that *changed*
    //    something. A re-save of the value already held is not one, and
    //    filling permanent history with no-op rows would make "who changed the
    //    city" harder to answer — which is the thing the client is actually
    //    buying (design 4, and the brief's own ask).
    // 2. It must not restamp the order key. If a no-op re-save advanced the
    //    stamp, it would take ownership of the field from a genuine edit: a
    //    later real edit from the other side could then lose to someone who
    //    re-submitted a value they did not change.
    //
    // This is a third layer of idempotence beneath the duplicate table and the
    // strict `>` of design 7.2 — and the strict `>` is still the backstop that
    // matters, because it is what handles a *different* value arriving with an
    // older stamp (design 8.1 layer 2, 8.2).
    outcome = "confirmed";
    tx.appendObservation({
      objectType,
      portalId,
      field,
      observedValue: value,
      occurredAtMs: input.occurredAtMs,
      origin: input.origin,
      originEventId: input.originEventId,
      actor: input.actor,
      outcome: "confirmed",
    });
  } else if (stored === undefined || isStrictlyNewer(incoming, stored)) {
    // Strictly greater, `>` and not `>=` (design 7.2): re-applying a change
    // already applied does nothing, so the inbound path is idempotent
    // independently of the duplicate table (design 8.1 layer 2). No stored key
    // at all means nothing has ever won this field, so this change wins.
    outcome = "applied";
    newKey = incoming;
    tx.setCurrentValue(objectType, portalId, field, value);
    tx.appendFieldChange({
      objectType,
      portalId,
      field,
      oldValue: currentBefore,
      newValue: value,
      occurredAtMs: input.occurredAtMs,
      origin: input.origin,
      originEventId: input.originEventId,
      actor: input.actor,
      outcome: "applied",
    });
  } else {
    // A real edit by a real person, to a value we do not hold, that lost the
    // order-key comparison. Kept with its value, actor and time, because the
    // brief is explicit that the fact of an earlier edit stays on record
    // (design 7.5).
    //
    // No `value !== currentBefore` guard is needed here: the equality branch
    // above has already taken every change that matches what we hold, so
    // everything reaching this branch is a genuine disagreement about the
    // value — which is also why a `superseded` row always records a real
    // difference rather than a no-op.
    outcome = "superseded";
    tx.appendFieldChange({
      objectType,
      portalId,
      field,
      oldValue: currentBefore,
      newValue: value,
      occurredAtMs: input.occurredAtMs,
      origin: input.origin,
      originEventId: input.originEventId,
      actor: input.actor,
      outcome: "superseded",
    });
  }

  // Persist the order key together with what step (a) learned. One write,
  // whatever happened above: when (c) did not apply the change, the existing
  // order key is kept and only the Salesforce columns move — otherwise what we
  // learned in (a) would be lost the moment the event lost the comparison, and
  // step (d) would have nothing to compare on the next event.
  writeFieldVersion(tx, input, field, { versionBefore, newKey, sfValue, sfObservedAtMs });

  const currentAfter = currentValueOf(tx, input, field);

  // -------------------------------------------------------------- (d) repair
  //
  // **One condition, after every field, whatever happened to it** (design 8.3):
  // if `field_version.sf_value` is distinct from our current value — including
  // when we have never heard it — we owe Salesforce a call.
  //
  // Why one condition is enough. Salesforce has no merge logic (design 7.1),
  // so we are the only party that compares anything and its copy is a
  // projection of our decision. The six cases of design 8.3's table — applied,
  // superseded, out-of-order, echo, confirmed, restatement — differ only in
  // what `sf_value` and the current value *are* by the time we get here, which
  // is what step (a) and step (c) have just settled. There is no case analysis
  // left to do.
  //
  // It terminates: the repair sends our current value, the echo of that write
  // sets `sf_value` equal to it, and the condition goes false (design 9.1).
  // Canonical form (design 7.3) is the precondition — two spellings of one
  // value are the only way to give the loop fuel.
  const enqueuedOutbound = enqueueRepairIfNeeded(tx, input, field, {
    sfValue,
    currentAfter,
  });

  return {
    field,
    outcome,
    previousValue: currentBefore,
    newValue: currentAfter,
    enqueuedOutbound,
  };
}

/**
 * Step (d): enqueue the outbound call this field owes, if it owes one.
 *
 * @returns whether a row was added. False means either that we believe
 *   Salesforce agrees with us, that a call for this field is already pending,
 *   or that the breaker of design 9.4 has tripped.
 */
function enqueueRepairIfNeeded(
  tx: Tx,
  input: ApplyChangesInput,
  field: string,
  args: { sfValue: string | null | undefined; currentAfter: string | null },
): boolean {
  const { sfValue, currentAfter } = args;

  // "**Is distinct from**", in SQL's exact sense (design 8.3, and the SQL in
  // Appendix C.2): an `sf_value` we have never learned IS distinct from any
  // current value, because "we do not know what Salesforce holds" is itself a
  // disagreement we owe a call about.
  //
  // Without this, a portal edit to a field Salesforce has never mentioned
  // would enqueue nothing and Salesforce would never learn the value at all —
  // every portal-created record would be stranded, which is the opposite of
  // what the restart and outage paths require (design 6.5, 10.3).
  //
  // It opens no hole in the cases that must stay silent, because step (a) sets
  // `sfValue` for every Salesforce-origin field before (d) runs: an applied
  // change, an echo, a confirmation and an out-of-order event all arrive here
  // with `sfValue` already equal to the current value.
  const sfKnown = sfValue !== undefined;
  const owed = !sfKnown || sfValue !== currentAfter;
  if (!owed) return false;

  const { objectType, portalId } = input;

  // Rule L4, the repair breaker, checked **first** (design 9.4).
  //
  // It bounds the one way L1 fails: a value Salesforce stores in a spelling
  // our canonical form does not normalise makes every echo read as
  // disagreement, and the two systems then argue at one request per round trip
  // forever — spending the whole 100 req/s budget and stopping sync for every
  // record at once. Once a field has had MORE THAN 5 repairs inside the hour we
  // keep serving our value and stop arguing: knowingly different on one field
  // beats spending the cap on an argument neither side can win.
  //
  // The comparison reads the repairs ALREADY made, so the sixth is still sent
  // and the seventh is not. The boundary is asserted in the tests on purpose,
  // because an off-by-one here stops repairs a round trip early and looks like
  // correct behaviour (design 9.4).
  if (tx.repairsInLastHour(objectType, portalId, field) > 5) {
    // The design marks the field contested and alerts. This demo has no
    // alerting surface and no column for it, so the fact is emitted as a
    // process warning rather than dropped: a breaker that trips silently would
    // leave the two systems knowingly different with nobody told, which is the
    // one outcome worse than the argument it ended.
    process.emitWarning(
      `repair breaker tripped: ${objectType} ${portalId}.${field} is contested ` +
        `(we hold ${JSON.stringify(currentAfter)}, Salesforce holds ${JSON.stringify(sfValue)})`,
    );
    return false;
  }

  // `portal-edit` when the edit we are publishing came from the portal,
  // `repair` when we are ending a disagreement we detected. The condition is
  // the same on both paths (design 9.1); only the reason differs, and it is
  // what the breaker above counts.
  const reason: OutboundReason = input.origin === "portal" ? "portal-edit" : "repair";

  // False here means a pending row already exists for this field — the partial
  // unique index of design 4, which is what stops an echo arriving beside an
  // already-queued repair from piling up a second call (Appendix B step 5).
  // The queue holds no value, so the one row sends whatever is current at send
  // time (design 6.3).
  return tx.enqueueOutbound({
    objectType,
    portalId,
    field,
    reason,
    occurredAtMs: input.occurredAtMs,
  });
}

/** The field's committed current value, or `null` when we hold none. */
function currentValueOf(tx: Tx, input: ApplyChangesInput, field: string): string | null {
  const record = tx.getRecord(input.objectType, input.portalId);
  return record?.values[field] ?? null;
}

/** The order key of the change currently winning this field, if any. */
function storedKeyOf(version: FieldVersionRow | undefined): OrderKey | undefined {
  if (version === undefined) return undefined;
  return {
    occurredAtMs: version.occurredAtMs,
    originRank: version.originRank,
    originEventId: version.originEventId,
  };
}

/**
 * Write the `field_version` cache row: the winning order key, plus what we
 * believe Salesforce holds.
 *
 * `newKey` is set only when step (c) applied the change. Otherwise the stored
 * key is preserved, because the change that is winning has not changed.
 */
function writeFieldVersion(
  tx: Tx,
  input: ApplyChangesInput,
  field: string,
  args: {
    versionBefore: FieldVersionRow | undefined;
    newKey: OrderKey | undefined;
    sfValue: string | null | undefined;
    sfObservedAtMs: number | undefined;
  },
): void {
  const { versionBefore, newKey, sfValue, sfObservedAtMs } = args;

  const base: FieldVersionRow = versionBefore ?? {
    objectType: input.objectType,
    portalId: input.portalId,
    field,
    // No change has ever won this field, and this row is being created only to
    // remember what Salesforce holds. The minimum key — time 0, rank 0, empty
    // id — is deliberate: any real change is strictly newer than it, so a row
    // written purely to record an observation can never block a genuine edit.
    occurredAtMs: 0,
    originRank: 0,
    originEventId: "",
    origin: input.origin,
    actor: input.actor,
  };

  tx.putFieldVersion({
    ...base,
    ...(newKey === undefined
      ? {}
      : {
          occurredAtMs: newKey.occurredAtMs,
          originRank: newKey.originRank,
          originEventId: newKey.originEventId,
          origin: input.origin,
          actor: input.actor,
        }),
    sfValue,
    sfObservedAtMs,
  });
}
