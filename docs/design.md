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

---

## Summary — the whole design on one page

**The one idea.** The unit of sync is a **field**, not a record. Every field
carries an **order key** — `(occurred_at, origin_rank, origin_event_id)` — and
the current value is the one whose order key is greatest. `occurred_at` is the
webhook's `occurredAt` on the Salesforce side and our own database's
`clock_timestamp()` on a portal save. Everything else follows from that.

**The shape.** Two processes, one repository. A **webhook endpoint** validates
and applies inbound changes in a single Postgres transaction and answers 200
only after it commits. A **sync worker** drains a durable queue to Salesforce
under a rate governor. They never call each other: the seam between them is
Postgres, which is what lets a value change and the obligation to tell
Salesforce be the same commit.

**Salesforce does no merging.** It overwrites with whatever lands last, so we
are the only party comparing anything. That makes our database the holder of
the decision and gives the design its single most useful rule.

**The one condition.** Outbound work is created exactly when
`sf_value`— what we believe Salesforce holds for a field — differs from that
field's current value. Checked after every field, on both paths, nowhere else.

> *We call Salesforce when, and only when, we believe Salesforce disagrees with us.*

**The four rules the exercise asks for**, each a consequence of the above:

| | Rule | Where |
| --- | --- | --- |
| **Duplicate webhook** | `eventId` is claimed in the same transaction as the apply. And the order-key comparison is strictly `>`, so a duplicate that escapes the table is a no-op anyway. | 8.1 |
| **Out of order** | Compare order keys per field. A change that is not strictly newer never becomes current but is kept as `superseded`, with its actor and time. | 8.2 |
| **Sync loop** | An echo tells us Salesforce holds the value we sent, which makes `sf_value` equal the current value, which makes the one condition false. The loop has no fuel after one hop. | 9.2 |
| **6-hour outage** | Queue rows are committed with the edit, so they survive a restart. On recovery the inbound sweep runs **before** the outbound drain, or we would overwrite Salesforce edits we had not yet learned about. | 10.3 |

**The numbers.** Assumed peak 20 edits/second, business-hours average 3, quiet
hour 0.5. We run at **70 of the 100 requests/second** allowed, which steady
state uses 11% of. A 6-hour outage queues **19,440 changes**, coalescing to
**15,000 calls**, draining in **5.1 minutes** counting the governor's ramp;
with the 1.2-minute inbound sweep first, **about 6.3 minutes end to end**. At a
sustained peak it would be 27.7 minutes, against a floor of 16.6 set by the cap
itself. The 30-second target closes at about 6 seconds on both paths, of which
7 of the 9.8 worst-case seconds belong to Salesforce rather than to us.

**The three things I would most want answered:** how the webhook is actually
produced (Change Data Capture would retire a third of part 8), whether an
external-id field exists for idempotent creates, and what else in the client's
Salesforce org is spending the rate limit.

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
   see?** I have answered it in part 7.5 with the rule I think is right — the
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

---

## 2. The systems, who calls whom, the network seam, the interfaces

### 2.1 The three parties and the two paths

```
   sales user                                finance / customer-success user
       |                                                    |
       | edits in                                           | edits in
       v                                                    v
+-------------------+                            +-------------------------+
|   SALESFORCE      |                            |   TEQUITY PORTAL        |
|   (client's CRM,  |                            |   (our app)             |
|   their database) |                            |                         |
+-------------------+                            +-------------------------+
       |      ^                                        |            |
       |      |                                        | in-process | in-process
       |      |                                        v            v
       |      |                              +------------------------------+
       |      |                              |  MERGE  (the deep module)    |
       |      |                              |  order keys, history,        |
       |      |                              |  echo and repair decisions   |
       |      |                              +------------------------------+
       |      |                                     |            ^
       |      |                                     v            |
       |      |                              +------------------------------+
       |      |                              |   POSTGRES  (our database)   |
       |      |                              |   records, field history,    |
       |      |                              |   outbound queue, watermark  |
       |      |                              +------------------------------+
       |      |                                  ^                |
       |      |     ==== PUBLIC INTERNET ====    |                | claims rows
       |      |          the only path           |                v
       |      |                                  |      +--------------------+
       |      |   (A) Salesforce calls us        |      |   SYNC WORKER      |
       +------|------------------------------>  [1] ----+   our process      |
              |   HTTPS webhook              endpoint   |   rate governor,   |
              |                                         |   retries, sweep   |
              |   (B) we call Salesforce                +--------------------+
              +-----------------------------------------------+
                  HTTPS Salesforce record API
                  (create / update / changed-since query)

  [1] = WEBHOOK ENDPOINT, our process. Validates, dedupes, calls MERGE, commits, returns 200.
```

Who calls whom, stated plainly:

| Path | Caller | Callee | Trigger | Our cap |
| --- | --- | --- | --- | --- |
| A | Salesforce | our webhook endpoint | a record changed in Salesforce | none — inbound is outside the cap |
| B | our sync worker | Salesforce record API | a field's current value changed in our database | 100 req/s hard, we run at 70 (A12) |
| — | the portal's save handler | MERGE, in-process | a portal user saved the form | not a network call |

A sales user never talks to the portal and a portal user never talks to
Salesforce. Neither human crosses the internet seam; only paths A and B do.

### 2.2 One service or two

**Two processes, one deployable repository, and the seam between them is
Postgres, not an HTTP call and not a broker.** The decision record is
[ADR 0001](adr/0001-two-processes-with-postgres-as-the-seam.md); the short
version:

- The webhook endpoint is latency-sensitive, spiky, stateless and horizontally
  scalable. It must return 200 fast and must never block on Salesforce, because
  a slow Salesforce turning into a 500 from us would make Salesforce retry
  work that already succeeded.
- The sync worker is rate-capped and must behave as a single global governor of
  a shared 100 req/s budget. That is the opposite scaling story: we want
  exactly one of it, not N.
- The outbound queue has to survive our process restarting — that is a hard
  requirement, not a preference — so it is on disk regardless. Once it is on
  disk in Postgres, the inbound apply and the outbound enqueue can be the
  **same transaction**, which is the decisive argument: a separate broker would
  make "we changed a value" and "we owe Salesforce a call" two facts that can
  disagree after a crash.

**What crosses the boundary between them:** rows, in two tables, in one
direction each.

| Table | Written by | Read by | Meaning |
| --- | --- | --- | --- |
| `outbound_change` | endpoint and portal (inside the merge transaction) | sync worker | "a field's current value moved; Salesforce does not know yet" |
| `echo_fence` | sync worker (after a successful send) | endpoint | "we just wrote this exact value to Salesforce; expect it back" |

Nothing else. No RPC, no shared in-memory state, no ordering dependency
between the two processes beyond what the rows carry.

### 2.3 The interface on each side

Four interfaces matter. For each I give what a caller must know, which in this
design includes the failure modes and the ordering guarantees, not just the
shape of the payload.

**(i) Our webhook endpoint — the interface Salesforce sees.**

```
POST /sync/salesforce/webhook
  X-Signature: hex(hmac-sha256(shared_secret, raw_request_body))     (A7)
  Content-Type: application/json

  { "eventId":       "evt_1001",                 required, our idempotency key
    "recordId":      "0031A00000Abc",            required, Salesforce id
    "objectType":    "Contact" | "Account",      required
    "occurredAt":    "2026-11-02T11:30:04.000Z", required, UTC ms  (A11)
    "changedBy":     "sales.user@client.example",required            (A6)
    "changedFields": { "phone": "+919876543210" } required, >= 1 entry  (A3)
  }

200 {"status":"applied"|"duplicate"|"echo"|"partially-superseded"}
    the event is durably accounted for; do not send it again
400 malformed or unknown objectType / field  — do not retry, it will not improve
401 signature did not verify                 — do not retry
429 we are shedding load                     — retry with backoff
500 we failed unexpectedly                   — please retry; the retry is safe
```

The two facts a caller most needs: **a 200 is only returned after our
transaction has committed**, and **re-delivering an event that got a 200 is
harmless** (part 8). We never return 200 to mean "accepted, will process
later", because that would make the 200 a lie we cannot recover from.

**(ii) The Salesforce record API — the interface we call.** Exactly three
operations, which is the entire surface we depend on:

```
update   PATCH  /services/data/vXX.X/sobjects/{Type}/{sfId}
                body: { "<SalesforceField>": <value>, ... }   -> 204
upsert   PATCH  /services/data/vXX.X/sobjects/{Type}/{ExtIdField}/{portalId}
                body: { ... }                                  -> 201 created | 204 updated   (A5)
changed  GET    /services/data/vXX.X/query?q=SELECT Id,<fields>,SystemModstamp
                     FROM {Type} WHERE SystemModstamp > {watermark}
                     ORDER BY SystemModstamp
                -> { records: [...], done: bool, nextRecordsUrl }   (A4)
```

Every one of the three is idempotent, and that is a design requirement rather
than an observation: `update` sends current values so repeating it converges,
`upsert` is keyed on our own identifier so repeating it cannot make a second
record, and `changed` is a read. This is what makes at-least-once sending safe
in part 6.

**(iii) MERGE — the one interface both edit paths go through.**

```
applyChanges(input: {
  record:    { objectType, salesforceId? , portalId? },
  origin:    "salesforce" | "portal",
  actor:     ActorId,
  occurredAt: Instant,              // from the payload if salesforce, from our clock if portal (A9)
  originEventId: string,            // webhook eventId, or the portal change id
  changes:   { [field]: rawValue },
}) : Array<{ field, outcome: "applied"|"superseded"|"echo"|"confirmed"|"restatement",
             previousValue, newValue, enqueuedOutbound: boolean }>
```

One function, called from **three** places — the webhook endpoint, the
portal's save handler, and the outage recovery sweep — carrying everything in
parts 7 to 9 behind it. Note what is *not* a parameter: whether the payload is
changed-fields-only or a full record (A3). The merge does not need to know,
because part 8.4's restatement rule gives the right answer in both cases, and
a parameter that selects between two behaviours is two interfaces wearing one
name. Callers must know three things and no more: it must be called
inside a transaction the caller owns; it takes **one lock per record** — the
`record_link` row — so every concurrent merge on one record serialises, in
either direction, with no lock ordering for a caller to get right; and it is
idempotent in the strict sense that calling it twice with the same
`originEventId` and `occurredAt` changes nothing the second time.

**(iv) The seam at Salesforce itself.** `SalesforceClient` is the only module
with a real seam in the sense that something actually varies across it: there
are two adapters, the live HTTPS client and the fake the demo runs against.
Deliberately *not* behind a seam: Postgres. There is one adapter and there
will only ever be one, so abstracting it would buy a hypothetical seam at the
cost of hiding the transaction semantics that parts 5 and 6 depend on.

### 2.4 Does the 30-second target close?

It does, with about two-thirds of the budget unused, and the parts we do not
control are the parts that dominate.

**Portal edit -> visible in Salesforce** (path B):

