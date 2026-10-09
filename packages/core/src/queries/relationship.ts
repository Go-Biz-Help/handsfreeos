/**
 * Reads for relationships (0101): the fields a business invented, its kinds of records, its relationship types,
 * the records of a kind, one record, and everything one record is related to — from either end of each pair.
 */
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { rows, sql, type Tx } from '@hfos/db/client';
import { customFields, customRecordTypes } from '@hfos/db/schema';
import { uuidArray } from '../calendar/load';
import { customSummary, type CustomFieldOption } from '../crm/custom-fields';
import { defineQuery } from '../kernel/define';
import { decodeCursor, page } from '../kernel/pagination';
import {
  endRecords,
  fieldsByKind,
  requireCustomRecord,
  requireRecordType,
  typeRef,
} from '../relationships/store';
import type { RelationshipEndKind } from '../relationships/words';
import { CustomFieldListInput, CustomFieldListOutput } from '../schemas/custom-field';
import {
  CustomRecordGetInput,
  CustomRecordGetOutput,
  CustomRecordListInput,
  CustomRecordListOutput,
  CustomRecordTypeListInput,
  CustomRecordTypeListOutput,
  RelationshipListInput,
  RelationshipListOutput,
  RelationshipTypeListInput,
  RelationshipTypeListOutput,
  type CustomRecordTypeRef,
} from '../schemas/relationship';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

const iso = (d: Date | string) => new Date(d).toISOString();

const optionsOut = (raw: unknown): CustomFieldOption[] =>
  Array.isArray(raw)
    ? raw
        .filter((o): o is Record<string, unknown> => !!o && typeof o === 'object')
        .map((o) => ({
          value: String(o.value ?? o.label ?? ''),
          label: String(o.label ?? o.value ?? ''),
        }))
        .filter((o) => o.value)
    : [];

export const customFieldList = defineQuery({
  name: 'custom_field.list',
  description:
    'The fields a business invented, for customers, companies, leads or one kind of record, in the order it put them.',
  input: CustomFieldListInput,
  output: CustomFieldListOutput,
  permission: 'records.read',
  scope: inWorkspace,
  async handler(ctx, input) {
    const list = await ctx.tx
      .select()
      .from(customFields)
      .where(
        and(
          eq(customFields.workspaceId, input.workspaceId),
          ...(input.entity ? [eq(customFields.entity, input.entity)] : []),
          ...(input.recordTypeId ? [eq(customFields.recordTypeId, input.recordTypeId)] : []),
          ...(input.includeArchived ? [] : [isNull(customFields.archivedAt)]),
        ),
      )
      .orderBy(
        asc(customFields.entity),
        asc(customFields.recordTypeId),
        asc(customFields.position),
        asc(customFields.label),
      );
    return {
      fields: list.map((f) => ({
        id: f.id,
        entity: f.entity,
        recordTypeId: f.recordTypeId,
        key: f.key,
        label: f.label,
        type: f.type,
        options: optionsOut(f.options),
        help: f.help,
        position: f.position,
        alwaysShow: f.alwaysShow,
        archivedAt: f.archivedAt ? iso(f.archivedAt) : null,
      })),
    };
  },
});

export const customRecordTypeList = defineQuery({
  name: 'custom_record_type.list',
  description:
    'The kinds of records a business keeps (pets, vehicles, properties), with how many of each.',
  input: CustomRecordTypeListInput,
  output: CustomRecordTypeListOutput,
  permission: 'records.read',
  scope: inWorkspace,
  async handler(ctx, input) {
    const list = await rows<{
      id: string;
      key: string;
      singular: string;
      plural: string;
      name_label: string;
      icon: string;
      position: number;
      archived_at: Date | null;
      created_at: Date;
      record_count: number;
      field_count: number;
    }>(
      ctx.tx,
      sql`select t.id, t.key, t.singular, t.plural, t.name_label, t.icon, t.position, t.archived_at, t.created_at,
            (select count(*) from app.custom_records r where r.type_id = t.id and r.archived_at is null)::int as record_count,
            (select count(*) from app.custom_fields f where f.record_type_id = t.id and f.archived_at is null)::int as field_count
          from app.custom_record_types t
          where t.workspace_id = ${input.workspaceId}
            ${input.includeArchived ? sql`` : sql`and t.archived_at is null`}
          order by t.archived_at nulls first, t.position, lower(t.singular)`,
    );
    return {
      types: list.map((t) => ({
        id: t.id,
        key: t.key,
        singular: t.singular,
        plural: t.plural,
        nameLabel: t.name_label,
        icon: t.icon,
        archived: !!t.archived_at,
        position: t.position,
        archivedAt: t.archived_at ? iso(t.archived_at) : null,
        recordCount: Number(t.record_count),
        fieldCount: Number(t.field_count),
        createdAt: iso(t.created_at),
      })),
    };
  },
});

