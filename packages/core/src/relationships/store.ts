/**
 * What the relationship commands and queries read from the database: a kind of record, a record, a kind's fields,
 * and the names of the records on either end of a pair. Server-only (it reads through the caller's transaction),
 * so it is not exported from the browser-safe `relationships/index.ts`.
 */
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Tx } from '@hfos/db/client';
import {
  companies,
  customFields,
  customRecords,
  customRecordTypes,
  people,
  relationshipTypes,
} from '@hfos/db/schema';
import {
  customSummary,
  type CustomFieldEntity,
  type CustomFieldOption,
  type CustomFieldShape,
  type CustomFieldType,
} from '../crm/custom-fields';
import { formatPhone } from '../crm/phone';
import { fullName } from '../crm/records';
import { HfosError } from '../errors';
import type { CustomRecordTypeRef } from '../schemas/relationship';
import type { RelationshipEndKind } from './words';

export type CustomRecordTypeRow = typeof customRecordTypes.$inferSelect;
export type CustomRecordRow = typeof customRecords.$inferSelect;
export type RelationshipTypeRow = typeof relationshipTypes.$inferSelect;

export const typeRef = (t: CustomRecordTypeRow): CustomRecordTypeRef => ({
  id: t.id,
  key: t.key,
  singular: t.singular,
  plural: t.plural,
  nameLabel: t.nameLabel,
  icon: t.icon,
  archived: !!t.archivedAt,
});

/** A kind of record in this business. `live` refuses an archived one, naming it. */
export async function requireRecordType(
  tx: Tx,
  workspaceId: string,
  typeId: string,
  opts: { readonly live?: boolean; readonly lock?: boolean } = {},
): Promise<CustomRecordTypeRow> {
  const query = tx
    .select()
    .from(customRecordTypes)
    .where(and(eq(customRecordTypes.id, typeId), eq(customRecordTypes.workspaceId, workspaceId)));
  const [t] = opts.lock ? await query.for('update') : await query;
  if (!t)
    throw HfosError.notFound(
      'That kind of record isn’t there anymore. It may have been deleted. Refresh and try again.',
    );
  if (opts.live && t.archivedAt)
    throw HfosError.rule(
      'record_type_archived',
      409,
      `${t.plural} are archived. Restore them in Settings → Relationships first.`,
    );
  return t;
}

/** A record of a kind the business made up, in this business. */
export async function requireCustomRecord(
  tx: Tx,
  workspaceId: string,
  customRecordId: string,
  opts: { readonly lock?: boolean } = {},
): Promise<CustomRecordRow> {
  const query = tx
    .select()
    .from(customRecords)
    .where(and(eq(customRecords.id, customRecordId), eq(customRecords.workspaceId, workspaceId)));
  const [r] = opts.lock ? await query.for('update') : await query;
  if (!r)
    throw HfosError.notFound(
      'That record isn’t there anymore. It may have been deleted. Refresh and try again.',
    );
  return r;
}

/** A relationship type in this business. */
export async function requireRelationshipType(
  tx: Tx,
  workspaceId: string,
  relationshipTypeId: string,
  opts: { readonly lock?: boolean } = {},
): Promise<RelationshipTypeRow> {
  const query = tx
    .select()
    .from(relationshipTypes)
    .where(
      and(
        eq(relationshipTypes.id, relationshipTypeId),
        eq(relationshipTypes.workspaceId, workspaceId),
      ),
    );
  const [t] = opts.lock ? await query.for('update') : await query;
  if (!t)
    throw HfosError.notFound(
      'That relationship type isn’t there anymore. It may have been deleted. Refresh and try again.',
    );
  return t;
}

/** A field as the checks and the words need it, with what the editor needs besides. */
export interface LiveField extends CustomFieldShape {
  readonly key: string;
  readonly position: number;
}

const optionsOf = (raw: unknown): CustomFieldOption[] =>
  Array.isArray(raw)
    ? raw
        .filter((o): o is Record<string, unknown> => !!o && typeof o === 'object')
        .map((o) => ({
          value: String(o.value ?? o.label ?? ''),
          label: String(o.label ?? o.value ?? ''),
        }))
        .filter((o) => o.value)
    : [];

/** The live fields on one kind of record, in the business's order: customers', companies', leads' or a kind's. */
export async function liveFields(
  tx: Tx,
  workspaceId: string,
  entity: CustomFieldEntity,
  recordTypeId: string | null,
): Promise<LiveField[]> {
  const list = await tx
    .select({
      id: customFields.id,
      key: customFields.key,
      label: customFields.label,
      type: customFields.type,
      options: customFields.options,
      position: customFields.position,
    })
    .from(customFields)
    .where(
      and(
        eq(customFields.workspaceId, workspaceId),
        eq(customFields.entity, entity),
        recordTypeId
          ? eq(customFields.recordTypeId, recordTypeId)
          : isNull(customFields.recordTypeId),
        isNull(customFields.archivedAt),
      ),
    )
    .orderBy(asc(customFields.position), asc(customFields.label));
  return list.map((f) => ({
    id: f.id,
    key: f.key,
    label: f.label,
    type: f.type as CustomFieldType,
    options: optionsOf(f.options),
    position: f.position,
  }));
}

