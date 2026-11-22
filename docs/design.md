# Two-way sync of customer and contact records

**Design document — Tequity Round 1**

The client's sales team edits customers and contacts in Salesforce. The
client's finance and customer-success staff edit the same records in the portal
Tequity built, which stores them in Postgres. Both copies have to stay in sync
within 30 seconds while both systems are up, every field's history has to be
kept, and we only control our side.

This document is written for a teammate who was not on the call. Parts 1 and 2
are the context; parts 7 to 10 are the four rules the exercise asks for; the
arithmetic is in part 10 and the running totals in part 2.3.

**Contents**

1. [Assumptions, and the questions I would ask](#1-assumptions-and-the-questions-i-would-ask)
2. [The systems, who calls whom, the network seam, the interfaces](#2-the-systems-who-calls-whom-the-network-seam-the-interfaces)
3. [The subproblems, in the order I would build them](#3-the-subproblems-in-the-order-i-would-build-them)
4. [The data we store](#4-the-data-we-store)
5. [The inbound path: webhook to our database](#5-the-inbound-path-webhook-to-our-database)
6. [The outbound path: portal edit to Salesforce API call](#6-the-outbound-path-portal-edit-to-salesforce-api-call)
7. [The rule when both sides change the same record](#7-the-rule-when-both-sides-change-the-same-record)
8. [The rule for a duplicate webhook, and for an older one arriving after a newer one](#8-the-rule-for-a-duplicate-webhook-and-for-an-older-one-arriving-after-a-newer-one)
9. [The rule that stops a loop](#9-the-rule-that-stops-a-loop)
10. [The 6-hour outage: what is on disk, how we drain it, the arithmetic](#10-the-6-hour-outage-what-is-on-disk-how-we-drain-it-the-arithmetic)
11. [Three numbers I would watch, and when I would call someone](#11-three-numbers-i-would-watch-and-when-i-would-call-someone)
12. [What I am leaving out of this weekend's work](#12-what-i-am-leaving-out-of-this-weekends-work)

Appendix A: [the exercise's worked scenario, traced](#appendix-a-the-exercises-worked-scenario-traced)

---

## 1. Assumptions, and the questions I would ask

Nothing below was given to me. Each one is an assumption I had to make to close
the design, followed by one sentence on what I would change if the answer came
back the other way. The five the exercise names are A1, A3, A4, A7 and A9.

### 1.1 Volume and shape of the traffic

**A1 — Peak edit rate is 20 edits/second; the business-hours average is 3
edits/second; a quiet hour is 0.5 edits/second.**
Derived rather than guessed: 5 million records touched about four times a year
is 20 million edits a year; spread over 250 working days of 8 hours
(7,200,000 seconds) that is 2.8 edits/second average, which I round to 3. A
peak-to-average factor of 7, which is ordinary for a business application with
daily, weekly and month-end peaks, gives 20 edits/second sustained over the
busiest quarter hour. Part 10 uses these numbers.
*If it goes the other way:* at a real peak of 200 edits/second the portal's
share alone is 60 requests/second and we are close to the cap in steady state,
so per-record coalescing stops being an optimisation and becomes load-bearing,
and the 30-second budget needs a debounce per record instead of the flat
1-second window in part 6.

**A2 — 70% of edits originate in Salesforce, 30% in the portal.**
The sales team is the larger population and touches every record; finance and
customer-success touch a subset.
*If it goes the other way:* if the portal is the busier side, steady-state
outbound traffic roughly doubles to 14 requests/second and the 6-hour backlog
grows to about 45,000 records, which drains in roughly 12 minutes instead of 4
— still inside the cap, but it consumes most of the headroom I deliberately
keep in A12.

**A3 — A webhook carries only the changed fields, as the sample shows.**
I design for changed-fields-only and I would ask for it, because in a
full-record payload a field's silence and a field's restatement look identical.
*If it goes the other way:* part 8.4 gives the full rule — in full-record mode
I must diff the payload against the last value I attributed to Salesforce
rather than against our current value, which costs one extra column, because
otherwise an unchanged field restamped with a new `occurredAt` would overwrite
a newer portal edit that had not yet reached Salesforce.

### 1.2 Salesforce APIs this note does not give me

These are the three places where I need something the brief does not hand me.
Each is marked as an assumption in the text that uses it.

**A4 — We can ask Salesforce for records that changed in a time window.**
I assume a SOQL query over the Salesforce Query API filtering on
`SystemModstamp > :watermark`, returning up to 2,000 records per request. This
is how outage recovery works in part 10.
*If it goes the other way:* without it, Salesforce-side edits made during the
6-hour blackout are unrecoverable except by comparing all 5 million records
field by field (2,500 query requests and about 40 seconds of API budget, but a
full local re-merge), so I would run that sweep on a schedule instead of on
demand, and I would push much harder for Change Data Capture, which would also
retire assumption A11.

**A5 — Salesforce creates can be made idempotent with an external-id upsert.**
I assume a `PATCH /sobjects/{Type}/{ExternalIdField}/{portalId}` upsert against
an external-id field on Account and Contact, so that retrying a create we are
unsure about cannot produce a second record. Part 6.4.
*If it goes the other way:* without an external-id field we must search before
create on a natural key, which is racy, so every portal-originated create
becomes a two-call sequence with a duplicate-record risk I would have to accept
and report on a dashboard.

**A6 — A webhook's `changedBy` identifies the API caller, so our integration
user is recognisable in it.**
Part 9's cheap classification rule reads this field.
*If it goes the other way:* if `changedBy` reports the record's owner rather
than the caller, rule L2 in part 9 is simply switched off; loop termination is
unaffected because it rests on rule L1, which is structural, but we lose the
cheap classification and pay a little more in history noise and repair writes.

### 1.3 The wire between us

**A7 — Webhook delivery is at-least-once, over HTTPS, authenticated with a
signature over the raw body using a shared secret, and Salesforce retries on a
5xx or a timeout.**
The exercise promises duplicates and reordering, which only makes sense with
retries. I assume nothing about a retry budget.
*If it goes the other way:* if delivery is at-most-once with no retry, every
missed webhook becomes permanent divergence, so the recovery sweep of A4 stops
being outage machinery and has to run continuously as the primary inbound path
with webhooks as a latency optimisation on top.

**A8 — Salesforce signals rate limiting with HTTP 429 or a
`REQUEST_LIMIT_EXCEEDED` error, and a `Retry-After` when it has one.**
Part 6.5 is the slow-down behaviour.
*If it goes the other way:* if the signal is only a hard rejection with no
hint, the sender halves its rate on any rejection and probes upward on
success, which is what it does anyway; only the recovery speed changes.

**A13 — Salesforce's own webhook emission delay is at most 5 seconds at p99,
and a record API write returns within 2 seconds at p99.**
These two are the only parts of the 30-second budget we do not control.
*If it goes the other way:* if Salesforce takes 25 seconds to emit, the
30-second target is not achievable by any design on our side and that becomes a
conversation with the client about the number rather than about the system.

### 1.4 Time and identity on our own side

**A9 — On a portal save, the time comes from our database and the actor comes
from the authenticated session.**
The sample portal edit has no time field, so there is nothing to trust in the
payload. The portal save takes the transaction's `clock_timestamp()` at the
moment it writes, and the actor is the session principal that the portal
authenticated, not the `editedBy` string in the request body — a client-supplied
actor is an assertion, and attributing history to it would let a caller forge
who made a change. `editedBy` is kept as a reported value for comparison.
*If it goes the other way:* if the portal must honour a client-supplied edit
time, for instance because an offline mobile client replays saves, then portal
changes stop being monotonic per record and the duplicate rule of part 8 has to
be extended to portal saves, which currently cannot duplicate.

**A10 — Clock skew between Salesforce's clock and ours is at most 2 seconds.**
Part 7 compares a Salesforce-supplied `occurredAt` against a time our own
database generated, so the two clocks are being compared directly.
*If it goes the other way:* with unbounded skew the order key stops ordering
cross-side edits to the same field within the skew window; it still converges
both copies to the same value, because the comparison is deterministic and both
sides run it identically, but which value wins becomes arbitrary, so I would
raise the divergence alert of part 11 to a page and widen it to watch for a
systematic bias in one direction.

**A11 — `occurredAt` is UTC with millisecond resolution, and two distinct
Salesforce edits to the same field can share a millisecond.**
This is why the order key in part 7 has tiebreakers rather than being a bare
timestamp.
*If it goes the other way:* if Salesforce exposes a monotonic replay sequence
instead — Change Data Capture replay ids would do it — the tiebreakers go away
and the out-of-order rule gets strictly stronger, because we would be able to
detect a *gap* and not merely order what arrived.

**A12 — The 100 requests/second cap is ours alone to spend, and we choose to
run at 70.**
Part 6.5 justifies the 70 both ways: low enough that another consumer in the
client's Salesforce org cannot push us into rejections, high enough to drain
the outage backlog inside the window computed in part 10.
*If it goes the other way:* if the client's org already spends, say, 60
requests/second on other integrations, our governor drops to roughly 25 and the
6-hour drain stretches from about 4 minutes to about 10 — the design does not
change, one configured number does.

### 1.5 Scope assumptions

**A14 — The nine fields named in the exercise are the whole schema, and the set
is closed.** A tenth field would be configuration, not a code change, because
nothing in the design is written per field.

**A15 — No record is ever deleted, as the exercise puts deletes out of scope.**
*If it goes the other way:* a delete is a change whose new value is "gone", and
it needs a tombstone that survives in history, plus a rule for an edit that
arrives after a delete — which is the same order-key comparison, so the data
model in part 4 would carry it, but the portal's reads would all need a
not-deleted predicate.

**A16 — The 6-hour outage is a two-way blackout.** The brief says the
Salesforce API is unreachable and separately that webhooks sent during the
window may never arrive, so I design for both directions being dark at once,
which is the strictly harder case.

### 1.6 Questions I could not close with an assumption

These would change the design, and I would want them answered before locking
it. I have put each one where it would land.

1. **How is the webhook actually produced** — an Apex trigger callout, a
   Platform Event subscription, Change Data Capture, or an external middleware?
   This decides A4, A6 and A11 together, and Change Data Capture would let me
   delete a third of part 8. It is the single highest-value question on this
   list.
2. **Is there an external-id field on Account and Contact already, and may we
   write to it?** This is A5, and it is the difference between safe retries and
   a duplicate-record risk on every portal-originated create.
3. **What else in the client's Salesforce org consumes the API limit?** This is
   A12, and it sets one configured number.
4. **When two portal users edit the same field, what should the second one
   see?** I have answered it in part 7.4 with the rule I think is right — the
   save succeeds, the portal re-reads, and the loser is told who overwrote them
   — but the honest answer is that it is a product decision and I would rather
   the client made it.
5. **Does the client need the history to be legally retained, and does that
   conflict with a right-to-erasure obligation?** Part 4 never deletes a change,
   and that is a deliberate product commitment that someone should sign off
   rather than inherit from me.
6. **Is a record ever intentionally allowed to differ between the two
   systems** — a field finance owns and sales must not touch, for instance? I
   have assumed not. If some fields are single-owner, the merge in part 7 gets
   simpler for them and the design gets a per-field ownership table.
7. **What should the portal show while a save is still on its way to
   Salesforce?** I have assumed sync is invisible to the user. If it has to be
   visible, the outbound queue's state becomes a read model the portal renders,
   which is a small change made expensive by being discovered late.
