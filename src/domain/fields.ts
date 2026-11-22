/**
 * The field catalogue: the nine fields the exercise names, and how each is
 * canonicalised.
 *
 * This is deliberately data rather than code. Assumption A14 says the field
 * set is closed for the exercise, and the design's claim is that a tenth field
 * would be *configuration* — so nothing anywhere else in this codebase is
 * written per field, and adding one means adding a row here.
 */

import type { ObjectType } from "./types.js";

/** How a field's raw value is reduced to the one spelling comparisons use. */
export type CanonicalKind =
  /** Unicode NFC, trimmed, internal whitespace runs collapsed to one space. */
  | "text"
  /** `text`, then lowercased whole. */
  | "email"
  /** E.164 where parseable; otherwise digits with a leading `+`. */
  | "phone"
  /** `text`, then mapped through the agreed picklist vocabulary. */
  | "picklist"
  /** `text`, then lowercased — our own UUIDs. */
  | "id";

export interface FieldSpec {
  readonly field: string;
  readonly kind: CanonicalKind;
}

/** The nine syncable fields, by object type (design 4). */
export const FIELDS: Readonly<Record<ObjectType, readonly FieldSpec[]>> =
  Object.freeze({
    Customer: Object.freeze([
      { field: "name", kind: "text" },
      { field: "status", kind: "picklist" },
      { field: "owner", kind: "text" },
    ] as const),
    Contact: Object.freeze([
      { field: "full_name", kind: "text" },
      { field: "phone", kind: "phone" },
      { field: "email", kind: "email" },
      { field: "city", kind: "text" },
      { field: "owner", kind: "text" },
      { field: "customer_id", kind: "id" },
    ] as const),
  });

/**
 * The picklist vocabulary for `Customer.status`, mapping every spelling either
 * system might use onto one canonical value (design 7.3).
 */
export const STATUS_VOCABULARY: Readonly<Record<string, string>> = Object.freeze({
  active: "Active",
  prospect: "Prospect",
  churned: "Churned",
  "on hold": "On Hold",
  onhold: "On Hold",
  "on-hold": "On Hold",
});

/** The field names that exist on an object type. */
export function fieldNames(objectType: ObjectType): readonly string[] {
  return FIELDS[objectType].map((f) => f.field);
}

/**
 * The spec for one field, or `undefined` when the object type has no such
 * field. Callers treat `undefined` as a 400 — an unknown field name is a
 * payload that will never work, so retrying cannot help (design 5).
 */
export function fieldSpec(
  objectType: ObjectType,
  field: string,
): FieldSpec | undefined {
  return FIELDS[objectType].find((f) => f.field === field);
}

/**
 * Fields are always processed in one fixed order so that two runs over the
 * same payload produce identical history. (The record-level lock is what
 * serialises concurrent merges; this only makes output deterministic.)
 */
export function sortFields(
  objectType: ObjectType,
  fields: readonly string[],
): readonly string[] {
  const order = fieldNames(objectType);
  return [...fields].sort((a, b) => order.indexOf(a) - order.indexOf(b));
}
