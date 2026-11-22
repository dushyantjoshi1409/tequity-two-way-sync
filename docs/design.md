# Two-way sync of customer and contact records

**Design document — Tequity Round 1**

Sales edits customers and contacts in Salesforce; finance and customer-success
edit the same records in the portal Tequity built on Postgres. Both copies must
agree within 30 seconds while both are up, every field's history must be kept,
and we control only our side.

Parts 7–10 are the four rules; all arithmetic is one table in 10.4. Every
justification lives in [`design-appendix.md`](design-appendix.md) (**F**, by
section), with the brief's scenario and the hardest race traced (**A**, **B**),
interfaces, schema DDL and sequences (**C**), the assumptions derived (**D**),
and what the demo substitutes for (**E**). `docs/adr/` holds the three decisions
expensive to reverse.

## Summary

The unit of sync is a **field**, not a record. Each field carries an **order key**
`(occurred_at, origin_rank, origin_event_id)`; the current value is the one whose
key is greatest. **Salesforce has no merge logic** — it overwrites with whatever
lands last — so our database holds the decision and Salesforce's copy is a
projection of it. Hence the one rule everything follows from:

> **Outbound work is created exactly when `sf_value` — what we believe Salesforce
> holds for a field — differs from that field's current value.** After every
> field, on both paths, nowhere else.
> *We call Salesforce when, and only when, we believe Salesforce disagrees with us.*

| Rule | | § |
| --- | --- | --- |
| **Duplicate** | `eventId` claimed in the apply's transaction; and `>` is strict, so an escaped duplicate is a no-op | 8.1 |
| **Out of order** | order keys per field; not-newer never becomes current, kept as `superseded` with actor and time | 8.2 |
| **Loop** | an echo makes `sf_value` equal the current value, so the condition goes false — no fuel after one hop | 9 |
| **6-h outage** | queue rows commit with the edit; on recovery the sweep runs **before** the drain | 10.3 |

**Numbers.** Peak 20 edits/s assumed, business-hours average 3, quiet hour 0.5.
We run at **70 of the 100 req/s** allowed, 11% used in steady state. A 6-hour
outage queues **19,440 changes → 14,954 calls**, draining in 5.1 min; with the
1.2-min sweep first, **6.3 min** (row 1, 10.4). The 30-second target closes at
~6 s both ways, 7 of the 9.8 worst-case seconds being Salesforce's.

## 1. Assumptions, and the questions I would ask

Nothing below was given; **Appendix D derives each and says what changes if it
goes the other way.** The exercise names five — A1, A3, A4, A7, A9 — and **A4 and
A5 assume Salesforce APIs the brief does not mention.**

