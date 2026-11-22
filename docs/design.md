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
inside a transaction the caller owns; it takes row locks per field in a fixed
field order, so concurrent calls on one record serialise rather than deadlock;
and it is idempotent in the strict sense that calling it twice with the same
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
