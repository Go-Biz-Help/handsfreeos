/**
 * The wording a business reuses (M16).
 *
 * A template is deliberately small: a name, a channel, the words, and somewhere to file it. It carries the
 * same `{{placeholders}}` a workflow step uses, because a business should not have to learn two ways of
 * writing "the customer's first name" depending on where they are standing.
 */
import { z } from 'zod';
import { isoDateTime, uuid } from './common';

export const templateChannel = z.enum(['sms', 'email']);
export type TemplateChannel = z.infer<typeof templateChannel>;

/** One level deep on purpose: folders inside folders are how a library becomes a filing cabinet. */
const folder = z.string().trim().max(60).nullable().default(null);

const body = z
  .string()
  .trim()
  .min(1, 'Write the message.')
  .max(20_000, 'That is longer than a message anybody reads.');

export const TemplateCreateInput = z
  .object({
    workspaceId: uuid,
    name: z.string().trim().min(1, 'Name it, so you can find it again.').max(120),
    channel: templateChannel.default('sms'),
    subject: z.string().trim().max(200).nullable().default(null),
    body,
    folder,
  })
  .refine((t) => t.channel === 'email' || !t.subject, {
    error: 'A text message has no subject line.',
    path: ['subject'],
  });
export const TemplateCreateOutput = z.object({ templateId: uuid });

export const TemplateUpdateInput = z
  .object({
    workspaceId: uuid,
    templateId: uuid,
    name: z.string().trim().min(1).max(120).optional(),
    channel: templateChannel.optional(),
    subject: z.string().trim().max(200).nullable().optional(),
    body: body.optional(),
    folder: z.string().trim().max(60).nullable().optional(),
  })
  .refine((t) => t.channel !== 'sms' || !t.subject, {
    error: 'A text message has no subject line.',
    path: ['subject'],
  });
export const TemplateUpdateOutput = z.object({ templateId: uuid });

export const TemplateArchiveInput = z.object({
  workspaceId: uuid,
  templateId: uuid,
  /** Put one back. */
  restore: z.boolean().default(false),
});
export const TemplateArchiveOutput = z.object({ templateId: uuid, archived: z.boolean() });

/** Somebody reached for it. Counted so the library sorts itself by what the business actually says. */
export const TemplateUsedInput = z.object({ workspaceId: uuid, templateId: uuid });
export const TemplateUsedOutput = z.object({ templateId: uuid, usedCount: z.number().int() });

export const TemplateListInput = z.object({
  workspaceId: uuid,
  /** The composer asks for one channel; the library screen asks for both. */
  channel: templateChannel.optional(),
  includeArchived: z.boolean().default(false),
  /** Matches the name, the folder and the words themselves. */
  search: z.string().trim().max(120).optional(),
});

export const TemplateRow = z.object({
  id: uuid,
  name: z.string(),
  channel: templateChannel,
  subject: z.string().nullable(),
  body: z.string(),
  folder: z.string().nullable(),
  usedCount: z.number().int(),
  lastUsedAt: isoDateTime.nullable(),
  archivedAt: isoDateTime.nullable(),
  /** Every `{{placeholder}}` the wording uses, in the order it uses them. */
  placeholders: z.array(z.string()),
  createdAt: isoDateTime,
});
export const TemplateListOutput = z.object({
  templates: z.array(TemplateRow),
  /** The folders in use, for the picker's headings. */
  folders: z.array(z.string()),
});
