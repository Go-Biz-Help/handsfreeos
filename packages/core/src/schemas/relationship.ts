import { z } from 'zod';
import {
  RECORD_ICONS,
  RELATIONSHIP_CARDINALITIES,
  RELATIONSHIP_ENDS,
} from '../relationships/words';
import { isoDateTime, uuid } from './common';
import { ListInput, notApplied, notes, seenText, UserRef } from './crm';
import { customFieldType } from './custom-field';

export const relationshipEnd = z.enum(RELATIONSHIP_ENDS);
export const relationshipCardinality = z.enum(RELATIONSHIP_CARDINALITIES);
export const recordIcon = z.enum(RECORD_ICONS);
export const relationshipSide = z.enum(['a', 'b']);

const kindName = z.string().trim().min(1, 'Enter a name.').max(40, 'Keep it under 40 characters.');
const endLabel = z
  .string()
  .trim()
  .min(1, 'Say what this end is called.')
  .max(40, 'Keep it under 40 characters.');
const recordName = z
  .string()
  .trim()
  .min(1, 'Enter a name.')
  .max(160, 'Keep it under 160 characters.');
const pairNote = z.string().trim().max(200, 'Keep it under 200 characters.').nullable().optional();

// ---- Kinds of records ----

/** A kind of record as the rest of a page needs it: its names and its picture. */
export const CustomRecordTypeRef = z.object({
  id: uuid,
  key: z.string(),
  singular: z.string(),
  plural: z.string(),
  nameLabel: z.string(),
  icon: z.string(),
  archived: z.boolean(),
});
export type CustomRecordTypeRef = z.infer<typeof CustomRecordTypeRef>;

export const CustomRecordTypeOut = CustomRecordTypeRef.extend({
  position: z.number().int(),
  archivedAt: isoDateTime.nullable(),
  /** Records of this kind that aren't archived. */
  recordCount: z.number().int(),
  /** Its live fields. */
  fieldCount: z.number().int(),
  createdAt: isoDateTime,
});
export type CustomRecordTypeOut = z.infer<typeof CustomRecordTypeOut>;

/** A first field made with a new kind (a starter's "Breed", "License plate"). */
const StarterFieldIn = z.object({
  label: z.string().trim().min(1).max(60),
  type: customFieldType.default('text'),
  options: z.array(z.string().trim().min(1).max(80)).max(100).optional(),
});

export const CustomRecordTypeCreateInput = z.object({
  workspaceId: uuid,
  singular: kindName,
  /** Worked out from the singular when left out ("Property" → "Properties"). */
  plural: kindName.optional(),
  nameLabel: kindName.optional(),
  icon: recordIcon.default('box'),
  /** Its first fields, made with it. */
  fields: z.array(StarterFieldIn).max(20).optional(),
  /**
   * The relationship that ties it to customers or companies, made with it: end A the customer (called `label`,
   * "Owner"), end B one of these (called `recordLabel`, or the kind's own name). Many to many unless said.
   */
  link: z
    .object({
      end: z.enum(['person', 'company']),
      label: endLabel,
      recordLabel: endLabel.optional(),
      cardinality: relationshipCardinality.default('many_to_many'),
    })
    .optional(),
});
export const CustomRecordTypeCreateOutput = z.object({
  customRecordTypeId: uuid,
  key: z.string(),
  customFieldIds: z.array(uuid),
  relationshipTypeId: uuid.nullable(),
});

export const CustomRecordTypeUpdateInput = z.object({
  workspaceId: uuid,
  customRecordTypeId: uuid,
  singular: kindName.optional(),
  plural: kindName.optional(),
  nameLabel: kindName.optional(),
  icon: recordIcon.optional(),
  position: z.number().int().min(0).max(1000).optional(),
});
export const CustomRecordTypeUpdateOutput = z.object({
  customRecordTypeId: uuid,
  updated: z.array(z.string()),
});

export const CustomRecordTypeArchiveInput = z.object({
  workspaceId: uuid,
  customRecordTypeId: uuid,
});
export const CustomRecordTypeArchiveOutput = z.object({
  customRecordTypeId: uuid,
  /** The relationship types that had this kind on an end, archived with it. */
  archivedRelationshipTypes: z.number().int(),
});
export const CustomRecordTypeRestoreInput = z.object({
  workspaceId: uuid,
  customRecordTypeId: uuid,
});
export const CustomRecordTypeRestoreOutput = z.object({ customRecordTypeId: uuid });

export const CustomRecordTypeListInput = z.object({
  workspaceId: uuid,
  includeArchived: z.boolean().default(false),
});
export const CustomRecordTypeListOutput = z.object({ types: z.array(CustomRecordTypeOut) });

