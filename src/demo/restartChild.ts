/**
 * A child process the restart scenario spawns (design 6.5, 10.2).
 *
 * This file exists so that "survives a restart" means what it says: a
 * genuinely separate operating-system process, which the parent kills, opening
 * the same state file afterwards. Nothing is shared in memory.
 *
 * Usage: `node dist/demo/restartChild.js <scenario-dir-name> <phase>`
 *   phase `attempt-while-down` — try to drain against a Salesforce that is
 *     down, then hard-kill itself with SIGKILL so there is no orderly
 *     shutdown to credit the durability to.
 *   phase `drain-after-up` — drain normally, and report what it sent.
 */

import { World } from "./world.js";

/** Run one phase. Errors are printed and turned into a non-zero exit. */
async function main(): Promise<void> {
  const [, , name, phase] = process.argv;
  if (!name || !phase) {
    throw new Error("usage: restartChild.js <scenario-dir-name> <phase>");
  }
  // `fresh: false` is the whole point: this process reads the state the parent
  // left on disk.
  const w = World.create({ name, fresh: false, ceilingPerSecond: 50, leaseMs: 800 });

  if (phase === "attempt-while-down") {
    console.log(`      [child ${process.pid}] opened the store; salesforce down = ${w.salesforce.isDown}`);
    const report = await w.worker.drain();
    console.log(
      `      [child ${process.pid}] endpoint failures=${report.endpointFailures} ` +
        `sent=${report.sent} pending after=${w.worker.pendingCount()}`,
    );
    console.log(`      [child ${process.pid}] about to be killed with SIGKILL`);
    // No orderly shutdown, no flush, no cleanup hook. If the queued call
    // survives this, it survives because it was committed to disk when the
    // portal saved it — which is exactly the claim being tested.
    process.kill(process.pid, "SIGKILL");
    return;
  }

  if (phase === "drain-after-up") {
    console.log(`      [child ${process.pid}] opened the store; salesforce down = ${w.salesforce.isDown}`);
    const reclaimed = w.worker.reclaimExpiredLeases();
    console.log(`      [child ${process.pid}] reclaimed ${reclaimed} row(s) from the dead sender's lease`);
    const report = await w.worker.drain();
    console.log(
      `      [child ${process.pid}] sent=${report.sent} calls=${report.callsMade} ` +
        `pending after=${w.worker.pendingCount()}`,
    );
    return;
  }

  throw new Error(`unknown phase ${phase}`);
}

main().catch((error: unknown) => {
  // Never silent: the parent reads this child's output as evidence, so a
  // failure here must be visible and must fail the process.
  console.error(`      [child ${process.pid}] FAILED: ${String(error)}`);
  process.exitCode = 1;
});
