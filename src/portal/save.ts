/**
 * The portal's save handler (design 6.1).
 *
 * The property that matters here: **the value change and the obligation to
 * tell Salesforce are the same commit.** Die after it and the queue row is on
 * disk, so the call will happen. Die before it and the edit did not happen, so
 * the user is told. There is no third outcome, and that is what ADR 0001
 * bought by putting the queue in the same database as the records.
 */

import { randomUUID } from "node:crypto";

import { applyChanges } from "../domain/merge.js";
import type { AppliedField, ObjectType } from "../domain/types.js";
import type { DurableStore } from "../store/store.js";

export interface PortalSave {
  readonly objectType: ObjectType;
  /** Omit to create a new record; the portal mints the id. */
  readonly portalId?: string;
  /**
   * The authenticated session's principal.
   *
   * Deliberately **not** the `editedBy` field a request body might carry
   * (assumption A9). A client-supplied actor is an assertion, and attributing
   * history to it would let a caller forge who made a change — history that
   * can be forged by its caller is not history.
   */
  readonly actor: string;
  readonly changedFields: Readonly<Record<string, string | null>>;
}

export interface PortalSaveResult {
  readonly portalId: string;
  readonly fields: readonly AppliedField[];
  /** The order key's time, which the portal also shows as "set at". */
  readonly occurredAtMs: number;
}

/**
 * Save a portal edit.
 *
 * `occurredAt` comes from our own clock at the moment we write, standing in
 * for Postgres's `clock_timestamp()` — and `clock_timestamp()` rather than
 * `now()` because `now()` returns the transaction's start time, so two saves
 * inside one transaction would tie needlessly (design 7.2).
 *
 * The outbound queue row is created by the merge's condition (d), the same one
 * the inbound path uses, so a save that re-submits the value we already hold
 * creates no row and a save that happens to set the value Salesforce already
 * holds creates no row either (design 8.3).
 *
 * @throws {StoreWriteError} if the transaction cannot be persisted. Surfaced,
 *   never swallowed: a save that was not durably recorded must not look like
 *   one that was.
 */
export function savePortalEdit(
  store: DurableStore,
  save: PortalSave,
  nowMs: () => number = () => Date.now(),
): PortalSaveResult {
  return store.transaction((tx) => {
    const portalId = save.portalId ?? randomUUID();
    if (!tx.getRecord(save.objectType, portalId)) {
      // A portal-created record has our identifier before it has a Salesforce
      // one, which is why `record_link.sfId` is nullable (design 4, S5).
      tx.createRecord(save.objectType, portalId, null);
    }
    const occurredAtMs = nowMs();
    const fields = applyChanges(tx, {
      objectType: save.objectType,
      portalId,
      origin: "portal",
      actor: save.actor,
      occurredAtMs,
      // The portal change id. A ULID in the design; a UUID here, and all the
      // order key needs of it is that it be unique and compare stably.
      originEventId: `pc_${randomUUID()}`,
      rawChanges: save.changedFields,
    });
    return { portalId, fields, occurredAtMs };
  });
}
