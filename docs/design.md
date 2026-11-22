# Two-way sync of customer and contact records

**Design document — Tequity Round 1**

Sales edits customers and contacts in Salesforce; finance and customer-success
edit the same records in the portal Tequity built on Postgres. Both copies must
agree within 30 seconds while both are up, every field's history must be kept,
and we control only our side.

Parts 7–10 are the four rules; all arithmetic is one table in 10.4. The
appendices carry what the body points to: **A** the brief's scenario traced,
**B** the hardest race, **C** schema, interfaces and sequences, **D** the
reasoning behind each assumption and the alternatives rejected. `docs/adr/` has
the three decisions expensive to reverse.

---

## Summary

The unit of sync is a **field**, not a record. Each field carries an **order
key** `(occurred_at, origin_rank, origin_event_id)` and the current value is
the one whose key is greatest. `occurred_at` is the webhook's `occurredAt`
inbound, our own `clock_timestamp()` on a portal save.

**Salesforce has no merge logic** — it overwrites with whatever lands last. We
are the only party that compares anything, so our database holds the decision
and Salesforce's copy is a projection of it. Hence the one rule everything
follows from:

> **Outbound work is created exactly when `sf_value` — what we believe
> Salesforce holds for a field — differs from that field's current value.**
> Checked after every field, on both paths, nowhere else.
> *We call Salesforce when, and only when, we believe Salesforce disagrees with us.*

| Rule | | § |
| --- | --- | --- |
| **Duplicate** | `eventId` claimed in the apply's own transaction; and the compare is strictly `>`, so a duplicate escaping the table is a no-op anyway | 8.1 |
| **Out of order** | compare order keys per field; a change not strictly newer never becomes current, and is kept as `superseded` with its actor and time | 8.2 |
| **Loop** | an echo makes `sf_value` equal the current value, so the condition goes false — no fuel after one hop | 9.1 |
| **6-h outage** | queue rows commit with the edit, so they survive a restart; on recovery the inbound sweep runs **before** the outbound drain | 10.3 |

**Numbers.** Peak 20 edits/s assumed, business-hours average 3, quiet hour 0.5.
We run at **70 of the 100 req/s** allowed, 11% used in steady state. A 6-hour
outage queues **19,440 changes → 14,954 calls**, draining in 5.1 min; with the
1.2-min sweep first, **6.3 min** (row 1, 10.4). The 30-second target closes at
~6 s both ways, of which 7 of the 9.8 worst-case seconds are Salesforce's.

---

## 1. Assumptions, and the questions I would ask

