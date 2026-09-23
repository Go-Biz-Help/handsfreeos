import { z } from 'zod';
import { CUSTOM_FIELD_ENTITIES, CUSTOM_FIELD_TYPES } from '../crm/custom-fields';
import { isoDateTime, uuid } from './common';
import { notApplied } from './crm';

export const customFieldEntity = z.enum(CUSTOM_FIELD_ENTITIES);
export const customFieldType = z.enum(CUSTOM_FIELD_TYPES);

/** A record that holds fields: a customer, a company, a lead, or a record of a kind the business made up. */
export const fieldedRecordType = z.enum(['person', 'company', 'lead', 'custom_record']);
export type FieldedRecordType = z.infer<typeof fieldedRecordType>;

export const CustomFieldOptionOut = z.object({ value: z.string(), label: z.string() });

export const CustomFieldOut = z.object({
  id: uuid,
  entity: customFieldEntity,
  /** The kind of record it belongs to, when entity is custom_record. */
  recordTypeId: uuid.nullable(),
  /** The short name used in imports, exports and the API ('gate_code'). */
  key: z.string(),
  label: z.string(),
  type: customFieldType,
  options: z.array(CustomFieldOptionOut),
  help: z.string(),
  position: z.number().int(),
  /** Shown on the record even when empty. */
  alwaysShow: z.boolean(),
  archivedAt: isoDateTime.nullable(),
});
export type CustomFieldOut = z.infer<typeof CustomFieldOut>;

const fieldLabel = z
  .string()
  .trim()
  .min(1, 'Name the field.')
  .max(60, 'Keep it under 60 characters.');
const help = z.string().trim().max(200, 'Keep it under 200 characters.');
/** A choice on the list. Its value is made from the label the first time and never changes after. */
const optionIn = z.object({
  value: z.string().trim().min(1).max(40).optional(),
  label: z.string().trim().min(1, 'Name the choice.').max(80),
});
const optionsIn = z.array(optionIn).max(100, 'Keep it to 100 choices.');

export const CustomFieldCreateInput = z
  .object({
    workspaceId: uuid,
    entity: customFieldEntity,
    /** Which kind of record, when entity is custom_record. */
    recordTypeId: uuid.nullable().optional(),
    label: fieldLabel,
    type: customFieldType.default('text'),
    options: optionsIn.optional(),
    help: help.optional(),
    alwaysShow: z.boolean().default(false),
  })
  .refine((v) => (v.entity === 'custom_record') === !!v.recordTypeId, {
    path: ['recordTypeId'],
    error: 'Say which kind of record this field is for.',
  });
export const CustomFieldCreateOutput = z.object({ customFieldId: uuid, key: z.string() });

/** Its type never changes (the values already written are in its shape); everything else may. */
export const CustomFieldUpdateInput = z.object({
  workspaceId: uuid,
  customFieldId: uuid,
  label: fieldLabel.optional(),
  /** The whole list, in order. A choice keeps its value; one taken off the list stays on records that have it. */
  options: optionsIn.optional(),
  help: help.optional(),
  alwaysShow: z.boolean().optional(),
  position: z.number().int().min(0).max(1000).optional(),
});
export const CustomFieldUpdateOutput = z.object({
  customFieldId: uuid,
  updated: z.array(z.string()),
});

export const CustomFieldArchiveInput = z.object({ workspaceId: uuid, customFieldId: uuid });
export const CustomFieldArchiveOutput = z.object({ customFieldId: uuid });

export const CustomFieldListInput = z.object({
  workspaceId: uuid,
  entity: customFieldEntity.optional(),
  recordTypeId: uuid.optional(),
  includeArchived: z.boolean().default(false),
});
export const CustomFieldListOutput = z.object({ fields: z.array(CustomFieldOut) });

/**
 * Fill in or clear a record's fields: only the ones edited, each checked against its field, each with what the
 * person saw (`base`), and the newest change to each wins (kernel/field-merge). null or an empty value clears one.
 */
export const RecordSetFieldsInput = z.object({
  workspaceId: uuid,
  recordType: fieldedRecordType,
  recordId: uuid,
  values: z
    .record(uuid, z.unknown())
    .refine((v) => Object.keys(v).length <= 200, { error: 'Too many fields at once.' }),
  base: z.record(uuid, z.unknown()).optional(),
});
export const RecordSetFieldsOutput = z.object({
  recordId: uuid,
  /** The fields that changed, by id. */
  updated: z.array(uuid),
  notApplied,
});
