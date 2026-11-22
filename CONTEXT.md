# Customer and contact sync

The one context in this repository: keeping the client's customer and contact
records consistent between Salesforce and the Tequity portal, in both
directions, without losing the record of who changed what and when.

## Language

### The records

**Record**:
One customer or one contact. The thing that exists in both Salesforce and the
portal and has to agree.
_Avoid_: entity, object, row.

**Customer**:
An organisation the client sells to. Has a name, a status and an owner.
_Avoid_: account, client, company.

**Contact**:
A person at a customer. Has a full name, phone, email, city, owner and the
customer they belong to.
_Avoid_: person, lead, user.

**Field**:
One named, separately syncable value on a record, such as a contact's city.
The field, not the record, is the unit that conflicts and the unit that carries
history.

### What happens to them

**Edit**:
One human action: a sales user saving in Salesforce, or a finance user saving
the portal form. An edit touches one or more fields.
_Avoid_: update, modification.

**Change**:
One field moving to one new value, attributed to one actor at one time. An
edit of three fields is three changes. Changes, not edits, are what the sync
reasons about.
_Avoid_: delta, event, patch.

**Origin**:
The system an edit was made in: Salesforce or the portal. Every change carries
its origin for the rest of its life.
_Avoid_: source, side, direction.

**Actor**:
The identified human or integration account that made an edit. Part of the
history the client is paying for, not metadata.
_Avoid_: user, author, editor.

### Deciding what is true

**Order key**:
The comparable value that decides which of two changes to the same field is
the later one. Two changes to one field are always comparable, and the
comparison gives the same answer wherever it is made.
_Avoid_: version, timestamp, sequence number.

**Current value**:
The value of a field that the portal shows and that we are willing to defend
as correct: the value of the change with the highest order key for that field.
_Avoid_: latest value, truth, master value.

**Superseded change**:
A real change that lost the order-key comparison. It never becomes a current
value, and it is kept with its actor and time, because the client asked for the
fact of the earlier edit to stay on record.
_Avoid_: stale change, rejected change, discarded change.

**Canonical form**:
The single spelling of a value that comparisons use, so that two systems
agreeing on a value never look like they disagree. "+91 98765 43210" and
"+919876543210" have one canonical form.
_Avoid_: normalised value, cleaned value.

### Keeping the two sides apart

**Echo**:
A webhook describing a change we ourselves made in Salesforce moments earlier.
An echo is a genuine Salesforce notification, not a duplicate, and it carries
no new information.
_Avoid_: loopback, reflection, bounce.

**Repair write**:
An outbound call we send because we learned that Salesforce holds a value our
rules do not accept. It carries our current value and exists to end a
disagreement we detected rather than to publish a new edit.
_Avoid_: correction, reconciliation, force push.

**Integration user**:
The single Salesforce login every call of ours is made as. Its only purpose is
to make our own changes recognisable when Salesforce describes them back to us.
_Avoid_: service account, API user, bot.

**Record link**:
The pairing between a record's Salesforce identifier and its portal
identifier. A record created in the portal has a portal identifier before it
has a Salesforce one.
_Avoid_: mapping, id map, cross-reference.

**Watermark**:
The point in Salesforce's own change history up to which we are confident we
have seen everything. What recovery after an outage starts from.
_Avoid_: checkpoint, cursor, offset.
