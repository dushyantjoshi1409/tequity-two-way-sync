/**
 * The exercise's own acceptance scenario (design 7.4, Appendix A).
 *
 * Sales creates a customer, finance corrects the billing city in the portal,
 * sales then changes the phone in Salesforce, and the portal must end with the
 * new phone **and** the finance city — with the history of both.
 *
 * This is the scenario that forces field-level merge (ADR 0002): the two edits
 * are concurrent with each other, so any record-level comparison would discard
 * one of them, being unable to see that they touched different fields.
 */

import { check, detail, heading, kv, step, table, why } from "../report.js";
import { World } from "../world.js";

export async function phoneAndCity(): Promise<void> {
  heading(1, "Both sides change the same record, different fields", "7.4 / Appendix A");
  const w = World.create({ name: "phone-and-city", ceilingPerSecond: 50 });

  // --- sales creates the contact in Salesforce --------------------------------
  step("A sales user creates the contact in Salesforce (11:00:00.000).");
  const t0 = Date.parse("2026-11-02T11:00:00.000Z");
  const { sfId } = w.salesforce.applyExternalEdit({
    objectType: "Contact",
    changedFields: {
      full_name: "Asha Mehta",
      phone: "+919876500001",
      email: "ASHA@Client.example",
      city: "Gurugram",
      owner: "sales.user@client.example",
    },
    actor: "sales.user@client.example",
    atMs: t0,
  });
  for (const event of w.salesforce.drainWebhooks()) {
    const res = w.deliver(event);
    kv("webhook -> endpoint", `${res.status} ${res.body.status}`);
  }
  const portalId = w.store.read((tx) => tx.findLinkBySfId("Contact", sfId)?.portalId ?? "");
  kv("Salesforce id", sfId);
  kv("portal id", portalId.slice(0, 8) + "...");
  detail('email was canonicalised: "ASHA@Client.example" -> ' +
    JSON.stringify(w.portalValues("Contact", portalId)["email"]));

  // --- finance corrects the city in the portal -------------------------------
  step("A finance user corrects the billing city in the portal.");
  const save = w.save({
    objectType: "Contact",
    portalId,
    actor: "finance.user@client.example",
    changedFields: { city: "Noida" },
  });
  kv("city now", w.portalValues("Contact", portalId)["city"]);
  kv("outbound rows queued", w.outbound().filter((r) => r.state === "pending").length);
  why(
    "the queue row and the value change are the same commit, so there is no " +
      "state in which the portal shows Noida and we have forgotten to tell " +
      "Salesforce (design 6.1).",
  );

  // --- the worker sends it ---------------------------------------------------
  step("The sync worker sends it to Salesforce.");
  const sent = await w.worker.drain();
  kv("calls made", sent.callsMade);
  kv("Salesforce city", w.salesforce.recordValues(sfId)?.["city"]);
  check(sent.callsMade === 1, "one call carried the city — the only real news");

  // --- Salesforce echoes our own write ---------------------------------------
  step("Salesforce tells us about our own write (the echo).");
  let echoOutbound = 0;
  for (const event of w.salesforce.drainWebhooks()) {
    const res = w.deliver(event);
    kv(`echo ${event.eventId} (${event.changedBy.split("@")[0]})`, `${res.status} ${res.body.status}`);
    echoOutbound += w.outbound().filter((r) => r.state === "pending").length;
  }
  check(echoOutbound === 0, "the echo created no outbound work — the loop is dead");

  // --- sales changes the phone in Salesforce ---------------------------------
  step("A sales user changes the phone in Salesforce (11:05:00.000).");
  const t3 = Date.parse("2026-11-02T11:05:00.000Z");
  w.salesforce.applyExternalEdit({
    objectType: "Contact",
    sfId,
    changedFields: { phone: "+919876500002" },
    actor: "sales.user@client.example",
    atMs: t3,
  });
  for (const event of w.salesforce.drainWebhooks()) {
    const res = w.deliver(event);
    kv(`webhook ${event.eventId}`, `${res.status} ${res.body.status}`);
  }

  // --- the result ------------------------------------------------------------
  step("The result.");
  const values = w.portalValues("Contact", portalId);
  kv("portal phone", values["phone"]);
  kv("portal city", values["city"]);
  check(values["phone"] === "+919876500002", "the portal has the new phone");
  check(values["city"] === "Noida", "the portal still has the finance city");

  step("The history the client asked for.");
  table(
    ["field", "old", "new", "actor", "origin", "outcome"],
    w.history("Contact", portalId).map((h) => [
      h.field,
      h.oldValue ?? "-",
      h.newValue ?? "-",
      (h.actor.split("@")[0] ?? h.actor),
      h.origin,
      h.outcome,
    ]),
  );
  const phoneChange = w.history("Contact", portalId).find(
    (h) => h.field === "phone" && h.newValue === "+919876500002",
  );
  const cityChange = w.history("Contact", portalId).find(
    (h) => h.field === "city" && h.newValue === "Noida",
  );
  check(
    phoneChange?.actor === "sales.user@client.example",
    "who changed the phone is on record",
  );
  check(
    cityChange?.actor === "finance.user@client.example",
    "who changed the city is on record",
  );
  check(
    cityChange?.oldValue === "Gurugram",
    "the value the city displaced is still on record",
  );
  why(
    "the field, not the record, is the unit of sync, so the two edits never " +
      "competed. A record-level last-writer-wins would have had to discard one " +
      "of them (ADR 0002).",
  );
}
