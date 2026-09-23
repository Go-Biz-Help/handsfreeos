import { z } from 'zod';
import { isoDateTime, uuid } from './common';
import {
  AddressInput,
  AddressOut,
  AddressSeen,
  CompanyRef,
  ListInput,
  notApplied,
  notes,
  optionalEmail,
  OtherAddressOut,
  OtherEmailOut,
  OtherPhoneOut,
  otherAddressesInput,
  otherEmailsInput,
  otherPhonesInput,
  phoneInput,
  seenId,
  seenList,
  seenText,
  source,
  tagIds,
  TagRef,
  TeamRef,
  UserRef,
} from './crm';

const personFields = {
  firstName: z.string().trim().max(80).default(''),
  lastName: z.string().trim().max(80).default(''),
  email: optionalEmail,
  phone: phoneInput,
  /** Kept for phones on older builds: a number here joins the other numbers, first. */
  phoneAlt: phoneInput,
  companyId: uuid.nullable().optional(),
  address: AddressInput.optional(),
  /** The emails, numbers and addresses besides the main ones (0102), each with an optional label. */
  otherEmails: otherEmailsInput,
  otherPhones: otherPhonesInput,
  otherAddresses: otherAddressesInput,
  notes,
  source,
  ownerUserId: uuid.nullable().optional(),
};

export const PersonCreateInput = z
  .object({
    workspaceId: uuid,
    /** The id the phone made for them, so what it adds for them offline can point at them (M10). */
    id: uuid.optional(),
    ...personFields,
    tagIds: tagIds.optional(),
    ignoreDuplicates: z.boolean().default(false),
    /** Set by the import worker only: makes a retried batch a no-op. */
    importId: uuid.optional(),
    importRow: z.number().int().min(1).optional(),
  })
  .refine((v) => (v.firstName + v.lastName).trim().length > 0, {
    path: ['firstName'],
    error: 'Enter a first or last name.',
  });
export const PersonCreateOutput = z.object({ personId: uuid });

/** What the person saw of each detail they edited (see kernel/field-merge). */
export const PersonSeen = z.object({
  firstName: seenText,
  lastName: seenText,
  email: seenText,
  phone: seenText,
  phoneAlt: seenText,
  companyId: seenId,
  address: AddressSeen.optional(),
  otherEmails: seenList,
  otherPhones: seenList,
  otherAddresses: seenList,
  notes: seenText,
  source: seenText,
  ownerUserId: seenId,
});

/** Only the details that were edited, each merged on its own: newest wins. */
export const PersonUpdateInput = z.object({
  workspaceId: uuid,
  personId: uuid,
  firstName: z.string().trim().max(80).optional(),
  lastName: z.string().trim().max(80).optional(),
  email: optionalEmail,
  phone: phoneInput,
  phoneAlt: phoneInput,
  companyId: uuid.nullable().optional(),
  address: AddressInput.optional(),
  /** The whole list as it should be; left out, the list stays as it is. */
  otherEmails: otherEmailsInput,
  otherPhones: otherPhonesInput,
  otherAddresses: otherAddressesInput,
  notes,
  source,
  ownerUserId: uuid.nullable().optional(),
  base: PersonSeen.optional(),
});
export const PersonUpdateOutput = z.object({
  personId: uuid,
  updated: z.array(z.string()),
  notApplied,
});

export const PersonArchiveInput = z.object({
  workspaceId: uuid,
  personId: uuid,
  force: z.boolean().default(false),
});
export const PersonArchiveOutput = z.object({ personId: uuid, archivedLeads: z.number().int() });
export const PersonRestoreInput = z.object({ workspaceId: uuid, personId: uuid });
export const PersonRestoreOutput = z.object({ personId: uuid });

export const PersonSummary = z.object({
  id: uuid,
  firstName: z.string(),
  lastName: z.string(),
  fullName: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  phoneE164: z.string().nullable(),
  /** The first of the other numbers, as people read it: what older builds showed as "Other phone". */
  phoneAlt: z.string().nullable(),
  address: AddressOut,
  otherEmails: z.array(OtherEmailOut),
  otherPhones: z.array(OtherPhoneOut),
  otherAddresses: z.array(OtherAddressOut),
  source: z.string().nullable(),
  company: CompanyRef.nullable(),
  owner: UserRef,
  /** Everyone else the customer is assigned to (0103), in the order they were added. */
  team: TeamRef,
  tags: z.array(TagRef),
  openLeads: z.number().int(),
  lastActivityAt: isoDateTime.nullable(),
  archivedAt: isoDateTime.nullable(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});
export type PersonSummary = z.infer<typeof PersonSummary>;

export const PersonListInput = ListInput.extend({
  workspaceId: uuid,
  q: z.string().trim().max(120).optional(),
  tagId: uuid.optional(),
  companyId: uuid.optional(),
  ownerUserId: uuid.optional(),
  /** The customers assigned to this person: the ones they own and the ones they are on (0103). */
  assignedUserId: uuid.optional(),
  includeArchived: z.boolean().default(false),
  sort: z.enum(['name', 'recent']).default('name'),
});
export const PersonListOutput = z.object({
  items: z.array(PersonSummary),
  nextCursor: z.string().nullable(),
});

export const PersonGetInput = z.object({ workspaceId: uuid, personId: uuid });
export const PersonGetOutput = z.object({
  person: PersonSummary.extend({
    notes: z.string().nullable(),
    /** The fields this business invented, by field id (M15, 0076). */
    custom: z.record(z.string(), z.unknown()),
  }),
});