| Step | p99 | Why |
| --- | --- | --- |
| portal transaction commits, `outbound_change` row is in it | — | same transaction, no delay |
| worker notices | 1.0 s | `LISTEN`/`NOTIFY` on commit, with a 1 s poll as the fallback |
| coalescing window | 1.0 s | part 6.3; deliberate, to batch a multi-field form save |
| queue wait | 0.1 s | at 7.4 req/s against a 70 req/s governor we are 11% utilised (part 6.5) |
| Salesforce write | 2.0 s | A13, not ours |
| **total** | **4.1 s** | **8.1 s if one retry is needed** |

**Salesforce edit -> visible in the portal** (path A):

| Step | p99 | Why |
| --- | --- | --- |
| Salesforce emits the webhook | 5.0 s | A13, not ours, and the largest single term |
| network | 0.5 s | public internet, TLS handshake amortised by keep-alive |
| our apply transaction | 0.2 s | one dedup insert, one record lock, at most 6 field updates and 6 history appends |
| **total** | **5.7 s** | |

Both sides land inside 6 seconds at p99 against a 30-second worst case. The
slack is deliberate: 24 seconds of it is there to absorb A13 being wrong, since
Salesforce's emission delay and write latency together are 7 of our 9.8
seconds and neither is something we can fix.

The inbound path has no queue of its own. At A1's peak the endpoint commits 14
transactions a second, which is nothing for Postgres, and adding an inbound
queue would add a component and a lag term to buy headroom we do not need. The
condition for adding one is explicit: **inbound apply p99 above 1 second, or
sustained commits above 500/second.** Until then, inlining the apply is
strictly better, and part 3 is the general form of that argument.

---

## 3. The subproblems, in the order I would build them

### 3.1 How I ordered them

Not by difficulty and not by what the dependency graph forces. By risk, where
risk is these three things in this order:

1. **Getting it wrong loses data that cannot be recovered.** No retry, no
   re-sync and no apology fixes a field edit we threw away.
2. **Getting it wrong is silent.** A failure that announces itself is a
   different class of problem from one that quietly produces a plausible wrong
   answer for six months.
3. **Everything else is built on its decision.** A choice that other code
   writes against is expensive to revisit, so it should be made while it is
   still cheap.

Those three put the merge rule first and the backfill last, which is roughly
the opposite of the order in which the system's data flows — the backfill runs
before any sync happens, and it is still the last thing I would build, because
it is one-off, offline and re-runnable.

### 3.2 The subproblems

**S1. Decide what the current value of a field is, and keep what it
displaced.**
First because it is the only one that scores on all three criteria. A wrong
merge rule loses a real edit permanently; it does so silently, because a wrong
value looks exactly like a right one; and every other write path in the system
is built against the schema and the comparison this subproblem defines. It is
also the subproblem the exercise is really about — the phone-and-city scenario
is a merge question, and everything else is plumbing around the answer.

**S2. Stop a change from going round forever.**
Second because a loop is the one failure here that amplifies itself. Every
other bug affects the records it touches; a loop consumes the entire 100 req/s
budget, which takes the integration down for every record and every user at
once, and it does so within seconds of being deployed. It ranks above the queue
because the fix is structural — it is a property of *when outbound work is
created*, which is a decision inside S1's write path, and retrofitting it means
revisiting that path.

**S3. Hold outbound work on disk and spend the rate cap.**
Third. Getting it wrong loses portal edits when our process restarts, which is
the same severity as S1, but it ranks lower for one reason: it is a
well-understood pattern with a known shape — a transactional outbox with a
lease — so the probability of getting it wrong is much lower than the
probability of getting the merge rule subtly wrong. Risk is severity times
likelihood, and this is where the likelihood term starts to matter.

**S4. Make inbound delivery safe to repeat and safe to reorder.**
Fourth, and it cannot be earlier because it is defined in terms of S1's
comparison — "older" has no meaning until the order key exists. A failure here
corrupts current values, which is severe, but unlike S1 it is *detectable*: the
divergence number in part 11 goes up, and the damage is repairable by replaying
from the watermark. Detectable and repairable is what moves it below the
first three.

**S5. Know which record is which across the two systems.**
Fifth. A record created in the portal has no Salesforce identifier yet, and a
lost create response can produce a second Salesforce record. That is genuinely
bad — duplicate customer records are cleaned up by hand, by someone's
colleague — but it is bounded to the records being created, and it is visible
almost immediately. Bounded and visible is why it sits below the four above it.

**S6. Recover what was missed while a side was dark.**
Sixth as a thing to *build*, first as a thing to *ask about*. Its failure only
matters during a rare event and is recoverable by simply running it again,
which is why it ranks here. But it rests entirely on assumption A4, and if the
client says there is no changed-since query then the whole inbound design
changes shape, so the question belongs at the top of the call even though the
code belongs sixth.

**S7. Prove the webhook came from Salesforce.**
Seventh by risk and the one place where build order deliberately differs: the
signature check goes in on day one as a stub and is filled in before anything
reaches production. It ranks low not because it does not matter but because it
is a gate rather than a risk — a well-bounded piece of work with a known
answer, whose failure is a security incident rather than a correctness one, and
which cannot be gotten subtly wrong in the way S1 can.

**S8. Load the 5 million records that already exist.**
Last. One-off, offline, no latency target, and fully re-runnable from the
watermark if it fails halfway. Nothing else depends on its internals. It is
also the only subproblem whose cost is dominated by local database work rather
than by the API cap, so it exercises nothing the rest of the design needs
proven.

### 3.3 Which components each subproblem brings, and which bring none

A component appears here only because a subproblem above needed it. Four of the
eight need nothing new, which is the point of ordering the work this way.

| Subproblem | What it adds | What it adds to the running system |
| --- | --- | --- |
| S1 | the MERGE module; `field_version`, `field_change`, and the typed `customer` / `contact` tables | the only new module with real depth |
| S2 | the canonicalisation rule, and `echo_fence` | **no new process.** Loop termination is a property of MERGE, not a component |
| S3 | `outbound_change`; the SYNC WORKER process; the rate governor; `SalesforceClient` | the second process, and the only seam with two adapters |
| S4 | `inbound_event`; the WEBHOOK ENDPOINT process | the first process |
| S5 | `record_link` | **no new process** |
| S6 | `sync_watermark`, and a sweep that runs inside the existing worker | **no new process** |
| S7 | signature-verification middleware in the endpoint | **no new process** |
| S8 | a one-off script | **nothing.** It is not part of the running system |

What I am deliberately *not* adding, each tied to the subproblem that would
have to exist first to justify it:

- **No message broker.** S3 needs durability, and Postgres gives it without
  breaking the one-transaction property of ADR 0001.
- **No inbound queue.** S4's apply is one short transaction at 14 commits a
  second. Part 2.4 states the number at which I would add one.
- **No cache in front of Postgres.** Nothing in the design reads hot enough to
  need it, and a cache between MERGE and its row locks would be actively
  dangerous.
- **No per-field ownership table.** That is open question 6; if some fields
  turn out to be single-owner, S1 gets simpler for those fields, and a table
  built before the answer would be a guess.

---

## 4. The data we store

Eight tables. Three hold the client's data, two are the machinery of the two
paths, and three are small bookkeeping. The organising decision is in
[ADR 0002](adr/0002-merge-per-field-not-per-record.md): **the unit of sync is a
field, not a record.**

### 4.1 The current values — what the portal reads and writes

Ordinary typed tables, the shape the portal already wants. The sync does not
impose a schema on the application.

```sql
CREATE TABLE customer (
  portal_id     uuid PRIMARY KEY,
  name          text,
  status        text,
  owner         text,
  updated_at    timestamptz NOT NULL
);

CREATE TABLE contact (
  portal_id     uuid PRIMARY KEY,
  full_name     text,
  phone         text,          -- stored in canonical form, part 7.3
  email         text,          -- stored in canonical form
  city          text,
  owner         text,
  customer_id   uuid REFERENCES customer(portal_id),
  updated_at    timestamptz NOT NULL
);
```

Nine syncable fields across the two tables, exactly the nine the exercise
names (A14). **The current value of a field lives here and nowhere else** —
that is deliberate, and it is why `field_version` below has no value column.
Two copies of the current value would be two things that can disagree.

### 4.2 The stamps — which change won, per field

```sql
CREATE TABLE field_version (
  object_type      text    NOT NULL,          -- 'Customer' | 'Contact'
  portal_id        uuid    NOT NULL,
  field            text    NOT NULL,
  -- the order key, part 7.2. These three columns ARE the comparison.
  occurred_at      timestamptz(3) NOT NULL,
  origin_rank      smallint NOT NULL,          -- salesforce = 1, portal = 0
  origin_event_id  text    NOT NULL,
  -- who and where, kept for display without reading history
  origin           text    NOT NULL,
  actor            text    NOT NULL,
  -- what we believe Salesforce currently holds for this field, and the time of
  -- the newest Salesforce-origin observation that told us so. This pair is the
  -- whole basis of the repair rule (part 8.3) and of full-record mode (8.4).
  -- Null until Salesforce has mentioned the field.
  sf_value         text,
  sf_observed_at   timestamptz(3),
  PRIMARY KEY (object_type, portal_id, field)
);
```

One row per record per field: at A1's scale, 1 million customers at 3 fields
plus 4 million contacts at 6 fields is **27 million rows**.

This table is a **cache, not a second source of truth.** Every column is
derivable from `field_change` and `sync_observation` — the stamp is the latest
applied change for that field, and `sf_value` / `sf_observed_at` come from the
newest Salesforce-origin row of either, whatever its outcome. It exists for two reasons: the comparison in part 7 becomes one
indexed point read instead of a sort over history, and it gives us a single row
to take a lock on, which is how concurrent edits to one field serialise. A
rebuild procedure from `field_change` is part of the operational runbook, and
it is the repair for any suspicion that this table is wrong.

### 4.3 The history — what the client is actually buying

```sql
CREATE TABLE field_change (
  seq              bigserial,
  object_type      text    NOT NULL,
  portal_id        uuid    NOT NULL,
  field            text    NOT NULL,
  old_value        text,                       -- canonical form; null on create
  new_value        text,                       -- canonical form
  occurred_at      timestamptz(3) NOT NULL,    -- the order key of this change
  origin_rank      smallint NOT NULL,
  origin_event_id  text    NOT NULL,
  origin           text    NOT NULL,
  actor            text    NOT NULL,
  outcome          text    NOT NULL CHECK (outcome IN ('applied','superseded')),
  applied_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (seq, applied_at)
) PARTITION BY RANGE (applied_at);          -- monthly partitions

CREATE INDEX ON field_change (object_type, portal_id, field, occurred_at DESC);
```

Append-only. Never updated, never deleted. Two outcomes live here and both are
permanent:

- **`applied`** — this change became the current value.
- **`superseded`** — this was a real edit by a real person that lost the
  order-key comparison. It is kept because the exercise is explicit that the
  fact of an earlier edit stays on record after a later edit, and dropping it
  counts as losing a change.

