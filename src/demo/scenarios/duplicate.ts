/**
 * A duplicate webhook (design 8.1), and the validation refusals around it.
 *
 * The rule has two independent layers and **only the second is the
 * guarantee**, which is what this scenario is really showing:
 *
 * 1. suppression — the `eventId` claim, which makes a duplicate do no work;
 * 2. harmlessness — the strict `>` of the order key, which makes a duplicate a
 *    no-op even if the claim table were pruned, restored from backup, or
 *    truncated.
 *
 * A design resting on layer 1 alone is one retention policy away from
 * corrupting data, so the scenario proves layer 2 separately by replaying an
 * event whose claim has been deliberately forgotten.
 */

import { check, detail, heading, kv, step, why } from "../report.js";
import { World } from "../world.js";

export async function duplicate(): Promise<void> {
  heading(2, "A duplicate webhook", "8.1");
  const w = World.create({ name: "duplicate" });

  const at = Date.parse("2026-11-02T09:00:00.000Z");
  const { sfId, event } = w.salesforce.applyExternalEdit({
    objectType: "Contact",
    changedFields: { full_name: "Ravi Kumar", city: "Pune" },
    actor: "sales.user@client.example",
    atMs: at,
  });
  w.salesforce.drainWebhooks();

  step(`First delivery of ${event.eventId}.`);
  const first = w.deliver(event);
  kv("response", `${first.status} ${first.body.status}`);
  const portalId = w.store.read((tx) => tx.findLinkBySfId("Contact", sfId)?.portalId ?? "");
  const historyAfterFirst = w.history("Contact", portalId).length;
  kv("permanent history rows", historyAfterFirst);

  step(`Salesforce delivers ${event.eventId} again — byte for byte.`);
  const second = w.deliver(event);
  kv("response", `${second.status} ${second.body.status}`);
  kv("permanent history rows", w.history("Contact", portalId).length);
  check(second.body.status === "duplicate", "the second delivery was recognised");
  check(
    w.history("Contact", portalId).length === historyAfterFirst,
    "it wrote no history and changed nothing",
  );
  detail("Not alerted, only counted: assumption A7 permits a second delivery.");

  step("Layer 2: the same event again, with its claim deliberately forgotten.");
  detail("Simulating a 30-day prune, a restore from backup, or a truncate.");
  w.store.transaction((tx) => {
    delete tx.state.inboundEvents[event.eventId];
  });
  const third = w.deliver(event);
  kv("response", `${third.status} ${third.body.status}`);
  kv("permanent history rows", w.history("Contact", portalId).length);
  check(
    w.history("Contact", portalId).length === historyAfterFirst,
    "still no new history — the order key is strictly greater, and equal is not greater",
  );
  why(
    "suppression saves work; strictness is the correctness guarantee. Because " +
      "the comparison is `>` and not `>=`, re-applying a change we have already " +
      "applied does nothing, independently of the claim table.",
  );

  step("Malformed and invalid webhooks are refused with a specific reason.");
  const cases: readonly (readonly [string, string])[] = [
    ["not json at all", "{not json"],
    ["missing eventId", JSON.stringify({ recordId: "x", objectType: "Contact", occurredAt: 1, changedBy: "a", changedFields: { city: "P" } })],
    ["unknown objectType", JSON.stringify({ eventId: "e1", recordId: "x", objectType: "Invoice", occurredAt: 1, changedBy: "a", changedFields: { city: "P" } })],
    ["unknown field", JSON.stringify({ eventId: "e2", recordId: "x", objectType: "Contact", occurredAt: 1, changedBy: "a", changedFields: { telephon: "P" } })],
    ["no changed fields", JSON.stringify({ eventId: "e3", recordId: "x", objectType: "Contact", occurredAt: 1, changedBy: "a", changedFields: {} })],
    ["unparseable occurredAt", JSON.stringify({ eventId: "e4", recordId: "x", objectType: "Contact", occurredAt: "soon", changedBy: "a", changedFields: { city: "P" } })],
  ];
  for (const [label, body] of cases) {
    const res = w.deliverRaw(body);
    kv(label, `${res.status} ${res.body.reason}`);
    check(res.status === 400, `${label} -> 400, named precisely`);
  }
  why(
    "a 400 discards the event forever, so it is only for payloads time will " +
      "not fix. An unknown field name earns one; a value we merely failed to " +
      "canonicalise would not — that is our bug, and it earns a 500 and a retry " +
      "(design 5).",
  );
}
