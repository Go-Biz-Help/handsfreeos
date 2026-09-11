import { z } from 'zod';
import { isoDateTime, uuid } from './common';
import {
  AddressInput,
  AddressOut,
  ListInput,
  notes,
  optionalEmail,
  phoneInput,
  source,
  tagIds,
  TagRef,
  UserRef,
} from './crm';

const companyFields = {
  name: z.string().trim().min(1, 'Enter a company name.').max(120),
  email: optionalEmail,
  phone: phoneInput,
  website: z.string().trim().max(200).nullable().optional(),
  address: AddressInput.optional(),
  notes,
  source,
  ownerUserId: uuid.nullable().optional(),
};

export const CompanyCreateInput = z.object({
  workspaceId: uuid,
  ...companyFields,
  tagIds: tagIds.optional(),
  /** Save even when an existing company matches the email, phone or name. */
  ignoreDuplicates: z.boolean().default(false),
  /** Set by the import worker only: makes a retried batch a no-op. */
  importId: uuid.optional(),
  importRow: z.number().int().min(1).optional(),
});
export const CompanyCreateOutput = z.object({ companyId: uuid });

export const CompanyUpdateInput = z.object({
  workspaceId: uuid,
  companyId: uuid,
  ...Object.fromEntries(Object.entries(companyFields).map(([k, v]) => [k, v.optional()])),
}) as z.ZodObject<
  { workspaceId: typeof uuid; companyId: typeof uuid } & {
    [K in keyof typeof companyFields]: z.ZodOptional<(typeof companyFields)[K]>;
  }
>;
export const CompanyUpdateOutput = z.object({ companyId: uuid, updated: z.array(z.string()) });

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
  source: z.string().nullable(),
  owner: UserRef,
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
  includeArchived: z.boolean().default(false),
});
export const CompanyListOutput = z.object({
  items: z.array(CompanySummary),
  nextCursor: z.string().nullable(),
});

export const CompanyGetInput = z.object({ workspaceId: uuid, companyId: uuid });
export const CompanyGetOutput = z.object({
  company: CompanySummary.extend({ notes: z.string().nullable() }),
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