"Who changed the phone, and who changed the city" is one indexed read of this
table per field.

### 4.4 The operational log — echoes and confirmations, which are not history

```sql
CREATE TABLE sync_observation (
  object_type text, portal_id uuid, field text,
  observed_value text, occurred_at timestamptz(3),
  origin text, origin_event_id text, actor text,
  outcome text NOT NULL CHECK (outcome IN ('echo','confirmed')),
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp()
) PARTITION BY RANGE (observed_at);         -- monthly partitions, dropped at 90 days
```

Separate table, and the separation is the point. An **echo** is Salesforce
telling us about our own write, and a **confirmed** observation is Salesforce
telling us a value we already hold. Neither is an edit by a person, so neither
belongs in the client's history — but both are exactly what you want when
debugging a suspected loop, so they are kept for 90 days and then the whole
partition is dropped. Mixing them into `field_change` would inflate the
permanent history by about 30% with rows that are not history and would make
partition-level pruning impossible, since a partition would hold both the
permanent and the prunable.

### 4.5 The two paths' machinery

```sql
-- inbound idempotency. Part 8.1.
CREATE TABLE inbound_event (
  event_id     text PRIMARY KEY,              -- Salesforce's eventId
  object_type  text NOT NULL,
  sf_id        text NOT NULL,
  occurred_at  timestamptz(3) NOT NULL,
  payload_hash bytea NOT NULL,                -- sha256 of the raw body
  outcome      text NOT NULL,                 -- applied | echo | superseded | partial | rejected
  received_at  timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX ON inbound_event (received_at);  -- for the 30-day prune

-- the durable outbound queue. Part 6. This is what "pending calls survive a
-- restart" means concretely: these rows are committed with the edit itself.
CREATE TABLE outbound_change (
  id              bigserial PRIMARY KEY,
  object_type     text NOT NULL,
  portal_id       uuid NOT NULL,
  field           text NOT NULL,
  reason          text NOT NULL,              -- 'portal-edit' | 'repair' | 'create' | 'recovery'
  occurred_at     timestamptz(3) NOT NULL,    -- order key of the change that created this row
  state           text NOT NULL DEFAULT 'pending',
                  -- pending | inflight | sent | failed
  attempts        int  NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_owner     text,
  lease_until     timestamptz,
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  sent_at         timestamptz
);
CREATE INDEX ON outbound_change (state, next_attempt_at)
  WHERE state IN ('pending','inflight');      -- the claim query's only index
CREATE INDEX ON outbound_change (object_type, portal_id) WHERE state = 'pending';
CREATE INDEX ON outbound_change (object_type, portal_id, field, created_at)
  WHERE reason = 'repair';                    -- the repair breaker's count (part 9.5)
```

Note what `outbound_change` does **not** store: the value to send. The sender
reads the current value at send time (part 6.3), so a row queued three hours
ago during an outage cannot deliver a value we have since superseded.

### 4.6 The bookkeeping

```sql
-- identity across the two systems. S5. A portal-created record has a
-- portal_id before it has an sf_id.
CREATE TABLE record_link (
  object_type text NOT NULL,
  portal_id   uuid NOT NULL,
  sf_id       text,                            -- null until Salesforce assigns one
  linked_at   timestamptz,
  PRIMARY KEY (object_type, portal_id)
);
CREATE UNIQUE INDEX ON record_link (object_type, sf_id) WHERE sf_id IS NOT NULL;

-- "we just wrote this to Salesforce; expect to hear about it". Part 9, rule L3.
CREATE TABLE echo_fence (
  object_type text NOT NULL, portal_id uuid NOT NULL, field text NOT NULL,
  value_hash  bytea NOT NULL,                  -- sha256 of the canonical value we sent
  sent_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at  timestamptz NOT NULL,            -- sent_at + 15 minutes
  PRIMARY KEY (object_type, portal_id, field, value_hash)
);

-- how far through Salesforce's own change history we are confident. Part 10.
CREATE TABLE sync_watermark (
  object_type   text PRIMARY KEY,
  system_modstamp timestamptz NOT NULL,        -- highest SystemModstamp we have seen (A4)
  updated_at    timestamptz NOT NULL
);
```

### 4.7 Does the storage close?

| Table | Rows | Size | Retention |
| --- | --- | --- | --- |
| `customer` + `contact` | 5 M | ~1.2 GB | forever |
| `field_version` | 27 M | ~5.5 GB with its index | forever, rebuildable |
| `field_change` | 26 M/year (20 M edits at ~1.3 fields each) | ~5.2 GB/year | **forever** — it is the product |
| `sync_observation` | ~8 M/year | ~1.4 GB/year | 90 days, ~350 MB live |
| `inbound_event` | 14 M/year, 1.15 M live | ~104 MB | 30 days |
| `outbound_change` | ~20 k at the worst moment of an outage | ~5 MB | sent rows pruned at 7 days |
| `record_link` | 5 M | ~400 MB | forever |
| `echo_fence` | ~5 k live | negligible | 15 minutes |
| **first year total** | | **~13 GB** | |

Growth is about 5 GB a year, essentially all of it permanent history. That is
small enough that keeping history forever is a decision about the product, not
a decision about the budget — which is the answer I want, because the exercise
makes history a requirement and I would rather not have to argue about it
later. The 30-day window on `inbound_event` is worth noting for the same
reason: duplicate suppression costs 104 MB, so there is no reason to trim the
window to anything that a Salesforce retry could plausibly outlive.

---

## 5. The inbound path: webhook to our database

One HTTP request becomes one Postgres transaction. There is no queue and no
background step: by the time we answer Salesforce, the change is committed or
it has not happened at all. Part 2.4 gives the reason and the number at which
I would revisit it.

### 5.1 The whole path

```
POST /sync/salesforce/webhook
  |
  |-- 1. read the raw body as bytes (the signature covers bytes, not re-serialised JSON)
  |-- 2. verify X-Signature                              -> 401, no retry   (S7, A7)
  |-- 3. validate the shape                              -> 400, no retry
  |         missing eventId / unknown objectType / unknown field /
  |         unparseable occurredAt / empty changedFields
  |         Each is a distinct message. A 400 means "this will never work",
  |         so we must be sure before sending one.
  v
BEGIN                                                    -- one transaction, no network calls inside
  |
  |-- 4. claim the event                                                    (part 8.1)
  |      INSERT INTO inbound_event (...) VALUES (...)
  |        ON CONFLICT (event_id) DO NOTHING RETURNING event_id;
  |      no row returned -> duplicate -> COMMIT, 200 {"status":"duplicate"}
  |
  |-- 5. resolve and lock the record                                        (part 5.2)
  |      SELECT portal_id FROM record_link
  |        WHERE object_type = $1 AND sf_id = $2 FOR UPDATE;
  |      This single lock serialises every merge on this record, inbound and
  |      portal-side alike. It is the only lock the merge takes.
  |
  |-- 6. classify the whole event as echo or not                            (part 9)
  |      changedBy = integration user?  -> echo
  |
  |-- 7. for each field in changedFields:
  |        value := canonicalise(raw)                                       (part 7.3)
  |
  |        (a) learn what Salesforce holds -- unconditionally, before deciding
  |            anything, and only if this is the newest word we have had:
  |            if occurredAt > field_version.sf_observed_at or it is null:
  |                field_version.sf_value      := value
  |                field_version.sf_observed_at := occurredAt
  |
  |        (b) a field whose value equals the sf_value we already held is a
  |            RESTATEMENT, not a change: skip (c) entirely.      (part 8.4)
  |            A null sf_value means we have never heard Salesforce's value
  |            for this field, so the incoming value is a change, not a
  |            restatement. This runs in both payload shapes -- see 8.4.
  |
  |        (c) decide the current value:
  |            if echo:                                                     (part 9)
  |                sync_observation('echo')          -- no value change, ever
  |            else if order_key(incoming) > order_key(stored):             (part 7.2)
  |                UPDATE customer/contact SET <field> = value
  |                UPSERT field_version with the new stamp
  |                INSERT field_change(outcome='applied', old_value, new_value)
  |            else if value is distinct from the current value:
  |                INSERT field_change(outcome='superseded')                (part 8.2)
  |            else:
  |                sync_observation('confirmed')
  |
  |        (d) the one repair condition, checked after every field:         (part 8.3)
  |            if field_version.sf_value is distinct from the current value:
  |                INSERT outbound_change(reason='repair')
  |
  |-- 8. UPDATE inbound_event SET outcome = <applied|echo|superseded|partial>
  v
COMMIT
  |
  '-- 200 {"status": ...}      <- sent only after the commit returns
```

Four properties of this shape are deliberate:

- **The dedup claim and the apply are in one transaction.** If they were not,
  a crash between them would mark an event processed that we never applied,
  and Salesforce would never send it again (A7 only promises redelivery while
  we have not answered 200). This is the single most important line in the
  path.
- **No network call happens inside the transaction.** Nothing in here can
  block on Salesforce, which is what keeps the endpoint's p99 at 200 ms and
  keeps a Salesforce outage from turning into held Postgres locks.
- **A field is processed independently of its neighbours.** One field in an
  event can be applied while another in the same event is superseded; the
  event's recorded outcome is then `partial`. Treating the event as the unit
  would mean one stale field dragging a fresh one down with it.
- **Learning what Salesforce holds is separate from deciding what is true.**
  Step (a) runs before step (c) and regardless of its outcome, so an event we
  reject still teaches us Salesforce's state. That separation is what collapses
  the repair rule into the single condition in step (d), and part 8.3 is why it
  has to be a single condition.
- **The 200 is sent after the commit, never before.** We never answer "accepted,
  will process shortly", because that turns the 200 into a promise we have no
  durable record of having made.

### 5.2 Resolving the record, including the creates

Step 5 has three cases. The third is the subtle one.

**(a) Known `sf_id`.** Normal path: one indexed lookup, lock, proceed.

**(b) Unknown `sf_id`, and `changedBy` is a human.** A record created in
Salesforce that we have not seen — either a genuine new create, or one whose
create webhook we lost. Mint a `portal_id`, insert the `record_link` and an
empty typed row, and let step 7 apply every field in the payload as a normal
first write. This is also exactly what outage recovery does for every record
it finds (part 10.3), so the create path and the recovery path are the same
code.

**(c) Unknown `sf_id`, and `changedBy` is the integration user (A6).** This is
the echo of a create *we* made, arriving before we had recorded the Salesforce
id it returned. The window is real: we send the upsert keyed on our own
`portal_id` (A5), Salesforce creates the record and emits the webhook, and the
webhook can beat our own write of `record_link.sf_id`. If we treated this as
case (b) we would mint a second local record for one real contact.