export const relationshipTypeList = defineQuery({
  name: 'relationship_type.list',
  description:
    'How records relate in this business: each relationship type’s two ends, what each is called, and how many each may have.',
  input: RelationshipTypeListInput,
  output: RelationshipTypeListOutput,
  permission: 'records.read',
  scope: inWorkspace,
  async handler(ctx, input) {
    const list = await rows<{
      id: string;
      a_end: RelationshipEndKind;
      a_record_type_id: string | null;
      a_label: string;
      b_end: RelationshipEndKind;
      b_record_type_id: string | null;
      b_label: string;
      cardinality: 'one_to_one' | 'one_to_many' | 'many_to_one' | 'many_to_many';
      mutual: boolean;
      position: number;
      archived_at: Date | null;
      pair_count: number;
    }>(
      ctx.tx,
      sql`select t.id, t.a_end::text as a_end, t.a_record_type_id, t.a_label, t.b_end::text as b_end,
            t.b_record_type_id, t.b_label, t.cardinality::text as cardinality, t.mutual, t.position, t.archived_at,
            (select count(*) from app.relationships r where r.type_id = t.id)::int as pair_count
          from app.relationship_types t
          where t.workspace_id = ${input.workspaceId}
            ${input.includeArchived ? sql`` : sql`and t.archived_at is null`}
          order by t.archived_at nulls first, t.position, lower(t.a_label)`,
    );
    const kindIds = [
      ...new Set(
        list
          .flatMap((t) => [t.a_record_type_id, t.b_record_type_id])
          .filter((k): k is string => !!k),
      ),
    ];
    const kinds = new Map<string, CustomRecordTypeRef>();
    if (kindIds.length) {
      const found = await ctx.tx
        .select()
        .from(customRecordTypes)
        .where(
          and(
            eq(customRecordTypes.workspaceId, input.workspaceId),
            inArray(customRecordTypes.id, kindIds),
          ),
        );
      for (const k of found) kinds.set(k.id, typeRef(k));
    }
    return {
      types: list.map((t) => ({
        id: t.id,
        a: {
          end: t.a_end,
          recordType: t.a_record_type_id ? (kinds.get(t.a_record_type_id) ?? null) : null,
          label: t.a_label,
        },
        b: {
          end: t.b_end,
          recordType: t.b_record_type_id ? (kinds.get(t.b_record_type_id) ?? null) : null,
          label: t.b_label,
        },
        cardinality: t.cardinality,
        mutual: t.mutual,
        position: t.position,
        archivedAt: t.archived_at ? iso(t.archived_at) : null,
        pairCount: Number(t.pair_count),
      })),
    };
  },
});

/**
 * The records each of these is related to, a few apiece, with what each is to it ("Owner"), for a list's second
 * column. Only relationship types that aren't archived.
 */
async function relatedPreview(
  tx: Tx,
  workspaceId: string,
  recordIds: readonly string[],
  each = 3,
): Promise<
  Map<
    string,
    { kind: RelationshipEndKind; id: string; name: string; label: string; archived: boolean }[]
  >
