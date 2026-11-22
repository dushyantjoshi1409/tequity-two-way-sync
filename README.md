# Two-way sync of customer and contact records

Tequity Round 1 exercise. The client runs sales in Salesforce and finance /
customer-success in a portal Tequity built on Postgres. The same customers and
contacts live in both systems and have to stay in two-way sync, with every
field's history kept.

## What is in this repository

| Path | What it is |
| --- | --- |
| `docs/design.md` | **The design document. Start here.** The exercise's 12-part outline, assumptions first, with four appendices: A the brief's scenario traced, B the hardest race, C interfaces/schema/sequences, D assumption consequences and rejected alternatives. |
| `CONTEXT.md` | Glossary. The project's domain vocabulary, fixed before the design leans on it. |
| `docs/adr/` | Decision records for the three choices that are expensive to reverse. |
| `src/`, `package.json` | Optional demo code (Phase 2). TypeScript on Node 20+, fake Salesforce, no external services. |

## Reading order

1. `docs/design.md` part 1 — assumptions and the questions I would have asked.
2. `docs/design.md` part 2 — the systems, who calls whom, the network seam.
3. `docs/design.md` parts 7-10 — the four rules: same-record conflict,
   duplicates and out-of-order, loop termination, and the 6-hour outage with
   the arithmetic.
4. `docs/design.md` appendix A — the exercise's own worked scenario (phone in
   Salesforce, city in the portal) traced through every rule, and appendix B —
   the overwrite race, which is where tracing found a real bug.

## Running the demo

Phase 2. Not yet present.

## Commit history

The commits are the record of how the design developed and are deliberately
not squashed. Each message says what was decided and why.