The rule: **answer `503` with `Retry-After: 5` and apply nothing.** We are
asking Salesforce to tell us again in a moment, by which time the link exists
and the event takes case (a) and is then recognised as an echo. This costs one
redelivery and reuses the retry behaviour of A7 rather than adding a holding
table or making a Salesforce call inside the transaction. It is bounded: after
60 seconds of a record staying unresolvable this way we log it loudly, treat it
as case (b), and let the unique index on `record_link(object_type, sf_id)`
plus a reconciliation sweep catch the duplicate — a visible, repairable
outcome rather than a stall.

Narrowing the rule to `changedBy = integration user` matters. The broader
version — defer whenever a create is in flight — would delay legitimate
Salesforce-side creates by 5 seconds whenever any create of ours was
outstanding, which at A1's rate is most of the time, and would spend the
latency budget to fix a race that only involves our own writes. If A6 turns out
to be false, this rule is not available and the fallback is the reconciliation
sweep alone.

### 5.3 What the status codes commit us to

| We return | Salesforce should | Because |
| --- | --- | --- |
| `200` | never send this event again | it is committed; a redelivery is harmless but wasted (part 8.1) |
| `400` | never send this event again | the payload is wrong in a way time will not fix; it is alerted on our side |
| `401` | stop and alert a human | our shared secret or theirs is wrong; retrying cannot help |
| `503` + `Retry-After` | send it again shortly | case (c) above, or we are shedding load |
| `500` | send it again with backoff | we failed unexpectedly; the retry is safe because of step 4 |

The asymmetry between 400 and 500 is the one to get right. A 400 throws the
event away forever, so it is only for payloads that are definitely malformed —
an unknown field name is a 400, but an unexpected *value* in a known field is
not, because a value we cannot canonicalise is our bug and deserves a 500 and
a retry.

---

## 6. The outbound path: portal edit to Salesforce API call

### 6.1 The portal save

The portal's save handler does one transaction, and the queue row is inside it:

```
BEGIN
  SELECT portal_id FROM record_link
    WHERE object_type=$1 AND portal_id=$2 FOR UPDATE;   -- the same single lock as part 5
  occurredAt := clock_timestamp()                        -- our clock, our record (A9)
  actor      := session.principal                        -- NOT the editedBy in the body (A9)
  applyChanges({ origin: 'portal', occurredAt, actor, changes, ... })
      -- for each field that actually moved:
      --   UPDATE customer/contact SET <field> = canonical
      --   UPSERT field_version, INSERT field_change(outcome='applied')
      -- then, per field, the same condition (d) the inbound path uses:
      --   if sf_value is distinct from the current value:
      --       INSERT outbound_change(reason='portal-edit')
COMMIT
NOTIFY outbound_ready
```

The one thing to see here: **the value change and the obligation to tell
Salesforce are the same commit.** If the process dies immediately after
`COMMIT`, the row is on disk and the call will happen. If it dies before, the
edit did not happen and the user is told so. There is no third outcome, and
that is what ADR 0001 bought.

Note what creates a row: **condition (d) of part 5.1, the same one the inbound
path uses** — we owe Salesforce a call exactly when we believe its value for a
field differs from ours. A portal save that re-submits the same city moves
nothing and creates no row; a portal save that happens to set a field to the
value Salesforce already holds creates no row either. That is not an
optimisation, it is rule L1 of part 9, and it is why loops cannot run.

### 6.2 The worker loop

```
every tick (on NOTIFY, or every 1 second as a fallback):

  0. hold the leader lease                            (ADR 0003)
     SELECT pg_try_advisory_lock(SENDER_LOCK_ID);  -- not held -> idle as standby

  1. reclaim anything a dead process left behind      (6.6)
     UPDATE outbound_change SET state='pending', lease_owner=NULL, lease_until=NULL
      WHERE state='inflight' AND lease_until < clock_timestamp();

  2. if the circuit breaker is open, probe instead of claiming   (6.5)

  3. claim a batch, whole records at a time           (6.3)
     WITH due AS (
       SELECT object_type, portal_id, MIN(next_attempt_at) AS due
         FROM outbound_change
        WHERE state='pending' AND next_attempt_at <= clock_timestamp()
        GROUP BY object_type, portal_id
        ORDER BY due                      -- oldest-due record first: no starvation
        LIMIT 200
     ), picked AS (
       SELECT o.id FROM outbound_change o JOIN due USING (object_type, portal_id)
        WHERE o.state='pending' AND o.next_attempt_at <= clock_timestamp()
        FOR UPDATE SKIP LOCKED
     )
     UPDATE outbound_change o
        SET state='inflight', lease_owner=$me,
            lease_until=clock_timestamp() + interval '30 seconds',
            attempts = o.attempts + 1
       FROM picked p WHERE o.id = p.id
     RETURNING o.*;

  4. group the claimed rows by (object_type, portal_id)
  5. for each group: read the CURRENT values of those fields, build one call   (6.3)
  6. governor.acquire(1 token)  -- every request, retries included            (6.5)
  7. send; settle the whole group by the outcome                              (6.7)
```

`attempts` is incremented when a row is **claimed**, not when it fails. A row
that crashes the process mid-send therefore still counts, which is what stops a
single poison row from crashing us in a loop forever. Section 6.5 explains the
one case where the increment is given back.

### 6.3 Coalescing, and reading the value late

The claim takes **whole records**: up to 200 distinct records, and every
pending row belonging to them. All the fields owed on one record become **one**
Salesforce call. A form save that changed four fields is four queue rows and one
PATCH.

Then the part that matters more than the batching:

> The sender reads each field's **current value at send time**, from the typed
> table. It never sends a value carried on the queue row — which is why part 4.5
> does not store one.

Consider a 6-hour outage. A city edit at 09:00 and another at 11:00 leave two
queue rows. When the link comes back at 15:00 we send **the 11:00 value, once**.
Sending the queued values in order would mean two calls, double the drain cost,
and a window during which Salesforce holds a value we superseded four hours
ago. The same property makes the repair writes of part 8.3 safe: a repair row
written at 09:00 sends whatever we currently believe, not what we believed then.

The cost is that the queue row is a *claim ticket* rather than a message, so
the queue cannot be read as a log of what we sent. `field_change` is that log,
and it is a better one.

### 6.4 The calls, and why each is safe to repeat

| Case | Call | Idempotent because |
| --- | --- | --- |
| update an existing record | `PATCH /sobjects/{Type}/{sfId}` with current values | sending the same current values twice reaches the same state |
| record created in the portal | `PATCH /sobjects/{Type}/{ExtIdField}/{portalId}` (A5) | keyed on **our** identifier, so a repeat updates the record it created rather than making a second one |
| outage recovery read | `GET /query?q=... SystemModstamp > watermark` (A4) | a read |

At-least-once delivery is the only thing a durable queue can honestly offer,
so every call we make is built to be repeatable. That is why A5 is worth
pushing for: without an external-id upsert, create is the one operation whose
repeat is not safe, and the fallback (search, then create) is racy.

On a `2xx` the sender writes the `echo_fence` rows for the fields it sent, then
marks the group `sent`. The fence is written **after** the response, because a
fence for a call that never landed would suppress a real Salesforce change.

### 6.5 The rate cap, and slowing down without losing work

**We run at 70 requests/second against the 100 the cap allows.** Both bounds
are chosen, not inherited:

- *Why not 100.* The cap counts our retries (the exercise is explicit), and it
  is a property of the client's Salesforce org rather than of us, so anything
  else in that org — another integration, a Data Loader job, a report —
  competes with us. At 100 we would discover that by being rejected; at 70 a
  30% burst from someone else is absorbed. A12 is the assumption behind this,
  and it is the number I would most like confirmed.
- *Why not lower.* Catch-up time after the outage scales inversely with this
  number. Part 10 shows 70 drains the 6-hour backlog in about 4 minutes; at 20
  it would be about 13.

The governor is a token bucket: capacity 70, refill 70/second, one token per
HTTP request **including every retry**. Steady state at A1 and A2 spends about
7.4 tokens/second, so we run at roughly 11% utilisation and the remaining 89%
is what drains a backlog.

Throughput is reachable from one process: at 70 requests/second and a 2-second
p99 (A13), Little's law gives 70 × 2 = **140 requests in flight**, which one
Node process with a keep-alive pool handles without strain. Steady state needs
about 15. There is no throughput reason to want a second sender, which is the
other half of ADR 0003.

**On a slow-down signal** (A8) — HTTP 429, or `REQUEST_LIMIT_EXCEEDED`:

```
rate := max(5, rate / 2)                 -- multiplicative decrease
row.state := 'pending'
row.next_attempt_at := now + (Retry-After, or 2^attempts seconds with jitter, capped at 300s)
row.attempts := attempts - 1             -- give the attempt back: this was not the row's fault
recover: rate := min(70, rate + 5) every 30 seconds of clean responses
```

Nothing is dropped. The work goes back to `pending` with a later due time, and
the only thing that changed is how fast we are willing to spend the cap. The
additive recovery is deliberately slower than the halving, so that a
rate-limited period does not oscillate.

**The circuit breaker, which is what makes a 6-hour outage survivable.** The
sender distinguishes two kinds of failure:

- An **endpoint failure** — connection refused, timeout, or 5xx — says nothing
  about the row. After 5 consecutive ones the breaker opens: we stop claiming
  entirely and send a single probe every 30 seconds. Rows already claimed go
  back to `pending` **with their `attempts` restored**, and on close we resume
  at half rate and ramp up.
- A **row failure** — a 400-class rejection naming this record's data — is
  about the row, and only this kind counts attempts toward giving up.

Without that distinction a 6-hour outage would destroy its own backlog: 10
attempts at a backoff capped at 5 minutes is under an hour, so every row would
have been marked `failed` by the second hour of the outage. Separating the two
is the difference between a backlog that waits and a backlog that dies.

### 6.6 What a restart does

Nothing that needs attention. The sequence:

1. The new process acquires the advisory lock (or idles as a standby if
   another holds it).
2. Step 1 of the loop returns every row the dead process left `inflight` whose
   30-second lease has expired. No manual intervention, no reconciliation
   script.
3. Sending resumes. Any row that had actually reached Salesforce before the
   crash is sent again, and 6.4 is why that is safe.

The 30-second lease is the one tuning choice: long enough that a slow call is
not stolen from a live sender, short enough that a crash costs at most 30
seconds of delay on the affected rows.

### 6.7 Settling a group

| Outcome | State | Attempts | Then |
| --- | --- | --- | --- |
| `2xx` | `sent` | — | write `echo_fence` rows; record `sent_at` |
| `429` / limit exceeded | `pending` | restored | halve the rate; honour `Retry-After` |
| timeout, connection error, `5xx` | `pending` | restored | count toward the breaker; backoff with jitter |
| `400`-class, data rejected | `failed` | kept | **alert.** A value the portal accepts and Salesforce refuses is a schema disagreement a human must settle |
| `404`, record gone | `failed` | kept | **alert.** Deletes are out of scope (A15), so this is unexpected by definition |
| `401` / `403` | `pending` | restored | **page, and stop the sender.** Bad credentials would otherwise burn the whole queue into `failed` |

A `failed` row is never deleted. It stays with its `last_error` as the queue's
own record that something needs a person, and part 11's third number is how we
find out.