Nothing below was given. **[Appendix D](#appendix-d-assumption-consequences-and-rejected-alternatives)
gives what changes if each goes the other way** — required reading beside this
table. The five the exercise names are A1, A3, A4, A7, A9.

| | Assumption |
| --- | --- |
| **A1** | **Peak 20 edits/s; business-hours average 3/s; quiet hour 0.5/s.** Derived: 5 M records × ~4 touches/yr = 20 M/yr ÷ (250 d × 8 h = 7,200,000 s) = 2.8/s, × 7 peak factor. **10.4 uses the 3/s average — 10.1 says why** |
| **A2** | 70% of edits originate in Salesforce, 30% in the portal |
| **A3** | **A webhook carries only the changed fields**, per the sample |
| **A4** | **Salesforce can be queried for records changed in a window** — SOQL on `SystemModstamp > :watermark`, 2,000 records per request |
| **A5** | **Creates can be made idempotent** via external-id upsert keyed on our own `portalId` |
| **A6** | `changedBy` names the API caller, so our integration user is recognisable in it |
| **A7** | **Delivery is at-least-once**, HTTPS, HMAC-SHA256 over the raw body, retried on 5xx or timeout |
| **A8** | Throttling arrives as 429 or `REQUEST_LIMIT_EXCEEDED`, with `Retry-After` when available |
| **A9** | **On a portal save, the time comes from our database** (`clock_timestamp()`) **and the actor from the authenticated session** — not the body's `editedBy`, which a caller could forge |
| **A10** | Clock skew between Salesforce's clock and ours is at most 2 s |
| **A11** | `occurredAt` is UTC, millisecond resolution; two edits can share a millisecond |
| **A12** | The 100 req/s cap is ours alone to spend, and **we run at 70** |
| **A13** | Salesforce emits a webhook within 5 s p99; a record write returns within 2 s p99 |
| **A14** | The nine named fields are the whole schema |
| **A15** | No record is ever deleted (the exercise's scope) |
| **A16** | **The outage is dark both ways at once** — the brief's two sentences jointly imply it, and it is the harder reading |

**Questions I could not close with an assumption.**

1. **How is the webhook produced** — Apex callout, Platform Event, Change Data
   Capture, middleware? Decides A4, A6 and A11 together and would let me delete
   a third of part 8. Highest-value question here.
2. **Is there an external-id field on Account and Contact we may write?** (A5.)
3. **What else in the client's org spends the API limit?** (A12, row 5 of 10.4.)
4. **When two portal users edit one field, what should the second see?** 7.5
   gives my rule, but it is a product decision.
5. **Must history be retained legally, and does that conflict with
   right-to-erasure?** Part 4 never deletes a change; someone should sign that
   off rather than inherit it from me.
6. **Is any field single-owner?** I assume not; if some are, part 7 simplifies
   for them and we need a per-field ownership table.

---

## 2. The systems, who calls whom, the network seam, the interfaces

```
   sales user                        finance / customer-success user
       | edits in                                 | edits in
       v                                          v
+----------------+                     +---------------------+
|  SALESFORCE    |                     |  TEQUITY PORTAL     |
| their CRM + DB |                     |  our app            |
+----------------+                     +---------------------+
    |        ^                               | in-process
    |        |                               v
    |        |                 +-------------------------------+
    |        |                 | MERGE   order keys, history,  |
    |        |                 | echo and repair decisions     |
    |        |                 +-------------------------------+
    |        |                      |                ^
    |        |                      v                |
    |        |                 +-------------------------------+
    |        |                 | POSTGRES  records, field      |
    |        |                 | history, outbound queue       |
    |        |                 +-------------------------------+
    |        |                     ^                  |
    |  === PUBLIC INTERNET ===     |                  v
    |        |  the only path      |          +----------------+
    |        |                     |          | SYNC WORKER    |
    |        |  (A) Salesforce->us [EP]-------| governor,      |
    +--------|-------------------->|          | retries, sweep |
             |     HTTPS webhook              +----------------+
             |  (B) us->Salesforce                   |
             +---------------------------------------+
                HTTPS record API: create / update / changed-since

  [EP] WEBHOOK ENDPOINT (ours): validate, dedupe, MERGE, commit, 200.
```

| Path | Caller | Callee | Trigger | Cap |
| --- | --- | --- | --- | --- |
| **A** | Salesforce | our webhook endpoint | a record changed in Salesforce | none — inbound is outside the cap |
| **B** | our sync worker | Salesforce record API | we believe Salesforce disagrees with us | 100 req/s hard; we run at 70 |
| — | the portal's save handler | MERGE, in-process | a portal user saved | not a network call |

No human crosses the internet seam; only paths A and B do.

**Two processes, one repository, and the seam between them is Postgres** — not
HTTP, not a broker ([ADR 0001](adr/0001-two-processes-with-postgres-as-the-seam.md)).
The endpoint is latency-sensitive and horizontally scalable and must never
block on Salesforce; the worker is the single governor of a shared cap, so we
want exactly one. The decisive argument is transactional: the queue must
survive a restart anyway, and once it is in the same database the inbound apply
and the outbound enqueue are **one commit**, so "we changed a value" and "we
owe Salesforce a call" cannot disagree after a crash.

| Crosses the boundary | Written by | Read by | Means |
| --- | --- | --- | --- |
| `outbound_change` | endpoint and portal, in the merge transaction | sync worker | "we believe Salesforce disagrees about this field" |
| `echo_fence` | sync worker, after a successful send | endpoint | "we just wrote this value; expect it back" |

**The interface on each side** is in
[Appendix C.1](#c1-the-interface-on-each-side): our webhook endpoint's contract
and status codes, the three Salesforce record-API operations we depend on —
each idempotent **by design**, which is what makes at-least-once sending safe —
and `applyChanges`, the one interface every edit path goes through. Two facts a
caller most needs: **a 200 is returned only after our transaction commits**, and
redelivering an event that got a 200 is harmless.

**Seams.** `SalesforceClient` has two real adapters, live HTTPS and the demo's
fake. Postgres deliberately has none: there will only ever be one, and
abstracting it would hide the transaction semantics parts 5 and 6 rest on.

**Does 30 seconds close?** Yes, at ~6 s both ways:

| Portal → Salesforce | p99 | Salesforce → portal | p99 |
| --- | --- | --- | --- |
| commit (queue row is in it) | — | Salesforce emits (A13, **not ours**) | 5.0 s |
| worker notices (`NOTIFY`, 1 s poll fallback) | 1.0 s | network | 0.5 s |
| coalescing window | 1.0 s | our apply transaction | 0.2 s |
| queue wait at 11% utilisation | 0.1 s | | |
| Salesforce write (A13, **not ours**) | 2.0 s | | |
| **total** | **4.1 s** | **total** | **5.7 s** |

The slack is insurance against A13: 7 of the 9.8 worst-case seconds are
Salesforce's emission delay and write latency, neither ours to fix. **No
inbound queue** — at A1's peak the endpoint commits 14 transactions a second.
What would change that: inbound apply p99 above 1 s, or sustained commits above
500/s.

---

## 3. The subproblems, in the order I would build them

**Ordered by risk:** (1) getting it wrong loses data unrecoverably, (2) getting
it wrong is silent, (3) other code is built on the decision. That puts the
merge rule first and the backfill last — the opposite of the data's flow, since
the backfill runs before any sync and is still last, being one-off and
re-runnable.

| | Subproblem | Why here | Demo |
| --- | --- | --- | --- |
| **S1** | decide a field's current value, and keep what it displaced | scores on all three: a wrong merge loses a real edit permanently and silently, and every write path is built on its schema | **yes** — the phone-and-city scenario, both values and full history |
| **S2** | stop a change going round forever | the only self-amplifying failure: a loop eats the whole cap and stops sync for every record within seconds | **yes** — our own update returns and is not sent back |
| **S3** | hold outbound work on disk and spend the cap | S1's severity, lower likelihood — a transactional outbox is a known shape, and risk is severity × likelihood | **yes** — a pending call survives a restart with the fake down, then drains; the cap is enforced |
| **S4** | make inbound delivery safe to repeat and to reorder | cannot be earlier: "older" needs S1's order key. Severe but **detectable** and repairable by replaying from the watermark | **yes** — a duplicate, and an older event after a newer one |
| **S5** | know which record is which across the systems | a lost create response can make a second Salesforce record: bad, hand-cleaned, but bounded and visible at once | no |
| **S6** | recover what was missed while a side was dark | sixth to build, **first to ask about** — failure is fixed by re-running, but it rests on A4 | no |
| **S7** | prove the webhook came from Salesforce | a gate, not a risk; stubbed day one, filled before production | no |
| **S8** | load the 5 million existing records | one-off, offline, no latency target, re-runnable | no |

The demo covers **S1–S4 and nothing below** — exactly the four whose failures
are unrecoverable or silent. S5–S8 fail visibly and are fixed by re-running
something, so a green demo would say little about them.

**Four of the eight add no component.** S1 adds MERGE and the record/history
tables; S3 adds `outbound_change`, the worker, the governor and
`SalesforceClient`; S4 adds `inbound_event` and the endpoint; S5 adds
`record_link`. S2, S6, S7 and S8 add **no process** — termination is a property
of MERGE, the sweep runs inside the existing worker, the signature check is
middleware, and the backfill is a script outside the running system.
Deliberately absent: no broker, no inbound queue, no cache in front of MERGE's
row locks, no per-field ownership table (open question 6).

---

## 4. The data we store

Eight tables; [Appendix C.2](#c2-schema) has the DDL.
[ADR 0002](adr/0002-merge-per-field-not-per-record.md): **the unit of sync is a
field** — forced, since the brief's own scenario has a portal city edit and a
Salesforce phone edit concurrent with each other, and a record-level comparison
must discard one, unable to see they touched different fields.

| Table | Holds | Note |
| --- | --- | --- |
| `customer`, `contact` | **the current values**, typed, as the portal already wants them | the current value lives **here and nowhere else**; two copies would be two things that can disagree |
| `field_version` | the **order key** per `(record, field)`, plus `sf_value` / `sf_observed_at` | a **cache, not a second truth** — derivable from the logs below, and a rebuild is the repair for any doubt. Also the row MERGE locks |
| `field_change` | **the history**: append-only, `applied` and `superseded`, both **permanent** | what the client is buying. `superseded` is kept because the brief says the fact of an earlier edit stays on record |
| `sync_observation` | `echo` and `confirmed` observations, 90-day partitions | neither is an edit by a person, so neither is history; mixing them in would inflate permanent history ~30% and defeat partition pruning |
| `inbound_event` | the duplicate key, 30-day retention (104 MB) | 8.1 |
| `outbound_change` | the **durable queue** — which field is owed, **never the value** | so a row queued three hours into an outage cannot deliver a value we have since superseded (6.3) |
| `record_link` | Salesforce id ↔ portal id, and the per-record lock | a portal-created record has a `portal_id` before an `sf_id` |
| `echo_fence`, `sync_watermark` | "we just wrote this" (15-min TTL); how far through Salesforce's history we are sure | 9.3, 10.3 |

**Does the storage close?** 5 M typed rows at 1.2 GB; **27 M** `field_version`
rows (1 M customers × 3 fields + 4 M contacts × 6) at 5.5 GB with its index;
`field_change` at **26 M rows/year** (20 M edits × 1.3 fields) and **5.2 GB/yr,
kept forever because it is the product**; everything else under 1 GB.
**~13 GB in year one, growing 5 GB/yr** — almost entirely permanent history,
which makes keeping it a product decision rather than a budget one.

---

## 5. The inbound path

**One HTTP request becomes one Postgres transaction**, with no network call
inside it and no background step. The sequence is
[Appendix C.3](#c3-the-inbound-apply-one-transaction): validate, claim the
`eventId`, lock the record, then per field **learn → decide → repair**, then
commit and answer 200.

Four properties are deliberate:

- **The duplicate claim and the apply share one transaction.** Split them and a
  crash between marks an event processed that was never applied — and
  Salesforce will never resend it, since A7 only promises redelivery while we
  have not answered 200. The most important line in the path.
- **No network call is inside it**, which keeps the endpoint's p99 at 200 ms
  and stops a Salesforce outage becoming held Postgres locks.
- **Fields are independent**: one event may apply `phone` and supersede `city`,
  and the event's outcome is then `partial`.
- **Learning is separate from deciding.** Step (a) records what Salesforce
  holds before step (c) decides anything, and regardless of what it decides, so
  an event we reject still teaches us Salesforce's state — which is what
  collapses repair into the single condition 8.3.

**Resolving the record, including creates:**

| Case | Rule |
| --- | --- |
| **(a)** known `sf_id` | one indexed lookup, lock, proceed |
| **(b)** unknown `sf_id`, `changedBy` a human | a Salesforce-created record we have not seen: mint a `portal_id`, insert the link and an empty row, apply every field as a first write. **Recovery (10.3) reuses this path** |
| **(c)** unknown `sf_id`, `changedBy` the integration user | the echo of a create *we* made, arriving before we recorded the id it returned. **Answer 503 + `Retry-After: 5`, apply nothing** — by the redelivery the link exists and it becomes case (a). Bounded: after 60 s log loudly, treat as (b), and let the unique index plus a reconciliation sweep catch the duplicate |

Treating (c) as (b) would mint a second local record for one real contact.
Narrowing it to the integration user matters: deferring whenever *any* create
is in flight would delay legitimate Salesforce creates by 5 s most of the time
at A1's rate, to fix a race that only involves our own writes.

**400 versus 500** is the pair to get right, since a 400 discards the event
forever: an unknown *field name* earns one, a *value* we failed to canonicalise
does not — that is our bug and deserves a 500 and a retry.

---

## 6. The outbound path

### 6.1 The portal save

The handler takes the same record lock as part 5, stamps `occurredAt` from
`clock_timestamp()` and the actor from the authenticated session (A9), calls
`applyChanges`, and commits. **The value change and the obligation to tell
Salesforce are the same commit:** die after it and the row is on disk, die
before and the edit did not happen and the user is told. There is no third
outcome — that is what ADR 0001 bought.

What creates a queue row is **condition 8.3, the same one the inbound path
uses**, so a save re-submitting the same city creates nothing, and a save that
happens to set the value Salesforce already holds creates nothing either.

### 6.2 The worker loop

[Appendix C.4](#c4-the-outbound-worker-loop) has it. Each tick: hold the leader
lease (else idle as a standby, [ADR 0003](adr/0003-one-sender-with-a-leader-lease.md));
reclaim rows whose 30-second lease expired; probe instead of claiming if the
breaker is open; claim **whole records**, oldest-due first so nothing starves;
read current values and build one call per record; take a governor token; send
and settle. `attempts` rises when a row is **claimed**, not when it fails, so a
row that crashes us mid-send still counts and cannot be retried forever.

### 6.3 Coalescing, and reading the value late

All fields owed on one record become **one** call — a four-field form save is
four rows and one PATCH.

> The sender reads each field's **current value at send time**, never a value
> carried on the queue row, which is why part 4 stores none.

A city edit at 09:00 and another at 11:00 during an outage send **the 11:00
value, once**. Sending the queued values in order would mean two calls and a
window where Salesforce holds a value we superseded four hours earlier. The
cost: the queue is a claim ticket, not a message log — `field_change` is that
log, and a better one.

On a `2xx`, **after** the response and never before, the sender sets `sf_value`
and `sf_observed_at` to what it sent — *our own write is the most recent thing
we know about Salesforce's state* — writes the `echo_fence` rows, and records
`sent_at`. Appendix B traces the silent divergence that first step prevents.

### 6.4 The cap, slowing down, and the breaker

**70 of the 100 req/s,** both bounds chosen. *Not 100:* the cap counts our
retries and belongs to the client's org, so another integration's burst would
reach us as rejections, while at 70 a 30% burst is absorbed. *Not lower:*
catch-up scales inversely — row 1 of 10.4 drains in 6.3 min, row 5 at a
governor of 25 takes 16.0. Steady state spends ~7.4 req/s, so we run at **11%
utilisation** and the other 89% drains backlogs. One process suffices: 70 req/s
at a 2 s p99 is **140 requests in flight** by Little's law.

**On a slow-down signal** (A8), nothing is dropped:

```
rate := max(5, rate / 2)                   -- multiplicative decrease
row.state := 'pending'
row.next_attempt_at := now + (Retry-After, else 2^attempts s with jitter, cap 300 s)
row.attempts := attempts - 1               -- given back: not the row's fault
recover: rate := min(70, rate + 5) per 30 s of clean responses
```

**The breaker is what makes a 6-hour outage survivable.** An **endpoint
failure** (refused, timeout, 5xx) says nothing about the row: after 5
consecutive ones we stop claiming and probe once every 30 s; claimed rows
return to `pending` **with attempts restored**; on close we resume at half rate
and ramp. A **row failure** — a 400-class rejection naming this record's data —
is the only kind counting attempts toward giving up. Without the split a
6-hour outage destroys its own backlog: 10 attempts at a 5-minute cap is under
an hour, so every row would be `failed` by hour two.

### 6.5 Restart, and settling a group

A restart is a non-event: the new process takes the lease, reclaims rows whose
lease expired, and resumes. A row that reached Salesforce before the crash is
sent again, which is safe because all three calls are idempotent (C.1).

| Outcome | State | Attempts | Then |
| --- | --- | --- | --- |
| `2xx` | `sent` | — | set `sf_value`/`sf_observed_at`; write `echo_fence`; record `sent_at` |
| `429` / limit | `pending` | restored | halve the rate; honour `Retry-After` |
| timeout / refused / `5xx` | `pending` | restored | counts toward the breaker; backoff with jitter |
| `400`-class, data rejected | `failed` | kept | **alert** — a value the portal accepts and Salesforce refuses needs a human |
| `404`, record gone | `failed` | kept | **alert** — deletes are out of scope (A15), so this is unexpected by definition |
| `401` / `403` | `pending` | restored | **page, stop the sender** — bad credentials would otherwise burn the queue into `failed` |

A `failed` row is never deleted; it keeps its `last_error` as the record that
something needs a person.

---

## 7. The rule when both sides change the same record

### 7.1 Who is doing the merging

**Salesforce has no merge logic** — it overwrites with whatever lands last. We
are the only party that compares anything, so our database holds the decision
and Salesforce's copy is a projection of it. Hence the rule that is easy to
miss: **a webhook we reject is not a no-op.** It is the discovery that
Salesforce holds a value we rejected, and since nobody else will fix that, it
owes an outbound call (8.3). Leaving that out is how a design that looks
correct leaves Salesforce permanently wrong.

### 7.2 The order key — the field that decides which edit is current

| Component | On a webhook | On a portal save |
| --- | --- | --- |
| `occurred_at` | **the payload's `occurredAt`** | **`clock_timestamp()` of the saving transaction**, from our database as it writes (A9) |
| `origin_rank` | `1` | `0` |
| `origin_event_id` | **the payload's `eventId`** | the portal change id, a ULID per save |

> **Apply the incoming change if and only if its order key is strictly greater
> than the stored one.**

`clock_timestamp()` not `now()`, which returns the transaction's start. On an
exact tie Salesforce wins, the cheaper direction, since a losing Salesforce
value owes a repair write and a losing portal value owes nothing; a shared
millisecond (A11) then breaks on `origin_event_id`, arbitrarily but **stably**,
which matters because redelivered events must rank the same way twice.
Strictness is load-bearing: `>` and not `>=` makes re-applying an applied
change a no-op, so the inbound path is idempotent independently of the
duplicate table (8.1).

### 7.3 Canonical form

Canonicalised **before** being compared or stored; the stored form is canonical.

| Field | Canonical form |
| --- | --- |
| all text | Unicode NFC; trim; collapse internal whitespace runs to one space |
| `email` | the above, then lowercased whole |
| `phone` | E.164 by the contact's country; on a parse failure, digits with a leading `+`, and raise the parse-failure counter |
| `status` | mapped through the agreed picklist vocabulary |
| `customer_id` | the `portal_id` UUID, lowercase hex |
| empty | `''` and `NULL` are one thing, stored `NULL` |

Not hygiene — this is what makes 9.1 true. Send `+919876543210`, let Salesforce
store `+91 98765 43210`, and the echo reads as a different value with a later
time: we apply it, our value changes, that creates outbound work, which echoes
again. One formatting difference turns the sync into a generator of its own
traffic.

### 7.4 Different fields — the brief's own scenario

No conflict rule needed, which is the argument for ADR 0002. Finance sets
`city`; `phone` is untouched. Sales changes `phone`; the webhook names `phone`
only (A3), so `city` is never looked at. The portal ends with the new phone
**and** the finance city, each with its own actor and time. Appendix A traces
it with the echo in place.

### 7.5 The same field

**Across the two sides:** the order key decides; the winner gets an `applied`
row; **the loser is kept** as `superseded` with its value, actor and time (the
brief is explicit that the fact of an earlier edit stays on record); and **if
the loser was Salesforce's value, a repair write is enqueued** (8.3).

**Two portal users, same field** (the exercise asks directly). The record lock
makes the saves serialise rather than tie, so the second wins on a later
`clock_timestamp()` and its save succeeds normally. The first user's value is
in `field_change` under their name and as the `old_value` of what replaced it,
so nothing is lost. What they *see* is a product decision (open question 4); my
rule is that the portal re-reads after a save, renders each field with "set by
X at T", and shows an inline notice naming who replaced a value the user
submitted — **no blocking and no merge dialog**, because the write already
happened and the intent is already recorded, so the honest thing is to make the
overwrite visible rather than pretend it can be prevented. To Salesforce, both
saves are transitions, so coalescing sends the current value once inside the
1-second window, or two calls land in order outside it; both are correct
because the sender reads the current value at send time.

### 7.6 Two clocks: the rule for the skew window

7.2 compares Salesforce's clock against ours, so inside the skew window (A10:
2 s) an edit made second can rank first. **The rule: the order key stays
authoritative inside the window; we do not detect or correct an inversion. We
bound the skew, and we measure and page on the inversions.**

| | |
| --- | --- |
| **Bound** | hosts run NTP; drift above **500 ms** is a host alarm, so at most a quarter of A10's 2 s is ours |
| **Measure** | **cross-side near-tie inversions/hour** — `superseded` rows whose superseding change has the opposite `origin` and `abs(Δ occurred_at) ≤ 2 s`; the precise form of part 11's third number |
| **Warn / page** | 5/hour; **20/hour**, or any rolling 4-hour window where **≥ 80%** of inversions favour one origin |

The bias threshold does the work: genuine races go both ways, so a sustained
one-directional result is the signature of real skew and would sit under any
volume threshold indefinitely. **No deterministic in-window tiebreak** is
offered because it would have to rank by something other than time, and both
candidates are worse than the inversion they fix — arrival order is confounded
by Salesforce's 5-second emission delay (A13), which exceeds the skew, and a
fixed origin preference would make Appendix B's race settle on the wrong value.
Being wrong is bounded: the mis-ranked edit is in history with its actor, both
copies still converge, and the nightly sweep (row 6, 10.4) is the backstop.

---

## 8. Duplicates and out-of-order changes

### 8.1 A duplicate webhook

**`eventId` is the idempotency key, claimed in the same transaction as the
apply.** No row from the `ON CONFLICT DO NOTHING` means we have seen it:
commit, answer `200 {"status":"duplicate"}`, change nothing. Salesforce has
done nothing wrong (A7), so this is counted, not alerted.

Two independent layers, **and only the second is the guarantee:**

1. *Suppression* — the table. A duplicate does no work.
2. *Harmlessness* — the strict `>` of 7.2. Even unsuppressed, re-applying a
   change whose order key equals the stored one does nothing.

Layer 1 falls to a prune, a restore, or a truncate; layer 2 holds regardless.
**A design resting on the table alone is one retention policy away from
corrupting data.** Two details: a repeated `eventId` with a *different*
`payload_hash` is a provider bug — first write wins and this one **is** alerted,
because the key we trust is not unique; and **a duplicate is not an echo** — a
duplicate is one event twice under one `eventId`, an echo a distinct event
describing our own write.

### 8.2 An older webhook after a newer one

**Compare order keys per field; a change not strictly newer never becomes
current, and is recorded `superseded`.**

```
evt_A  phone -> ...0001  occurredAt 11:30:04.000    evt_B  phone -> ...0002  11:30:09.000

B first:  11:30:09 > stored           -> APPLIED. current ...0002,
                                         sf_value ...0002, sf_observed_at 11:30:09
A second: (a) 11:30:04 NOT > 11:30:09 -> sf_value LEFT ALONE (a later SF state is known)
          (c) 11:30:04 < 11:30:09     -> SUPERSEDED. history keeps ...0001,
                                         sales.user, 11:30:04; current stays ...0002
          (d) sf_value = current      -> NO repair write
```

Step (a) is why this is correct and not merely plausible: a repair rule
comparing the incoming value against ours would fire here and waste a call,
because `evt_A` describes a **past** state of Salesforce, not its current one.

**No reordering buffer, deliberately:** A11 gives no sequence numbers, so we
cannot detect that anything is *missing*, and a buffer could only wait a fixed
time, adding that latency to every event to maybe help a rare one. Change Data
Capture replay ids (open question 1) would let us detect a real gap, and then a
short buffer is worth reconsidering.

### 8.3 The repair write — one condition for every case

> **After every field, regardless of what happened to it: if
> `field_version.sf_value` is distinct from the current value, enqueue a repair
> write.**

| What happened | `sf_value` after | Current | Repair? |
| --- | --- | --- | --- |
| Salesforce change applied | the new value | the same | no |
| Salesforce value superseded by a newer portal edit | Salesforce's | ours | **yes** |
| older event after a newer one (8.2) | unchanged | matches it | no |
| echo of our own write | what we sent | the same | no |
| Salesforce restates a value we hold | that value | the same | no |
| full-record restatement during an outage (8.4) | Salesforce's stale value | our unsent edit | **yes** |

It **terminates** — the repair sends our current value, the echo sets
`sf_value` to it, the condition goes false — and it is the **entire logic of
outage recovery** (10.3): feed Salesforce's current values in as observations
and the fields needing repair are those where the condition is true.

### 8.4 If a webhook carries the full record instead

A3 assumes changed-fields-only. **Full-record mode is the dangerous one,**
because a field's silence and its restatement look identical.

*The hazard:* during the outage finance sets `city` to Noida at 15:00, unsent.
At 16:00 a sales user changes the phone and the full-record payload carries
`city: "Gurugram"` — Salesforce's stale copy — stamped 16:00. Compared as a
change, `16:00 > 15:00`, so we would **overwrite the finance edit with an older
value Salesforce was merely restating:** exactly the loss this exercise is
about, caused by a payload shape.

*The rule* is step (b) of the apply: **a field whose canonical value equals the
`sf_value` we already held is a restatement — not restamped, not compared, not
touched.** Traced: `sf_value[city]` is already `Gurugram`, so `city` is skipped
and stays Noida, and 8.3 enqueues the repair we already owed; `phone` differs
from its `sf_value` and applies normally. Both come out right.

**Step (b) is unconditional**, whatever the payload shape, which is why
`applyChanges` needs no mode parameter: in changed-fields mode it only skips a
re-save of an identical value, and it is **required by the outage sweep**
(10.3) regardless. Full-record remains the weaker shape, since a restatement
coinciding with a real Salesforce edit to the same field in one payload is
invisible to us — which is why A3 is the assumption I would most want confirmed
in writing.

---

## 9. The rule that stops a loop

Ranked second of eight: every other failure damages the records it touches,
while a loop consumes the whole 100 req/s budget and stops sync for every
record at once, within seconds of deployment.

### 9.1 L1 — the structural rule, and the termination guarantee

> **Outbound work is created exactly when `field_version.sf_value` differs from
> a field's current value — condition 8.3, after every field, on both paths,
> and nowhere else.**

*We call Salesforce when, and only when, we believe Salesforce disagrees with us.*

```
portal sets city = Noida  -> sf_value "Gurugram" <> "Noida"  -> 1 outbound row
we PATCH Noida, 2xx       -> sf_value := "Noida"                            (6.3)
Salesforce echoes Noida   -> sf_value "Noida" = current       -> 0 rows.  Dead.
```

No fuel after one hop — not because a rule caught it, but because there is
nothing left to disagree about. **Precondition: canonical form (7.3)**, since
two spellings of one value are the only way to give the loop fuel.

### 9.2 L2 — the actor rule

> A webhook whose `changedBy` is the integration user (A6) is an echo:
> recorded, never compared, never applied.

**Load-bearing, not economy.** L1 guarantees the loop stops; L2 guarantees it
stops on the right value. The echo of our own write carries the time Salesforce
stored it, which is later than the edit that write overwrote, so compared as a
change it would win and launder our value back over a newer edit from the other
side — Appendix B traces exactly that. It also closes 5.1 case (c).

### 9.3 L3 — the echo fence

> After a 2xx the sender records the record, field and hash of the canonical
> value sent, expiring in 15 minutes; an inbound change matching an unexpired
> entry is an echo.

L2's guarantee keyed on the value rather than the actor, so it still holds if
A6 is false, and it suppresses a wasted repair when two of our own writes to
one field are in flight. Safe because the fence is written after the response,
so it cannot exist for a call that did not land, and because a genuine
Salesforce edit setting the value we just sent is indistinguishable from an
echo and treating it as one changes nothing.

### 9.4 L4 — the repair breaker

> Above **5 repairs to one field in an hour**, enqueue nothing more for it,
> mark it contested, and alert.

Bounds the one way L1 fails: a value Salesforce stores in a spelling our
canonical form does not normalise makes every echo read as disagreement, and
the two systems argue at one request per round trip forever. When it trips we
keep serving our value and stop arguing — knowingly different on one field
beats spending the cap on an argument neither side can win.

| | Guarantees | Absent |
| --- | --- | --- |
| **L1** + canonical form | the loop **terminates** | everything; no other layer saves us |
| **L2** | it terminates on the **right value** | our own write launders a stale value over a newer one |
| L3 | L2's guarantee without A6 | nothing, while A6 holds |
| L4 | bounds L1's one failure mode | an unbounded argument over one field |

---

## 10. The 6-hour outage

### 10.1 What it is

Six hours with the Salesforce API unreachable and webhooks sent during it
possibly never arriving — dark both ways at once (A16).

**The arithmetic uses the business-hours average of 3 edits/s, not A1's 20/s
peak.** Saying so up front because the two differ greatly — about 6 minutes
against about 35 — and the choice is a judgement, not an oversight: a peak is a
15-minute phenomenon, and six consecutive hours of one is not credible, so
sizing the headline for it would overstate what the client should expect. The
peak is carried as row 3 of 10.4, so both numbers are on the page.

**The portal keeps working throughout.** Staff edit records, edits apply
locally and appear at once, and queue for Salesforce. Nothing is read-only. The
only cost is visibility in Salesforce, and the 30-second target does not apply
during catch-up — the brief says so, and the number we commit to instead is
10.4's.

### 10.2 What is on disk

| | At the worst moment | Why |
| --- | --- | --- |
| `outbound_change`, `pending` | **19,440 rows, ~4.9 MB** | each committed in the same transaction as the edit that caused it (6.1) |
| rows left `inflight` by a restart | a handful | reclaimed when the 30-second lease expires |
| `sync_watermark` | one row per object type | where the sweep resumes |
| history and typed rows | normal growth | the portal is fully operational |

Five megabytes is what "pending calls must still be there after our process
restarts" costs. **A restart during the outage is a non-event:** rows are
committed so they survive, leases expire and rows return to `pending`, the
breaker reopens on its probes. Nothing needs a human.

### 10.3 How we drain it — and why the order is not negotiable

> **The inbound sweep must complete before the outbound drain begins.**

The loss it prevents: finance sets a city to Noida at 15:00, queued unsent; at
17:00 a sales user sets it to Delhi in Salesforce and that webhook never
arrives; the link returns at 21:00. *Drain first:* we PATCH Noida, Salesforce's
Delhi is overwritten, and the sweep then reads back our own value and learns
nothing — **Delhi is destroyed with no record it existed**, and nothing in the
system would report it. *Sweep first:* Delhi's `SystemModstamp` of 17:00 beats
the portal's 15:00, Noida is kept as `superseded` under the finance user's
name, 8.3 finds nothing owed, and the queued row then sends the **current**
value (6.3) — Delhi, a no-op. Both edits on record, both copies agreeing.

The window is small, which is the point: with 14,954 portal-touched and 34,892
Salesforce-touched records out of 5 M (row 1), the expected overlap is
`14,954 x 34,892 / 5,000,000` = **104 records**. The ordering costs no time and
protects exactly the hundred records where an edit would vanish.

**The sweep depends on the restatement rule and could not work without it.** A
`SystemModstamp` is a *record's* modification time, not a field's, so a record
touched at 17:00 hands back every one of its fields stamped 17:00 — including
fields last changed months ago, which compared as changes would beat any portal
edit made during the outage. Step (b) of 8.4 stops it, which is why that rule
is unconditional.

The sequence is [Appendix C.5](#c5-outage-recovery): probe, hold the drain,
page through the changed-since query feeding each record in as a full-record
observation, advance the watermark per page so a crash resumes at a page
boundary, then release the drain at half rate. Webhooks arriving mid-sweep are
safe without extra machinery — same `applyChanges`, same record lock, and the
sweep's later observation for such a record carries an equal-or-older stamp and
is a no-op — and the drain skips what the sweep resolved by dropping at claim
time any row whose field already has `sf_value` equal to the current value.

### 10.4 The arithmetic — every figure, in one table

**The shared derivation, written once.** Every number in this document comes
out of these lines; the table varies one assumption per row.

```
window           6 h x 3600                                 = 21,600 s
queued changes   portal edits/s x 21,600
outbound calls   queued changes / 1.3 changes per record      (coalescing, 6.3)
drain capacity   governor - 7.4 req/s reserved for live traffic
                 (7.4 = peak steady state: (6 + 0.7 repairs) x 1.1 retries, 6.4)
drain            resume at half the governor, +5 req/s every 30 s, then full capacity
sweep            Salesforce records / 2,000 per SOQL page     (requests)
                 Salesforce records / 500 per second          (local apply)
total            sweep + drain  -- the sweep blocks the drain (10.3)
```

| # | Scenario | What varies | portal /s | queued | calls | drain | SF records | reqs | sweep | **total** |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **1** | **base** | — | 0.90 | 19,440 | 14,954 | 5.1 | 34,892 | 18 | 1.2 | **6.3** |
| 2 | no coalescing | 1.0 changes/record | 0.90 | 19,440 | 19,440 | 6.3 | 34,892 | 18 | 1.2 | **7.5** |
| 3 | sustained peak | A1 → 20 edits/s | 6.00 | 129,600 | 99,692 | 27.7 | 232,615 | 117 | 7.8 | **35.4** |
| 4 | portal-heavy | A2 → 70% portal, reserve 15.7 | 2.10 | 45,360 | 34,892 | 12.0 | 14,954 | 8 | 0.5 | **12.5** |
| 5 | contended cap | A12 → governor 25 | 0.90 | 19,440 | 14,954 | 14.8 | 34,892 | 18 | 1.2 | **16.0** |
| 6 | no changed-since | A4 false → compare all 5 M | 0.90 | 19,440 | 14,954 | 5.1 | 5,000,000 | 2,500 | 16.7 | **21.8** |

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
and the breaker needing a few probes to close.

**What the table says beyond row 1.** The **cap is the floor, not our design**:
row 3's 99,692 calls at the full 100 req/s with no reserve is still
`99,692 / 100 = 997 s = 16.6 min`, so our 30% reserve costs about 11 minutes in
the worst credible case and nothing on our side beats 16.6 — the trade to put
in front of the client (A12). **One request reads 2,000 records and one writes
1**, which is why the inbound side of a blackout is nearly free (18 requests,
0.3 s) and recovery is dominated by the drain in every row but 6. **Row 5
matters most**, being the only row driven by a number we choose rather than
observe. And **row 6 demotes A4** from load-bearing to preferable: a full 5 M
compare costs 2,500 requests, 40 s of API budget and ~17 min of local merge, so
I would want that sweep **running nightly regardless of A4**, as the standing
net under lost webhooks, canonicalisation gaps, fields L4 gave up on, and
7.6's inversions.

---

## 11. Three numbers I would watch

One per failure mode: outbound stuck, inbound slow, and getting it wrong. The
third is the only one that detects incorrectness rather than slowness.

| | Number | Normal | Warn | **Call someone** |
| --- | --- | --- | --- | --- |
| **1** | **age of the oldest unsent change** — `min(created_at)` over `pending` rows | < 5 s | 60 s | **300 s (5 min)** |
| **2** | **inbound lag** — p99 of `applied_at − occurred_at` over Salesforce-origin rows, last 5 min | < 6 s | 20 s | **> 30 s sustained 5 min** |
| **3** | **divergence** — repairs enqueued + Salesforce-origin `superseded` rows, per minute; **and** 7.6's near-tie inversions per hour | ~0; < 1/h | 10/min; 5/h | **100/min; or 20/h, or ≥ 80% one-directional over 4 h** |

**Age, not depth,** for number 1: 19,000 rows draining fast is healthy and 3
rows stuck is not, and during catch-up a depth alarm fires exactly when the
system is doing its job — which is how alarms get muted. Its page means one of
three things, and the first action is to tell them apart: the sender lost its
lease, the breaker is open, or a poison row at the head is being retried
forever.

Number 2 deliberately **includes Salesforce's own emission delay**, which is
not ours to fix, because the 30 seconds we promised is end to end and a number
excluding it would stay green while we miss the commitment.

Number 3 is the one I would least give up: nothing else reports a skew past
A10, a canonicalisation gap turning echoes into changes, a loop rule that
stopped working, or a Salesforce process overwriting portal edits in bulk —
all of which look healthy on latency and queue metrics.

**On the dashboard but not paging,** each a leading indicator of the above: the
governor's current rate and 429 count, the breaker's state, rows in `failed`
and fields marked contested, signature failures and 400s (a Salesforce-side
payload change), and `sync_watermark` lag (whether the nightly sweep keeps up).

---

## 12. What I am leaving out

**Because the exercise says so:** deletes (A15), Salesforce login screens, any
visual UI, a second region, and load testing real Salesforce. Where code
exists it runs against a fake Salesforce I wrote.

**Because I chose to,** each named with its cost rather than left to be
discovered:

| Left out | What it would take | Why it waits |
| --- | --- | --- |
| the initial 5 M backfill | designed as S8, costed as row 6 of 10.4 — 2,500 requests, 40 s of API budget, ~17 min of local merge | one-off, offline, re-runnable, and it needs the merge rule first |
| Salesforce auth lifecycle | a connected app, refresh token, rotation; assumed working | mechanical, and no design decision rests on it |
| schema-change handling | a picklist value the client adds that 7.3 does not know | L4 degrades it into a contested field and an alert rather than a loop |
| merging already-duplicated records | a matching rule, and folding two histories | a pre-existing data-quality problem, not one this sync creates |
| field-level permissions | a table of who may edit what, enforced on both paths | open question 6; building it before the answer is a guess |
| attachments, notes, objects beyond the nine fields | more of the same machinery, keyed the same way | A14 — a tenth field is configuration |
| the portal's overwrite notice (7.5) | a read-after-save and an inline message | the rule and the data are designed; the UI is out of scope |
| right-to-erasure against permanent history | a decision, then likely crypto-shredding values while keeping the change records | open question 5 — a legal question before an engineering one |
| the monitoring itself | wiring part 11's numbers into what the client already uses | the queries are in part 11; the plumbing is site-specific |

**What I would build first:** S1 and S2 alone for a week — the merge rule, the
history, canonical form, and the one condition — against a fake Salesforce with
no real integration connected. Everything after is plumbing around a decision
that has to be right first. And before writing any of it, I would get open
question 1 answered: if the webhook is Change Data Capture, replay ids retire
A11, strengthen 8.2 from ordering-what-arrived to detecting-what-is-missing,
and turn the recovery sweep into a replay. That one answer changes more of this
document than any other.
## Appendix A: the exercise's worked scenario, traced

The scenario from the brief — sales creates a customer, finance corrects the
city in the portal, sales then changes the phone in Salesforce, and the portal
must end with **the new phone and the finance city** — traced through every
rule, with a duplicate and a late event added so all four required rules
appear. The contact is `0031A00000Abc` in Salesforce and `P` in the portal.

#### Step 1 — sales creates the contact in Salesforce

`evt_1`, `occurredAt 11:00:00.000`, `changedBy sales.user@client.example`.

The Salesforce id is unknown and `changedBy` is a human, so 5.1 case (b):
mint `P`, write the `record_link`, apply every field as a first write. The
email `ASHA@Client.example` is canonicalised to `asha@client.example` (7.3).

```
contact        full_name="Asha Mehta"  phone="+919876500001"  city="Gurugram"
field_version  every field = (11:00:00.000, rank 1, evt_1)
sf_value       every field = the value just applied,  sf_observed_at = 11:00:00.000
condition (d)  sf_value = current for every field          -> 0 outbound rows
```

#### Step 2 — finance corrects the city in the portal

A finance user saves `{"city": "Noida"}`. Per A9 the time is our database's
`clock_timestamp()` — `11:00:20.000` — and the actor is the authenticated
session, **not** the `editedBy` in the body. The portal change id is `pc_01`.

```
order key  (11:00:20.000, rank 0, pc_01) > (11:00:00.000, rank 1, evt_1)   -> APPLIED
contact.city  := "Noida"
field_change  += (city, "Gurugram" -> "Noida", finance.user, 11:00:20.000, applied)
condition (d) sf_value "Gurugram" <> current "Noida"       -> 1 outbound row
```

#### Step 3 — the sync worker sends it

Claims the row, reads the **current** value at send time (6.3), sends one
`PATCH {City: "Noida"}`, gets a 2xx, writes `echo_fence(P, city, hash("Noida"))`
and marks the row `sent`. **This is the only outbound call in the entire
scenario.**

#### Step 4 — Salesforce echoes our own write

`evt_2`, `occurredAt 11:00:25.000`, `changedBy integration.user@tequity`,
`{"city": "Noida"}`. This is the loop rule.

```
dedup       new eventId, claimed
L2          changedBy is the integration user                  -> classified ECHO
(a)         11:00:25.000 > 11:00:00.000  -> sf_value[city] := "Noida"
(c)         echo: no comparison, no value change; sync_observation('echo')
(d)         sf_value "Noida" = current "Noida"                 -> 0 outbound rows
```

The loop ends here, and 9.1 is why: there is nothing left to disagree
about. Had L2 been unavailable (A6 false), the echo would have been a
`confirmed` observation and (d) would still have produced nothing.

#### Step 5 — sales changes the phone in Salesforce

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

#### Step 6 — Salesforce delivers `evt_3` a second time

```
INSERT ... ON CONFLICT (event_id) DO NOTHING  -> 0 rows  -> 200 {"status":"duplicate"}
```

Nothing happens, and nothing is alerted — A7 permits this. And if
`inbound_event` had been pruned, layer 2 of 8.1 still holds: the order key
would be *equal*, not greater, so (c) applies nothing, `sf_observed_at` is not
advanced by (a), and (d) finds nothing owed. Harmless either way.

#### Step 7 — an older phone event arrives late

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
is the bug 8.3 exists to prevent.

#### The result

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

---

## Appendix B: the overwrite race, traced

The race the captain asked to see. It is the hardest case in this design and
tracing it found a bug, so it gets its own appendix.

**Setup.** `phone` currently `+919000000000` (OLD), last observed from
Salesforce at 09:00:00. F = `+919000000111` (finance), S = `+919000000222`
(sales).

| # | Time | What happens |
| --- | --- | --- |
| 1 | 10:00:00.000 *(our clock)* | finance saves `phone = F` in the portal |
| 2 | 10:00:01.000 *(SF clock)* | sales sets `phone = S` in Salesforce |
| 3 | 10:00:05.000 | our call lands, writing **F** over S in Salesforce |
| 4 | 10:00:06.000 | the webhook for step 2 finally arrives |
| 5 | 10:00:07.000 | the echo of our step-3 write arrives |

**Step 1 — the portal save.**
```
order key (10:00:00.000, rank 0, pc_1) > (09:00:00, 1, evt_prev)   -> APPLIED
current := F ;  field_change += (OLD -> F, finance.user, applied)
(d) sf_value OLD <> current F                                      -> 1 outbound row
```

**Step 3 — our call lands.** The sender reads the current value at send time
(6.3) and sends F. Salesforce now holds F: **the sales edit has been
overwritten in Salesforce.** On the 2xx (6.3):
```
sf_value := F ,  sf_observed_at := 10:00:05.000
echo_fence(phone, hash(F))
```

**Step 4 — the sales webhook arrives**, `occurredAt 10:00:01.000`,
`changedBy sales.user`.
```
L2  not the integration user                                        -> not an echo
(a) 10:00:01.000 > sf_observed_at 10:00:05.000 ?  NO
    -> sf_value STAYS F. Our 10:00:05 write is later than the edit
       this webhook describes, so it is still the freshest thing we
       know about Salesforce's state.
(b) S <> sf_value F                                                 -> a real change
(c) (10:00:01.000, 1, evt_S) > (10:00:00.000, 0, pc_1)              -> APPLIED
    current := S ;  field_change += (F -> S, sales.user, 10:00:01, applied)
(d) sf_value F <> current S                                         -> REPAIR queued
```

**Step 5 — the echo of our own write arrives**, `occurredAt ~10:00:05.000`,
value F, `changedBy integration.user`.
```
L2  -> ECHO. sync_observation('echo'). Step (c) never runs.
(d) sf_value F <> current S -> a repair is already pending for this field;
    the partial unique index on outbound_change keeps it at one row.
```

**Step 6 — the repair sends.** Reads the current value, sends **S**. Salesforce
holds S. `sf_value := S`. Its own echo then makes `sf_value` equal the current
value and condition (d) goes false. Settled.

#### The result

```
portal:      phone = S  (sales, 10:00:01)
Salesforce:  phone = S
history:     OLD -> F  finance.user  10:00:00  applied
             F   -> S  sales.user    10:00:01  applied
```

**Both copies end on the sales value**, and the finance edit is on record with
its author rather than being silently discarded.

#### Why the echo cannot win on its later `occurredAt`

Because it is classified as an echo by `changedBy` **before** any order-key
comparison happens, so its 10:00:05 stamp is never compared — which is
load-bearing rather than tidy, since that stamp is later than the sales edit's
10:00:01 and would otherwise let our own write launder the value we sent back
over a newer edit from the other side.

#### The bug this trace found

Without step 3's `sf_value := F`, step 4(a) would have seen `10:00:01.000 >
09:00:00` and set `sf_value := S`. Condition (d) would then have compared S
against a current value of S, found them equal, and queued **no repair** —
leaving Salesforce holding F and the portal holding S, permanently, with every
metric green. The fix is one line in the sender, and the reason it was missing
is that I had been treating `sf_value` as "what Salesforce told us" when it has
to mean "what we believe Salesforce holds", and our own writes are part of that.

---

## Appendix C: interfaces, schema and the sequences

Reference for parts 2, 4, 5, 6 and 10. No new rules — the body's rules in the
form you would build from.

### C.1 The interface on each side

```
(i) OUR WEBHOOK ENDPOINT -- what Salesforce sees
POST /sync/salesforce/webhook     X-Signature: hex(hmac-sha256(secret, raw_body))  (A7)
{ "eventId":"evt_1001", "recordId":"0031A00000Abc", "objectType":"Contact"|"Account",
  "occurredAt":"2026-11-02T11:30:04.000Z",         (A11)
  "changedBy":"sales.user@client.example",         (A6)
  "changedFields":{ "phone":"+919876543210" } }    (A3)

200 {"status":"applied"|"duplicate"|"echo"|"partial"}  committed; never resend
400 malformed / unknown objectType or field            do not retry
401 signature failed                                   do not retry
503 + Retry-After                                       resend shortly (5 case c, or shedding)
500 we failed unexpectedly                              retry; it is safe (8.1)

A 200 is returned ONLY after our transaction commits, and redelivering an event
that got a 200 is harmless. We never return 200 to mean "accepted, will
process later" -- that would be a promise with no durable record of it.

(ii) THE SALESFORCE RECORD API -- our entire dependency. Each is idempotent BY
     DESIGN, which is what makes at-least-once sending safe (6.5).
update   PATCH /sobjects/{Type}/{sfId}                   -> 204      sends current values, so a repeat converges
upsert   PATCH /sobjects/{Type}/{ExtIdField}/{portalId}  -> 201|204  keyed on OUR id (A5), so a repeat cannot duplicate
changed  GET   /query?q=SELECT Id,<fields>,SystemModstamp
                      FROM {Type} WHERE SystemModstamp > :watermark  -> a read   (A4)

(iii) MERGE -- the one interface every edit path goes through, called from the
      endpoint, the portal's save handler, and the recovery sweep.
applyChanges({ record, origin:"salesforce"|"portal", actor, occurredAt,
               originEventId, changes:{field: rawValue} })
  -> [{ field, outcome:"applied"|"superseded"|"echo"|"confirmed"|"restatement",
        previousValue, newValue, enqueuedOutbound }]

A caller must know only: it runs inside a transaction the caller owns; it takes
ONE lock per record (the record_link row), so concurrent merges serialise with
no lock ordering to get right; and it is idempotent for the same originEventId
and occurredAt. The payload shape is deliberately NOT a parameter (A3) -- the
restatement rule of 8.4 answers both cases, and a parameter selecting between
two behaviours is two interfaces wearing one name.
```

### C.2 Schema

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
  phone         text,          -- stored in canonical form, 7.3
  email         text,          -- stored in canonical form
  city          text,
  owner         text,
  customer_id   uuid REFERENCES customer(portal_id),
  updated_at    timestamptz NOT NULL
);

CREATE TABLE field_version (
  object_type      text    NOT NULL,          -- 'Customer' | 'Contact'
  portal_id        uuid    NOT NULL,
  field            text    NOT NULL,
  -- the order key, 7.2. These three columns ARE the comparison.
  occurred_at      timestamptz(3) NOT NULL,
  origin_rank      smallint NOT NULL,          -- salesforce = 1, portal = 0
  origin_event_id  text    NOT NULL,
  -- who and where, kept for display without reading history
  origin           text    NOT NULL,
  actor            text    NOT NULL,
  -- what we believe Salesforce currently holds for this field, and when we
  -- last learned it. Updated by a Salesforce observation AND by our own
  -- successful send (part 6.4) -- a write of ours is the most recent thing we
  -- know about Salesforce's state. This pair is the whole basis of the repair
  -- rule (8.3) and the restatement rule (8.4). Null until either happens.
  sf_value         text,
  sf_observed_at   timestamptz(3),
  PRIMARY KEY (object_type, portal_id, field)
);

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

CREATE TABLE sync_observation (
  object_type text, portal_id uuid, field text,
  observed_value text, occurred_at timestamptz(3),
  origin text, origin_event_id text, actor text,
  outcome text NOT NULL CHECK (outcome IN ('echo','confirmed')),
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp()
) PARTITION BY RANGE (observed_at);         -- monthly partitions, dropped at 90 days

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
  WHERE reason = 'repair';                    -- the repair breaker's count (9.4)
CREATE UNIQUE INDEX ON outbound_change (object_type, portal_id, field)
  WHERE state = 'pending';                    -- at most one pending call per field

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

### C.3 The inbound apply, one transaction

Part 5. Its four deliberate properties are in the body.

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
  |-- 4. claim the event                                                    (8.1)
  |      INSERT INTO inbound_event (...) VALUES (...)
  |        ON CONFLICT (event_id) DO NOTHING RETURNING event_id;
  |      no row returned -> duplicate -> COMMIT, 200 {"status":"duplicate"}
  |
  |-- 5. resolve and lock the record                                        (part 5)
  |      SELECT portal_id FROM record_link
  |        WHERE object_type = $1 AND sf_id = $2 FOR UPDATE;
  |      This single lock serialises every merge on this record, inbound and
  |      portal-side alike. It is the only lock the merge takes.
  |
  |-- 6. classify the whole event as echo or not                            (part 9)
  |      changedBy = integration user?  -> echo
  |
  |-- 7. for each field in changedFields:
  |        value := canonicalise(raw)                                       (7.3)
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
  |            else if order_key(incoming) > order_key(stored):             (7.2)
  |                UPDATE customer/contact SET <field> = value
  |                UPSERT field_version with the new stamp
  |                INSERT field_change(outcome='applied', old_value, new_value)
  |            else if value is distinct from the current value:
  |                INSERT field_change(outcome='superseded')                (part 8.2)
  |            else:
  |                sync_observation('confirmed')
  |
  |        (d) the one repair condition, checked after every field:         (8.3)
  |            if field_version.sf_value is distinct from the current value:
  |                INSERT outbound_change(reason='repair')
  |
  |-- 8. UPDATE inbound_event SET outcome = <applied|echo|superseded|partial>
  v
COMMIT
  |
  '-- 200 {"status": ...}      <- sent only after the commit returns
```

### C.4 The outbound worker loop

Part 6.2.

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

### C.5 Outage recovery

Part 10.3. The sweep must finish before the drain starts.

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
   twice is a no-op (strict > in 7.2)
5. RELEASE the drain, at half rate, ramping (part 6.5)
```

---

## Appendix D: assumption consequences, and rejected alternatives

### D.1 If each assumption goes the other way

Required reading beside part 1. One sentence each, as the exercise asks.

| | If the answer goes the other way |
| --- | --- |
| **A1** | At a 200/s peak the portal's share alone is 60 req/s, so coalescing becomes load-bearing and the 30-s budget needs a per-record debounce; catch-up becomes row 3 of 10.4, 35.4 min. |
| **A2** | Row 4: steady-state outbound roughly doubles to 15.7 req/s and catch-up becomes 12.5 min, consuming most of A12's headroom. |
| **A3** | 8.4 is the rule: a field equal to the `sf_value` we hold is a restatement and is skipped. It runs in both modes anyway, so no code changes — but risk rises, because a field's silence and its restatement become indistinguishable. |
| **A4** | Row 6: recovery becomes a full 5 M-record compare, 21.8 min instead of 6.3 — cheap enough that A4 is *preferable*, not load-bearing. I would run that sweep nightly regardless. |
| **A5** | Create becomes search-then-create, which is racy, so every portal-originated create carries a duplicate-record risk needing a reconciliation sweep. |
| **A6** | Loop layer L2 switches off and L3's fence carries the same guarantee by a different key (9.2–9.3); termination is unaffected, correctness of the winner is not. |
| **A7** | At-most-once delivery makes every missed webhook permanent divergence, so A4's sweep becomes the primary inbound path and webhooks a latency optimisation on top. |
| **A8** | With no hint we halve on any rejection and probe upward on success — which is what 6.4 already does; only recovery speed changes. |
| **A9** | If a client-supplied edit time must be honoured (an offline client replaying saves), portal changes stop being monotonic per record and 8.1's duplicate rule must extend to portal saves, which currently cannot duplicate. |
| **A10** | 7.6's inversion rate rises; both copies still converge and nothing is lost, but which edit wins inside the window becomes arbitrary, and 7.6's bias page is the detector. |
| **A11** | A monotonic replay sequence (Change Data Capture) retires the tiebreakers and strengthens 8.2 from ordering-what-arrived to detecting-what-is-missing. |
| **A12** | Row 5: a governor of 25 makes catch-up 16.0 min instead of 6.3 — one configured number, no design change. |
| **A13** | At a 25-second emission delay the 30-second target is unachievable by any design on our side, and it becomes a conversation about the number rather than about the system. |
| **A14** | A tenth field is configuration, not a code change, because nothing in the design is written per field. |
| **A15** | A delete is a change whose new value is "gone": it needs a tombstone that survives in history, a rule for an edit arriving after a delete (the same order-key comparison), and a not-deleted predicate on every portal read. |
| **A16** | If only the outbound direction fails, 10.3's inbound sweep shrinks to the records whose webhooks were lost. |

### D.2 Alternatives rejected, and why

The three big ones are ADRs. These are the smaller decisions a reader might
otherwise re-propose.

| Considered | Rejected because |
| --- | --- |
| **A reordering buffer** holding events back for the missing earlier one | A11 gives no sequence numbers, so we cannot detect that anything is *missing*; a buffer could only wait a fixed time, adding that latency to every event to maybe help a rare one. Worth reconsidering if open question 1 returns Change Data Capture, whose replay ids would expose a real gap. |
| **A deterministic tiebreak inside the clock-skew window** (7.6) | Both candidates are worse than the inversion they fix: arrival order is confounded by Salesforce's 5-second emission delay (A13), which exceeds the 2-second skew, and a fixed origin preference would make Appendix B's race settle on the finance value rather than the sales one. A correct cross-side order needs a sequencer both sides share. |
| **Storing the value on the outbound queue row** | Then a row queued at 09:00 during an outage delivers a value we superseded at 11:00, costing two calls and a window where Salesforce holds something stale. Reading the current value at send time also makes repair rows and recovery no-ops safe (6.3, 10.3). |
| **An inbound queue** between the endpoint and the apply | At 14 commits a second it buys headroom we do not need and adds a component plus a lag term. The threshold that would change it is written down in part 2: inbound apply p99 above 1 s, or sustained commits above 500/s. |
| **Alerting on outbound queue depth** rather than age | During catch-up the depth is *supposed* to be 19,000, so a depth alarm fires exactly when the system is working correctly — which is how alarms get muted. |
| **Recording echoes in `field_change`** with the real history | An echo is not an edit by a person. It would inflate permanent history about 30% with non-history and, because the two have different retentions, make partition-level pruning impossible. |
| **A per-field ownership table** (finance owns some fields, sales others) | That is open question 6. Building it before the answer would be a guess, and if the answer is yes, part 7 gets *simpler* for those fields rather than harder. |
