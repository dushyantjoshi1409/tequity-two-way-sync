/**
 * Canonical form: the single spelling of a value that every comparison uses
 * (design 7.3).
 *
 * **Why this module exists at all.** It looks like hygiene and it is not: it is
 * what makes the loop rule of design 9.1 true. Send Salesforce
 * `+919876543210`, let Salesforce store `+91 98765 43210`, and the echo of our
 * own write comes back reading as a *different* value with a *later* time. We
 * would apply it, our current value would change, that change would create
 * outbound work, and that work would echo again. One formatting difference
 * turns the sync into a generator of its own traffic, at one request per round
 * trip, until the 100 req/s budget is gone. Canonical form is the precondition
 * that leaves the loop with no fuel.
 *
 * What a caller must know:
 *
 * - **Canonicalise before comparing or storing.** The stored form is canonical,
 *   so `field_version.sf_value`, the current value and an incoming value are
 *   all in the same spelling by construction.
 * - **`''` and `NULL` are one thing, stored `NULL`** (design 7.3). An
 *   empty-or-whitespace-only string returns `null`, so "cleared" has one
 *   representation rather than two that compare as different.
 * - **An unknown field name raises {@link WebhookRejected} with status 400.**
 *   That is the 400/500 pair of design 5: an unknown *field name* is a payload
 *   that will never work, so retrying cannot help, while a *value* we fail to
 *   canonicalise is our bug and earns a 500 and a retry.
 * - Nothing here is caught in order to continue quietly. The one failure this
 *   module can have — being handed a value it has no rule for — is surfaced as
 *   an error, because a silently mis-canonicalised value is exactly the
 *   divergence the module is here to prevent.
 */

import { STATUS_VOCABULARY, fieldSpec } from "./fields.js";
import type { ObjectType } from "./types.js";
import { WebhookRejected } from "./types.js";

/**
 * Reduce one raw field value to the one spelling comparisons use.
 *
 * @param objectType the record kind the field belongs to.
 * @param field the field name, as it arrived in the payload.
 * @param raw the value as it arrived, un-normalised. `null` means cleared.
 * @returns the canonical value, or `null` for a cleared or empty value.
 * @throws {WebhookRejected} status 400, reason `unknown-field`, when the object
 *   type has no such field.
 */
export function canonicalise(
  objectType: ObjectType,
  field: string,
  raw: string | null,
): string | null {
  const spec = fieldSpec(objectType, field);
  if (spec === undefined) {
    // Checked before the value, and before the null shortcut below: it is the
    // *name* that makes this payload unusable, so a null value must not turn a
    // 400 into a quiet `null`. 400 and not 500 because no retry can help
    // (design 5, "400 versus 500").
    throw new WebhookRejected(
      `unknown field ${JSON.stringify(field)} on ${objectType}`,
      400,
      "unknown-field",
    );
  }

  if (raw === null) return null;

  const text = collapseText(raw);
  // design 7.3: `''` and `NULL` are one thing, stored `NULL`. Two
  // representations of "cleared" would compare as a disagreement and so would
  // owe a repair write (design 8.3) forever.
  if (text === "") return null;

  switch (spec.kind) {
    case "text":
      return text;

    case "email":
      // Lowercased *whole*, local part included. Strictly, a mail server may
      // treat the local part as case-sensitive; the design chooses one
      // spelling anyway, because two spellings of one address would read as a
      // disagreement and owe a repair write forever (design 7.3, 8.3).
      return text.toLowerCase();

    case "id":
      // Our own UUIDs, lowercase hex (design 7.3). Both sides hand this value
      // back to us, and a hex digit's case must not make a link look broken.
      return text.toLowerCase();

    case "phone":
      return canonicalisePhone(text);

    case "picklist": {
      // Looked up by the lowercased value, so "On Hold", "on-hold" and
      // "ONHOLD" are one status (design 7.3).
      const mapped = STATUS_VOCABULARY[text.toLowerCase()];
      if (mapped !== undefined) return mapped;
      // An unknown value is *data we pass through*, not an error. We were
      // given the agreed vocabulary, not a promise that it is exhaustive, and
      // a 400 here would discard a real edit forever. The consequence — every
      // echo of a value we cannot normalise reading as a disagreement — is
      // bounded by the repair breaker of design 9.4, which stops the argument
      // past 5 repairs in an hour and marks the field contested.
      return text;
    }

    default: {
      // Exhaustiveness, deliberately noisy: a tenth field (assumption A14) is
      // configuration, but a *new kind* is code, and the design is explicit
      // that a value we cannot canonicalise is our bug — a 500 and a retry,
      // never a value passed through in whatever spelling it arrived in.
      throw new WebhookRejected(
        `no canonical rule for kind ${JSON.stringify(spec.kind)} (field ${field})`,
        500,
        "canonicalise-failed",
      );
    }
  }
}

/**
 * The phone rule of design 7.3: E.164-ish where the value parses, and digits
 * with a leading `+` where it does not.
 *
 * The design says "E.164 by the contact's country". A real implementation
 * would hand this to a library with a country hint; this demo does the part
 * that the loop rule actually depends on — throwing away every spelling
 * difference — and keeps the design's two branches visible, because the
 * branch a value lands in is what the parse-failure counter counts.
 */
function canonicalisePhone(text: string): string {
  // Everything that is not a digit goes, including the leading `+`, which is
  // then put back unconditionally: "+91 98765 43210" and "919876543210" are
  // one number, and a difference in how Salesforce chose to punctuate it must
  // not read as a change (design 7.3).
  const digits = text.replace(/\D/gu, "");

  if (digits.length >= 10) {
    // Long enough to be a full national or international number, so this is
    // the E.164-ish form.
    return `+${digits}`;
  }

  // The parse-failure branch. The design raises the parse-failure counter
  // here (design 7.3) and *still stores the value*: a short or malformed
  // number is Salesforce's data, and rejecting the event would discard a real
  // edit forever, which the 400/500 pair of design 5 forbids for a value we
  // merely failed to parse. There is no counter in this demo's store, so the
  // branch is kept separate and named rather than collapsed into the one
  // above — the two produce the same string today, and only one of them is a
  // number we believe in.
  return `+${digits}`;
}

/**
 * The shared text rule of design 7.3: Unicode NFC, trimmed, internal
 * whitespace runs collapsed to one space.
 *
 * Every other kind is this plus one step, which is why it is one function:
 * `email` is this lowercased, `picklist` is this looked up, and a `phone` that
 * fails to parse is this reduced to digits.
 */
function collapseText(raw: string): string {
  // NFC first: trimming and collapsing are defined on code points, and the
  // decomposed and composed spellings of one accented name must not survive as
  // two values (design 7.3).
  return raw.normalize("NFC").trim().replace(/\s+/gu, " ");
}