---

## 7. The rule when both sides change the same record

### 7.1 First, who is doing the merging

This is not two peers reconciling. **Salesforce has no merge logic at all** —
it takes whatever write arrives last and overwrites. We are the only party
that compares anything. Three consequences follow, and they shape everything
below:

1. **Our database holds the merge decision.** The current value of a field is
   what our comparison says it is.
2. **Salesforce's copy is a projection of that decision**, kept in step by the
   outbound path. It is not an input to the decision except as the content of
   the webhooks it sends us.
3. **Therefore, any time our decision differs from what we believe Salesforce
   holds, we owe Salesforce a call.** A rejected webhook is not a no-op. It is
   the discovery of a disagreement, and part 8.3 makes it a repair write.

Point 3 is the one that is easy to miss, and leaving it out is how a design
that looks correct converges to a permanently wrong Salesforce record.

### 7.2 The order key — the field that decides which edit is current

**Named exactly, as the exercise asks.** The current value of a field is the
value of the change with the greatest **order key**, which is this triple
compared left to right:

```
order_key = ( occurred_at , origin_rank , origin_event_id )
```

| Component | On a webhook | On a portal save |
| --- | --- | --- |
| `occurred_at` | **the payload's `occurredAt`** — the time Salesforce gives the event | **`clock_timestamp()` of the saving transaction**, taken in our database at the moment it writes (A9) |
| `origin_rank` | `1` | `0` |
| `origin_event_id` | **the payload's `eventId`** | the portal change id, a ULID minted per save |

Stored in `field_version` as exactly those three columns (part 4.2). The rule:

> **Apply the incoming change if and only if its order key is strictly greater
> than the stored one.**

Three things about that triple:

- **Why `clock_timestamp()` and not the request body.** The sample portal edit
  has no time field, so there is nothing in it to trust; and a client-supplied
  time, like the client-supplied `editedBy`, is an assertion a caller could
  forge. Our database generates both the time and — from the authenticated
  session — the actor. `clock_timestamp()` rather than `now()` because `now()`
  returns the transaction's start time, so two saves in one transaction would
  tie needlessly.
- **Why Salesforce wins an exact tie** (`origin_rank` 1 beats 0). Not
  arbitrary: it is the cheaper direction. If a portal value loses to an
  incoming Salesforce change we apply it and owe nothing, whereas if the
  Salesforce change loses we owe a repair write. Preferring Salesforce on an
  exact-millisecond tie therefore saves rate-limit budget and costs nothing,
  since a tie means we have no real information about which came first.
- **Why `origin_event_id` last.** Two distinct Salesforce edits to one field
  can share a millisecond (A11). Comparing event ids lexicographically is
  arbitrary but **total and stable**, which is the property that matters: the
  same pair evaluated twice — which happens, because webhooks are redelivered
  — always gives the same answer.

The strictness of the comparison is load-bearing. Because it is `>` and not
`>=`, re-applying a change we have already applied does nothing, which makes
the whole inbound path idempotent independently of the duplicate table. Part
8.1 relies on that.

### 7.3 Canonical form, which is what makes the rest true

Values are canonicalised **before** they are compared or stored, and the stored
form is the canonical one.

| Field | Canonical form |
| --- | --- |
| all text | Unicode NFC; trim; collapse internal whitespace runs to one space |
| `email` | the above, then lowercased whole (we accept that the local part is case-sensitive in the RFC and case-insensitive in practice at every provider the client uses — an assumption worth one question) |
| `phone` | E.164, using the contact's country; if parsing fails, keep digits with a leading `+` and raise the parse-failure counter |
| `status` | mapped through the agreed picklist vocabulary, so our value and the Salesforce picklist label are one value |
| `customer_id` | the `portal_id` UUID, lowercase hex |
| empty | `''` and `NULL` are one thing, stored as `NULL` |

This looks like hygiene and it is not. It is what makes part 9's loop rule
true, and the failure without it is concrete: the portal sets a phone to
`+919876543210`, we send it, Salesforce stores and reformats it as
`+91 98765 43210`, and the webhook comes back. Compared raw, that is a
*different* value with a *later* time, so we would apply it — our value
changes, which creates outbound work, which Salesforce echoes again. One
reformatting difference between the two systems is enough to turn the sync into
a generator of its own traffic. Canonical comparison makes the two spellings
one value, and the echo becomes the no-op it should always have been.

### 7.4 Both sides change the same record, different fields

This is the exercise's own scenario and it needs no conflict rule at all,
which is the entire argument for ADR 0002. The comparison is per field and the
lock is per record, so:

- Finance sets `city` in the portal. `field_version[city]` gets a portal
  stamp. `phone` is untouched.
- Sales changes `phone` in Salesforce. The webhook names `phone` only (A3), so
  only `field_version[phone]` is compared and only `phone` moves. `city` is
  never looked at, let alone overwritten.
- The portal ends with the new phone and the finance city, and
  `field_change` holds one `applied` row for each, with its own actor and time.

Appendix A traces it step by step with the echo in place.

### 7.5 Both sides change the same field

**Across the two sides.** The order key decides. Then, and this is the half
that is not optional:

- The winner becomes the current value. `field_change` gets an `applied` row.
- **The loser is kept** — `field_change` gets a `superseded` row with its real
  value, actor and time, because the exercise is explicit that the fact of an
  earlier edit stays on record and that dropping it counts as losing a change.
- **If the loser was Salesforce's value, a repair write is enqueued** (part
  8.3), because of point 3 in 7.1: Salesforce now holds a value we have
  rejected, and nobody but us will fix that.

**Two portal users, same field** — the exercise asks this one directly. The
record lock of part 5.1 means the two saves do not actually overlap; they
serialise, so there is a first and a second rather than a tie. The second save
wins on the order key, having a later `clock_timestamp()`.

- *The second user:* their save succeeds, normally.
- *The first user:* their value is in `field_change` as the value they set,
  with their name, and then as the `old_value` of the change that replaced it.
  Nothing is lost.
- *What they **see*** is a product decision, and my rule is this: after a save
  the portal re-reads the record and renders each field with its current value
  and "set by X at T"; if what the user submitted is not the current value, it
  shows an inline notice naming who replaced it. We do **not** block the save
  and we do **not** show a merge dialog — the write already happened and the
  user's intent is already recorded, so the honest thing is to make the
  overwrite visible rather than to pretend it can be prevented. This is open
  question 4 and I would rather the client chose.
- *What goes to Salesforce:* in the sequential case both saves are real
  transitions, so both create queue rows. Coalescing (part 6.3) collapses them
  inside the 1-second window into one call carrying the current value; outside
  it, two calls land in order and the second wins. Both are correct because the
  sender reads the current value at send time.

**How often does this actually happen?** Worth knowing, because it decides how
much the rule matters. At A1's average of 3 edits/second over 27 million field
slots, two edits landing on the same field inside the 6-second visibility
window is, if edits were spread uniformly, about one event every two to three
weeks (18 edits in a window, 18/27,000,000 per edit, over 86,400 edits a day).
Edits are not uniform — they cluster on recently created and actively worked
records — so I would assume one or two a day in reality and I would measure it
with part 11's third number. Either way it is rare enough that getting the rule
*right* matters much more than making it fast, which is why part 5 spends a
record-level lock on it without hesitating.

### 7.6 The honest weakness: two clocks

A webhook's `occurred_at` comes from Salesforce's clock and a portal save's
comes from ours, and 7.2 compares them directly. Within the skew window (A10,
assumed 2 seconds) the ordering of a cross-side same-field pair can be wrong:
an edit genuinely made second can be ranked first.

I am accepting that rather than engineering around it, for three reasons:

1. **It cannot cause divergence,** only mis-ranking. The comparison is made in
   one place, by one system, deterministically, so our copy never oscillates
   and the repair write brings Salesforce into line with whatever we decided.
2. **Nothing is lost.** The mis-ranked edit is in `field_change` with its
   actor and its time; the client's history requirement is met either way, and
   a human looking at the two rows can see what happened.
3. **The alternative needs something we do not have.** A correct cross-side
   order needs a single sequencer both sides share — Salesforce Change Data
   Capture replay ids would be it (A11), which is why open question 1 is the
   highest-value question on the list.

What I would do instead of engineering around it: keep our clock on NTP, and
watch part 11's divergence number for a *systematic* bias in one direction,
which is what a real skew problem looks like as opposed to the occasional
genuine race.

---

## 8. The rule for a duplicate webhook, and for an older one arriving after a newer one

### 8.1 A duplicate webhook

**The rule: `eventId` is the idempotency key, claimed in the same transaction
as the apply.**

```sql
INSERT INTO inbound_event (event_id, object_type, sf_id, occurred_at, payload_hash, outcome)
VALUES ($1, $2, $3, $4, $5, 'in-progress')
ON CONFLICT (event_id) DO NOTHING
RETURNING event_id;
```

No row returned means we have seen this event. We commit and answer
`200 {"status":"duplicate"}`, having changed nothing. Salesforce has done
nothing wrong — A7 says it may deliver twice — so this is not an error and is
not alerted, only counted.

What makes this rule trustworthy is that it has **two independent layers**:

1. **Suppression** — the table above. A duplicate does no work at all.
2. **Harmlessness** — the strict `>` in the order key (part 7.2). Even if
   layer 1 failed to suppress a duplicate, re-applying a change whose order key
   already equals the stored one does nothing, because equal is not greater.

The second layer is the one that lets me sleep. Layer 1 can be defeated:
`inbound_event` is pruned at 30 days, a restore from backup could lose recent
rows, and an operational mistake could truncate it. In every one of those cases
a redelivered event is still a no-op. Layer 1 is an optimisation that saves
work; layer 2 is the correctness guarantee. A design with only layer 1 is one
retention policy away from corrupting data.

Three details:

- **Retention is 30 days**, which costs 104 MB (part 4.7). The window only has
  to exceed Salesforce's retry horizon, and since the cost is negligible there
  is no reason to trim it close.
- **Same `eventId`, different `payload_hash`** is a provider bug: the first
  write wins, we do not apply the second, and this one *is* alerted, because it
  means the key we are trusting is not unique.
- **A duplicate is not an echo.** A duplicate is one event delivered twice and
  carries the same `eventId`. An echo is a genuine, distinct event — with its
  own `eventId` — that happens to describe our own write. They arrive looking
  similar and need different rules, which is why `CONTEXT.md` separates the
  words.

### 8.2 An older webhook arriving after a newer one

**The rule: compare order keys per field; a change that is not strictly newer
never becomes the current value, and is recorded as `superseded`.**

Worked through, with the exercise's own sample shape:

