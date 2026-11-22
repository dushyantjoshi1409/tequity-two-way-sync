# Two-way sync of customer and contact records

Tequity Round 1 exercise. The client runs sales in Salesforce and finance /
customer-success in a portal Tequity built on Postgres. The same customers and
contacts live in both systems and have to stay in two-way sync, with every
field's history kept.

## What is in this repository

| Path | What it is |
| --- | --- |
| `docs/design.md` | **The design document. Start here.** The exercise's 12-part outline, assumptions first. It carries every rule, interface and number, and nothing else. |
| `docs/design-appendix.md` | The working behind the design, for checking a decision rather than building from it: A the brief's scenario traced, B the hardest race, C interfaces/schema/sequences, D each assumption's consequence and the alternatives rejected, E what the demo substitutes for, F the argument behind every rule, by section. |
| `CONTEXT.md` | Glossary. The project's domain vocabulary, fixed before the design leans on it. |
| `docs/adr/` | Decision records for the three choices that are expensive to reverse. |
| `src/`, `package.json` | The optional demo. TypeScript on Node 20+, a fake Salesforce, no external services. |

## Reading order

1. `docs/design.md` part 1 — assumptions and the questions I would have asked.
2. `docs/design.md` part 2 — the systems, who calls whom, the network seam.
3. `docs/design.md` parts 7-10 — the four rules: same-record conflict,
   duplicates and out-of-order, loop termination, and the 6-hour outage with
   the arithmetic.
4. `docs/design-appendix.md` appendix A — the exercise's own worked scenario
   (phone in Salesforce, city in the portal) traced through every rule, and
   appendix B — the overwrite race, which is where tracing found a real bug.
   Appendix F holds the reasoning behind each rule the design document states.

## Running the demo

```bash
npm install
npm run demo     # the six scenarios, with printed output
npm test         # the unit tests at the rule seams
```

Node 20 or newer. No network, no services, no credentials — a fake Salesforce
written for this repository stands in for the real one, and a JSON document on
disk stands in for Postgres. `docs/design-appendix.md` appendix E lists every
substitution and says which guarantees are real and which are imitated.

The demo runs six scenarios. Four are the checks the exercise names — a
duplicate webhook, an older event arriving after a newer one, our own update
coming back as a webhook and not being sent again, and a pending call still
present after a `SIGKILL` while the fake Salesforce is down — plus the brief's
own phone-and-city acceptance scenario and the rate cap. Each names the design
section it exercises, and a failed check exits non-zero rather than printing
"FAIL" and carrying on.

## Commit history

The commits are the record of how the design developed and are deliberately
not squashed. Each message says what was decided and why.
