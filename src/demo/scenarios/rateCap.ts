/**
 * The rate cap, and slowing down without losing work (design 6.4).
 *
 * The design runs at 70 of the 100 requests per second Salesforce allows. The
 * exercise permits a lower cap in a demo so the wait is visible, and that is
 * what this scenario does — but **the code enforces whatever cap it is
 * given**, which is the property on show. The cap counts every request
 * including retries, because the exercise is explicit that it does.
 *
 * The second half is the slow-down signal. Nothing is dropped: the governor
 * halves the rate it is willing to spend, and the queue rows go back to
 * `pending` with their attempt **restored**, because being throttled was not
 * the row's fault.
 */

import { check, detail, heading, kv, step, why } from "../report.js";
import { World } from "../world.js";

const CEILING = 4;
const RECORDS = 12;

export async function rateCap(): Promise<void> {
  heading(5, "The rate cap is enforced, and a slow-down keeps the work", "6.4");
  const w = World.create({ name: "rate-cap", ceilingPerSecond: CEILING });

  step(`Queue ${RECORDS} separate records, with the governor set to ${CEILING} req/s.`);
  detail("Separate records on purpose: coalescing would otherwise collapse them");
  detail("into one call, which is the right behaviour but not what is being shown.");
  for (let i = 0; i < RECORDS; i += 1) {
    w.save({
      objectType: "Contact",
      actor: "finance.user@client.example",
      changedFields: { full_name: `Person ${i}`, city: "Pune" },
    });
  }
  kv("pending outbound rows", w.worker.pendingCount());

  step("Drain, and time it.");
  const started = Date.now();
  await w.worker.drain();
  const elapsedMs = Date.now() - started;
  const lowerBoundMs = ((RECORDS - CEILING) / CEILING) * 1000;
  kv("calls made", w.governor.grantedCount);
  kv("elapsed", `${elapsedMs} ms`);
  kv("floor implied by the cap", `${Math.round(lowerBoundMs)} ms`);
  kv("effective rate", `${(w.governor.grantedCount / (elapsedMs / 1000)).toFixed(1)} req/s`);
  check(w.governor.grantedCount === RECORDS, `all ${RECORDS} records were sent`);
  check(
    elapsedMs >= lowerBoundMs * 0.8,
    `the drain took at least the time the ${CEILING} req/s cap allows`,
  );
  check(w.worker.pendingCount() === 0, "nothing was left behind");
  why(
    "the bucket starts with one second's worth of tokens, so the first " +
      `${CEILING} calls go immediately and the remaining ${RECORDS - CEILING} are ` +
      `paced at ${CEILING} per second. Raising the cap shortens this; the code ` +
      "does not care what the number is.",
  );

  // --- the slow-down signal -------------------------------------------------
  step("Salesforce says slow down (429 with Retry-After) on the next 3 calls.");
  const rateBefore = w.governor.currentRate;
  w.salesforce.throttleNext(3, 120);
  for (let i = 0; i < 3; i += 1) {
    w.save({
      objectType: "Contact",
      actor: "finance.user@client.example",
      changedFields: { city: `City ${i}` },
    });
  }
  const queued = w.worker.pendingCount();
  kv("pending outbound rows", queued);
  kv("governor rate before", `${rateBefore} req/s`);

  const firstPass = await w.worker.drain();
  kv("throttled rows", firstPass.throttled);
  kv("governor rate after", `${w.governor.currentRate} req/s`);
  check(w.governor.currentRate < rateBefore, "the governor halved its rate");
  check(w.worker.pendingCount() > 0, "the work is still queued — nothing was dropped");
  const attempts = w.outbound().filter((r) => r.state === "pending").map((r) => r.attempts);
  kv("attempt counts on those rows", JSON.stringify(attempts));
  check(
    attempts.every((a) => a === 0),
    "their attempt counts were restored — a 429 is not the row's fault",
  );

  step("Wait out Retry-After and drain again.");
  await settle(w);
  kv("pending outbound rows", w.worker.pendingCount());
  kv("failed rows", w.outbound().filter((r) => r.state === "failed").length);
  check(w.worker.pendingCount() === 0, "everything the portal saved reached Salesforce");
  check(
    w.outbound().filter((r) => r.state === "failed").length === 0,
    "no row was marked failed by being throttled",
  );
  why(
    "the governor only decides how fast we are willing to spend the cap; it " +
      "has no knowledge of queue rows, so it cannot lose one. Keeping the work " +
      "is a property of the settle table, not of the rate limiter.",
  );
}

/** Drain repeatedly, waiting for `nextAttemptAt` to come due, until empty. */
async function settle(w: World, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (w.worker.pendingCount() > 0) {
    if (Date.now() > deadline) {
      // Surfaced, not swallowed: a demo that quietly gave up here would
      // report a drained queue that is not drained.
      throw new Error(
        `queue did not settle within ${timeoutMs} ms; ${w.worker.pendingCount()} rows remain`,
      );
    }
    await new Promise((r) => setTimeout(r, 50));
    await w.worker.drain();
  }
}