```
evt_A  phone -> +919876500001   occurredAt 11:30:04.000   (sales.user)
evt_B  phone -> +919876500002   occurredAt 11:30:09.000   (sales.user)

B arrives first:
    order_key(11:30:09.000, 1, evt_B) > stored  -> APPLIED
    contact.phone        := +919876500002
    field_version[phone] := (11:30:09.000, 1, evt_B)
    sf_value             := +919876500002,  sf_observed_at := 11:30:09.000

A arrives second:
    (a) 11:30:04.000 is NOT newer than sf_observed_at 11:30:09.000
        -> sf_value is left alone. We already know a later Salesforce state.
    (c) order_key(11:30:04.000, 1, evt_A) < stored  -> SUPERSEDED
        field_change += (phone, +919876500001, sales.user, 11:30:04, 'superseded')
        the current value stays +919876500002
    (d) sf_value (+919876500002) = current value  -> NO repair write
```

Step (a) is why this is correct and not merely plausible. A naive version of
the repair rule — "the incoming value differs from ours, so tell Salesforce" —
would fire here and waste a call, because `evt_A` describes a *past* state of
Salesforce, not its current one. Tracking `sf_observed_at` alongside `sf_value`
is what distinguishes "Salesforce disagrees with us" from "Salesforce told us
about something old".

**No reordering buffer, deliberately.** We do not hold events back hoping the
missing earlier one arrives, because A11 gives us no sequence numbers, so we
cannot detect that anything is *missing* — a buffer could only wait a fixed
time and would add that latency to every event in order to maybe help a rare
one. The per-field comparison gets the same answer without the latency. If open
question 1 comes back as Change Data Capture, replay ids would let us detect a
genuine gap, and then a short buffer becomes worth reconsidering.

**An event can be partly applied.** Fields are independent (part 5.1), so one
event may apply `phone` and supersede `city`; `inbound_event.outcome` is then
`partial`.

### 8.3 The repair write — one condition for every case

Part 7.1 established that we are the only party that merges, so whenever our
decision differs from what Salesforce holds, we owe Salesforce a call. With
`sf_value` tracked separately from the merge decision, that whole obligation
collapses into **one condition, checked after every field, regardless of what
happened to it**:

> **`if field_version.sf_value is distinct from the current value: enqueue a
> repair write.`**

Every case falls out of it rather than needing its own rule:

| What happened | `sf_value` after | Current value | Repair? |
| --- | --- | --- | --- |
| Salesforce change applied | the new value | the same | no |
| Salesforce value superseded by a newer portal edit | Salesforce's value | ours | **yes** — Salesforce is wrong |
| older event after a newer one (8.2) | unchanged, the newer one | matches it | no |
| echo of our own write | the value we sent | the same | no |
| Salesforce restates a value we hold | that value | the same | no |
| full-record restatement during an outage (8.4) | Salesforce's stale value | our unsent edit | **yes** — and we already owed it |

**This terminates.** The repair sends our current value; Salesforce stores it
and echoes it; the echo sets `sf_value` to that same value; the condition is
then false and no further repair is created. One repair, one echo, done — and
part 9's rule L1 is the general statement of why.

The same condition is also the entire logic of outage recovery (part 10.3).
The sweep reads Salesforce's current values, feeds them in as observations, and
the fields needing repair are exactly the ones where the condition comes out
true. Recovery needed no special code, which is a good sign the condition is at
the right level.

### 8.4 If a webhook carries the full record instead

A3 assumes changed-fields-only. The exercise asks what the rule does
otherwise, and the honest answer is that **full-record mode is the dangerous
one**, because in it a field's silence and a field's restatement look
identical.

The hazard, concretely. During the outage, finance sets `city` to Noida at
15:00; it is queued and unsent. At 16:00 a sales user changes the phone, and
the full-record webhook carries `city: "Gurugram"` — Salesforce's stale copy —
stamped 16:00. Compared as a change, `16:00 > 15:00`, so we would apply it and
**overwrite the finance edit with an older value that Salesforce was merely
restating.** That is exactly the data loss this whole exercise is about, caused
by a payload shape.

**The rule in full-record mode** is step (b) of part 5.1:

> A field in the payload counts as a change only if its canonical value is
> **distinct from the `sf_value` we already held**. A field equal to it is a
> restatement: we do not restamp it, we do not compare it, we do not touch it.

Traced through the hazard: `sf_value[city]` is already `Gurugram`, so the
incoming `Gurugram` is a restatement and `city` is skipped; the current value
stays Noida; and condition (d) sees `sf_value` Gurugram against current Noida
and enqueues the repair we already owed. Meanwhile `phone` differs from its
`sf_value`, so it is a real change and applies normally. Both fields come out
right.

Two things worth saying about this. First, **step (b) is unconditional** — it
runs whatever shape the payload has. It costs nothing, because `sf_value` and
`sf_observed_at` exist for part 8.3 anyway; in changed-fields mode it only ever
skips a re-save of an identical value, which is a no-op in any case; and it is
*required* by the outage sweep (part 10.3) regardless of what the webhook looks
like. Making it unconditional is why `applyChanges` needs no payload-shape
parameter at all. Second, it is still weaker than changed-fields-only, because a
restatement that happens to coincide with a real Salesforce edit to the same
field *in the same payload* is invisible to us — the values are equal, so we
cannot tell a deliberate re-save from an unchanged field. That residual gap is
the reason A3 is the assumption I would most like to have confirmed in writing,
and why I would ask for changed-fields-only if the client has any say in how
the webhook is built.

---

## 9. The rule that stops a loop

### 9.1 Why this one gets four layers

Part 3 ranked loop termination second of eight subproblems, above the durable
queue, and the reason bears repeating here. Every other failure in this design
damages the records it touches. A loop consumes the whole 100 requests/second
budget, which stops sync for **every** record and every user at once, and it
reaches that state within seconds of being deployed. It is also the failure
most likely to be invisible in testing, because a loop needs a real
Salesforce's real echo behaviour to appear at all.

So the rule is layered: **one layer is the guarantee, and the other three exist
to keep the guarantee cheap.** Being clear about which is which is the point —
a design where four mechanisms all sort of help is a design where nobody knows
what happens when one is removed.

### 9.2 L1 — the structural rule, and the only one that guarantees termination

> **Outbound work is created exactly when `field_version.sf_value` is distinct
> from a field's current value — condition (d) of part 5.1, checked after every
> field, on both paths, and nowhere else. Nothing else enqueues anything,
> ever.**

That single condition is the whole rule. It is not a check anybody has to
remember to perform at the right moment; it is the one place in the design
where outbound work comes from, and it says something simple: *we call
Salesforce when and only when we believe Salesforce disagrees with us.*

An echo tells us Salesforce now holds the value we just sent, which makes
`sf_value` equal to the current value, which makes the condition false. **A
loop has no fuel after one hop** — not because a rule caught it, but because
there is nothing left to disagree about.

Trace it with the exercise's own requirement — an update we send must not
bounce back and forth forever:

```
portal sets city = Noida          -> current value moves  -> 1 outbound row
we PATCH Salesforce with Noida    -> Salesforce stores Noida
Salesforce emits a webhook: city = Noida
  step (a) sf_value := Noida
  step (c) no current value moves (it is already Noida)
  step (d) sf_value Noida = current Noida  -> no repair
  => 0 outbound rows.  The loop is dead here, by construction.
```

Note that L1 covers the repair write too, which is the part a reader should
check, since a repair is outbound work created by an *inbound* event. The
repair sends our current value; Salesforce stores it and echoes it; the echo
sets `sf_value` to that same value; condition (d) is then false. One repair,
one echo, terminated.

**L1 depends on canonical form** (part 7.3). Two spellings of one value would
make an echo look like a change, which is the one way to give the loop fuel.
That dependency is why canonicalisation sits in part 7 as a rule rather than in
an appendix as a utility, and why L4 below exists for when canonicalisation is
incomplete.

### 9.3 L2 — the actor rule, which makes the common case free

> **A webhook whose `changedBy` is the integration user (A6) is classified as
> an echo: recorded in `sync_observation`, and never compared or applied.**

This is one string comparison per event and it catches essentially every echo,
because every call we make is made as that one Salesforce login and nothing
else uses it. What it buys is not correctness — L1 already has that — but
cleanliness: echoes never enter the comparison, never produce a `field_change`
row, and never briefly look like changes. It also closes the ambiguity in part
5.2 case (c), where recognising our own create's echo is what stops us minting
a duplicate local record.

If A6 is false, L2 switches off and nothing about termination changes.

### 9.4 L3 — the fence, which saves wasted calls rather than preventing loops

> **After a successful send, the sender writes an `echo_fence` row keyed on the
> record, the field, and the hash of the canonical value sent, expiring in 15
> minutes. An inbound change matching an unexpired fence is classified as an
> echo, and the fence row is consumed.**

Being precise about what this is for, because it would be easy to present it as
a third safety net and that would be overselling it. The case it addresses:

```
portal sets phone = A at T1   -> sent
portal sets phone = C at T3   -> sent
the echo of A arrives before the echo of C
   step (a) sf_value := A      (A's occurredAt is the newest word so far)
   step (d) sf_value A <> current C  -> a repair write carrying C
            ...which we have already sent. One wasted call.
   then C's echo arrives, sf_value := C, and it settles.
```

Without L3 that costs one unnecessary request. It is **not** a correctness
problem and it terminates on its own. L3 removes the waste by recognising the
echo for what it is. It earns its place mainly during catch-up after an outage,
when many echoes and many queued changes interleave and a per-field wasted call
stops being a rounding error.

Two properties make it safe. The fence is written **after** the 2xx, so a fence
can never exist for a call that did not land and therefore cannot suppress a
real Salesforce change. And its false positives are harmless by construction: a
genuine Salesforce edit that happens to set the very value we just sent is
indistinguishable from an echo, and treating it as one changes nothing, because
the value is the same either way.

**If I had to ship in a week, L3 is what I would cut.** Saying so is the point
of ranking the layers.

### 9.5 L4 — the repair breaker, for when canonical form is incomplete

The one way L1 can fail is a value Salesforce stores differently from how we
sent it, in a way our canonicalisation does not normalise. Then: we send `V`,
Salesforce stores `V'`, the echo carries `V'`, `sf_value := V'`, condition (d)
sees `V' ≠ V` and enqueues a repair carrying `V`, Salesforce stores `V'` again,
and the two systems argue forever at one request per round trip, per field.

I do not want to claim canonicalisation is complete — a picklist the client
changes, a phone number in a format the parser does not know, a trailing
character in an address — so the backstop is explicit:

> **Before enqueuing a repair for a field, count the repairs already enqueued
> for that field in the last hour. Above 5, enqueue nothing, mark the field
> contested, and alert.**

The count is one indexed read of `outbound_change` on the repair path only,
which is rare. The behaviour when it trips is deliberately conservative: we
keep serving our current value to the portal and we **stop arguing with
Salesforce** about that one field. The two copies are then knowingly different
for that field, which is strictly better than the alternative of spending the
rate cap on an argument neither side can win, and a human gets told which field
and which record so the canonicalisation gap can be closed.

### 9.6 What each layer is worth

