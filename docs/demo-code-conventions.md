# Conventions for the optional demo code

Recorded during the design phase so the code phase inherits them rather than
rediscovering them. These are requirements on the demo, not suggestions.

## Documentation

- Every module has a TSDoc block saying what it is for and what a caller must
  know, in the sense part 2.3 of the design uses the word "interface":
  invariants, ordering constraints and failure modes, not only types.
- Every exported function has a TSDoc block. Non-exported helpers get one when
  the name does not already say it.
- At each of the four rules — duplicate webhook, out-of-order change, loop
  termination, outage and rate cap — a comment explains **why** the rule is
  shaped that way and cites the design section it implements. The what is
  visible in the code; the why is not, and the why is what a reviewer will
  check against the design document.

## Error handling

- Malformed or invalid webhooks are rejected with a clear, specific error that
  names what was wrong. An unparseable body, a missing `eventId`, an unknown
  `objectType` and an unknown field are four different messages.
- Fake-Salesforce failures and 429 slow-downs are caught and retried without
  losing work: the queued row goes back to pending with its attempt count
  raised, never dropped.
- Store read and write failures are surfaced, never swallowed. A failed apply
  must leave the transaction rolled back and the error visible to the caller.
- **No empty catch blocks, anywhere.** A catch either handles the error,
  translates it into a domain error and rethrows, or records it somewhere a
  human will see. Catching to continue silently is the one thing that would
  make the demo's printed output a lie.

## Why these matter for this exercise specifically

The exercise says a rule that is only in the document, with a demo that does
something else, will come up on the call. Comments that cite the design section
are how the two stay tied together, and explicit error handling is how the
demo's output stays trustworthy — a swallowed exception in the outbound sender
would make a lost call look like a drained queue.