// ---- Relationship types ----

const RelationshipEndIn = z
  .object({
    end: relationshipEnd,
    /** Which kind, when the end is a record of a kind the business made up. */
    recordTypeId: uuid.nullable().optional(),
    label: endLabel,
  })
  .refine((v) => (v.end === 'custom_record') === !!v.recordTypeId, {
    path: ['recordTypeId'],
    error: 'Pick which kind of record.',
  });

export const RelationshipTypeCreateInput = z.object({
  workspaceId: uuid,
  a: RelationshipEndIn,
  b: RelationshipEndIn,
  /** Many to many unless somebody says otherwise. */
  cardinality: relationshipCardinality.default('many_to_many'),
  /** The same part on both ends, like spouses: one label, no direction. */
  mutual: z.boolean().default(false),
});
export const RelationshipTypeCreateOutput = z.object({ relationshipTypeId: uuid });

/** What each end is never changes once pairs rest on it; what it's called, and how many, may. */
export const RelationshipTypeUpdateInput = z.object({
  workspaceId: uuid,
  relationshipTypeId: uuid,
  aLabel: endLabel.optional(),
  bLabel: endLabel.optional(),
  cardinality: relationshipCardinality.optional(),
  position: z.number().int().min(0).max(1000).optional(),
});
export const RelationshipTypeUpdateOutput = z.object({
  relationshipTypeId: uuid,
  updated: z.array(z.string()),
});

export const RelationshipTypeArchiveInput = z.object({
  workspaceId: uuid,
  relationshipTypeId: uuid,
});
export const RelationshipTypeArchiveOutput = z.object({ relationshipTypeId: uuid });
export const RelationshipTypeRestoreInput = z.object({
  workspaceId: uuid,
  relationshipTypeId: uuid,
});
export const RelationshipTypeRestoreOutput = z.object({ relationshipTypeId: uuid });

export const RelationshipEndOut = z.object({
  end: relationshipEnd,
  recordType: CustomRecordTypeRef.nullable(),
  label: z.string(),
});
export type RelationshipEndOut = z.infer<typeof RelationshipEndOut>;

export const RelationshipTypeOut = z.object({
  id: uuid,
  a: RelationshipEndOut,
  b: RelationshipEndOut,
  cardinality: relationshipCardinality,
  mutual: z.boolean(),
  position: z.number().int(),
  archivedAt: isoDateTime.nullable(),
  /** How many pairs rest on it. */
  pairCount: z.number().int(),
});
export type RelationshipTypeOut = z.infer<typeof RelationshipTypeOut>;

export const RelationshipTypeListInput = z.object({
  workspaceId: uuid,
  includeArchived: z.boolean().default(false),
});
export const RelationshipTypeListOutput = z.object({ types: z.array(RelationshipTypeOut) });

// ---- Records ----

export const CustomRecordCreateInput = z.object({
  workspaceId: uuid,
  typeId: uuid,
  name: recordName,
  notes,
  /** Its fields, by field id, checked like record.set_fields. */
  values: z.record(uuid, z.unknown()).optional(),
  /**
   * Who is on it, for a kind kept to its people (Real Estate step 4): its main person (its maker when not said) and
   * everyone else on it. Refused for a kind everyone sees.
   */
  ownerUserId: uuid.optional(),
  teamUserIds: z.array(uuid).max(20).optional(),
  /**
   * Related to another record as it is made ("Add pet" on a customer's page): the relationship type, the record on
   * the other end, and which end the new record takes.
   */
  relateTo: z
    .object({
      relationshipTypeId: uuid,
      recordId: uuid,
      side: relationshipSide,
      note: pairNote,
    })
    .optional(),
});
export const CustomRecordCreateOutput = z.object({
  customRecordId: uuid,
  relationshipId: uuid.nullable(),
});

export const CustomRecordSeen = z.object({ name: seenText, notes: seenText });
export const CustomRecordUpdateInput = z.object({
  workspaceId: uuid,
  customRecordId: uuid,
  name: recordName.optional(),
  notes,
  base: CustomRecordSeen.optional(),
});
export const CustomRecordUpdateOutput = z.object({
  customRecordId: uuid,
  updated: z.array(z.string()),
  notApplied,
});

export const CustomRecordArchiveInput = z.object({ workspaceId: uuid, customRecordId: uuid });
export const CustomRecordArchiveOutput = z.object({ customRecordId: uuid });
export const CustomRecordRestoreInput = z.object({ workspaceId: uuid, customRecordId: uuid });
export const CustomRecordRestoreOutput = z.object({ customRecordId: uuid });