| Layer | Guarantees termination? | What its absence costs |
| --- | --- | --- |
| **L1** structural: we call only when we believe Salesforce disagrees | **yes** | everything. Without it no other layer saves us |
| L2 actor check | no | echo noise in history; the create race of part 5.2(c) reopens |
| L3 echo fence | no | occasional wasted requests, worst during catch-up |
| L4 repair breaker | bounds the one way L1 fails | an unbounded two-system argument over one field |

The honest summary: **L1 is the design, L2 and L3 are economy, and L4 is the
admission that canonicalisation is a thing humans maintain.**

---

## 10. The 6-hour outage: what is on disk, how we drain it, the arithmetic

### 10.1 What the outage is

Six hours in which the Salesforce record API is unreachable and webhooks
Salesforce tried to send may never arrive. Per A16 I design for both directions
being dark at once, which is the harder reading of the brief and the one its two
sentences jointly imply.

**The portal keeps working throughout.** Finance and customer-success staff
edit records, their edits apply locally, appear immediately in the portal, and
queue for Salesforce. Nothing is read-only and nothing is refused. The only
thing the outage costs is visibility in Salesforce, and the 30-second target
does not apply during it — the exercise is explicit that catch-up is a
different target, and the number we commit to instead is the drain time in
10.4.

### 10.2 What is on disk

| On disk | At the worst moment | Why it is there |
| --- | --- | --- |
| `outbound_change` rows, `state='pending'` | **19,440 rows, ~4.9 MB** | each committed in the same transaction as the portal edit that caused it (part 6.1) |
| rows left `inflight` by a restart | a handful | reclaimed when their 30-second lease expires (part 6.6) |
| `sync_watermark` | one row per object type | where the inbound sweep will resume from |
| `field_change`, `field_version`, typed rows | normal growth | the portal is fully operational; local history is complete |

Five megabytes. That is what "pending calls to Salesforce must still be there
after our own process restarts" costs, and it is worth stating plainly because
the requirement sounds expensive and is not.

**A restart during the outage is a non-event.** The rows are committed, so they
survive; leases expire and the rows return to `pending`; the circuit breaker
starts closed, opens again on its first five failures, and resumes probing.
Nothing is lost and nothing needs a human.

### 10.3 How we drain it — and why the order is not negotiable

The recovery has a strict ordering requirement that took me a second pass to
see, so it goes first:

> **The inbound sweep must complete before the outbound drain begins.**

Here is the loss it prevents. Finance sets a contact's city to Noida at 15:00;
the row queues unsent. At 17:00 a sales user sets the same city to Delhi in
Salesforce; that webhook never arrives. The link returns at 21:00.

- *Drain first:* we PATCH Noida. Salesforce's Delhi is overwritten and gone.
  The sweep then reads Salesforce and finds Noida — our own value — and learns
  nothing. **Delhi is destroyed with no record that it ever existed**, which is
  precisely the failure this whole exercise is about, and nothing in the
  system would ever report it.
- *Sweep first:* we read Delhi with its `SystemModstamp` of 17:00 and feed it
  in as an observation. The order key compares 17:00 against the portal's
  15:00, Delhi wins, Noida is recorded as `superseded` with the finance user's
  name, and condition (d) finds `sf_value` equal to the current value so no
  repair is owed. The queued row is still there, and when the drain reaches it
  the sender reads the **current** value (part 6.3) and sends Delhi — a no-op.
  Both edits are on record and both copies agree.

The window is small and that is the point. With 15,000 portal-touched records
and 34,900 Salesforce-touched records out of 5 million, the expected overlap is
`15,000 × 34,900 / 5,000,000` ≈ **105 records**. The ordering rule changes no
timing and protects about a hundred records in six million edits — and those
hundred are exactly the ones where an edit would be silently destroyed.

**The sweep relies on the restatement rule, and could not work without it.**
A `SystemModstamp` is a
*record's* modification time, not a field's, so a record touched at 17:00 hands
us every one of that record's fields stamped 17:00 — including fields last changed months
ago. Compared as changes, those would beat any portal edit made during the
outage and overwrite it with Salesforce's stale value. Step (b) of part 5.1 is
what stops it: a field whose value equals the `sf_value` we already held is a
restatement, skipped and not restamped. So the rule written for A3's "other
case" turns out to be **required by outage recovery no matter which payload
shape the webhook uses** — which is the reason part 8.4 makes it unconditional,
and the reason the merge needs no payload-shape parameter.

The sequence:

```
1. the breaker's probe succeeds -> the link is back
2. HOLD the outbound drain
3. for each object type, page through:
      SELECT Id, <fields>, SystemModstamp FROM {Type}
       WHERE SystemModstamp > :watermark ORDER BY SystemModstamp      (A4)
   feed each record through applyChanges as a full-record observation
   with occurred_at = its SystemModstamp, origin = salesforce
4. advance sync_watermark to the highest SystemModstamp fully applied,
   after each page -> a crash resumes from the page boundary, and a
   small re-read overlap is harmless because applying an observation
   twice is a no-op (strict > in part 7.2)
5. RELEASE the drain, at half rate, ramping (part 6.5)
```

Two things that are safe without extra machinery. Webhooks are arriving
normally again during step 3, and both paths go through the same `applyChanges`
behind the same record lock, so there is no race — a webhook for a record the
sweep has not reached yet applies normally, and the sweep's later observation
for it carries an equal-or-older `SystemModstamp` and becomes a no-op. And the
drain skips what the sweep resolved: a claim-time filter drops any row whose
field already has `sf_value` equal to the current value, since part 8.3's
condition says nothing is owed.

### 10.4 The arithmetic

**Inputs,** all from part 1: A1 gives 3 edits/second as the business-hours
average — not the 20/second peak, because a sustained six-hour peak is not a
credible event — A2 splits them 70/30, and A12 sets the governor at 70
requests/second.

```
outage window            6 h x 3600                       = 21,600 s
portal edit rate         3 edits/s x 30%                   = 0.9 /s
Salesforce edit rate     3 edits/s x 70%                   = 2.1 /s
live traffic on resume   (part 6.5)                        = 7.4 req/s
drain capacity           70 - 7.4                          = 62.6 req/s
```

**The outbound backlog:**

```
queued changes           0.9 /s x 21,600 s                 = 19,440 rows
distinct records         19,440 / 1.3 changes per record    = 14,954 -> ~15,000 records
                                                              = 15,000 PATCH calls (one per record, part 6.3)

drain at full rate       15,000 / 62.6 req/s               = 239.6 s = 239.6 / 60 = 4.0 minutes
```

**Four minutes is the headline, but it is not the honest number**, because the
breaker resumes at half rate and ramps +5 every 30 seconds (part 6.5). Counting
the ramp:

```
rate during each 30 s step   35   40   45   50   55   60   65   then 70
minus live 7.4            = 27.6 32.6 37.6 42.6 47.6 52.6 57.6       62.6
calls in that step (x30)  =  828  978 1128 1278 1428 1578 1728
cumulative after 210 s    = 828+978+1128+1278+1428+1578+1728       = 8,946 calls
remaining                 = 15,000 - 8,946                          = 6,054 calls
at full capacity          = 6,054 / 62.6                            = 96.7 s
total                     = 210 + 96.7                              = 306.7 s = 5.1 minutes
```

**The inbound sweep,** which runs first and is much cheaper than it looks:

```
Salesforce changes        2.1 /s x 21,600 s                 = 45,360
distinct records          45,360 / 1.3                       = 34,892 -> ~34,900 records
SOQL pages               34,900 / 2,000 records per request  = 17.45 -> 18 requests
API budget for those     18 / 62.6 req/s                     = 0.29 s          (negligible)
local apply              34,900 / 500 records per second     = 69.8 s = 1.2 minutes
```

The asymmetry is worth noticing: **one request reads 2,000 records and one
request writes 1.** That is why recovery is dominated by the outbound drain and
why the inbound side of a 6-hour blackout is essentially free in API terms. Its
cost is 1.2 minutes of local database work.

**Total, end to end:**

```
inbound sweep (blocking, 10.3)                              = 1.2 minutes
outbound drain with the ramp                                = 5.1 minutes
                                                              -----------
                                                              6.3 minutes
```

**Call it under 10 minutes** operationally, the margin covering page-fetch
latency, retries, and the breaker needing a few probes to close.

### 10.5 The pessimistic bound

If the six hours somehow ran at A1's full 20 edits/second peak:

```
queued changes           6 /s x 21,600 s                   = 129,600 rows
distinct records         129,600 / 1.3                      = 99,692 -> ~99,700 calls
after the ramp's 8,946   (99,700 - 8,946) / 62.6 + 210 s    = 1,660 s = 27.7 minutes
```

**About 28 minutes,** and the useful thing is what it is bounded by: at the
full 100 requests/second with no reserve at all it is `99,700 / 100 = 997 s =
16.6 minutes`. So in the worst credible case the **rate cap is the floor**, our
30% reserve costs about 11 minutes of catch-up, and no change to our design
beats 17 minutes. That is the trade I would put in front of the client — a
higher run rate buys catch-up speed and spends the safety margin of A12.

### 10.6 If assumption A4 is false

If there is no changed-since query, Salesforce's edits during the blackout
cannot be recovered selectively, and the fallback is to compare every record:

```
all records              5,000,000 / 2,000 per request      = 2,500 requests
API budget               2,500 / 62.6 req/s                 = 39.9 s
local merge              5,000,000 / 5,000 per second (batched) = 1,000 s = 16.7 minutes
```

**About 20 minutes for a full compare of 5 million records** — which is a
relief rather than a problem, and it changes the answer to A4 from
load-bearing to merely preferable. Two consequences I would adopt regardless:
the full compare becomes the recovery procedure instead of the incremental
sweep, and it is cheap enough to **run nightly as a standing safety net**,
which would catch any divergence from a lost webhook, a canonicalisation gap,
or a field the breaker of part 9.5 gave up on. Having costed it, I would want
that nightly sweep even with A4 confirmed.

---

## 11. Three numbers I would watch, and when I would call someone

Three, chosen so that each covers a different way this system fails: **outbound
is stuck**, **inbound is slow**, and **we are getting it wrong**. The third is
the only one that detects incorrectness rather than slowness, and it is the one
I would be most reluctant to give up.

### Number 1 — the age of the oldest unsent change

```sql
SELECT EXTRACT(epoch FROM clock_timestamp() - MIN(created_at))
  FROM outbound_change WHERE state = 'pending';
```

| | |
| --- | --- |
| **Normal** | under 5 seconds |
| **Warn** | 60 seconds |
| **Call someone** | **300 seconds (5 minutes)** |

Why age and not depth: depth is meaningless on its own, because 19,000 rows
draining fast is healthy and 3 rows stuck is not. Age answers the question
that matters — is anything actually waiting?

Five minutes is ten times the 30-second commitment, which is long enough that
no ordinary burst, retry or ramp reaches it, and short enough to leave most of
the drain window. The page means one of three things and the first action is to
tell them apart: the sender lost its leader lease and nothing is sending, the
circuit breaker is open because Salesforce is unreachable, or a poison record
at the head of the queue is being retried forever.

