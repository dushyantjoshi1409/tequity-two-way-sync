/**
 * The demo. One command after `npm install`: `npm run demo`.
 *
 * Six scenarios, each naming the design section it exercises. Four of them are
 * the checks the exercise asks for — a duplicate, an older event after a newer
 * one, a webhook that must not be sent back to Salesforce, and a pending call
 * still present after a restart while the fake Salesforce is down — plus the
 * brief's own phone-and-city acceptance scenario and the rate cap.
 *
 * Everything runs against a fake Salesforce written for this repository and a
 * JSON-file store standing in for Postgres. No network, no services, no
 * credentials. `src/store/store.ts` lists exactly which Postgres guarantees
 * are real here and which are imitated.
 *
 * A failed check throws, so the process exits non-zero. A demo that printed
 * "FAIL" and carried on to a cheerful summary would be worse than one that
 * stops.
 */

import { duplicate } from "./scenarios/duplicate.js";
import { loop } from "./scenarios/loop.js";
import { outOfOrder } from "./scenarios/outOfOrder.js";
import { phoneAndCity } from "./scenarios/phoneAndCity.js";
import { rateCap } from "./scenarios/rateCap.js";
import { restart } from "./scenarios/restart.js";

/** The scenarios, in the order a reader should meet them. */
const SCENARIOS: readonly (readonly [string, () => Promise<void>])[] = [
  ["the brief's acceptance scenario", phoneAndCity],
  ["a duplicate webhook", duplicate],
  ["an older event after a newer one", outOfOrder],
  ["our own update, not sent back", loop],
  ["the rate cap and a slow-down", rateCap],
  ["a restart while Salesforce is down", restart],
];

async function main(): Promise<void> {
  console.log("Two-way sync of customer and contact records — demo");
  console.log("Design: docs/design.md. Every scenario names the section it exercises.");
  console.log(`Node ${process.version}; no network, no services.`);

  const started = Date.now();
  for (const [, run] of SCENARIOS) {
    await run();
  }

  console.log("");
  console.log("=".repeat(78));
  console.log("  All scenarios passed.");
  console.log("=".repeat(78));
  for (const [name] of SCENARIOS) console.log(`    [ok] ${name}`);
  console.log("");
  console.log(`  ${((Date.now() - started) / 1000).toFixed(1)}s. Run \`npm test\` for the unit tests.`);
  console.log("");
}

main().catch((error: unknown) => {
  // Printed in full and the exit code set: the demo's value is that its output
  // can be trusted, so a failure must be loud and must fail the command.
  console.error("");
  console.error("DEMO FAILED");
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
