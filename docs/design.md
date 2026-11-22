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
  payloadShape: "changed-fields" | "full-record",   // A3 and part 8.4
}) : Array<{ field, outcome: "applied"|"superseded"|"echo"|"confirmed",
             previousValue, newValue, enqueuedOutbound: boolean }>
```

One function, called from two places, carrying everything in parts 7 to 9
behind it. Callers must know three things and no more: it must be called
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
| our apply transaction | 0.2 s | one dedup insert, at most 9 row locks, at most 9 history appends |
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
  phone         text,          -- stored in canonical form, part 7.2
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
  -- the order key, part 7.1. These three columns ARE the comparison.
  occurred_at      timestamptz(3) NOT NULL,
  origin_rank      smallint NOT NULL,          -- salesforce = 1, portal = 0
  origin_event_id  text    NOT NULL,
  -- who and where, kept for display without reading history
  origin           text    NOT NULL,
  actor            text    NOT NULL,
  -- what Salesforce last told us it holds for this field; only used in
  -- full-record mode (A3, part 8.4). Null until Salesforce mentions the field.
  sf_value         text,
  PRIMARY KEY (object_type, portal_id, field)
);
```

One row per record per field: at A1's scale, 1 million customers at 3 fields
plus 4 million contacts at 6 fields is **27 million rows**.

This table is a **cache, not a second source of truth.** Every column is
derivable from `field_change` — the stamp is the latest applied change for that
field, and `sf_value` is the newest Salesforce-origin change we applied or
confirmed. It exists for two reasons: the comparison in part 7 becomes one
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
  |        canonicalise the value                                           (part 7.2)
  |        if echo:
  |            sync_observation('echo'); field_version.sf_value = value
  |        else if order_key(incoming) > order_key(stored):                 (part 7.1)
  |            UPDATE customer/contact SET <field> = value
  |            UPSERT field_version with the new stamp, sf_value = value
  |            INSERT field_change(outcome='applied', old_value, new_value)
  |            -- no outbound row: this change came FROM Salesforce
  |        else if value <> current value:
  |            INSERT field_change(outcome='superseded')                    (part 8.2)
  |            field_version.sf_value = value
  |            INSERT outbound_change(reason='repair')  -- Salesforce is wrong (part 8.3)
  |        else:
  |            sync_observation('confirmed'); field_version.sf_value = value
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
      --   INSERT outbound_change(reason='portal-edit')
COMMIT
NOTIFY outbound_ready
```

The one thing to see here: **the value change and the obligation to tell
Salesforce are the same commit.** If the process dies immediately after
`COMMIT`, the row is on disk and the call will happen. If it dies before, the
edit did not happen and the user is told so. There is no third outcome, and
that is what ADR 0001 bought.

Note also what creates a row: only a field whose **current value actually
moved**. A portal save that re-submits the same city creates no queue row at
all. That is not an optimisation; it is rule L1 of part 9, and it is why loops
cannot run.

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
