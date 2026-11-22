/**
 * The rate governor: a token bucket with additive-increase /
 * multiplicative-decrease, implementing design 6.4.
 *
 * The design runs at 70 of the 100 requests per second Salesforce allows. The
 * demo configures a deliberately low ceiling so the wait is visible, which the
 * exercise explicitly permits — but the code enforces whatever cap it is
 * given, which is the property being demonstrated.
 *
 * One token per HTTP request **including every retry**, because the exercise
 * is explicit that the cap counts retries.
 */

/** A clock and a sleep, injected so tests do not have to wait in real time. */
export interface GovernorClock {
  nowMs(): number;
  sleep(ms: number): Promise<void>;
}

/** The real clock. */
export const realClock: GovernorClock = {
  nowMs: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export interface GovernorOptions {
  /** The ceiling, in requests per second. The design's value is 70. */
  readonly ceilingPerSecond: number;
  /** Floor for the multiplicative decrease, so we never stall completely. */
  readonly floorPerSecond?: number;
  /** Added back per recovery step. The design's value is 5. */
  readonly increasePerStep?: number;
  /** How long a clean run must last before a recovery step. Design: 30 s. */
  readonly recoveryStepMs?: number;
  readonly clock?: GovernorClock;
}

/**
 * Token bucket with AIMD.
 *
 * Why additive recovery is slower than the halving (design 6.4): a
 * rate-limited period should not oscillate. Halving reacts immediately to a
 * signal we were given; recovery has to probe, because nothing tells us the
 * limit has lifted.
 */
export class RateGovernor {
  private ratePerSecond: number;
  private readonly ceiling: number;
  private readonly floor: number;
  private readonly increase: number;
  private readonly recoveryStepMs: number;
  private readonly clock: GovernorClock;

  private tokens: number;
  private lastRefillMs: number;
  private lastDecreaseMs: number;

  /** Requests granted, for the demo's printed output and for assertions. */
  private granted = 0;

  constructor(options: GovernorOptions) {
    if (options.ceilingPerSecond <= 0) {
      throw new RangeError("ceilingPerSecond must be positive");
    }
    this.ceiling = options.ceilingPerSecond;
    this.floor = options.floorPerSecond ?? Math.min(1, options.ceilingPerSecond);
    this.increase = options.increasePerStep ?? 5;
    this.recoveryStepMs = options.recoveryStepMs ?? 30_000;
    this.clock = options.clock ?? realClock;
    this.ratePerSecond = this.ceiling;
    this.tokens = this.ceiling;
    this.lastRefillMs = this.clock.nowMs();
    this.lastDecreaseMs = 0;
  }

  /** The rate currently allowed, in requests per second. */
  get currentRate(): number {
    return this.ratePerSecond;
  }

  /** How many requests this governor has granted. */
  get grantedCount(): number {
    return this.granted;
  }

  /**
   * Resume at half the ceiling, which is what the circuit breaker does on
   * close (design 6.4) and what the outage arithmetic in 10.4 charges for.
   */
  resumeAtHalfRate(): void {
    this.ratePerSecond = Math.max(this.floor, this.ceiling / 2);
    this.lastDecreaseMs = this.clock.nowMs();
  }

  /**
   * Take one token, waiting if the bucket is empty.
   *
   * Every request passes through here, retries included, which is the whole
   * point: the exercise's cap counts the calls we make, not the edits we
   * process.
   */
  async acquire(): Promise<void> {
    for (;;) {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        this.granted += 1;
        return;
      }
      // Wait for the next whole token rather than spinning.
      const deficit = 1 - this.tokens;
      await this.clock.sleep(Math.ceil((deficit / this.ratePerSecond) * 1000));
    }
  }

  /**
   * Handle a slow-down signal: halve the rate, keeping the work (design 6.4).
   *
   * Nothing is dropped here, and nothing can be — the governor has no
   * knowledge of queue rows. The caller returns the row to `pending` with its
   * attempt restored; this object only decides how fast we are willing to
   * spend the cap.
   */
  onThrottled(): void {
    this.ratePerSecond = Math.max(this.floor, this.ratePerSecond / 2);
    this.tokens = 0;
    this.lastDecreaseMs = this.clock.nowMs();
  }

  /**
   * Called after a clean response. Steps the rate back up once a full
   * recovery interval has passed since the last decrease or step.
   */
  onSuccess(): void {
    if (this.ratePerSecond >= this.ceiling) return;
    const now = this.clock.nowMs();
    if (now - this.lastDecreaseMs >= this.recoveryStepMs) {
      this.ratePerSecond = Math.min(this.ceiling, this.ratePerSecond + this.increase);
      this.lastDecreaseMs = now;
    }
  }

  /** Add tokens for elapsed time, capped at one second's worth. */
  private refill(): void {
    const now = this.clock.nowMs();
    const elapsedMs = Math.max(0, now - this.lastRefillMs);
    this.lastRefillMs = now;
    this.tokens = Math.min(
      this.ratePerSecond,
      this.tokens + (elapsedMs / 1000) * this.ratePerSecond,
    );
  }
}
