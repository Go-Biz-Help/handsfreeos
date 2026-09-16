import { z } from 'zod';
import { normalizePhone } from '../crm/phone';
import { uuid } from './common';

export const recordType = z.enum(['person', 'company', 'lead']);
export type RecordType = z.infer<typeof recordType>;

/** Common list input: page size and an opaque keyset cursor (see kernel/pagination). */
export const ListInput = z.object({
  limit: z.number().int().min(1).max(100).default(50),
  cursor: z.string().max(400).optional(),
});

const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();

/** A phone as typed by a person; stored as E.164 (US default). Empty means "no phone". */
export const phoneInput = z
  .string()
  .trim()
  .max(40)
  .nullable()
  .optional()
  .transform((value, ctx) => {
    if (value === undefined) return undefined; // absent on an update: leave the stored value alone
    if (!value) return null;
    const e164 = normalizePhone(value);
    if (!e164) {
      ctx.addIssue({ code: 'custom', message: 'Enter a valid phone number.' });
      return z.NEVER;
    }
    return e164;
  });

export const optionalEmail = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .nullable()
  .optional()
  .transform((value, ctx) => {
    if (value === undefined) return undefined; // absent on an update: leave the stored value alone
    if (!value) return null;
    if (!z.email().safeParse(value).success) {
      ctx.addIssue({ code: 'custom', message: 'Enter a valid email address.' });
      return z.NEVER;
    }
    return value;
  });

export const AddressInput = z.object({
  line1: optionalText(200),
  line2: optionalText(200),
  city: optionalText(100),
  state: optionalText(50),
  postalCode: optionalText(20),
  country: z.string().trim().length(2).toUpperCase().optional(),
});
export type AddressInput = z.infer<typeof AddressInput>;

export const AddressOut = z.object({
  line1: z.string().nullable(),
  line2: z.string().nullable(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  postalCode: z.string().nullable(),
  country: z.string(),
});
export type AddressOut = z.infer<typeof AddressOut>;

export const TagRef = z.object({ id: uuid, name: z.string(), color: z.string() });
export type TagRef = z.infer<typeof TagRef>;

export const tagIds = z.array(uuid).max(20);

export const PersonRef = z.object({ id: uuid, fullName: z.string(), archived: z.boolean() });
export const CompanyRef = z.object({ id: uuid, name: z.string(), archived: z.boolean() });
export const UserRef = z.object({ id: uuid, fullName: z.string() }).nullable();

export const notes = optionalText(10000);
export const source = optionalText(80);

/**
 * What the person saw of a detail before editing it (an update's `base`, M10): compared with what's stored now,
 * never validated like a new value, since it may have been saved before today's rules. Absent: not said.
 */
export const seenText = z.string().max(20_000).nullable().optional();
export const seenId = uuid.nullable().optional();
export const AddressSeen = z.object({
  line1: seenText,
  line2: seenText,
  city: seenText,
  state: seenText,
  postalCode: seenText,
  country: seenText,
});

/** The details an update didn't change because someone changed them later than it was made (M10). */
export const notApplied = z.array(z.string()).default([]);