> {
  const map = new Map<
    string,
    { kind: RelationshipEndKind; id: string; name: string; label: string; archived: boolean }[]
  >();
  if (!recordIds.length) return map;
  const ids = uuidArray(recordIds);
  const pairs = await rows<{
    record_id: string;
    other_kind: RelationshipEndKind;
    other_id: string;
    label: string;
  }>(
    tx,
    sql`select x.record_id, x.other_kind, x.other_id, x.label from (
          select r.a_custom_record_id as record_id, t.b_end::text as other_kind, r.b_id as other_id,
            t.b_label as label, r.created_at
          from app.relationships r
          join app.relationship_types t on t.id = r.type_id and t.archived_at is null
          where r.workspace_id = ${workspaceId} and r.a_custom_record_id = any(${ids})
          union all
          select r.b_custom_record_id, t.a_end::text, r.a_id, t.a_label, r.created_at
          from app.relationships r
          join app.relationship_types t on t.id = r.type_id and t.archived_at is null
          where r.workspace_id = ${workspaceId} and r.b_custom_record_id = any(${ids})
        ) x
        order by x.created_at`,
  );
  const names = await endRecords(
    tx,
    workspaceId,
    pairs.map((p) => ({ kind: p.other_kind, id: p.other_id })),
  );
  for (const p of pairs) {
    const list = map.get(p.record_id) ?? [];
    const other = names.get(p.other_id);
    if (!other || list.length >= each) continue;
    list.push({
      kind: other.kind,
      id: other.id,
      name: other.name,
      label: p.label,
      archived: other.archived,
    });
    map.set(p.record_id, list);
  }
  return map;
}

export const customRecordList = defineQuery({
  name: 'custom_record.list',
  description:
    'Records of the business’s own kinds (pets, vehicles, properties): search by name or anything in their fields, with who each is related to.',
  input: CustomRecordListInput,
  output: CustomRecordListOutput,
  permission: 'records.read',
  scope: inWorkspace,
  async handler(ctx, input) {
    const cursor = decodeCursor(input.cursor);
    const q = input.q ? `%${input.q.toLowerCase()}%` : null;
    const list = await rows<{
      id: string;
      type_id: string;
      name: string;
      custom: Record<string, unknown>;
      archived_at: Date | null;
      created_at: Date;
      updated_at: Date;
      sort_key: string;
    }>(
      ctx.tx,
      sql`select * from (
            select r.id, r.type_id, r.name, r.custom, r.archived_at, r.created_at, r.updated_at,
              lower(r.name) as sort_key
            from app.custom_records r
            join app.custom_record_types t on t.id = r.type_id
            where r.workspace_id = ${input.workspaceId}
              ${input.typeId ? sql`and r.type_id = ${input.typeId}` : sql`and t.archived_at is null`}
              ${input.includeArchived ? sql`` : sql`and r.archived_at is null`}
              ${q ? sql`and r.search_text like ${q}` : sql``}
          ) x
          ${cursor ? sql`where (x.sort_key, x.id) > (${cursor.sort}, ${cursor.id}::uuid)` : sql``}
          order by x.sort_key, x.id
          limit ${input.limit + 1}`,
    );
    const result = page(list, input.limit, (r) => ({ sort: r.sort_key, id: r.id }));
    const fields = await fieldsByKind(
      ctx.tx,
      input.workspaceId,
      result.items.map((r) => r.type_id),
    );
    const related = await relatedPreview(
      ctx.tx,
      input.workspaceId,
      result.items.map((r) => r.id),
    );
    return {
      nextCursor: result.nextCursor,
      items: result.items.map((r) => ({
        id: r.id,
        typeId: r.type_id,
        name: r.name,
        detail: customSummary(fields.get(r.type_id) ?? [], r.custom ?? {}),
        related: related.get(r.id) ?? [],
        archivedAt: r.archived_at ? iso(r.archived_at) : null,
        createdAt: iso(r.created_at),
        updatedAt: iso(r.updated_at),
      })),
    };
  },
});

export const customRecordGet = defineQuery({
  name: 'custom_record.get',
  description: 'One record of the business’s own kinds, with its kind, notes and fields.',
  input: CustomRecordGetInput,
  output: CustomRecordGetOutput,
  permission: 'records.read',
  scope: inWorkspace,
  async handler(ctx, input) {
    const r = await requireCustomRecord(ctx.tx, input.workspaceId, input.customRecordId);
    const kind = await requireRecordType(ctx.tx, input.workspaceId, r.typeId);
    const [creator] = r.createdBy
      ? await rows<{ full_name: string; email: string }>(
          ctx.tx,
          sql`select full_name, email::text as email from app.users where id = ${r.createdBy}`,
        )
      : [];
    // Who is on it, for a record kept to its people (Real Estate step 4); somebody who left reads "Former member".
    const onIt = [...(r.ownerUserId ? [r.ownerUserId] : []), ...r.teamUserIds];
    const names = new Map(
      onIt.length
        ? (
            await rows<{ id: string; name: string }>(
              ctx.tx,
              sql`select u.id, coalesce(nullif(u.full_name, ''), u.email::text) as name from app.users u
                  where u.id = any(array[${sql.join(
                    onIt.map((i) => sql`${i}::uuid`),
                    sql`, `,
                  )}])`,
            )
          ).map((u) => [u.id, u.name])
        : [],
    );
    const person = (id: string) => ({ id, fullName: names.get(id) ?? 'Former member' });
    return {
      record: {
        id: r.id,
        type: typeRef(kind),
        name: r.name,
        notes: r.notes,
        custom: r.custom ?? {},
        archivedAt: r.archivedAt ? iso(r.archivedAt) : null,
        createdBy: r.createdBy
          ? { id: r.createdBy, fullName: creator?.full_name || creator?.email || 'Former member' }
          : null,
        createdAt: iso(r.createdAt),
        updatedAt: iso(r.updatedAt),
        keptToTeam: r.keptToTeam,
        owner: r.ownerUserId ? person(r.ownerUserId) : null,
        team: r.teamUserIds.map(person),
        addonId: kind.addonId,
      },
    };
  },
});

