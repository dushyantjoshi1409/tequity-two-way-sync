/**
 * Printing helpers for the demo.
 *
 * The demo's output is the deliverable the exercise asks to see run, so it is
 * written to be read by a person who has the design document open beside it:
 * every scenario names the rule it is exercising and the design section that
 * rule lives in, then shows the evidence, then states the check that passed.
 */

const WIDTH = 78;

/** A scenario heading, with the design section it exercises. */
export function heading(n: number, title: string, section: string): void {
  console.log("");
  console.log("=".repeat(WIDTH));
  console.log(`  ${n}. ${title}`);
  console.log(`     design ${section}`);
  console.log("=".repeat(WIDTH));
}

/** A step within a scenario. */
export function step(text: string): void {
  console.log(`\n  ${text}`);
}

/** An indented detail line. */
export function detail(text: string): void {
  console.log(`      ${text}`);
}

/** A labelled value. */
export function kv(label: string, value: unknown): void {
  console.log(`      ${label.padEnd(34)} ${String(value)}`);
}

/**
 * A check that must hold.
 *
 * Throws on failure rather than printing and continuing: a demo that prints
 * "FAIL" and carries on to a cheerful summary is worse than one that stops,
 * because the summary is what a reader remembers.
 */
export function check(passed: boolean, description: string): void {
  if (!passed) {
    console.log(`      [FAIL] ${description}`);
    throw new Error(`demo check failed: ${description}`);
  }
  console.log(`      [ok]   ${description}`);
}

/** A short explanation of why the rule is shaped the way it is. */
export function why(text: string): void {
  console.log("");
  for (const line of wrap(`why: ${text}`, WIDTH - 6)) {
    console.log(`      ${line}`);
  }
}

/** A table of rows, for history and queue listings. */
export function table(headers: readonly string[], rows: readonly (readonly string[])[]): void {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)),
  );
  const line = (cells: readonly string[]) =>
    `      ${cells.map((c, i) => (c ?? "").padEnd(widths[i] ?? 0)).join("  ")}`;
  console.log(line(headers));
  console.log(`      ${widths.map((w) => "-".repeat(w)).join("  ")}`);
  for (const row of rows) console.log(line(row));
}

/** Wrap text to a width, for the `why` notes. */
function wrap(text: string, width: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (current.length === 0) current = word;
    else if (current.length + 1 + word.length <= width) current += ` ${word}`;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines;
}
