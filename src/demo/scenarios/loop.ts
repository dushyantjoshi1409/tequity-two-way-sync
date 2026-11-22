/**
 * Our own update coming back as a webhook, and not being sent again
 * (design 9).
 *
 * The scenario runs the loop rule three ways, because the design is explicit
 * about which layer is the guarantee and which are economy:
 *
 * - **L1, structural:** outbound work exists only when we believe Salesforce
 *   disagrees with us. An echo makes `sf_value` equal the current value, so
 *   there is nothing left to disagree about and the loop has no fuel after one
 *   hop.
 * - **L2, the actor check:** load-bearing, not tidy. The echo carries the time
 *   Salesforce stored our write, which is *later* than the edit that write
 *   overwrote, so compared as a change it would win and launder our value back
 *   over a newer edit from the other side.
 * - **canonical form:** the precondition for L1. The scenario makes the fake
 *   reformat a phone number the way a real Salesforce does, which is the one
 *   way to give a loop fuel if values are compared raw.
 */

import { check, detail, heading, kv, step, why } from "../report.js";
import { World } from "../world.js";

export async function loop(): Promise<void> {
  heading(4, "Our own update returns as a webhook and is not sent back", "9");
  const w = World.create({ name: "loop", ceilingPerSecond: 50 });

  step("A finance user sets the city in the portal.");
  const { portalId } = w.save({
    objectType: "Contact",
    actor: "finance.user@client.example",
    changedFields: { full_name: "Nikhil Rao", city: "Noida", phone: "+91 98765 00003" },
  });
  kv("pending outbound rows", w.outbound().filter((r) => r.state === "pending").length);
  detail(
    'phone was canonicalised on the way in: "+91 98765 00003" -> ' +
      JSON.stringify(w.portalValues("Contact", portalId)["phone"]),
  );

  step("The worker sends it; Salesforce stores it and emits the echo.");
  const first = await w.worker.drain();
  kv("calls made", first.callsMade);
  const echoes = w.salesforce.drainWebhooks();
  kv("webhooks Salesforce emitted", echoes.length);

  step("We deliver the echo to our own endpoint.");
  for (const event of echoes) {
    const res = w.deliver(event);
    kv(`${event.eventId} by ${event.changedBy.split("@")[0]}`, `${res.status} ${res.body.status}`);
  }
  const pendingAfterEcho = w.outbound().filter((r) => r.state === "pending").length;
  kv("pending outbound rows", pendingAfterEcho);
  check(pendingAfterEcho === 0, "the echo created no outbound work");

  step("Drain again to prove there is nothing to send.");
  const second = await w.worker.drain();
  kv("calls made", second.callsMade);
  check(second.callsMade === 0, "zero calls — the loop is dead after one hop");
  why(
    "not because a rule caught it, but because there is nothing left to " +
      "disagree about: the send set sf_value to what we wrote, so the one " +
      "condition that creates outbound work is false (L1, design 9.1).",
  );

  // --- L1 survives the actor check being unavailable -------------------------
  step("The same echo with an UNRECOGNISABLE actor (assumption A6 false).");
  detail("L2 cannot fire, so only L1 and the echo fence are left.");
  w.save({
    objectType: "Contact",
    portalId,
    actor: "finance.user@client.example",
    changedFields: { city: "Gurugram" },
  });
  await w.worker.drain();
  const raw = w.salesforce.drainWebhooks();
  for (const event of raw) {
    // Rewrite the actor to a human, defeating L2 on purpose.
    const res = w.deliver({ ...event, changedBy: "someone.else@client.example" });
    kv(`${event.eventId} by someone.else`, `${res.status} ${res.body.status}`);
  }
  const afterDisguised = w.outbound().filter((r) => r.state === "pending").length;
  kv("pending outbound rows", afterDisguised);
  const third = await w.worker.drain();
  kv("calls made", third.callsMade);
  check(third.callsMade === 0, "still zero calls — L1 holds without the actor check");

  // --- canonical form is what makes L1 true ---------------------------------
  step("Salesforce reformats a value we sent (why canonical form is load-bearing).");
  w.salesforce.reformatOnWrite("+919876500004", "+91 98765 00004");
  w.save({
    objectType: "Contact",
    portalId,
    actor: "finance.user@client.example",
    changedFields: { phone: "+919876500004" },
  });
  await w.worker.drain();
  kv("what Salesforce stored", w.salesforce.recordValues(w.store.read((tx) => tx.findLinkByPortalId("Contact", portalId)?.sfId ?? ""))?.["phone"]);
  for (const event of w.salesforce.drainWebhooks()) {
    const res = w.deliver({ ...event, changedBy: "someone.else@client.example" });
    kv(`reformatted echo ${event.eventId}`, `${res.status} ${res.body.status}`);
  }
  const fourth = await w.worker.drain();
  kv("calls made", fourth.callsMade);
  check(
    fourth.callsMade === 0,
    "the two spellings are one canonical value, so the echo is still a no-op",
  );
  why(
    "compared raw, '+91 98765 00004' and '+919876500004' are different values " +
      "with a later time, so we would apply the echo, which changes our value, " +
      "which creates outbound work, which echoes again. One formatting " +
      "difference between the two systems is enough to turn the sync into a " +
      "generator of its own traffic (design 7.3).",
  );
}
