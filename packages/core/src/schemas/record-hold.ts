/**
 * Records on hold (Real Estate round six, 20261022000200): a legal hold keeps a record's files and history as they
 * are until it's lifted; a retention hold is the add-on's, keeping a closed record for the years the business sets.
 */
import { z } from 'zod';
import { isoDateTime, uuid } from './common';

const reason = z
  .string()
  .trim()
  .min(1, 'Say why, in a few words.')
  .max(500, 'Keep the reason to 500 characters.');

export const RecordHoldPlaceInput = z.object({
  workspaceId: uuid,
  customRecordId: uuid,
  /** Kept with the hold and on the record's timeline ("Dispute over the earnest money"). */
  reason,
});

export const RecordHoldLiftInput = z.object({
  workspaceId: uuid,
  holdId: uuid,
  reason,
});

export const RecordHold = z.object({
  id: uuid,
  customRecordId: uuid,
  recordName: z.string(),
  kind: z.enum(['legal', 'retention']),
  /** A retention hold's end; null while its record is open, and always for a legal hold. */
  heldUntil: isoDateTime.nullable(),
  reason: z.string().nullable(),
  placedBy: z.object({ id: uuid, fullName: z.string() }).nullable(),
  placedAt: isoDateTime,
});
export type RecordHold = z.infer<typeof RecordHold>;

export const RecordHoldOutput = z.object({ hold: RecordHold });
export const RecordHoldLiftOutput = z.object({ holdId: uuid, liftedAt: isoDateTime });

export const RecordHoldListInput = z.object({
  workspaceId: uuid,
  /** One record's holds; left out, every record's in the business that the person sees. */
  customRecordId: uuid.optional(),
  /** Legal holds only (Deal settings → Keeping records lists those). */
  kind: z.enum(['legal', 'retention']).optional(),
});
export const RecordHoldListOutput = z.object({ holds: z.array(RecordHold) });