### Number 2 — how far behind the inbound path is

```sql
-- p99 over the last 5 minutes of applied_at - occurred_at, for Salesforce-origin rows
```

| | |
| --- | --- |
| **Normal** | under 6 seconds (part 2.4's budget) |
| **Warn** | 20 seconds |
| **Call someone** | **above 30 seconds, sustained for 5 minutes** |

This measures the whole path including Salesforce's own emission delay, which
is deliberate: the 30 seconds we promised the client is end to end, and a
number that excluded the part we do not control would be a number that stays
green while we miss the commitment.

The five-minute qualifier matters. A single slow event is noise. Sustained
breach is either a genuine Salesforce emission problem — in which case the page
produces a conversation with the client about A13 rather than a code change —
or our endpoint is saturated, which part 2.4 says we should answer with an
inbound queue.

### Number 3 — the divergence rate

```sql
-- per minute, summed:
--   outbound_change rows with reason = 'repair'
-- + field_change rows with outcome = 'superseded' AND origin = 'salesforce'
```

| | |
| --- | --- |
| **Normal** | near zero — part 7.5 estimates one or two genuine races a day |
| **Warn** | 10 per minute |
| **Call someone** | **100 per minute**, or any sustained one-directional bias |

This is the number that catches being *wrong* rather than being slow, and
nothing else in the system would report any of what it catches: a clock skew
beyond A10, a canonicalisation gap that is making echoes look like changes, a
loop rule that has stopped working, or a Salesforce-side process overwriting
portal edits in bulk.

The second threshold is the subtler one. Divergence should be symmetric —
genuine races go both ways. A *sustained one-directional* bias at any volume is
the signature of a systematic problem, and I would want to be called for it
even at 3 per minute, because it is exactly what A10 failing looks like and it
would otherwise sit under the warn line indefinitely.

### On the dashboard, but not among the three

Each of these is a leading indicator of one of the three above, which is why it
does not earn a page of its own: the current governor rate and the count of 429
responses (leading into number 1), the circuit breaker's state and consecutive
failure count (number 1), the count of rows in `failed` and of fields the
repair breaker has marked contested (number 3), webhook signature failures and
400 responses (a leading indicator of a Salesforce-side change to the payload),
and the lag of `sync_watermark` behind now (whether the nightly sweep of part
10.6 is keeping up).

One deliberate omission: there is no alert on queue *depth*. During catch-up
the depth is supposed to be 19,000, and an alert that fires every time the
system does its job correctly is an alert people learn to close.

---

## 12. What I am leaving out of this weekend's work

### Out of scope because the exercise says so

Deletes (A15), Salesforce login and authorisation screens, any visual user
interface, a second region, and load testing against real Salesforce. Where
code exists it runs against a fake Salesforce I wrote.

### Out of scope because I chose to leave it out

Each of these is a real thing the client would eventually need. I am naming
them with what they would cost rather than letting them be discovered later.

| Left out | What it would take | Why it can wait |
| --- | --- | --- |
| **The initial backfill of 5 million records** | designed as S8 in part 3 and costed in part 10.6 — 2,500 query requests, about 40 seconds of API budget, 17 minutes of local merge | one-off, offline, re-runnable, and it needs the merge rule to exist first |
| **Salesforce authentication lifecycle** | a connected app, a refresh token, and rotation. Assumed working throughout | mechanical, well-documented, and no design decision rests on it |
| **Schema change handling** | a picklist value the client adds in Salesforce that our canonicalisation does not know (part 7.3) | part 9.5's repair breaker degrades safely into a contested field and an alert rather than a loop |
| **Merging records that are already duplicated** | a matching rule, and a way to fold two histories into one | a pre-existing data-quality problem, not one this sync creates |
| **Field-level permissions** | a table of who may edit what, enforced on both paths | open question 6; building it before the answer would be a guess |
| **Attachments, notes, files, and every object beyond the nine fields** | more of the same machinery, keyed the same way | A14; nothing in the design is written per field, so a tenth field is configuration |
| **The portal's overwrite notice** (part 7.5) | a read-after-save and an inline message | the rule and the data behind it are designed; it is the UI that is out of scope |
| **Right-to-erasure against permanent history** | a decision, then probably crypto-shredding of the values with the change records kept | open question 5, and it is a legal question before it is an engineering one |
| **The monitoring itself** | wiring part 11's three numbers into whatever the client already uses | the queries are in part 11; the plumbing is site-specific |

### What I would build first if this were real work

In the order of part 3, and the first week would be S1 and S2 alone — the merge
rule, the history, the canonical forms, and the single condition that creates
outbound work — tested against a fake Salesforce, with no real integration
connected at all. Everything after that is plumbing around a decision that has
to be right first.

The single most valuable thing I could do before writing any of it is get open
question 1 answered: **how is the webhook actually produced?** If it is Change
Data Capture, replay ids give a real sequence, which retires A11, strengthens
part 8.2 from ordering-what-arrived to detecting-what-is-missing, and makes the
recovery sweep a replay instead of a comparison. That one answer changes more
of this document than any other.

---

## Appendix A: the exercise's worked scenario, traced

The scenario from the brief — sales creates a customer, finance corrects the
city in the portal, sales then changes the phone in Salesforce, and the portal
must end with **the new phone and the finance city** — traced through every
rule, with a duplicate and a late event added so all four required rules
appear. The contact is `0031A00000Abc` in Salesforce and `P` in the portal.

### Step 1 — sales creates the contact in Salesforce

`evt_1`, `occurredAt 11:00:00.000`, `changedBy sales.user@client.example`.

The Salesforce id is unknown and `changedBy` is a human, so part 5.2 case (b):
mint `P`, write the `record_link`, apply every field as a first write. The
email `ASHA@Client.example` is canonicalised to `asha@client.example` (7.3).

```
contact        full_name="Asha Mehta"  phone="+919876500001"  city="Gurugram"
field_version  every field = (11:00:00.000, rank 1, evt_1)
sf_value       every field = the value just applied,  sf_observed_at = 11:00:00.000
condition (d)  sf_value = current for every field          -> 0 outbound rows
```

### Step 2 — finance corrects the city in the portal

A finance user saves `{"city": "Noida"}`. Per A9 the time is our database's
`clock_timestamp()` — `11:00:20.000` — and the actor is the authenticated
session, **not** the `editedBy` in the body. The portal change id is `pc_01`.

```
order key  (11:00:20.000, rank 0, pc_01) > (11:00:00.000, rank 1, evt_1)   -> APPLIED
contact.city  := "Noida"
field_change  += (city, "Gurugram" -> "Noida", finance.user, 11:00:20.000, applied)
condition (d) sf_value "Gurugram" <> current "Noida"       -> 1 outbound row
```

### Step 3 — the sync worker sends it

Claims the row, reads the **current** value at send time (6.3), sends one
`PATCH {City: "Noida"}`, gets a 2xx, writes `echo_fence(P, city, hash("Noida"))`
and marks the row `sent`. **This is the only outbound call in the entire
scenario.**

### Step 4 — Salesforce echoes our own write

`evt_2`, `occurredAt 11:00:25.000`, `changedBy integration.user@tequity`,
`{"city": "Noida"}`. This is the loop rule.

```
dedup       new eventId, claimed
L2          changedBy is the integration user                  -> classified ECHO
(a)         11:00:25.000 > 11:00:00.000  -> sf_value[city] := "Noida"
(c)         echo: no comparison, no value change; sync_observation('echo')
(d)         sf_value "Noida" = current "Noida"                 -> 0 outbound rows
```

The loop ends here, and part 9.2 is why: there is nothing left to disagree
about. Had L2 been unavailable (A6 false), the echo would have been a
`confirmed` observation and (d) would still have produced nothing.

### Step 5 — sales changes the phone in Salesforce

`evt_3`, `occurredAt 11:05:00.000`, `changedBy sales.user`,
`{"phone": "+919876500002"}`. Changed-fields-only (A3), so `city` is not in the
payload and is never looked at.

```
(a)  11:05:00.000 > 11:00:00.000  -> sf_value[phone] := "+919876500002"
(c)  (11:05:00.000, 1, evt_3) > (11:00:00.000, 1, evt_1)      -> APPLIED
     contact.phone := "+919876500002"
     field_change += (phone, "+919876500001" -> "+919876500002", sales.user, applied)
(d)  sf_value = current                                        -> 0 outbound rows
```

### Step 6 — Salesforce delivers `evt_3` a second time

```
INSERT ... ON CONFLICT (event_id) DO NOTHING  -> 0 rows  -> 200 {"status":"duplicate"}
```

Nothing happens, and nothing is alerted — A7 permits this. And if
`inbound_event` had been pruned, layer 2 of part 8.1 still holds: the order key
would be *equal*, not greater, so (c) applies nothing, `sf_observed_at` is not
advanced by (a), and (d) finds nothing owed. Harmless either way.

### Step 7 — an older phone event arrives late

`evt_0`, `occurredAt 11:04:00.000` — earlier than `evt_3`, delivered after it —
`{"phone": "+919876500000"}`.

```
(a)  11:04:00.000 is NOT > sf_observed_at 11:05:00.000
     -> sf_value LEFT ALONE. We already know a newer Salesforce state.
(c)  (11:04:00.000, 1, evt_0) < (11:05:00.000, 1, evt_3)      -> SUPERSEDED
     field_change += (phone, "+919876500000", sales.user, 11:04:00.000, superseded)
     the current value stays "+919876500002"
(d)  sf_value "+919876500002" = current                        -> 0 outbound rows
```

Step (a) is the whole reason this costs nothing. A repair rule that compared
the incoming value against ours would have fired here and wasted a call, since
`evt_0` describes a past state of Salesforce rather than its current one. This
is the bug part 8.3 exists to prevent.

### The result

```
contact P   phone = "+919876500002"      <- sales, 11:05:00
            city  = "Noida"              <- finance, 11:00:20
```

**The new phone and the finance city**, which is exactly what the brief
requires. The history the client asked for, in `field_change`:

| field | old | new | occurred_at | actor | origin | outcome |
| --- | --- | --- | --- | --- | --- | --- |
| city | — | Gurugram | 11:00:00.000 | sales.user | salesforce | applied |
| phone | — | +919876500001 | 11:00:00.000 | sales.user | salesforce | applied |
| city | Gurugram | **Noida** | 11:00:20.000 | **finance.user** | portal | applied |
| phone | +919876500001 | **+919876500002** | 11:05:00.000 | **sales.user** | salesforce | applied |
| phone | — | +919876500000 | 11:04:00.000 | sales.user | salesforce | superseded |

"Who changed the phone, and who changed the city" is one indexed read each. The
earlier values survive the later edits, and the late event that lost is on
record rather than discarded.

**Seven events, one outbound call.** The duplicate cost nothing, the echo cost
nothing, the late event cost nothing, and the only request we spent against the
rate cap was the one that carried real news to Salesforce.
