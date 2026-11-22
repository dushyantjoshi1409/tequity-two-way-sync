/**
 * A pending call that is still there after our process restarts, while the
 * fake Salesforce is down (design 6.5, 10.2).
 *
 * The exercise's hard requirement is that pending calls to Salesforce survive
 * our own process restarting, so this scenario uses a real child process and
 * kills it with `SIGKILL`. There is no orderly shutdown to credit the
 * durability to: the row is on disk because it was committed in the same
 * transaction as the portal edit that created it, which is what ADR 0001
 * bought.
 *
 * It then shows the second half of a restart — a row the dead sender had
 * already claimed is reclaimed when its lease expires, with no manual
 * intervention and no reconciliation script.
 */

import { spawnSync } from "node:child_process";

import { check, detail, heading, kv, step, table, why } from "../report.js";
import { World } from "../world.js";

const SCENARIO = "restart";

export async function restart(): Promise<void> {
  heading(6, "A pending call survives a restart while Salesforce is down", "6.5 / 10.2");
  const w = World.create({ name: SCENARIO, ceilingPerSecond: 50, leaseMs: 800 });

  step("Take the Salesforce record API down (the 6-hour outage of design 10).");
  w.salesforce.setDown(true);
  kv("salesforce reachable", !w.salesforce.isDown);

  step("A finance user saves anyway. The portal keeps working throughout.");
  const { portalId } = w.save({
    objectType: "Contact",
    actor: "finance.user@client.example",
    changedFields: { full_name: "Priya Nair", city: "Kochi", phone: "+919876500010" },
  });
  kv("portal city (visible at once)", w.portalValues("Contact", portalId)["city"]);
  const queued = w.outbound().filter((r) => r.state === "pending");
  kv("pending outbound rows", queued.length);
  kv("bytes of queue on disk", JSON.stringify(queued).length);
  detail("Nothing is read-only and nothing is refused. The only cost of the");
  detail("outage is visibility in Salesforce.");

  step("A separate process tries to drain, fails, and is SIGKILLed.");
  const first = spawnSync(
    process.execPath,
    ["dist/demo/restartChild.js", SCENARIO, "attempt-while-down"],
    { encoding: "utf8" },
  );
  process.stdout.write(first.stdout ?? "");
  if (first.stderr) process.stderr.write(first.stderr);
  kv("child terminated by", first.signal ?? `exit ${first.status}`);
  check(first.signal === "SIGKILL", "the child died hard, with no orderly shutdown");

  step("Our process reads the state file the dead child left behind.");
  const after = World.create({ name: SCENARIO, fresh: false, ceilingPerSecond: 50, leaseMs: 800 });
  const survived = after.outbound();
  table(
    ["id", "field", "reason", "state", "attempts", "lastError"],
    survived.map((r) => [
      String(r.id),
      r.field,
      r.reason,
      r.state,
      String(r.attempts),
      (r.lastError ?? "-").slice(0, 28),
    ]),
  );
  check(survived.length > 0, "the pending calls are still there");
  check(
    survived.every((r) => r.state === "pending"),
    "and they are pending, not lost and not failed",
  );
  check(
    survived.every((r) => r.attempts === 0),
    "with their attempts restored — an unreachable endpoint is not the row's fault",
  );
  why(
    "ten attempts at a backoff capped at five minutes is under an hour, so if " +
      "an unreachable Salesforce counted against the row, every queued call " +
      "would have marked itself failed during the second hour of a six-hour " +
      "outage. The backlog would have destroyed itself while waiting (design 6.4).",
  );

  step("Simulate a sender that died mid-call: a row left inflight, lease expired.");
  after.store.transaction((tx) => {
    const row = tx.outboundRows()[0];
    if (!row) throw new Error("expected at least one queued row");
    row.state = "inflight";
    row.leaseOwner = "sender-that-died";
    row.leaseUntilMs = Date.now() - 1; // already expired
  });
  kv("row state", after.outbound()[0]?.state);
  kv("lease owner", after.outbound()[0]?.leaseOwner);

  step("Bring Salesforce back up and start a fresh process.");
  after.salesforce.setDown(false);
  kv("salesforce reachable", !after.salesforce.isDown);
  const second = spawnSync(
    process.execPath,
    ["dist/demo/restartChild.js", SCENARIO, "drain-after-up"],
    { encoding: "utf8" },
  );
  process.stdout.write(second.stdout ?? "");
  if (second.stderr) process.stderr.write(second.stderr);
  check(second.status === 0, "the second process finished cleanly");

  step("The result.");
  const final = World.create({ name: SCENARIO, fresh: false });
  const rows = final.outbound();
  kv("rows now sent", rows.filter((r) => r.state === "sent").length);
  kv("rows still pending", rows.filter((r) => r.state === "pending").length);
  const sfId = final.store.read((tx) => tx.findLinkByPortalId("Contact", portalId)?.sfId ?? "");
  kv("Salesforce id assigned", sfId || "(none)");
  const sfValues = sfId ? final.salesforce.recordValues(sfId) : undefined;
  kv("Salesforce city", sfValues?.["city"]);
  kv("Salesforce phone", sfValues?.["phone"]);
  check(rows.every((r) => r.state === "sent"), "every queued call drained");
  check(sfValues?.["city"] === "Kochi", "Salesforce has the value the portal saved");
  check(
    sfValues?.["phone"] === "+919876500010",
    "and the other field from the same save, in one coalesced call",
  );
  why(
    "the record was created in the portal, so it had our identifier before it " +
      "had a Salesforce one and went out through the external-id upsert — keyed " +
      "on our id, so a repeat updates the record it created rather than making " +
      "a second one. That is what makes a retry after an uncertain outcome safe " +
      "(assumption A5).",
  );
}