/** Each kind's live fields, for many kinds at once: kind id → fields in order. */
export async function fieldsByKind(
  tx: Tx,
  workspaceId: string,
  typeIds: readonly string[],
): Promise<Map<string, LiveField[]>> {
  const map = new Map<string, LiveField[]>();
  if (!typeIds.length) return map;
  const list = await tx
    .select({
      id: customFields.id,
      recordTypeId: customFields.recordTypeId,
      key: customFields.key,
      label: customFields.label,
      type: customFields.type,
      options: customFields.options,
      position: customFields.position,
    })
    .from(customFields)
    .where(
      and(
        eq(customFields.workspaceId, workspaceId),
        inArray(customFields.recordTypeId, [...new Set(typeIds)]),
        isNull(customFields.archivedAt),
      ),
    )
    .orderBy(asc(customFields.position), asc(customFields.label));
  for (const f of list) {
    const fields = map.get(f.recordTypeId!) ?? [];
    fields.push({
      id: f.id,
      key: f.key,
      label: f.label,
      type: f.type as CustomFieldType,
      options: optionsOf(f.options),
      position: f.position,
    });
    map.set(f.recordTypeId!, fields);
  }
  return map;
}

/** One record on an end of a pair, as the pages and the timeline name it. */
export interface EndRecord {
  readonly kind: RelationshipEndKind;
  readonly id: string;
  readonly name: string;
  readonly detail: string | null;
  readonly archived: boolean;
  readonly recordType: CustomRecordTypeRef | null;
}

/**
 * The people, companies and records behind a set of ids, by id: their names, a line of detail (a phone or an email;
 * a record's first fields) and whether they're archived. Ids from another business simply aren't found.
 */
export async function endRecords(
  tx: Tx,
  workspaceId: string,
  refs: readonly { readonly kind: RelationshipEndKind; readonly id: string }[],
): Promise<Map<string, EndRecord>> {
  const out = new Map<string, EndRecord>();
  const ids = (kind: RelationshipEndKind) => [
    ...new Set(refs.filter((r) => r.kind === kind).map((r) => r.id)),
  ];
  const personIds = ids('person');
  const companyIds = ids('company');
  const recordIds = ids('custom_record');
  if (personIds.length) {
    const list = await tx
      .select({
        id: people.id,
        firstName: people.firstName,
        lastName: people.lastName,
        phoneE164: people.phoneE164,
        email: people.email,
        archivedAt: people.archivedAt,
      })
      .from(people)
      .where(and(eq(people.workspaceId, workspaceId), inArray(people.id, personIds)));
    for (const p of list)
      out.set(p.id, {
        kind: 'person',
        id: p.id,
        name: fullName(p.firstName, p.lastName),
        detail: p.phoneE164 ? formatPhone(p.phoneE164) : (p.email ?? null),
        archived: !!p.archivedAt,
        recordType: null,
      });
  }
  if (companyIds.length) {
    const list = await tx
      .select({
        id: companies.id,
        name: companies.name,
        phoneE164: companies.phoneE164,
        email: companies.email,
        city: companies.city,
        archivedAt: companies.archivedAt,
      })
      .from(companies)
      .where(and(eq(companies.workspaceId, workspaceId), inArray(companies.id, companyIds)));
    for (const c of list)
      out.set(c.id, {
        kind: 'company',
        id: c.id,
        name: c.name,
        detail: c.phoneE164 ? formatPhone(c.phoneE164) : (c.email ?? c.city ?? null),
        archived: !!c.archivedAt,
        recordType: null,
      });
  }
  if (recordIds.length) {
    const list = await tx
      .select({ r: customRecords, t: customRecordTypes })
      .from(customRecords)
      .innerJoin(customRecordTypes, eq(customRecordTypes.id, customRecords.typeId))
      .where(and(eq(customRecords.workspaceId, workspaceId), inArray(customRecords.id, recordIds)));
    const fields = await fieldsByKind(
      tx,
      workspaceId,
      list.map(({ r }) => r.typeId),
    );
    for (const { r, t } of list)
      out.set(r.id, {
        kind: 'custom_record',
        id: r.id,
        name: r.name,
        detail: customSummary(fields.get(r.typeId) ?? [], r.custom),
        archived: !!r.archivedAt,
        recordType: typeRef(t),
      });
  }
  return out;
}

/** The column a kind of record sits in on one end of a pair, for the queries that read pairs by one record. */
export const endColumnSql = (kind: RelationshipEndKind, side: 'a' | 'b') =>
  sql.raw(`r.${side}_${kind}_id`);
