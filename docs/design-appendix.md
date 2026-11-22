# Design appendices

**Companion to [`design.md`](design.md) — Tequity Round 1.** The design
document is the deliverable and stands alone: it carries every rule, every
interface and every number. This file carries the working behind it, for a
reader who wants to check a claim rather than build from it.

| | |
| --- | --- |
| **A** | the exercise's own scenario, traced event by event |
| **B** | the overwrite race — the hardest ordering case in the design |
| **C** | the interface on each side, the schema DDL, and four sequences |
| **D** | what changes if each assumption is wrong, and alternatives rejected |
| **E** | what the demo substitutes for Postgres and Salesforce |
| **F** | the reasoning behind rules whose statement is in the body |

## Appendix A: the exercise's worked scenario, traced

The scenario from the brief — sales creates a customer, finance corrects the
city in the portal, sales then changes the phone in Salesforce, and the portal
must end with **the new phone and the finance city** — traced through every
rule, with a duplicate and a late event added so all four required rules
appear. The contact is `0031A00000Abc` in Salesforce and `P` in the portal.

#### Step 1 — sales creates the contact in Salesforce

`evt_1`, `occurredAt 11:00:00.000`, `changedBy sales.user@client.example`.

The Salesforce id is unknown and `changedBy` is a human, so design 5 case (b):
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
  -- successful send (part 6.3) -- a write of ours is the most recent thing we
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
  outcome text NOT NULL CHECK (outcome IN ('echo','confirmed','restatement')),
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp()
) PARTITION BY RANGE (observed_at);         -- monthly partitions, dropped at 90 days