/** Another record on one of a record's relationships, as a list shows it. */
export const RelatedRecordRef = z.object({
  kind: relationshipEnd,
  id: uuid,
  name: z.string(),
  /** What it is to the record it's listed on ("Owner"). */
  label: z.string(),
  archived: z.boolean(),
});

export const CustomRecordSummary = z.object({
  id: uuid,
  typeId: uuid,
  name: z.string(),
  /** Its first filled-in fields, "Golden retriever · 42 lb". */
  detail: z.string().nullable(),
  /** The first few people, companies and records it's related to. */
  related: z.array(RelatedRecordRef),
  archivedAt: isoDateTime.nullable(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});
export type CustomRecordSummary = z.infer<typeof CustomRecordSummary>;

export const CustomRecordListInput = ListInput.extend({
  workspaceId: uuid,
  typeId: uuid.optional(),
  /** Its name, or anything in its fields: a plate, a VIN, a breed. */
  q: z.string().trim().max(120).optional(),
  includeArchived: z.boolean().default(false),
});
export const CustomRecordListOutput = z.object({
  items: z.array(CustomRecordSummary),
  nextCursor: z.string().nullable(),
});

export const CustomRecordGetInput = z.object({ workspaceId: uuid, customRecordId: uuid });
export const CustomRecordDetail = z.object({
  id: uuid,
  type: CustomRecordTypeRef,
  name: z.string(),
  notes: z.string().nullable(),
  /** Its fields' values, by field id. */
  custom: z.record(z.string(), z.unknown()),
  archivedAt: isoDateTime.nullable(),
  createdBy: UserRef,
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
  /** Kept to the people on it (Real Estate step 4): only they, and whoever sees every one of its kind, see it. */
  keptToTeam: z.boolean(),
  /** Its main person, when it is kept to its people. */
  owner: UserRef,
  /** Everyone else on it. */
  team: z.array(z.object({ id: uuid, fullName: z.string() })),
  /**
   * The add-on whose kind it is (Real Estate's deals), or null for one of the business's own. An add-on's record
   * can only be archived, never deleted for good (20261027000700).
   */
  addonId: z.string().nullable(),
});
export type CustomRecordDetail = z.infer<typeof CustomRecordDetail>;

/** Putting someone on a record kept to its people, or taking them off (Real Estate step 4). */
export const CustomRecordAssignInput = z.object({
  workspaceId: uuid,
  customRecordId: uuid,
  userId: uuid,
  /** Make them its main person; the one they replace stays on it. Owners and admins only. */
  main: z.boolean().default(false),
});
export const CustomRecordUnassignInput = z.object({
  workspaceId: uuid,
  customRecordId: uuid,
  userId: uuid,
});
export const CustomRecordGetOutput = z.object({ record: CustomRecordDetail });

// ---- Relationships ----

export const RelationshipCreateInput = z.object({
  workspaceId: uuid,
  relationshipTypeId: uuid,
  /** The record on end A, and the one on end B: the type says what kind each is. */
  aId: uuid,
  bId: uuid,
  note: pairNote,
});
export const RelationshipCreateOutput = z.object({ relationshipId: uuid });

export const RelationshipUpdateInput = z.object({
  workspaceId: uuid,
  relationshipId: uuid,
  note: pairNote,
});
export const RelationshipUpdateOutput = z.object({ relationshipId: uuid });

export const RelationshipDeleteInput = z.object({ workspaceId: uuid, relationshipId: uuid });
export const RelationshipDeleteOutput = z.object({ relationshipId: uuid });

/** A record that can be related: a person, a company, or a record of a kind the business made up. */
export const relatableRecordType = relationshipEnd;

/** One pair, from one record's side. */
export const RelationshipOut = z.object({
  id: uuid,
  typeId: uuid,
  /** Which end this record is on. */
  side: relationshipSide,
  /** What the other record is to this one ("Pet"). */
  label: z.string(),
  /** What this record is to the other one ("Owner"). */
  ownLabel: z.string(),
  mutual: z.boolean(),
  cardinality: relationshipCardinality,
  other: z.object({
    kind: relationshipEnd,
    id: uuid,
    name: z.string(),
    /** A phone or email for a person or company, the first fields for a record. */
    detail: z.string().nullable(),
    archived: z.boolean(),
    /** Its kind, when it's a record of a kind the business made up. */
    recordType: CustomRecordTypeRef.nullable(),
  }),
  note: z.string().nullable(),
  createdBy: UserRef,
  createdAt: isoDateTime,
});
export type RelationshipOut = z.infer<typeof RelationshipOut>;

export const RelationshipListInput = z.object({
  workspaceId: uuid,
  recordType: relatableRecordType,
  recordId: uuid,
});
export const RelationshipListOutput = z.object({ items: z.array(RelationshipOut) });
