/**
 * Current offers (M18): what the business is running right now, as the owner writes it. The AI teammate shares
 * the ones live today and never makes one up.
 */
import { z } from 'zod';
import { isLocalDate } from '../calendar/engine/zoned';
import { isoDateTime, uuid } from './common';

const localDate = z.string().refine(isLocalDate, { error: 'Use a date like 2026-10-01.' });
const name = z
  .string()
  .trim()
  .min(1, 'Name the promotion.')
  .max(120, 'Keep it under 120 characters.');
const details = z.string().trim().max(1000, 'Keep it under 1,000 characters.');

const endsAfterStart = (v: { startsOn?: string | null; endsOn?: string | null }) =>
  !v.startsOn || !v.endsOn || v.endsOn >= v.startsOn;

export const OfferCreateInput = z
  .object({
    workspaceId: uuid,
    name,
    details: details.default(''),
    startsOn: localDate.nullable().default(null),
    endsOn: localDate.nullable().default(null),
  })
  .refine(endsAfterStart, { path: ['endsOn'], error: 'End on or after the start.' });
export const OfferCreateOutput = z.object({ offerId: uuid });

export const OfferUpdateInput = z
  .object({
    workspaceId: uuid,
    offerId: uuid,
    name: name.optional(),
    details: details.optional(),
    startsOn: localDate.nullable().optional(),
    endsOn: localDate.nullable().optional(),
  })
  .refine(endsAfterStart, { path: ['endsOn'], error: 'End on or after the start.' });
export const OfferUpdateOutput = z.object({ offerId: uuid, updated: z.array(z.string()) });

export const OfferArchiveInput = z.object({ workspaceId: uuid, offerId: uuid });
export const OfferArchiveOutput = z.object({ offerId: uuid });

export const OfferListInput = z.object({ workspaceId: uuid });
export const OfferOut = z.object({
  id: uuid,
  name: z.string(),
  details: z.string(),
  startsOn: z.string().nullable(),
  endsOn: z.string().nullable(),
  /** live: running today; upcoming: starts later; ended: its end date has passed. */
  state: z.enum(['live', 'upcoming', 'ended']),
  updatedAt: isoDateTime,
});
export type OfferOut = z.infer<typeof OfferOut>;
export const OfferListOutput = z.object({ offers: z.array(OfferOut) });
