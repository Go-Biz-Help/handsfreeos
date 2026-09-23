import { z } from 'zod';
import { isoDateTime, uuid } from './common';
import {
  AddressInput,
  AddressOut,
  AddressSeen,
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

const companyFields = {
  name: z.string().trim().min(1, 'Enter a company name.').max(120),
  email: optionalEmail,
  phone: phoneInput,
  website: z.string().trim().max(200).nullable().optional(),
  address: AddressInput.optional(),
  /** The emails, numbers and addresses besides the main ones (0103); on an update, the whole list. */
  otherEmails: otherEmailsInput,
  otherPhones: otherPhonesInput,
  otherAddresses: otherAddressesInput,
  notes,
  source,
  ownerUserId: uuid.nullable().optional(),
};

export const CompanyCreateInput = z.object({
  workspaceId: uuid,
  /** The id the phone made for it, so what it adds for the company offline can point at it (M10). */
  id: uuid.optional(),
  ...companyFields,
  tagIds: tagIds.optional(),
  /** Save even when an existing company matches the email, phone or name. */
  ignoreDuplicates: z.boolean().default(false),
  /** Set by the import worker only: makes a retried batch a no-op. */
  importId: uuid.optional(),
  importRow: z.number().int().min(1).optional(),
});
export const CompanyCreateOutput = z.object({ companyId: uuid });

/** What the person saw of each detail they edited (see kernel/field-merge). */
export const CompanySeen = z.object({
  name: seenText,
  email: seenText,
  phone: seenText,
  website: seenText,
  address: AddressSeen.optional(),
  otherEmails: seenList,
  otherPhones: seenList,
  otherAddresses: seenList,
  notes: seenText,
  source: seenText,
  ownerUserId: seenId,
});

/** Only the details that were edited, each merged on its own: newest wins. */
export const CompanyUpdateInput = z.object({
  workspaceId: uuid,
  companyId: uuid,
  ...Object.fromEntries(Object.entries(companyFields).map(([k, v]) => [k, v.optional()])),
  base: CompanySeen.optional(),
}) as z.ZodObject<
  { workspaceId: typeof uuid; companyId: typeof uuid } & {
    [K in keyof typeof companyFields]: z.ZodOptional<(typeof companyFields)[K]>;
  } & { base: z.ZodOptional<typeof CompanySeen> }
>;
export const CompanyUpdateOutput = z.object({
  companyId: uuid,
  updated: z.array(z.string()),
  notApplied,
});

export const CompanyArchiveInput = z.object({
  workspaceId: uuid,
  companyId: uuid,
  /** Also archive the company's open leads instead of refusing. */
  force: z.boolean().default(false),
});
export const CompanyArchiveOutput = z.object({ companyId: uuid, archivedLeads: z.number().int() });
export const CompanyRestoreInput = z.object({ workspaceId: uuid, companyId: uuid });
export const CompanyRestoreOutput = z.object({ companyId: uuid });

export const CompanySummary = z.object({
  id: uuid,
  name: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  phoneE164: z.string().nullable(),
  website: z.string().nullable(),
  address: AddressOut,
  otherEmails: z.array(OtherEmailOut),
  otherPhones: z.array(OtherPhoneOut),
  otherAddresses: z.array(OtherAddressOut),
  source: z.string().nullable(),
  owner: UserRef,
  /** Everyone else the company is assigned to (0104), in the order they were added. */
  team: TeamRef,
  tags: z.array(TagRef),
  peopleCount: z.number().int(),
  openLeads: z.number().int(),
  archivedAt: isoDateTime.nullable(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});
export type CompanySummary = z.infer<typeof CompanySummary>;

export const CompanyListInput = ListInput.extend({
  workspaceId: uuid,
  q: z.string().trim().max(120).optional(),
  tagId: uuid.optional(),
  /** The companies assigned to this person: the ones they own and the ones they are on (0104). */
  assignedUserId: uuid.optional(),
  includeArchived: z.boolean().default(false),
});
export const CompanyListOutput = z.object({
  items: z.array(CompanySummary),
  nextCursor: z.string().nullable(),
});

export const CompanyGetInput = z.object({ workspaceId: uuid, companyId: uuid });
export const CompanyGetOutput = z.object({
  company: CompanySummary.extend({
    notes: z.string().nullable(),
    /** The fields this business invented, by field id (M15, 0076). */
    custom: z.record(z.string(), z.unknown()),
  }),
  people: z.array(
    z.object({
      id: uuid,
      fullName: z.string(),
      email: z.string().nullable(),
      phone: z.string().nullable(),
      archived: z.boolean(),
    }),
  ),
});