export const relationshipList = defineQuery({
  name: 'relationship.list',
  description:
    'Everything one person, company or record is related to, from either end: a customer’s pets and a pet’s owners come from the same pairs.',
  input: RelationshipListInput,
  output: RelationshipListOutput,
  permission: 'records.read',
  scope: inWorkspace,
  async handler(ctx, input) {
    const column = (side: 'a' | 'b') => sql.raw(`r.${side}_${input.recordType}_id`);
    const pairs = await rows<{
      id: string;
      type_id: string;
      side: 'a' | 'b';
      a_label: string;
      b_label: string;
      a_end: RelationshipEndKind;
      b_end: RelationshipEndKind;
      mutual: boolean;
      cardinality: 'one_to_one' | 'one_to_many' | 'many_to_one' | 'many_to_many';
      a_id: string;
      b_id: string;
      note: string | null;
      created_by: string | null;
      created_by_name: string | null;
      created_at: Date;
    }>(
      ctx.tx,
      sql`select r.id, r.type_id,
            case when ${column('a')} = ${input.recordId} then 'a' else 'b' end as side,
            t.a_label, t.b_label, t.a_end::text as a_end, t.b_end::text as b_end, t.mutual,
            t.cardinality::text as cardinality, r.a_id, r.b_id, r.note, r.created_by,
            coalesce(nullif(u.full_name, ''), u.email::text) as created_by_name, r.created_at
          from app.relationships r
          join app.relationship_types t on t.id = r.type_id and t.archived_at is null
          left join app.users u on u.id = r.created_by
          where r.workspace_id = ${input.workspaceId}
            and (${column('a')} = ${input.recordId} or ${column('b')} = ${input.recordId})
          order by t.position, t.created_at, r.created_at`,
    );
    const others = await endRecords(
      ctx.tx,
      input.workspaceId,
      pairs.map((p) =>
        p.side === 'a' ? { kind: p.b_end, id: p.b_id } : { kind: p.a_end, id: p.a_id },
      ),
    );
    const items = pairs.flatMap((p) => {
      const otherId = p.side === 'a' ? p.b_id : p.a_id;
      const other = others.get(otherId);
      if (!other) return [];
      return [
        {
          id: p.id,
          typeId: p.type_id,
          side: p.side,
          // What the other record is to this one: the label on its end.
          label: p.side === 'a' ? p.b_label : p.a_label,
          ownLabel: p.side === 'a' ? p.a_label : p.b_label,
          mutual: p.mutual,
          cardinality: p.cardinality,
          other: {
            kind: other.kind,
            id: other.id,
            name: other.name,
            detail: other.detail,
            archived: other.archived,
            recordType: other.recordType,
          },
          note: p.note,
          createdBy: p.created_by
            ? { id: p.created_by, fullName: p.created_by_name ?? 'Former member' }
            : null,
          createdAt: iso(p.created_at),
        },
      ];
    });
    if (!items.length && input.recordType === 'custom_record')
      // A record that isn't here reads as not found, like every other record's page.
      await requireCustomRecord(ctx.tx, input.workspaceId, input.recordId);
    return { items };
  },
});

export const relationshipQueries = [
  customFieldList,
  customRecordTypeList,
  relationshipTypeList,
  customRecordList,
  customRecordGet,
  relationshipList,
] as const;
