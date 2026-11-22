# One sender process, with a leader lease rather than replicas

Exactly one process sends to Salesforce at a time. It holds a Postgres
advisory lock; other instances run but idle as standbys, taking over when the
lock is released or its session dies.

The 100 requests/second cap is a single global budget, and the cheapest correct
way to spend a global budget is from one place: an in-process token bucket,
with no coordination, no clock skew between senders and no shared counter to
get wrong. The throughput argument that would normally force horizontal
scaling does not apply at this scale — 70 requests/second at a 2-second p99 is
140 requests in flight by Little's law, which one Node process handles
comfortably — so sharding the cap would buy capacity we do not need at the cost
of a distributed rate limiter we would have to make correct.

## Considered options

- **N senders, each given cap/N.** Rejected because the shares are wrong
  almost all the time: during catch-up one shard's queue is empty while
  another's is deep, so the aggregate stays under the cap while the backlog
  drains slower than it should.
- **N senders sharing a token bucket in Redis.** Rejected because it adds a
  component, and a second place where "how much cap is left" lives, to solve a
  throughput problem we do not have. This is the right answer if the outbound
  rate ever approaches what one process can push.
- **One sender, no standby.** Rejected only because the failover is nearly
  free: the lock is released automatically when the holder's session ends, so a
  standby takes over in seconds without an orchestrator deciding anything.

## Consequences

Sending is a singleton, so a restart has to reclaim rows left `inflight`,
which is why `outbound_change` carries a lease rather than a plain claim flag.
The standby must also be genuinely idle — it must not run the outage recovery
sweep either, since that spends the same cap.
