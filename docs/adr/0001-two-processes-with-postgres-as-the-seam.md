# Two processes, with Postgres as the seam between them

The webhook endpoint and the sync worker are separate processes in one
repository, and they communicate only through rows in Postgres
(`outbound_change` one way, `echo_fence` the other) rather than through HTTP or
a message broker.

They are split because their scaling and failure stories are opposites: the
endpoint is latency-sensitive and horizontally scalable and must never block on
Salesforce, while the worker is the single governor of a shared 100 req/s
budget and we want exactly one of it. They are joined through the database
because the outbound queue has to survive a process restart anyway, and once it
is in Postgres the inbound apply and the outbound enqueue become one
transaction — so "we changed a value" and "we owe Salesforce a call" cannot
disagree after a crash.

## Considered options

- **One process.** Simpler to deploy, and genuinely tempting at this volume.
  Rejected because a slow Salesforce would then share a process with the
  endpoint, and the back pressure would reach Salesforce as 500s on webhook
  delivery, causing it to retry work we had already accepted.
- **Two processes with a broker (SQS, Kafka, Redis).** Rejected because it
  buys nothing we need and costs the transactional guarantee above: enqueueing
  to a broker from inside a Postgres transaction is a two-phase problem, and
  the standard fix for it is to put the queue in the database, which is where
  we started. A broker becomes right if the outbound rate grows past what one
  Postgres table and one sender can carry; at 7 req/s steady state and a 70
  req/s ceiling that is more than an order of magnitude away.
- **Two processes talking over HTTP.** Rejected because the endpoint would
  then need its own durable retry of the hand-off, which is the queue again,
  built twice.

## Consequences

The sender is a singleton, so it needs a leader lease rather than a replica
set, and a restart has to reclaim rows it left in flight. Both are in part 6.
