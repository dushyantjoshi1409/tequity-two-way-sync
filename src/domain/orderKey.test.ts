/**
 * Tests for the order key — design 7.2.
 *
 * Three of these are property tests rather than examples, because the design's
 * claims about the key are properties: it is **total** (any two changes to one
 * field compare), **stable** (a redelivered event ranks the same way twice),
 * and **strict** (re-applying an applied change does nothing). An example can
 * show the first; only the properties pin the other two.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { compareOrderKeys, isStrictlyNewer, makeOrderKey } from "./orderKey.js";
import { ORIGIN_RANK } from "./types.js";

describe("makeOrderKey (design 7.2)", () => {
  test("takes the rank from ORIGIN_RANK rather than restating it", () => {
    const sf = makeOrderKey(1_000, "salesforce", "evt_1");
    const portal = makeOrderKey(1_000, "portal", "chg_1");
    assert.deepEqual(sf, {
      occurredAtMs: 1_000,
      originRank: ORIGIN_RANK.salesforce,
      originEventId: "evt_1",
    });
    assert.deepEqual(portal, {
      occurredAtMs: 1_000,
      originRank: ORIGIN_RANK.portal,
      originEventId: "chg_1",
    });
  });
});

describe("compareOrderKeys: time first (design 7.2)", () => {
  test("the later time wins, whichever side it came from", () => {
    const earlier = makeOrderKey(1_000, "salesforce", "evt_1");
    const later = makeOrderKey(2_000, "portal", "chg_1");
    assert.ok(compareOrderKeys(later, earlier) > 0);
    assert.ok(compareOrderKeys(earlier, later) < 0);
  });

  test("time beats rank: a later portal edit beats an earlier Salesforce one", () => {
    // Rank is only a tiebreak. If it were consulted before time, Salesforce
    // would win every comparison and the portal could never hold a value.
    const sfEarlier = makeOrderKey(1_000, "salesforce", "evt_1");
    const portalLater = makeOrderKey(1_001, "portal", "chg_1");
    assert.ok(isStrictlyNewer(portalLater, sfEarlier));
  });
});

describe("compareOrderKeys: Salesforce wins an exact tie (design 7.2, 8.3)", () => {
  test("same millisecond, different origin: Salesforce ranks higher", () => {
    // Not arbitrary, and worth stating as the reason rather than the rule: a
    // losing portal value costs nothing, while a losing Salesforce value
    // obliges us to send a repair write (design 8.3). The tie breaks towards
    // the cheaper direction.
    const sf = makeOrderKey(1_000, "salesforce", "evt_1");
    const portal = makeOrderKey(1_000, "portal", "chg_1");
    assert.ok(compareOrderKeys(sf, portal) > 0);
    assert.ok(compareOrderKeys(portal, sf) < 0);
    assert.ok(isStrictlyNewer(sf, portal));
    assert.ok(!isStrictlyNewer(portal, sf));
  });

  test("the tie breaks on origin, not on the event id's spelling", () => {
    // "chg_z" sorts after "evt_1", so a key that reached the event id first
    // would let the portal win this tie.
    const sf = makeOrderKey(1_000, "salesforce", "evt_1");
    const portal = makeOrderKey(1_000, "portal", "chg_z");
    assert.ok(isStrictlyNewer(sf, portal));
  });
});

describe("compareOrderKeys: the event id is last (design 7.2, A11)", () => {
  test("two Salesforce edits in one millisecond compare by event id", () => {
    // Assumption A11 gives us no sequence numbers, so a shared millisecond is
    // possible and the comparison must still be total — there is no "these two
    // are incomparable" branch for a caller to handle.
    const first = makeOrderKey(1_000, "salesforce", "evt_1");
    const second = makeOrderKey(1_000, "salesforce", "evt_2");
    assert.ok(compareOrderKeys(second, first) > 0);
    assert.ok(compareOrderKeys(first, second) < 0);
  });

  test("the answer is the same every time, which is what redelivery needs", () => {
    // Arbitrary but **stable**: a redelivered event must rank the same way the
    // second time, or "a duplicate does nothing" would depend on arrival
    // order instead of on the key (design 8.1).
    const a = makeOrderKey(1_000, "salesforce", "evt_7");
    const b = makeOrderKey(1_000, "salesforce", "evt_3");
    const first = compareOrderKeys(a, b);
    for (let i = 0; i < 5; i += 1) {
      assert.equal(compareOrderKeys(a, b), first);
    }
    assert.equal(compareOrderKeys(b, a), -first);
  });

  test("sorting is deterministic whatever order the keys arrive in", () => {
    const keys = [
      makeOrderKey(1_000, "portal", "chg_1"),
      makeOrderKey(1_000, "salesforce", "evt_2"),
      makeOrderKey(1_000, "salesforce", "evt_1"),
      makeOrderKey(900, "salesforce", "evt_9"),
    ];
    const expected = ["evt_9", "chg_1", "evt_1", "evt_2"];
    assert.deepEqual(
      [...keys].sort(compareOrderKeys).map((k) => k.originEventId),
      expected,
    );
    assert.deepEqual(
      [...keys].reverse().sort(compareOrderKeys).map((k) => k.originEventId),
      expected,
    );
  });
});

describe("isStrictlyNewer: equal keys are not newer (design 8.1 layer 2)", () => {
  test("a key is never strictly newer than itself", () => {
    // The idempotence property. Because the comparison is `>` and not `>=`,
    // re-applying a change that was already applied does nothing — so the
    // inbound path is idempotent even with the duplicate table pruned,
    // restored or truncated.
    const key = makeOrderKey(1_000, "salesforce", "evt_1");
    assert.equal(compareOrderKeys(key, key), 0);
    assert.ok(!isStrictlyNewer(key, key));
  });

  test("a redelivery built again from the same payload is not newer", () => {
    // Not the same object: the key is rebuilt from the payload's own fields,
    // exactly as a redelivered webhook would rebuild it.
    const stored = makeOrderKey(1_000, "salesforce", "evt_1");
    const redelivered = makeOrderKey(1_000, "salesforce", "evt_1");
    assert.notEqual(stored, redelivered);
    assert.ok(!isStrictlyNewer(redelivered, stored));
  });

  test("one millisecond later is newer; the same millisecond is not", () => {
    const stored = makeOrderKey(1_000, "salesforce", "evt_1");
    assert.ok(isStrictlyNewer(makeOrderKey(1_001, "salesforce", "evt_1"), stored));
    assert.ok(!isStrictlyNewer(makeOrderKey(1_000, "salesforce", "evt_1"), stored));
    assert.ok(!isStrictlyNewer(makeOrderKey(999, "salesforce", "evt_9"), stored));
  });
});

describe("compareOrderKeys: a total order (design 7.2)", () => {
  // One key per component, so every comparison path is exercised.
  const keys = [
    makeOrderKey(900, "portal", "chg_0"),
    makeOrderKey(900, "salesforce", "evt_0"),
    makeOrderKey(1_000, "portal", "chg_1"),
    makeOrderKey(1_000, "salesforce", "evt_1"),
    makeOrderKey(1_000, "salesforce", "evt_2"),
    makeOrderKey(1_001, "portal", "chg_2"),
  ];

  test("antisymmetric: swapping the arguments flips the sign", () => {
    for (const a of keys) {
      for (const b of keys) {
        const forwards = Math.sign(compareOrderKeys(a, b));
        const backwards = Math.sign(compareOrderKeys(b, a));
        // `===` rather than assert.equal, which compares by SameValue and so
        // would read the equal case as `0` against `-0` and fail.
        assert.ok(
          forwards === -backwards,
          `antisymmetry failed for ${a.originEventId} vs ${b.originEventId}: ${forwards} and ${backwards}`,
        );
      }
    }
  });

  test("transitive: a < b and b < c implies a < c", () => {
    for (const a of keys) {
      for (const b of keys) {
        for (const c of keys) {
          if (compareOrderKeys(a, b) < 0 && compareOrderKeys(b, c) < 0) {
            assert.ok(
              compareOrderKeys(a, c) < 0,
              `transitivity failed for ${a.originEventId} < ${b.originEventId} < ${c.originEventId}`,
            );
          }
        }
      }
    }
  });

  test("total: only an identical key compares equal", () => {
    for (const a of keys) {
      for (const b of keys) {
        const equal = compareOrderKeys(a, b) === 0;
        assert.equal(equal, a === b, `expected ${a.originEventId} vs ${b.originEventId}`);
      }
    }
  });
});