| | Assumption |
| --- | --- |
| **A1** | **Peak 20 edits/s, business-hours average 3/s, quiet 0.5/s.** 10.4 uses the average; 10.1 says why |
| **A2** | 70% of edits originate in Salesforce, 30% in the portal |
| **A3** | **A webhook carries only the changed fields**, per the sample |
| **A4** | **Salesforce can be queried for records changed in a window** (SOQL on `SystemModstamp`, 2,000/page). **Assumed** |
| **A5** | **Creates can be made idempotent** by external-id upsert on our `portalId`. **Assumed** |
| **A6** | `changedBy` names the API caller, so our integration user is recognisable |
| **A7** | **Delivery is at-least-once**; HMAC-SHA256 over the raw body; retried on 5xx or timeout |
| **A8** | Throttling arrives as 429 or `REQUEST_LIMIT_EXCEEDED`, with `Retry-After` when available |
| **A9** | **A portal save takes its time from our `clock_timestamp()` and its actor from the session** — never the body's `editedBy` |
| **A10** | Clock skew between the two clocks is at most 2 s |
| **A11** | `occurredAt` is UTC, millisecond; two edits can share a millisecond |
| **A12** | The 100 req/s cap is ours alone to spend, and **we run at 70** |
| **A13** | Salesforce emits within 5 s p99; a record write returns within 2 s p99 |
| **A14** | The nine named fields are the whole schema |
| **A15** | No record is ever deleted (the exercise's scope) |
| **A16** | **The outage is dark both ways at once** — the harder reading of the brief |

**Questions I could not close with an assumption.** (1) **How is the webhook
produced** — Apex callout, Platform Event, Change Data Capture, middleware? It
decides A4, A6 and A11 together; highest-value question here. (2) Is there an
external-id field on Account and Contact we may write (A5)? (3) What else in the
org spends the API limit (A12; row 5, 10.4)? (4) When two portal users edit one
field, what should the second see? 7.5 is my rule, but the choice is a product
decision. (5) Must history be retained legally, and does that conflict with
right-to-erasure? Part 4 never deletes a change. (6) Is any field single-owner?
I assume not; if some are, we need a per-field ownership table.

## 2. The systems, who calls whom, the network seam, the interfaces

```
 sales user              finance / customer-success user
     | edits in                      | edits in
     v                               v
+--------------+         +--------------------+
|  SALESFORCE  |         |  TEQUITY PORTAL    |
| their CRM+DB |         |  our app           |
+--------------+         +--------------------+
   |      ^                     | in-process
   |      |                     v
   |      |   +-----------------------------------+
   |      |   | MERGE   order keys, history, echo |
   |      |   |         and repair decisions      |
   |      |   +-----------------------------------+
   |      |          |                   ^
   |      |          v                   |
   |      |   +-----------------------------------+
   |      |   | POSTGRES  records, history, queue |
   |      |   +-----------------------------------+
   |      |         ^                     |
   | == PUBLIC INTERNET == only path      v
   |      | (A) SF->us            +-----------------+
   +------|---------> [EP] -------| SYNC WORKER     |
          | (B) us->SF            | governor, sweep |
          +-----------------------+-----------------+
            record API: create / update / changed-since

 [EP] WEBHOOK ENDPOINT (ours): validate, dedupe, MERGE, commit, 200.
```

| Path | Caller | Callee | Trigger | Cap |
| --- | --- | --- | --- | --- |
| **A** | Salesforce | our webhook endpoint | a record changed in Salesforce | none; inbound is outside the cap |
| **B** | our sync worker | Salesforce record API | we believe Salesforce disagrees | 100 req/s hard; we run at 70 |
| — | the portal's save handler | MERGE, in-process | a portal user saved | not a network call |

No human crosses the internet seam; only paths A and B do. **Two processes, one
repository, and the seam between them is Postgres** — not HTTP, not a broker
([ADR 0001](adr/0001-two-processes-with-postgres-as-the-seam.md)) — so the
inbound apply and the outbound enqueue are **one commit**.

| Crosses the boundary | Written by | Read by | Means |
| --- | --- | --- | --- |
| `outbound_change` | endpoint and portal, in the merge transaction | sync worker | "Salesforce disagrees about this field" |
| `echo_fence` | sync worker, after a successful send | endpoint | "we just wrote this; expect it back" |

**Appendix C.1 has the interface on each side**: our endpoint's contract and
status codes, the three Salesforce operations we depend on — each idempotent **by
design**, which is what makes at-least-once sending safe — and `applyChanges`.

**Does 30 seconds close?** Yes, at ~6 s both ways:

| Portal → Salesforce | p99 | Salesforce → portal | p99 |
| --- | --- | --- | --- |
| commit (queue row is in it) | — | Salesforce emits (A13, **not ours**) | 5.0 s |
| worker notices (`NOTIFY`, 1 s poll) | 1.0 s | network | 0.5 s |
| coalescing window | 1.0 s | our apply transaction | 0.2 s |
| queue wait at 11% utilisation | 0.1 s | | |
| Salesforce write (A13, **not ours**) | 2.0 s | | |
| **total** | **4.1 s** | **total** | **5.7 s** |

**No inbound queue** — at A1's peak the endpoint commits 14 transactions a second.

## 3. The subproblems, in the order I would build them

**Ordered by risk:** (1) getting it wrong loses data unrecoverably, (2) getting
it wrong is silent, (3) other code is built on the decision. That puts the merge
rule first and the backfill last, the opposite of the data's flow.

| | Subproblem | Why here | Demo |
| --- | --- | --- | --- |
| **S1** | decide a field's current value, keep what it displaced | all three: a wrong merge loses a real edit, silently | **yes** |
| **S2** | stop a change going round forever | the only self-amplifying failure: a loop eats the cap | **yes** |
| **S3** | hold outbound work on disk and spend the cap | S1's severity, lower likelihood; a known shape | **yes** |
| **S4** | make inbound delivery safe to repeat and reorder | "older" needs S1's key; severe but detectable | **yes** |
| **S5** | know which record is which across the systems | a lost create can duplicate a record: bounded, visible | no |
| **S6** | recover what was missed while a side was dark | **first to ask about**, sixth to build; rests on A4 | no |
| **S7** | prove the webhook came from Salesforce | a gate, not a risk; stubbed day one | no |
| **S8** | load the 5 million existing records | one-off, offline, no latency target | no |

**The demo exercises S1–S4 and nothing below** — the four whose failures are
unrecoverable or silent. S2, S6, S7 and S8 add **no process** of their own.

## 4. The data we store

Eight tables; Appendix C.2 has the DDL.
[ADR 0002](adr/0002-merge-per-field-not-per-record.md): **the unit of sync is a
field**, forced by the brief's own scenario — a record-level comparison would
have to discard one of two concurrent edits to different fields.

| Table | Holds |
| --- | --- |
| `customer`, `contact` | **the current values**, typed; they live here and nowhere else |
| `field_version` | the **order key** per `(record, field)`, plus `sf_value` / `sf_observed_at`: a cache, not a second truth |
| `field_change` | **the history**: append-only, `applied` and `superseded`, both **permanent** |
| `sync_observation` | `echo`, `confirmed`, `restatement`; 90-day partitions; not edits by people, so not history |
| `inbound_event` | the duplicate key, 30-day retention (104 MB) — 8.1 |
| `outbound_change` | the **durable queue**: which field is owed, **never the value** — 6.3 |
| `record_link` | Salesforce id ↔ portal id, and the per-record lock |
| `echo_fence`, `sync_watermark` | "we just wrote this" (15-min TTL); how far through history we are sure |

`sf_value` is moved by a Salesforce observation **and by our own successful send**.
**Storage:** 5 M typed rows at 1.2 GB; **27 M** `field_version` rows (1 M × 3
fields + 4 M × 6) at 5.5 GB with its index; `field_change` at **26 M rows/year**
(20 M edits × 1.3 fields) and **5.2 GB/yr, kept forever because it is the
product**. **~13 GB in year one, growing 5 GB/yr.**

## 5. The inbound path

**One HTTP request becomes one Postgres transaction**, with no network call
inside it and no background step. Appendix C.3 has the sequence: validate, claim
the `eventId`, lock the record, then four steps per field, then commit and 200.

- **(a) learn** records what Salesforce holds regardless of what (c) decides,
  which is what collapses repair into the single condition 8.3.
- **(b) restatement** skips a field restating the `sf_value` we already held (8.4).
- **(c) decide** takes the first case that applies — echo, value-already-equal
  (`confirmed`), the order-key comparison, `superseded` — and only here can a
  current value change.
- **(d) repair** is condition 8.3, after every field whatever happened to it.

**The duplicate claim and the apply share one transaction:** split them and a
crash between marks an event processed that was never applied, which Salesforce
will never resend. **Fields are independent**, so one event may apply `phone` and
supersede `city`, making the event's outcome `partial`.

> A change whose canonical value already equals the current value changes
> **nothing** — not the value, not the order key, and not history.

| Resolving the record | Rule |
| --- | --- |
| **(a)** known `sf_id` | one indexed lookup, lock, proceed |
| **(b)** unknown `sf_id`, human `changedBy` | mint a `portal_id`, insert link and empty row, apply every field as a first write. **Recovery (10.3) reuses this** |
| **(c)** unknown `sf_id`, integration user | the echo of a create *we* made. **503 + `Retry-After: 5`, apply nothing**; by redelivery it is case (a). After 60 s, log loudly and treat as (b) |

**400 versus 500**, since a 400 discards the event forever: an unknown *field
name* earns one; a *value* we failed to canonicalise is our bug and earns a 500.

## 6. The outbound path

**6.1 The portal save.** The handler takes part 5's record lock, stamps
`occurred_at` from `clock_timestamp()` and the actor from the session (A9), calls
`applyChanges`, and commits — **the value change and the queue row are the same
commit**, created by **condition 8.3, as on the inbound path**.

**6.2 The worker loop** (Appendix C.4). Each tick: hold the leader lease (else
idle as a standby, [ADR 0003](adr/0003-one-sender-with-a-leader-lease.md));
reclaim rows whose 30-second lease expired; probe instead of claiming if the
breaker is open; claim **whole records**, oldest-due first so nothing starves;
read current values and build one call per record; take a governor token; send
and settle. `attempts` rises when a row is **claimed**, not when it fails, so a
row that crashes us mid-send cannot be retried forever.

**6.3 Coalescing, and reading the value late.** All fields owed on one record
become **one** call — a four-field form save is four rows and one PATCH.

> The sender reads each field's **current value at send time**, never a value
> carried on the queue row, which is why part 4 stores none.

A city edit at 09:00 and another at 11:00 during an outage therefore send **the
11:00 value, once.** On a `2xx`, **after** the response and never before, the
sender sets `sf_value` to what it sent, writes the `echo_fence` rows, and records
`sent_at` (Appendix B traces the divergence that first step prevents).

**6.4 The cap, slowing down, and the breaker. 70 of the 100 req/s,** both bounds
chosen. *Not 100:* the cap counts our retries and belongs to the client's org, so
another integration's burst would reach us as rejections, while at 70 a 30% burst
is absorbed. *Not lower:* catch-up scales inversely — 10.4 row 1 drains in
6.3 min, row 5 at a governor of 25 takes 16.0. Steady state spends ~7.4 req/s, so
we run at **11% utilisation** and the other 89% drains backlogs.

On a slow-down signal (A8), nothing is dropped:

```
rate := max(5, rate / 2)                   -- multiplicative decrease
row.state := 'pending'
row.next_attempt_at := now + (Retry-After, else 2^attempts s jittered, cap 300 s)
row.attempts := attempts - 1               -- given back: not the row's fault
recover: rate := min(70, rate + 5) per 30 s of clean responses
```

**The breaker splits two failures, and that split is what makes a 6-hour outage
survivable.** An **endpoint failure** (refused, timeout, 5xx) says nothing about
the row: after 5 consecutive ones we stop claiming and probe every 30 s, and
claimed rows return to `pending` **with attempts restored**. A **row failure**, a
400-class rejection naming this record's data, is the only kind counting attempts
toward giving up (F.6).

**6.5 Restart, and settling a group.** A restart is a non-event: the new process
takes the lease, reclaims expired rows, and resumes; a row that reached
Salesforce before the crash is sent again, safely, because all three calls are
idempotent (C.1).

| Outcome | State | Attempts | Then |
| --- | --- | --- | --- |
| `2xx` | `sent` | — | set `sf_value`/`sf_observed_at`; write `echo_fence`; record `sent_at` |
| `429` / limit | `pending` | restored | halve the rate; honour `Retry-After` |
| timeout / refused / `5xx` | `pending` | restored | counts toward the breaker; backoff with jitter |
| `400`-class, data rejected | `failed` | kept | **alert** — a value we accept and Salesforce refuses needs a human |
| `404`, record gone | `failed` | kept | **alert** — deletes are out of scope (A15) |
| `401` / `403` | `pending` | restored | **page, stop the sender** — else the queue burns into `failed` |

A `failed` row is never deleted; it keeps its `last_error`.

## 7. The rule when both sides change the same record

**7.1 Who is doing the merging.** **Salesforce has no merge logic**, so our
database holds the decision — and hence the rule that is easy to miss: **a
webhook we reject is not a no-op.** It is the discovery that Salesforce holds a
value we rejected, and it owes an outbound call (8.3).

**7.2 The order key — the field that decides which edit is current.**

| Component | On a webhook | On a portal save |
| --- | --- | --- |
| `occurred_at` | **the payload's `occurredAt`** | **`clock_timestamp()` of the saving transaction** (A9) |
| `origin_rank` | `1` | `0` |
| `origin_event_id` | **the payload's `eventId`** | the portal change id, a ULID per save |

> **Apply the incoming change if and only if its order key is strictly greater
> than the stored one.**

`clock_timestamp()`, not `now()`, which returns the transaction's start. On an
exact tie **Salesforce wins**, the cheaper direction; a shared millisecond (A11)
breaks on `origin_event_id`, arbitrarily but **stably**. Strictness is
load-bearing: `>` and not `>=` makes re-applying an applied change a no-op (F.7).

**7.3 Canonical form.** Canonicalised **before** being compared or stored; the
stored form is canonical.

| Field | Canonical form |
| --- | --- |
| all text | Unicode NFC; trim; collapse internal whitespace runs to one space |
| `email` | the above, then lowercased whole |
| `phone` | E.164 by the contact's country; on a parse failure, digits with a leading `+`, and count it |
| `status` | mapped through the agreed picklist vocabulary |
| `customer_id` | the `portal_id` UUID, lowercase hex |
| empty | `''` and `NULL` are one thing, stored `NULL` |

Not hygiene — this is what makes part 9 true: **one formatting difference reads as
a change and turns the sync into a generator of its own traffic** (F.7).

**7.4 Different fields — the brief's own scenario.** No conflict rule needed,
which is the argument for ADR 0002: finance sets `city`, then sales changes
`phone` and the webhook names `phone` only (A3), so `city` is never looked at.
The portal ends with the new phone **and** the finance city, each with its own
actor and time (Appendix A).

**7.5 The same field. Across the two sides:** the order key decides; the winner
gets an `applied` row; **the loser is kept** as `superseded` with its value, actor
and time (the brief is explicit that an earlier edit stays on record); and **if
the loser was Salesforce's value, a repair write is enqueued** (8.3). **Two
portal users:** the record lock serialises the saves rather than tying them, so
the second wins on a later `clock_timestamp()` and the first's value survives in
`field_change` under their name. What they *see* is a product decision (open
question 4); my rule is that the portal renders each field as "set by X at T" and
names who replaced a submitted value — **no blocking, no merge dialog.**

**7.6 Two clocks: the rule for the skew window.** 7.2 compares Salesforce's clock
against ours, so inside the skew window (A10: 2 s) an edit made second can rank
first.

> **The order key stays authoritative inside the window; we do not detect or
> correct an inversion. We bound the skew, and we measure and page on the
> inversions.**

| | |
| --- | --- |
| **Bound** | hosts run NTP; drift above **500 ms** is a host alarm, so at most a quarter of A10's 2 s is ours |
| **Measure** | **cross-side near-tie inversions/hour**: `superseded` rows whose superseding change has the opposite `origin` and `abs(Δ occurred_at) ≤ 2 s` |
| **Warn / page** | 5/hour; **20/hour**, or a rolling 4-hour window where **≥ 80%** of inversions favour one origin |

The bias threshold does the work: genuine races go both ways, so a sustained
one-directional result is the signature of real skew. **No deterministic in-window
tiebreak is offered** (F.7).

## 8. Duplicates and out-of-order changes

**8.1 A duplicate webhook. `eventId` is the idempotency key, claimed in the same
transaction as the apply.** No row from the `ON CONFLICT DO NOTHING` means we have
seen it: commit, answer `200 {"status":"duplicate"}`, change nothing. Salesforce
has done nothing wrong (A7), so this is counted, not alerted. Two independent
layers, **and only the second is the guarantee:** *suppression*, the table, so a
duplicate does no work; and *harmlessness*, the strict `>` of 7.2, which makes an
unsuppressed duplicate a no-op anyway — the table falls to a prune or a truncate,
the compare holds regardless (F.8). A repeated `eventId` carrying a *different*
`payload_hash` is a provider bug: first write wins, and this one **is** alerted.

**8.2 An older webhook after a newer one.**

> **Compare order keys per field; a change not strictly newer never becomes
> current, and is recorded `superseded`.**

```
evt_A  phone -> ...0001  occurredAt 11:30:04.000    evt_B  phone -> ...0002  11:30:09.000

B first:  11:30:09 > stored           -> APPLIED. current ...0002,
                                         sf_value ...0002, sf_observed_at 11:30:09
A second: (a) 11:30:04 NOT > 11:30:09 -> sf_value LEFT ALONE (a later SF state is known)
          (c) 11:30:04 < 11:30:09     -> SUPERSEDED. history keeps ...0001,
                                         sales.user, 11:30:04; current stays ...0002
          (d) sf_value = current      -> NO repair write
```

Step (a) is what makes this correct rather than merely plausible: `evt_A`
describes a **past** state of Salesforce, so `sf_value` must not move. **No
reordering buffer** — A11 gives no sequence numbers, so we cannot detect that
anything is *missing* (F.8).

**8.3 The repair write — one condition for every case.**

> **After every field, regardless of what happened to it: if
> `field_version.sf_value` is distinct from the current value, enqueue a repair
> write.**

"Distinct from" is SQL's `IS DISTINCT FROM`, and the NULL case is load-bearing:
**an `sf_value` we have never learned is distinct from any current value.**
Without it every portal-created record would be stranded.

| What happened | `sf_value` after | Current | Repair? |
| --- | --- | --- | --- |
| Salesforce change applied | the new value | the same | no |
| Salesforce value superseded by a newer portal edit | Salesforce's | ours | **yes** |
| older event after a newer one (8.2) | unchanged | matches it | no |
| echo of our own write | what we sent | the same | no |
| Salesforce restates a value we hold | that value | the same | no |
| full-record restatement during an outage (8.4) | Salesforce's stale value | our unsent edit | **yes** |

It **terminates** — the repair sends our current value, the echo sets `sf_value`
to it, the condition goes false — and it is the **entire logic of outage
recovery** (10.3).

**8.4 If a webhook carries the full record instead.** A3 assumes
changed-fields-only, and **full-record mode is the dangerous one**, because a
field's silence and its restatement look identical. *The hazard:* finance sets
`city` to Noida at 15:00, unsent; at 16:00 a sales user changes the phone and the
full-record payload restates `city: "Gurugram"`, stamped 16:00. Compared as a
change, `16:00 > 15:00`, so we would **overwrite the finance edit with an older
value Salesforce was merely restating.**

> *The rule,* step (b) of the apply: **a field whose canonical value equals the
> `sf_value` we already held is a restatement — not restamped, not compared, not
> touched.**

Traced: `sf_value[city]` is already `Gurugram`, so `city` is skipped and stays
Noida while 8.3 enqueues the repair we already owed; `phone` differs and applies
normally. **Step (b) is unconditional**, whatever the payload shape, which is why
`applyChanges` needs no mode parameter — and the outage sweep (10.3) requires it
regardless.

## 9. The rule that stops a loop

Ranked second of eight: a loop consumes the whole 100 req/s budget and stops sync
for every record at once, within seconds of deployment.

> **9.1 — L1, the structural rule.** Outbound work is created exactly when
> `field_version.sf_value` differs from a field's current value — condition 8.3,
> after every field, on both paths, and nowhere else.

```
portal sets city = Noida  -> sf_value "Gurugram" <> "Noida"  -> 1 outbound row
we PATCH Noida, 2xx       -> sf_value := "Noida"                            (6.3)
Salesforce echoes Noida   -> sf_value "Noida" = current       -> 0 rows.  Dead.
```

No fuel after one hop, because there is nothing left to disagree about.
**Precondition: canonical form (7.3).**

> **9.2 — L2, the actor rule.** A webhook whose `changedBy` is the integration user
> (A6) is an echo: recorded, never compared, never applied.

L1 guarantees the loop stops; L2 that it stops on the **right value**, since an
echo carries a later time than the edit our write overwrote and would otherwise
launder a stale value over a newer one (Appendix B).

> **9.3 — L3, the echo fence.** After a 2xx the sender records the record, field and
> hash of the canonical value sent, expiring in 15 minutes; an inbound change
> matching an unexpired entry is an echo.

> **9.4 — L4, the repair breaker.** Above **5 repairs to one field in an hour**,
> enqueue nothing more for it, mark it contested, and alert.

L3 is L2's guarantee keyed on the value rather than the actor, so it holds if A6
is false. L4 bounds the one way L1 fails: a spelling our canonical form does not
normalise makes every echo read as disagreement.

| | Guarantees | Absent |
| --- | --- | --- |
| **L1** + canonical form | the loop **terminates** | everything; no other layer saves us |
| **L2** | it terminates on the **right value** | our own write launders a stale value over a newer one |
| L3 | L2's guarantee without A6 | nothing, while A6 holds |
| L4 | bounds L1's one failure mode | an unbounded argument over one field |

## 10. The 6-hour outage

**10.1 What it is.** Six hours with the Salesforce API unreachable and webhooks
sent during it possibly never arriving — dark both ways at once (A16).

**The arithmetic uses the business-hours average of 3 edits/s, not A1's 20/s
peak.** Saying so up front because the two differ greatly — about 6 minutes
against about 35 — and the choice is a judgement, not an oversight: a peak is a
15-minute phenomenon, and six consecutive hours of one is not credible. The peak
is carried as row 3 of 10.4, so both numbers are on the page. **The portal keeps
working throughout:** edits apply locally and queue for Salesforce, so the only
cost is visibility there, and the 30-second target does not apply during catch-up.

**10.2 What is on disk.**

| | At the worst moment | Why |
| --- | --- | --- |
| `outbound_change`, `pending` | **19,440 rows, ~4.9 MB** | each committed with the edit that caused it (6.1) |
| rows left `inflight` by a restart | a handful | reclaimed when the 30-second lease expires |
| `sync_watermark` | one row per object type | where the sweep resumes |

Five megabytes is what "pending calls must still be there after our process
restarts" costs, and **a restart during the outage is a non-event.**

**10.3 How we drain it — and why the order is not negotiable.**

> **The inbound sweep must complete before the outbound drain begins.**

The loss it prevents: finance sets a city to Noida at 15:00, queued unsent; at
17:00 a sales user sets it to Delhi in Salesforce and that webhook never arrives.
*Drain first:* we PATCH Noida, Delhi is overwritten, and the sweep reads back our
own value — **Delhi is destroyed with no record it existed.** *Sweep first:*
Delhi's 17:00 `SystemModstamp` beats the portal's 15:00, Noida is kept as
`superseded` under the finance user's name, and the queued row then sends the
**current** value (6.3) — Delhi, a no-op.

With 14,954 portal-touched and 34,892 Salesforce-touched records out of 5 M
(row 1), the expected overlap is `14,954 × 34,892 / 5,000,000` = **104 records**,
and the ordering costs no time. **The sweep also depends on the restatement rule
(8.4)**, since a `SystemModstamp` is a *record's* time, so a record touched at
17:00 hands back every field stamped 17:00. Appendix C.5 has the sequence: probe,
hold the drain, page through the changed-since query feeding each record in as a
full-record observation, advance the watermark per page, release at half rate.

**10.4 The arithmetic — every figure, in one table.** Every number in this
document comes out of these lines; the table varies one assumption per row.

```
window           6 h x 3600                                 = 21,600 s
queued changes   portal edits/s x 21,600
outbound calls   queued changes / 1.3 changes per record      (coalescing, 6.3)
drain capacity   governor - 7.4 req/s reserved for live traffic
                 (7.4 = peak steady state: (6 + 0.7 repairs) x 1.1 retries, 6.4)
drain            resume at half the governor, +5 req/s every 30 s, then full
sweep            Salesforce records / 2,000 per SOQL page     (requests)
                 Salesforce records / 500 per second          (local apply)
total            sweep + drain  -- the sweep blocks the drain (10.3)
```

| # | Scenario | What varies | portal /s | queued | calls | drain | SF records | reqs | sweep | **total** |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **1** | **base** | — | 0.90 | 19,440 | 14,954 | 5.1 | 34,892 | 18 | 1.2 | **6.3** |
| 2 | no coalescing | 1.0 chg/rec | 0.90 | 19,440 | 19,440 | 6.3 | 34,892 | 18 | 1.2 | **7.5** |
| 3 | sustained peak | A1 → 20/s | 6.00 | 129,600 | 99,692 | 27.7 | 232,615 | 117 | 7.8 | **35.4** |
| 4 | portal-heavy | A2 → 70% portal | 2.10 | 45,360 | 34,892 | 12.0 | 14,954 | 8 | 0.5 | **12.5** |
| 5 | contended cap | A12 → governor 25 | 0.90 | 19,440 | 14,954 | 14.8 | 34,892 | 18 | 1.2 | **16.0** |
| 6 | no changed-since | A4 false → all 5 M | 0.90 | 19,440 | 14,954 | 5.1 | 5,000,000 | 2,500 | 16.7 | **21.8** |

Drain, sweep and total are minutes. **Row 1 is the answer: about 6 minutes.**

```
Row 1, with the division shown
queued     0.9 x 21,600                             = 19,440 changes
calls      19,440 / 1.3                             = 14,954
capacity   70 - 7.4                                 = 62.6 req/s at full rate
ramp       35,40,45,50,55,60,65 req/s, 30 s each, each minus 7.4:
           (27.6+32.6+37.6+42.6+47.6+52.6+57.6) x 30 = 8,946 calls in 210 s
rest       (14,954 - 8,946) / 62.6                  = 96.0 s
drain      210 + 96.0 = 306.0 s                     = 5.1 minutes
sweep      2.1 x 21,600 / 1.3                       = 34,892 records
           34,892 / 2,000 = 18 requests (0.3 s of budget)
           34,892 / 500   = 69.8 s                  = 1.2 minutes
TOTAL      1.2 + 5.1                                = 6.3 minutes
```

Allow **under 10 minutes** operationally, covering page-fetch latency, retries,
and the breaker needing a few probes to close. **Beyond row 1:** the **cap is the
floor, not our design** — row 3 at the full 100 req/s with no reserve is still
`99,692 / 100 = 997 s = 16.6 min`, so our 30% reserve costs ~11 minutes in the
worst credible case (A12). **Row 6 demotes A4** from load-bearing to preferable,
and I would run that sweep **nightly regardless**, as the standing net under lost
webhooks, canonicalisation gaps, fields L4 gave up on, and 7.6's inversions.

## 11. Three numbers I would watch

One per failure mode: outbound stuck, inbound slow, and getting it wrong. The
third is the only one that detects incorrectness rather than slowness.

| | Number | Normal | Warn | **Call someone** |
| --- | --- | --- | --- | --- |
| **1** | **age of the oldest unsent change** — `min(created_at)` over `pending` | < 5 s | 60 s | **300 s (5 min)** |
| **2** | **inbound lag** — p99 `applied_at − occurred_at`, Salesforce-origin, last 5 min | < 6 s | 20 s | **> 30 s for 5 min** |
| **3** | **divergence** — repairs + Salesforce-origin `superseded` per minute; **and** 7.6's inversions per hour | ~0; < 1/h | 10/min; 5/h | **100/min; 20/h; or ≥ 80% one-way over 4 h** |

**Age, not depth,** for number 1: 19,000 rows draining fast is healthy, 3 rows
stuck is not. Number 2 **includes Salesforce's own emission delay**, because the
30 seconds we promised is end to end. Number 3 is the only one that reports a skew
past A10, a canonicalisation gap, or a loop rule that stopped working. **On the
dashboard but not paging:** the governor's rate and 429 count, the breaker's
state, rows in `failed` and fields marked contested, signature failures and 400s,
and `sync_watermark` lag.

## 12. What I am leaving out

**Because the exercise says so:** deletes (A15), Salesforce login screens, any
visual UI, a second region, and load testing real Salesforce. Where code exists
it runs against a fake Salesforce I wrote.

**Because I chose to:** the **initial 5 M backfill** (S8, costed as row 6 of
10.4); **Salesforce auth lifecycle** (mechanical); **schema-change handling** (L4
degrades an unknown picklist value into a contested field, not a loop);
**merging already-duplicated records** (a pre-existing data-quality problem);
**field-level permissions** (open question 6); **objects and fields beyond the
nine** (A14); **the portal's overwrite notice** (7.5's rule is designed, the UI
is not); **right-to-erasure against permanent history** (open question 5); and
**the monitoring plumbing** (part 11 has the queries).

**What I would build first:** S1 and S2 alone for a week — the merge rule, the
history, canonical form, and the one condition — against a fake Salesforce;
everything after is plumbing around a decision that has to be right first. And I
would get open question 1 answered first: Change Data Capture replay ids would
retire A11, strengthen 8.2 from ordering-what-arrived to detecting-what-is-missing,
and turn the recovery sweep into a replay.
