# Merge per field, not per record

Two changes to the same record are compared and resolved field by field. The
whole system's unit of sync is a field — one named value on one record — and
not the record itself. A record has no version; each of its fields has one.

This is forced by the requirement, not chosen for elegance: the exercise's own
scenario has finance correcting a contact's city in the portal and sales then
changing the same contact's phone in Salesforce, and demands that the portal
end with both. Any design that versions the record as a whole and takes the
later writer must discard one of those two edits, because the two edits are
concurrent with respect to each other and the record-level comparison has no
way to see that they touched different fields.

## Considered options

- **Record-level last-writer-wins.** One version per row, compare, take the
  later. This is what most sync integrations do and it is far simpler: 5
  million version stamps instead of 27 million, one lock instead of up to nine,
  no per-field history table. Rejected because it fails the exercise's stated
  acceptance scenario outright. It is worth naming explicitly because it is the
  obvious thing to reach for and a reader should know it was considered and why
  it is not enough.
- **Record-level, but with a merge on write.** Keep one version per record,
  and on conflict re-read both sides and merge the fields by hand. Rejected
  because "re-read both sides" means a Salesforce call per conflict, on a path
  that is already rate-capped, and because the merge still needs per-field
  times to decide anything — so it pays the cost of field-level ordering
  without getting the storage back.
- **Full event sourcing, with the current values projected.** Keep only the
  change log and derive everything. Rejected as the primary model because the
  portal is an existing application that reads typed rows, and making every
  portal read a fold over history would be a rewrite of the portal to serve the
  sync. The design keeps the useful half of this — `field_change` is an
  append-only log and `field_version` is explicitly a rebuildable cache over it
  — without making the portal pay for it.

## Consequences

Up to nine row locks per inbound webhook instead of one, taken in a fixed
field order so that concurrent applies to one record serialise instead of
deadlocking. About 27 million stamp rows and 5 GB a year of permanent history.
Both are priced in part 4.7 and neither is close to a problem at this scale.

The compensating benefit beyond correctness: because a change is per field,
"who changed the phone" and "who changed the city" are each one indexed read,
which is the other thing the client asked for.