-- inbound idempotency. Part 8.1.
CREATE TABLE inbound_event (
  event_id     text PRIMARY KEY,              -- Salesforce's eventId
  object_type  text NOT NULL,
  sf_id        text NOT NULL,
  occurred_at  timestamptz(3) NOT NULL,
  payload_hash bytea NOT NULL,                -- sha256 of the raw body
  outcome      text NOT NULL,                 -- applied | echo | superseded | partial
                                              -- | restatement | confirmed | rejected
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
  |        (c) decide the current value -- FIRST case that applies:
  |            if echo:                                                     (part 9)
  |                sync_observation('echo')          -- no value change, ever
  |            else if value = the current value:                           (part 5)
  |                sync_observation('confirmed')     -- no stamp, no history
  |            else if order_key(incoming) > order_key(stored):             (7.2)
  |                UPDATE customer/contact SET <field> = value
  |                UPSERT field_version with the new stamp
  |                INSERT field_change(outcome='applied', old_value, new_value)
  |            else:
  |                INSERT field_change(outcome='superseded')                (part 8.2)
  |
  |            The value-equality test comes BEFORE the order-key comparison,
  |            not after it. Reversed, a change that matches what we already
  |            hold but carries a newer stamp would be 'applied' and would
  |            RESTAMP the field -- taking ownership from a genuine edit, which
  |            is exactly what F.5 says must not happen.
  |
  |        (d) the one repair condition, checked after every field:         (8.3)
  |            if field_version.sf_value is distinct from the current value:
  |                INSERT outbound_change(reason='repair')
  |
  |-- 8. UPDATE inbound_event SET outcome =
  |        <applied|echo|superseded|partial|restatement|confirmed>
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

  1. reclaim anything a dead process left behind      (6.2)
     UPDATE outbound_change SET state='pending', lease_owner=NULL, lease_until=NULL
      WHERE state='inflight' AND lease_until < clock_timestamp();

  2. if the circuit breaker is open, probe instead of claiming   (6.4)

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
  6. governor.acquire(1 token)  -- every request, retries included            (6.4)
  7. send; settle the whole group by the outcome                              (6.5)
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
5. RELEASE the drain, at half rate, ramping (part 6.4)
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

---

## Appendix E: what the demo substitutes for

The optional code in `src/` implements the rules above and runs on Node alone,
so three things the design assumes are stood in for. Each substitution is also
documented at the point it is made — `src/store/store.ts` carries this table in
its own module docstring — because a reviewer checking code against design
needs to know which guarantees are real and which are imitated.

| The design assumes | The demo uses | Faithful? |
| --- | --- | --- |
| **Postgres tables** | one JSON document on disk, keyed objects and arrays | yes |
| **`BEGIN` / `COMMIT`** | mutate a deep clone, then write the file atomically; a throw discards the clone | **yes**, for one process — which is what part 5 needs, since the duplicate claim and the apply must commit together |
| **durability across a restart** | `writeFileSync` to a temp path, then `renameSync`, which is atomic on POSIX | **yes** — the demo SIGKILLs a child process and the queued call is still there |
| **`SELECT … FOR UPDATE`** (the per-record lock) | nothing: one process, one transaction at a time | **imitated.** The demo cannot show that the lock serialises competing merges, because it has no concurrency |
| **`FOR UPDATE SKIP LOCKED`** | the `leaseOwner` / `leaseUntilMs` columns the design already carries | **yes** — the lease, and its reclaim after a sender dies, are real |
| **the partial unique index** (one pending row per field) | an explicit check in the enqueue path | imitated |
| **`LISTEN` / `NOTIFY`** | the demo calls the worker directly | imitated |
| **monthly partitions and pruning** | not implemented | absent — retention is a design concern, not a rule |
| **the live Salesforce record API** | a fake written for this repository, file-backed so it survives the restart, with levers for the five behaviours the rules depend on: it echoes every write, it can be unreachable, it can answer 429, it can refuse a record's data, and it can refuse our credentials | the second adapter at the seam (part 2) |
| **HTTPS to the webhook endpoint** | the handler is called in-process, with the signature still verified over the raw body | imitated — the rules live in the handler, not in the HTTP framing |
| **70 req/s** (part 6.4) | a deliberately low cap so the wait is visible, which the exercise permits. **The code enforces whatever cap it is given** | the enforcement is real, the number is not the design's |
| **a 30-second lease** (part 6.2) | a shorter one, for the same reason | as above |
| **the governor's floor of 5 req/s** (part 6.4) | a floor of 1, because the demo's whole ceiling is 4 req/s | the halving and the ramp are real, the floor is not the design's |

Two of these are worth stating as limits rather than details. The demo **does
not** show the record-level lock doing its job, because proving that needs
concurrency it does not have; the lock is in the code and its contract is in
part 2, but the evidence here is the rules and the ordering, not the locking.
And the demo's echo fence is per **event** rather than per field, because
`applyChanges` takes one classification — strictly more conservative than the
design, since it can never mistake a real change for an echo.

---

## Appendix F: the argument behind each rule

The body states the rules and the numbers. This is the reasoning behind them,
keyed to the body's section numbers — the material a reader who wants to check a
decision needs, and that a reader who only wants to build does not. It starts at
F.2 because part 1 is the assumptions, and their reasoning is Appendix D.

### F.2 The process split and the seam

**Why two processes.** The webhook endpoint is latency-sensitive, horizontally
scalable, and must never block on Salesforce; the sync worker is the single
governor of a shared 100 req/s cap, so we want exactly one of it. Those are
opposite scaling properties, which is the first argument for splitting them.

**Why Postgres is the seam, not HTTP or a broker.** The decisive argument is
transactional rather than architectural. The outbound queue has to survive a
process restart whatever we choose (the brief requires it), so it is already
durable storage. Once it lives in the same database as the records, the inbound
apply and the outbound enqueue become **one commit** — and "we changed a value"
and "we owe Salesforce a call" can then never disagree after a crash. With a
broker between them, that pair is two writes to two systems and needs an outbox
anyway, so the broker adds a hop and a failure mode and buys nothing.

**Why Postgres gets no adapter interface** while `SalesforceClient` gets two.
There will only ever be one database, and an interface over it would have to
abstract transaction boundaries — exactly the semantics parts 5 and 6 rest on. A
seam is worth its cost where a second implementation really exists; for
Salesforce it does (live HTTPS, and the demo's fake), for Postgres it does not.

**The 30-second budget's slack.** Of the 9.8 worst-case seconds, 7 are
Salesforce's emission delay (5 s) and write latency (2 s) under A13, neither ours
to fix. We are spending ~2.8 s and holding ~20 s of margin, which is insurance
against A13 being optimistic rather than headroom we plan to use. **No inbound
queue** is right while the endpoint's apply p99 stays under 1 s and commits stay
under 500/s; above either, an inbound queue is the next change, and it costs the
"200 means committed" guarantee.

### F.3 What "risk" means here, and what adds no component

Risk is severity × likelihood, with two severity multipliers that matter more
than either: **unrecoverable** and **silent**. A failure you can detect and
re-run is an operational cost; one that destroys an edit nobody knows existed is
a product failure, and the brief's whole subject is the second kind. That is why
S1 and S2 come first and S5–S8 come last, even though the backfill (S8) runs
before any sync ever does — it is one-off, offline and re-runnable, so its
severity is low however early it executes.

**Four of the eight add no component.** S1 adds MERGE and the record/history
tables; S3 adds `outbound_change`, the worker, the governor and
`SalesforceClient`; S4 adds `inbound_event` and the endpoint; S5 adds
`record_link`. S2 is a *property* of MERGE rather than a thing, S6's sweep runs
inside the worker that already exists, S7 is middleware, and S8 is a script
outside the running system. **Deliberately absent:** no broker, no inbound queue,
no cache in front of MERGE's row locks, and no per-field ownership table
(open question 6 has to be answered before that could be designed honestly).

### F.4 Why the data is shaped this way

**`field_version` is a cache, not a second truth.** Every column in it is
derivable from `field_change` and `sync_observation`, which means a rebuild is
the repair for any doubt about it — and that matters because it is the row MERGE
locks and the row the loop rule reads. A design where the order key were the only
record of who won would have no way back from a bug.

**Why observations are not history.** An `echo`, a `confirmed` and a
`restatement` are not edits by a person: nobody changed anything. Mixing them
into `field_change` would inflate permanent history by roughly 30% with rows that
answer no question the client asked, and it would defeat partition pruning on the
table we actually query for "who changed the city". Hence 90-day partitions for
observations and forever for changes.

**The storage derivation.** 5 M typed rows ≈ 1.2 GB. `field_version` is one row
per record-field: 1 M customers × 3 fields + 4 M contacts × 6 fields = **27 M
rows**, 5.5 GB with its index. `field_change` grows at 20 M edits/yr × 1.3 fields
per edit = **26 M rows/yr** ≈ 5.2 GB/yr, kept forever because it is the product.
`inbound_event` at 30 days' retention is 104 MB. **~13 GB in year one, growing
5 GB/yr** — almost all of it permanent history, which makes retention a product
decision rather than a budget one.

### F.5 The inbound path's four properties

**Why the duplicate claim and the apply must share one transaction.** A7 promises
redelivery only until we answer 200. Claim the `eventId` in its own transaction,
crash before applying, and the event is marked processed but never applied — and
Salesforce will never send it again. The edit is then lost with no record that it
existed, which is the exact failure class this design is about. It is the most
important line in the path.

**Why no network call inside the transaction.** A Salesforce call inside the
apply would hold record locks for the duration of someone else's outage, turning
a Salesforce incident into a Postgres incident. Keeping the transaction local
holds the endpoint's p99 at 200 ms and makes the inbound side independent of
Salesforce's availability — which is also what lets the 6-hour outage leave the
portal fully operational.

**Why value equality is checked before the order key.** Two reasons, and the
second is the load-bearing one. (1) `field_change` is the client's record of edits
that *changed* something; a re-save of the value already held is not one, and
filling permanent history with no-op rows makes "who changed the city" harder to
answer. (2) It must not restamp the order key: if a no-op re-save advanced the
stamp, it would take ownership of the field from a genuine edit, so a later real
edit from the other side could lose to someone who re-submitted a value they
never changed. This is a third layer of idempotence beneath the duplicate table
and the strict `>`, and the strict `>` remains the backstop that matters, because
it is what handles a *different* value arriving with an older stamp.

**Why case (c) is narrowed to the integration user.** Deferring with a 503
whenever *any* create is in flight would delay legitimate Salesforce creates by
5 s most of the time at A1's rate, to fix a race that only ever involves our own
writes. Treating (c) as (b) instead would mint a second local record for one real
contact. The narrow condition is what makes the cheap answer safe.

**400 versus 500.** A 400 discards the event forever, so the line has to be
exact: an unknown *field name* is a contract violation and earns a 400; a *value*
we failed to canonicalise is our bug, and it earns a 500 and a retry so the event
survives until we fix the canonicaliser.

### F.6 The cap, the breaker, and reading the value late

**Why 70 and not 100.** The 100 req/s cap counts our retries and belongs to the
client's whole org, not to us. At 100 we would have no room for our own retries,
and another integration's burst would arrive as rejections we then retry into the
same wall. At 70 a 30% burst from elsewhere is absorbed without us failing
anything. **Why not lower:** catch-up time scales inversely with the governor, and
row 5 of 10.4 prices it — a governor of 25 turns a 6.3-minute recovery into 16.0.
**One process is enough:** 70 req/s at a 2 s p99 is 140 requests in flight by
Little's law, which one Node process handles comfortably.

**Why the breaker must split endpoint failures from row failures.** An endpoint
failure (refused, timeout, 5xx) says nothing about the row that happened to be in
flight; a 400-class rejection naming the record's data says everything about it.
Count them together and a 6-hour outage destroys its own backlog: 10 attempts at
a 5-minute backoff cap is under an hour, so every queued row would reach `failed`
by hour two of a six-hour outage, and the work the brief requires us to keep would
be gone. Restoring `attempts` on an endpoint failure is what makes the backlog
survive the thing it exists for.

**Why `attempts` rises on claim, not on failure.** A row that crashes the process
mid-send would otherwise never count an attempt, and a poison row could be retried
forever at the head of the queue. Counting at claim time bounds that.

**Why the queue carries no value.** A city edit at 09:00 and another at 11:00
during an outage would, as two queued messages, mean two calls — and a window in
which Salesforce holds a value we superseded four hours earlier. Reading the
current value at send time collapses them into one call carrying the 11:00 value.
The cost is that the queue is a claim ticket rather than a message log;
`field_change` is that log, and a better one.

### F.7 Ordering, canonical form, and the skew window

**Why Salesforce wins an exact tie.** The directions are not symmetric in cost. A
losing Salesforce value owes a repair write (8.3) — one API call out of our
budget; a losing portal value owes nothing, because Salesforce already holds what
it holds. Breaking ties toward Salesforce is therefore the cheaper direction, and
on a shared millisecond (A11) `origin_event_id` breaks it arbitrarily but
**stably** — which matters because a redelivered event must rank the same way the
second time or the duplicate rule's harmlessness layer would not hold.

**Why strictness is load-bearing.** `>` and not `>=` makes re-applying an already
applied change a no-op, so the inbound path is idempotent *independently of the
duplicate table*. That independence is the whole of 8.1's layer 2.

**Why canonical form is not hygiene.** Send `+919876543210`, let Salesforce store
`+91 98765 43210`, and the echo of our own write reads as a *different* value
carrying a later time. We would apply it, our value would change, that change
would create outbound work, and the write would echo again. One formatting
difference between the two systems is enough to turn the sync into a generator of
its own traffic, which is why 7.3 is the stated precondition of L1 and why L4
exists to bound the case where our canonicaliser is the one that is wrong.

**Why no deterministic in-window tiebreak.** Inside the skew window the order key
can rank an edit made second as first. Fixing that would mean ranking by something
other than time, and both candidates are worse than the inversion. *Arrival
order* is confounded by Salesforce's 5-second emission delay (A13), which is
larger than the 2-second skew, so it would mis-rank far more often than the skew
does. *A fixed origin preference* would make the overwrite race of Appendix B
settle on the wrong value. So we keep the order key authoritative and spend the
effort on bounding and detecting instead: NTP with a 500 ms host alarm, and the
inversion metric with a bias threshold. **Being wrong is bounded:** the mis-ranked
edit is in `field_change` with its actor and time, both copies still converge on
one value, and the nightly sweep (row 6, 10.4) is the backstop.

**Why the bias threshold does the real work.** Genuine near-tie races go both
ways, so a volume threshold alone cannot distinguish a busy hour from a broken
clock. A sustained one-directional result is the signature of real skew, and it
would sit under any volume threshold indefinitely — hence paging on ≥ 80%
one-directional over 4 hours as well as on 20/hour.

**Why the portal shows the overwrite rather than preventing it.** When two portal
users edit one field, the write has already happened and both intents are already
recorded. A merge dialog would pretend the overwrite can be prevented, and
blocking the second save would discard an edit a person deliberately made. Making
it visible — "set by X at T", plus a notice naming who replaced a value the user
submitted — is the honest option. It remains a product decision (open question 4).

### F.8 Duplicates, ordering, and payload shape

**Why the duplicate table is not the guarantee.** It is layer 1, suppression: a
duplicate does no work. Layer 2 is harmlessness — the strict `>` means an
unsuppressed duplicate changes nothing anyway. Layer 1 falls to a prune, a
restore from backup, or a truncate; layer 2 holds regardless. A design resting on
the table alone is one retention policy away from corrupting data, which is the
kind of coupling that only shows up months later.

**A duplicate is not an echo.** A duplicate is one event delivered twice under
one `eventId`; an echo is a *distinct* event, with its own `eventId`, describing
a write we made. They need different rules (8.1 and 9.2) and conflating them
would suppress real Salesforce edits.

**Why a repeated `eventId` with a different `payload_hash` is alerted** while an
ordinary duplicate is only counted: the ordinary case means Salesforce did what
A7 says it may do, while the other means the key we trust to be unique is not,
and every idempotence guarantee built on it is suspect.

**Why step (a) must run before the decision.** An out-of-order event describes a
*past* state of Salesforce. A repair rule comparing the incoming value against
ours would fire on it and spend a call arguing with Salesforce about a value it no
longer holds. Learning `sf_value` only from the newest Salesforce observation we
have seen — and leaving it alone when the event is older — is what keeps 8.3 a
single condition instead of a case analysis.

**Why no reordering buffer.** A11 gives no sequence numbers, so we cannot detect
that something is *missing*; a buffer could only wait a fixed time, adding that
latency to every event to maybe help a rare one. Change Data Capture replay ids
(open question 1) would change this: they would let us detect a real gap, and then
a short buffer becomes worth reconsidering.

**Why the NULL case in 8.3 is load-bearing.** "We do not know what Salesforce
holds" is itself a disagreement we owe a call about. Without `IS DISTINCT FROM`
semantics, a portal edit to a field Salesforce has never mentioned would enqueue
nothing, and every portal-created record would be stranded — the condition would
go silent exactly when Salesforce knows least.

**Why full-record is the weaker payload shape.** Step (b) handles the restatement
hazard, but one case stays invisible: a restatement coinciding with a *real*
Salesforce edit to the same field inside one payload cannot be told apart from
the restatement alone. Changed-fields-only (A3) has no such case, which is why it
is the assumption I would most want confirmed in writing.

### F.9 Why the loop needs four layers

**Why it ranks second of eight.** Every other failure damages the records it
touches. A loop consumes the entire 100 req/s budget and stops sync for *every*
record, within seconds of deployment — the only self-amplifying failure here.

**L2 is load-bearing, not an economy measure.** L1 guarantees the loop
terminates; L2 guarantees it terminates on the *right value*. The echo of our own
write carries the time Salesforce stored it, which is later than the edit that
write overwrote — so compared as a change it would win, and it would launder our
value back over a newer edit from the other side. Appendix B traces exactly that
sequence. Note what L2 does not consult: the value. "Never applied" has to hold
whatever the echo carries, or the guarantee would depend on Salesforce echoing
precisely what we sent.

**Why L3 exists given L2.** It is L2's guarantee keyed on the value rather than
the actor, so it survives A6 being false, and it suppresses a wasted repair when
two of our own writes to one field are in flight. It is safe because the fence is
written *after* the response, so it can never exist for a call that did not land;
and because a genuine Salesforce edit that happens to set the value we just sent
is indistinguishable from an echo, treating it as one changes nothing.

**What L4 trades.** When the breaker trips we are knowingly different from
Salesforce on one field, with an alert raised. That is worse than agreeing and
better than spending the whole cap on an argument neither side can win — and
every other record keeps syncing, which is the point.

### F.10 The outage numbers, and the recovery order

**Why the average and not the peak.** The two readings differ by a factor of six
— about 6 minutes against about 35 — so the choice has to be stated rather than
buried. A peak is a 15-minute phenomenon driven by a campaign or an import; six
consecutive hours of 20 edits/s is not a credible load for 5 M records touched
four times a year. Sizing the headline for it would overstate what the client
should expect to wait, so the headline uses the business-hours average and the
peak is carried as row 3 of the same table. Both numbers are on the page, and a
reader who disagrees with the judgement can read their answer off row 3.

**Why the sweep must finish before the drain starts.** Finance sets a city to
Noida at 15:00, queued unsent. At 17:00 a sales user sets it to Delhi in
Salesforce, and that webhook never arrives (A16). The link returns at 21:00.
*Drain first:* we PATCH Noida, Salesforce's Delhi is overwritten, and the sweep
then reads back our own value and learns nothing — Delhi is destroyed with no
record it ever existed, and nothing in the system would report it. *Sweep first:*
Delhi's `SystemModstamp` of 17:00 beats the portal's 15:00, so Delhi becomes
current, Noida is kept as `superseded` under the finance user's name, 8.3 finds
nothing owed, and the queued row sends the current value — Delhi — as a no-op.
Both edits on record, both copies agreeing.

**How small the window is, and why the ordering is still right.** With 14,954
portal-touched and 34,892 Salesforce-touched records out of 5 M, the expected
overlap is `14,954 × 34,892 / 5,000,000` = **104 records**. The ordering costs no
time at all — the sweep has to run anyway — and it protects exactly the hundred
records where an edit would otherwise vanish silently.

**Why the sweep could not work without the restatement rule.** A
`SystemModstamp` is a *record's* modification time, not a field's, so a record
touched at 17:00 hands back every one of its fields stamped 17:00 — including
fields last changed months ago. Compared as changes, those restatements would beat
any portal edit made during the outage and overwrite it with Salesforce's stale
value: the exact data loss the design exists to prevent. That is why step (b) of
8.4 is unconditional rather than a full-record-mode option.

**What the table says beyond row 1.** The **cap is the floor, not our design**:
row 3's 99,692 calls at the full 100 req/s with no reserve at all is still
`997 s = 16.6 min`, so our 30% reserve costs about 11 minutes in the worst
credible case and nothing we could do on our side beats 16.6. That is the trade to
put in front of the client (A12). **One request reads 2,000 records and one
writes 1**, which is why the inbound side of a blackout is nearly free (18
requests, 0.3 s of budget) and recovery is dominated by the drain in every row but
6. **Row 5 matters most**, being the only row driven by a number we choose rather
than observe. And **row 6 demotes A4** from load-bearing to merely preferable: a
full 5 M compare costs 2,500 requests, 40 s of API budget and ~17 min of local
merge — affordable, which is why I would run that sweep nightly regardless of A4,
as the standing net under lost webhooks, canonicalisation gaps, fields L4 gave up
on, and 7.6's inversions.

### F.11 Why these three numbers

**Age, not depth.** 19,000 rows draining fast is healthy; 3 rows stuck is not. A
depth alarm fires loudest during catch-up — exactly when the system is doing its
job — which is how alarms get muted. When number 1 pages, the first action is to
tell three causes apart: the sender lost its lease, the breaker is open, or a
poison row at the head is being retried forever.

**Why number 2 includes Salesforce's own emission delay,** which is not ours to
fix: the 30 seconds we promised is end to end, and a metric that excluded the
5 seconds we do not control would stay green while we missed the commitment.

**Why number 3 is the one I would least give up.** Nothing else reports a skew
past A10, a canonicalisation gap turning echoes into changes, a loop rule that
stopped working, or a Salesforce process overwriting portal edits in bulk — all of
which look perfectly healthy on latency and queue-depth metrics. It is the only
number that detects *incorrectness* rather than slowness.

### F.12 What each omission would cost

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
