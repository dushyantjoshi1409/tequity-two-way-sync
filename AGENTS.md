# Project agent memory

A Tequity take-home exercise: a design document plus an optional TypeScript demo
for two-way sync between Salesforce and a Postgres-backed portal. `README.md`
has the layout and the commands; `CONTEXT.md` is the domain glossary.

## The design document is the contract

`docs/design.md` states the rules, interfaces and numbers. `docs/design-appendix.md`
holds the working: traced scenarios (A, B), interfaces/schema/sequences (C),
assumption consequences (D), demo substitutions (E), and the argument behind each
rule (F). The exercise requires the code to match the design **rule for rule**.

**Source docstrings cite design section numbers** — "design 7.3", "design 8.3",
"Appendix C.2" and so on, ~200 references. Two consequences:

- Changing a rule in code means changing the design in the same commit, and
  saying so in the message.
- Editing or renumbering the design can leave those citations dangling. After any
  restructure, check every cited label still exists. Sections `9.1`–`9.4` are
  blockquote labels rather than headings (`**9.1 — L1, the structural rule.**`)
  precisely because 26 docstrings depend on them.

## Commit history is a graded deliverable

Never squash, amend, or rewrite history: the exercise reads every commit, and
each message is expected to say what was decided and why.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
