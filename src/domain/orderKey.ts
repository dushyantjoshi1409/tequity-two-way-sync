/**
 * The order key: the comparable value that decides which of two changes to one
 * field is current (design 7.2).
 *
 * Two changes to one field are always comparable, and the comparison gives the
 * same answer wherever and whenever it is made. Three components, compared
 * left to right:
 *
 * | Component        | On a webhook        | On a portal save                     |
 * | ---------------- | ------------------- | ------------------------------------ |
 * | `occurredAtMs`   | the payload's time  | `clock_timestamp()` of the save (A9) |
 * | `originRank`     | salesforce = 1      | portal = 0                           |
 * | `originEventId`  | the `eventId`       | the portal change id (a ULID)        |
 *
 * What a caller must know:
 *
 * - **Apply an incoming change if and only if its key is _strictly_ greater
 *   than the stored one** — {@link isStrictlyNewer}, and nothing else.
 * - The comparison is **total**: no two keys are incomparable, so there is no
 *   case for a caller to handle.
 * - It is **stable**: the same two keys always compare the same way, in any
 *   process, on any day. Redelivery depends on this.
 * - It carries no notion of *correctness across clocks*. Inside the skew
 *   window (design 7.6, assumption A10: 2 s) an edit made second can rank
 *   first, and the design's deliberate answer is that the key stays
 *   authoritative while the inversions are measured and paged on — not that
 *   this module should try to detect them.
 */

import type { OrderKey, Origin } from "./types.js";
import { ORIGIN_RANK } from "./types.js";

/**
 * Build the key for one change.
 *
 * @param occurredAtMs the payload's `occurredAt`, or `clock_timestamp()` of the
 *   saving transaction — never a time supplied by an untrusted caller (A9).
 * @param origin the system the edit was made in.
 * @param originEventId the webhook's `eventId`, or the portal change id.
 */
export function makeOrderKey(
  occurredAtMs: number,
  origin: Origin,
  originEventId: string,
): OrderKey {
  return {
    occurredAtMs,
    // Taken from the shared table rather than written as a literal here: the
    // rank is the *rule*, and two copies of a rule are one edit away from
    // disagreeing.
    originRank: ORIGIN_RANK[origin],
    originEventId,
  };
}

/**
 * Compare two keys: negative when `a` is older, zero when they are equal,
 * positive when `a` is newer.
 *
 * The return value is a sort comparator, so `[...keys].sort(compareOrderKeys)`
 * puts the oldest change first.
 */
export function compareOrderKeys(a: OrderKey, b: OrderKey): number {
  // Time first. Rank is only a tiebreak: consulted before time, it would make
  // Salesforce win every comparison and the portal could never hold a value.
  if (a.occurredAtMs !== b.occurredAtMs) {
    return a.occurredAtMs < b.occurredAtMs ? -1 : 1;
  }

  // Then rank, so an exact-millisecond tie goes to Salesforce (rank 1 over the
  // portal's 0). That is the *cheaper* direction, not an arbitrary one: a
  // losing portal value costs nothing, while a losing Salesforce value obliges
  // us to send a repair write (design 7.2, 8.3). Breaking the tie the other
  // way would be correct and would simply buy us an extra outbound call every
  // time it happened.
  if (a.originRank !== b.originRank) {
    return a.originRank < b.originRank ? -1 : 1;
  }

  // Last, the event id — because two Salesforce edits can share a millisecond
  // (assumption A11) and the comparison must still be total. Which id wins is
  // arbitrary; that it is **stable** is the point, because a redelivered event
  // must rank the same way the second time, or the "duplicate does nothing"
  // guarantee of design 8.1 layer 2 would depend on arrival order.
  //
  // Plain code-unit comparison, deliberately not `localeCompare`: a
  // locale-dependent or ICU-version-dependent collation would make the answer
  // differ between two processes comparing the same two keys, which is exactly
  // the stability this component exists to provide.
  if (a.originEventId === b.originEventId) return 0;
  return a.originEventId < b.originEventId ? -1 : 1;
}

/**
 * Whether an incoming change may become the current value.
 *
 * **Strictly** greater, `>` and not `>=`, and that is load-bearing: it makes
 * re-applying a change whose key equals the stored one a no-op, so the inbound
 * path is idempotent *independently of the duplicate table* (design 8.1 layer
 * 2). The table is only suppression, and it falls to a prune, a restore or a
 * truncate; this comparison is the guarantee that survives all three. A design
 * resting on the table alone is one retention policy away from corrupting
 * data.
 */
export function isStrictlyNewer(incoming: OrderKey, stored: OrderKey): boolean {
  return compareOrderKeys(incoming, stored) > 0;
}
