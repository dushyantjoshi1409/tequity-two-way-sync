/**
 * An older change arriving after a newer one (design 8.2).
 *
 * Two things are on show, and the second is the one that is easy to miss:
 *
 * 1. the older change never becomes the current value, but **is kept** as
 *    `superseded` with its real value, actor and time — because the brief says
 *    the fact of an earlier edit stays on record, and dropping it counts as
 *    losing a change;
 * 2. it enqueues **no repair call**. A repair rule that compared the incoming
 *    value against ours would fire here and waste a request, because the late
 *    event describes a *past* state of Salesforce rather than its current one.
 *    That is the bug step (a) of the apply exists to prevent, and this
 *    scenario is the regression test for it.
 */

import { check, detail, heading, kv, step, table, why } from "../report.js";
import { World } from "../world.js";

export async function outOfOrder(): Promise<void> {
  heading(3, "An older webhook arrives after a newer one", "8.2");
  const w = World.create({ name: "out-of-order" });

  const base = Date.parse("2026-11-02T11:30:00.000Z");
  const { sfId } = w.salesforce.applyExternalEdit({
    objectType: "Contact",
    changedFields: { full_name: "Meera Iyer", phone: "+919876500000" },
    actor: "sales.user@client.example",
    atMs: base,
  });
  w.deliver(w.salesforce.drainWebhooks()[0]!);
  const portalId = w.store.read((tx) => tx.findLinkBySfId("Contact", sfId)?.portalId ?? "");

  // Two Salesforce edits to one field, four and nine seconds in.
  const evtA = w.salesforce.applyExternalEdit({
    objectType: "Contact",
    sfId,
    changedFields: { phone: "+919876500001" },
    actor: "sales.user@client.example",
    atMs: base + 4_000,
  }).event;
  const evtB = w.salesforce.applyExternalEdit({
    objectType: "Contact",
    sfId,
    changedFields: { phone: "+919876500002" },
    actor: "sales.user@client.example",
    atMs: base + 9_000,
  }).event;
  w.salesforce.drainWebhooks();

  detail(`${evtA.eventId}  phone -> +919876500001  occurredAt 11:30:04.000`);
  detail(`${evtB.eventId}  phone -> +919876500002  occurredAt 11:30:09.000`);

  step("Salesforce delivers them out of order: the NEWER one first.");
  const resB = w.deliver(evtB);
  kv(`${evtB.eventId} (11:30:09)`, `${resB.status} ${resB.body.status}`);
  kv("phone now", w.portalValues("Contact", portalId)["phone"]);

  step("Then the OLDER one arrives.");
  const pendingBefore = w.outbound().filter((r) => r.state === "pending").length;
  const resA = w.deliver(evtA);
  kv(`${evtA.eventId} (11:30:04)`, `${resA.status} ${resA.body.status}`);
  kv("phone now", w.portalValues("Contact", portalId)["phone"]);
  const pendingAfter = w.outbound().filter((r) => r.state === "pending").length;

  check(
    w.portalValues("Contact", portalId)["phone"] === "+919876500002",
    "the current value is still the newer one",
  );
  check(resA.body.status === "superseded", "the older change was recorded as superseded");
  check(
    pendingAfter === pendingBefore,
    "no repair call was enqueued — the late event described a PAST Salesforce state",
  );

  step("The history: the loser is kept, with its author and its time.");
  table(
    ["field", "old", "new", "actor", "occurredAt", "outcome"],
    w.history("Contact", portalId)
      .filter((h) => h.field === "phone")
      .map((h) => [
        h.field,
        h.oldValue ?? "-",
        h.newValue ?? "-",
        h.actor.split("@")[0] ?? h.actor,
        new Date(h.occurredAtMs).toISOString().slice(11, 23),
        h.outcome,
      ]),
  );
  check(
    w.history("Contact", portalId).some(
      (h) => h.outcome === "superseded" && h.newValue === "+919876500001",
    ),
    "the superseded edit is on permanent record, not discarded",
  );
  why(
    "step (a) of the apply learns what Salesforce holds before step (c) decides " +
      "anything, and it only learns from an event that is the newest word we " +
      "have had. Without that guard the late event would have set sf_value to a " +
      "stale value and the one repair condition would have fired on a " +
      "disagreement that does not exist.",
  );

  step("No reordering buffer, deliberately.");
  detail("Assumption A11 gives no sequence numbers, so we cannot detect that");
  detail("anything is missing. A buffer could only wait a fixed time, adding");
  detail("that latency to every event to maybe help a rare one.");
}
