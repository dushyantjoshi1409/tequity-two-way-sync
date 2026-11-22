/**
 * Tests for the rate governor (design 6.4).
 *
 * All of them run on an injected clock, so the suite proves the pacing
 * arithmetic without spending the time it describes.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { RateGovernor } from "./governor.js";
import type { GovernorClock } from "./governor.js";

/** A clock the test drives. `sleep` advances it rather than waiting. */
function fakeClock(): GovernorClock & { advance(ms: number): void } {
  let now = 0;
  return {
    nowMs: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("RateGovernor", () => {
  test("enforces whatever cap it is given", async () => {
    const clock = fakeClock();
    const g = new RateGovernor({ ceilingPerSecond: 4, clock });
    // The bucket starts with one second's worth, so the first 4 are free.
    for (let i = 0; i < 4; i += 1) await g.acquire();
    assert.equal(clock.nowMs(), 0, "the first second's worth costs no time");

    // The next 8 must be paced at 4/s, which is 2 seconds.
    for (let i = 0; i < 8; i += 1) await g.acquire();
    assert.ok(
      clock.nowMs() >= 1900 && clock.nowMs() <= 2200,
      `8 more at 4/s should take about 2000 ms, took ${clock.nowMs()}`,
    );
    assert.equal(g.grantedCount, 12);
  });

  test("a different cap gives a proportionally different time", async () => {
    const clock = fakeClock();
    const g = new RateGovernor({ ceilingPerSecond: 8, clock });
    for (let i = 0; i < 8; i += 1) await g.acquire();
    for (let i = 0; i < 8; i += 1) await g.acquire();
    // 8 beyond the initial bucket, at 8/s, is about 1 second.
    assert.ok(
      clock.nowMs() >= 900 && clock.nowMs() <= 1200,
      `expected about 1000 ms, took ${clock.nowMs()}`,
    );
  });

  test("counts retries, because the cap counts the calls we make", async () => {
    const clock = fakeClock();
    const g = new RateGovernor({ ceilingPerSecond: 10, clock });
    await g.acquire();
    await g.acquire(); // the same row, retried
    assert.equal(g.grantedCount, 2, "a retry spends a token like any other request");
  });

  test("halves the rate on a slow-down signal", () => {
    const clock = fakeClock();
    const g = new RateGovernor({ ceilingPerSecond: 70, clock });
    assert.equal(g.currentRate, 70);
    g.onThrottled();
    assert.equal(g.currentRate, 35);
    g.onThrottled();
    assert.equal(g.currentRate, 17.5);
  });

  test("never halves below the floor, so it cannot stall completely", () => {
    const clock = fakeClock();
    const g = new RateGovernor({ ceilingPerSecond: 70, floorPerSecond: 5, clock });
    for (let i = 0; i < 20; i += 1) g.onThrottled();
    assert.equal(g.currentRate, 5);
  });

  test("recovers additively, and only after a full interval", () => {
    const clock = fakeClock();
    const g = new RateGovernor({
      ceilingPerSecond: 70,
      increasePerStep: 5,
      recoveryStepMs: 30_000,
      clock,
    });
    g.onThrottled();
    assert.equal(g.currentRate, 35);

    // Too soon: a clean response inside the interval does not step up. The
    // recovery is deliberately slower than the halving so a rate-limited
    // period does not oscillate (design 6.4).
    clock.advance(29_000);
    g.onSuccess();
    assert.equal(g.currentRate, 35);

    clock.advance(2_000);
    g.onSuccess();
    assert.equal(g.currentRate, 40);
  });

  test("recovery stops at the ceiling", () => {
    const clock = fakeClock();
    const g = new RateGovernor({
      ceilingPerSecond: 10,
      increasePerStep: 5,
      recoveryStepMs: 100,
      clock,
    });
    g.onThrottled(); // 5
    for (let i = 0; i < 10; i += 1) {
      clock.advance(200);
      g.onSuccess();
    }
    assert.equal(g.currentRate, 10, "never exceeds the cap it was given");
  });

  test("resumeAtHalfRate is what the breaker does on close", () => {
    const clock = fakeClock();
    const g = new RateGovernor({ ceilingPerSecond: 70, clock });
    g.resumeAtHalfRate();
    assert.equal(g.currentRate, 35, "design 6.4: resume at half rate and ramp");
  });

  test("refuses a nonsensical cap rather than behaving oddly", () => {
    assert.throws(() => new RateGovernor({ ceilingPerSecond: 0 }), RangeError);
  });
});
