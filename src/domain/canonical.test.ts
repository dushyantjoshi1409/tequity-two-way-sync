/**
 * Tests for {@link canonicalise} — the table in design 7.3.
 *
 * The table is the specification, so the cases here are its rows rather than
 * invented examples: every expected value is the one the design document
 * states, not one recomputed the way the implementation computes it.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { canonicalise } from "./canonical.js";
import { WebhookRejected } from "./types.js";

describe("canonicalise: text (design 7.3)", () => {
  test("trims and collapses internal whitespace runs to one space", () => {
    assert.equal(
      canonicalise("Contact", "full_name", " Asha   Mehta "),
      "Asha Mehta",
    );
  });

  test("collapses tabs and newlines, not only spaces", () => {
    assert.equal(
      canonicalise("Contact", "city", "New\tDelhi\n"),
      "New Delhi",
    );
  });

  test("normalises to Unicode NFC so one spelling survives", () => {
    // "e" + U+0301 COMBINING ACUTE is the decomposed spelling of "é"; NFC
    // composes it. Without this, the two spellings compare as different
    // values and the loop of design 9.1 has fuel.
    const decomposed = "André";
    const composed = "André";
    assert.notEqual(decomposed, composed);
    assert.equal(canonicalise("Contact", "full_name", decomposed), composed);
  });

  test("leaves an already-canonical value alone", () => {
    assert.equal(canonicalise("Customer", "name", "Acme Pvt Ltd"), "Acme Pvt Ltd");
  });
});

describe("canonicalise: phone (design 7.3, and why 9.1 needs it)", () => {
  test("two spellings of one Indian mobile reach one value", () => {
    // The whole point of the module, in one assertion: we send
    // "+919876543210", Salesforce stores "+91 98765 43210", and the echo must
    // not read as a different value — or we apply it, which creates outbound
    // work, which echoes again (design 7.3, 9.1).
    const spaced = canonicalise("Contact", "phone", "+91 98765 43210");
    const compact = canonicalise("Contact", "phone", "+919876543210");
    assert.equal(spaced, "+919876543210");
    assert.equal(compact, "+919876543210");
    assert.equal(spaced, compact);
  });

  test("strips punctuation Salesforce may add, and prepends a missing +", () => {
    assert.equal(
      canonicalise("Contact", "phone", "(044) 2345-6789"),
      "+04423456789",
    );
  });

  test("keeps a short number as digits with a leading + (the parse-failure branch)", () => {
    // Fewer than 10 digits is not a number we can put in E.164 form. The
    // design's rule is still to store digits with a leading `+` and raise the
    // parse-failure counter, because a 500 would reject a real edit over a
    // value Salesforce accepted (design 7.3; the 400/500 pair in design 5).
    assert.equal(canonicalise("Contact", "phone", "98765"), "+98765");
  });
});

describe("canonicalise: empty is null (design 7.3)", () => {
  test("null stays null", () => {
    assert.equal(canonicalise("Contact", "city", null), null);
  });

  test("an empty string becomes null", () => {
    assert.equal(canonicalise("Contact", "city", ""), null);
  });

  test("a whitespace-only string becomes null", () => {
    // `''` and `NULL` are one thing, stored `NULL`. Two spellings of "cleared"
    // would compare as a disagreement and owe a repair write forever.
    assert.equal(canonicalise("Contact", "city", "   "), null);
    assert.equal(canonicalise("Contact", "city", "\t\n "), null);
  });

  test("the rule holds for every kind, not only text", () => {
    assert.equal(canonicalise("Contact", "email", "  "), null);
    assert.equal(canonicalise("Contact", "phone", "  "), null);
    assert.equal(canonicalise("Customer", "status", "  "), null);
    assert.equal(canonicalise("Contact", "customer_id", "  "), null);
  });
});

describe("canonicalise: email (design 7.3)", () => {
  test("lowercases the whole address, local part included", () => {
    assert.equal(
      canonicalise("Contact", "email", "ASHA@Client.example"),
      "asha@client.example",
    );
  });

  test("applies the text rule before lowercasing", () => {
    assert.equal(
      canonicalise("Contact", "email", "  Asha@Client.Example  "),
      "asha@client.example",
    );
  });
});

describe("canonicalise: id (design 7.3)", () => {
  test("lowercases a customer_id UUID", () => {
    assert.equal(
      canonicalise("Contact", "customer_id", " 3F2A9C4E-1B77-4D6E-9A0C-5E8B2D1F4A63 "),
      "3f2a9c4e-1b77-4d6e-9a0c-5e8b2d1f4a63",
    );
  });
});

describe("canonicalise: picklist (design 7.3)", () => {
  test("maps every spelling of the on-hold status onto one value", () => {
    // Three spellings either system might send; one canonical value, so the
    // two sides never look like they disagree about a status they share.
    assert.equal(canonicalise("Customer", "status", "on-hold"), "On Hold");
    assert.equal(canonicalise("Customer", "status", "On Hold"), "On Hold");
    assert.equal(canonicalise("Customer", "status", "ONHOLD"), "On Hold");
  });

  test("maps the plain statuses too", () => {
    assert.equal(canonicalise("Customer", "status", "active"), "Active");
    assert.equal(canonicalise("Customer", "status", "  PROSPECT "), "Prospect");
  });

  test("passes an unknown status through in its text form", () => {
    // Data, not an error: an unknown picklist value is a vocabulary we have
    // not been told about, and design 9.4's repair breaker is what bounds the
    // consequence of arguing with Salesforce about it.
    assert.equal(
      canonicalise("Customer", "status", "  Pending   Review "),
      "Pending Review",
    );
  });
});

describe("canonicalise: unknown field (design 5, 7.3)", () => {
  test("rejects an unknown field name with status 400", () => {
    assert.throws(
      () => canonicalise("Contact", "favourite_colour", "blue"),
      (error: unknown) => {
        assert.ok(error instanceof WebhookRejected);
        assert.equal(error.status, 400);
        assert.equal(error.reason, "unknown-field");
        assert.match(error.message, /favourite_colour/);
        return true;
      },
    );
  });

  test("rejects a field that exists on the other object type", () => {
    // `city` is a Contact field. On a Customer it is just as unknown, and a
    // 400 is still right: no retry can make this payload work.
    assert.throws(
      () => canonicalise("Customer", "city", "Noida"),
      WebhookRejected,
    );
  });

  test("rejects an unknown field before looking at the value, including null", () => {
    // The field name is what makes the payload unusable, so a null value must
    // not turn a 400 into a quiet `null`.
    assert.throws(
      () => canonicalise("Contact", "favourite_colour", null),
      WebhookRejected,
    );
  });
});
