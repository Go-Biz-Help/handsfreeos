/**
 * Relationships (0101): which two kinds of record can relate and what each end is called (relationship types,
 * owners' and admins' to shape, fields.manage), and the pairs themselves (anyone who can write a record).
 *
 * A pair reads both ways from one row: a customer's page lists their pets, the pet's page its owners. Nothing is
 * assumed to be one-to-one; an end that may have only one is checked here with the records' own names, and again by
 * the database under a lock (`private.check_relationship`) for whoever else writes.
 */
import { and, eq, isNull, or, sql as dsql } from 'drizzle-orm';
import { customRecordTypes, relationships, relationshipTypes } from '@hfos/db/schema';
import { logSystemActivity } from '../crm/activities';
import { HfosError } from '../errors';
import { requireHuman } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import { isUniqueViolation } from '../kernel/pg-errors';
import type { CommandContext } from '../kernel/types';
import {
  endRecords,
  requireRecordType,
  requireRelationshipType,
  type EndRecord,
  type RelationshipTypeRow,
} from '../relationships/store';
import {
  endFullWords,
  manyFor,
  relationshipTypeName,
  type RelationshipCardinality,
  type RelationshipEndKind,
} from '../relationships/words';
import {
  RelationshipCreateInput,
  RelationshipCreateOutput,
  RelationshipDeleteInput,
  RelationshipDeleteOutput,
  RelationshipTypeArchiveInput,
  RelationshipTypeArchiveOutput,
  RelationshipTypeCreateInput,
  RelationshipTypeCreateOutput,
  RelationshipTypeRestoreInput,
  RelationshipTypeRestoreOutput,
  RelationshipTypeUpdateInput,
  RelationshipTypeUpdateOutput,
  RelationshipUpdateInput,
  RelationshipUpdateOutput,
} from '../schemas/relationship';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

/** A type's name in the audit log: "Owner ↔ Pet", or "Spouse". */
const typeName = (t: { aLabel: string; bLabel: string; mutual: boolean }) =>
  relationshipTypeName({ a: { label: t.aLabel }, b: { label: t.bLabel }, mutual: t.mutual });

const sameLabel = (x: string, y: string) => x.trim().toLowerCase() === y.trim().toLowerCase();

// ---- Relationship types ----

/** The ends a type already set up has, either way round: a second "Parent ↔ Child" helps nobody. */
async function assertTypeFree(
  ctx: CommandContext,
  a: { end: RelationshipEndKind; recordTypeId: string | null; label: string },
  b: { end: RelationshipEndKind; recordTypeId: string | null; label: string },
  exceptId?: string,
): Promise<void> {
  const live = await ctx.tx
    .select()
    .from(relationshipTypes)
    .where(
      and(
        eq(relationshipTypes.workspaceId, ctx.scope.workspaceId!),
        isNull(relationshipTypes.archivedAt),
      ),
    );
  const matches = (t: RelationshipTypeRow, x: typeof a, y: typeof b) =>
    t.aEnd === x.end &&
    (t.aRecordTypeId ?? null) === x.recordTypeId &&
    sameLabel(t.aLabel, x.label) &&
    t.bEnd === y.end &&
    (t.bRecordTypeId ?? null) === y.recordTypeId &&
    sameLabel(t.bLabel, y.label);
  if (live.some((t) => t.id !== exceptId && (matches(t, a, b) || matches(t, b, a))))
    throw HfosError.conflict('That relationship is already set up.', 'relationship_type_taken');
}

export const relationshipTypeCreate = defineCommand({
  name: 'relationship_type.create',
  description:
    'Set up how two kinds of record relate (a customer and a pet, a parent and a student, spouses), what each end is called, and how many each may have. Many to many unless said.',
  risk: 1,
  input: RelationshipTypeCreateInput,
  output: RelationshipTypeCreateOutput,
  permission: 'fields.manage',
  scope: inWorkspace,
  emits: ['relationship_type.created'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const end = (e: typeof input.a) => ({
      end: e.end,
      recordTypeId: e.end === 'custom_record' ? (e.recordTypeId ?? null) : null,
      label: e.label,
    });
    const a = end(input.a);
    // A mutual type is one part on both ends: the same kind, and one label.
    const b = input.mutual ? { ...a } : end(input.b);
    if (input.mutual) {
      if (input.b.end !== input.a.end || (input.b.recordTypeId ?? null) !== a.recordTypeId)
        throw HfosError.validation([
          {
            path: 'b',
            message: 'Both ends of a relationship that’s the same both ways are the same kind.',
          },
        ]);
      if (input.cardinality !== 'one_to_one' && input.cardinality !== 'many_to_many')
        throw HfosError.validation([
          { path: 'cardinality', message: 'Each can have one, or each can have many.' },
        ]);
    }
    const kinds = new Map<string, string>();
    for (const e of [a, b])
      if (e.recordTypeId)
        kinds.set(
          e.recordTypeId,
          (await requireRecordType(ctx.tx, ws, e.recordTypeId, { live: true })).singular,
        );
    await assertTypeFree(ctx, a, b);
    const [last] = await ctx.tx
      .select({ position: dsql<number>`coalesce(max(${relationshipTypes.position}), -1)` })
      .from(relationshipTypes)
      .where(eq(relationshipTypes.workspaceId, ws));
    let row: RelationshipTypeRow | undefined;
    try {
      [row] = await ctx.tx
        .insert(relationshipTypes)
        .values({
          workspaceId: ws,
          aEnd: a.end,
          aRecordTypeId: a.recordTypeId,
          aLabel: a.label,
          bEnd: b.end,
          bRecordTypeId: b.recordTypeId,
          bLabel: b.label,
          cardinality: input.cardinality,
          mutual: input.mutual,
          position: Math.min(1000, Number(last?.position ?? -1) + 1),
          createdBy: requireHuman(ctx).userId,
        })
        .returning();
    } catch (e) {
      if (isUniqueViolation(e))
        throw HfosError.conflict('That relationship is already set up.', 'relationship_type_taken');
      throw e;
    }
    if (!row) throw HfosError.forbidden();
    await ctx.emit({
      type: 'relationship_type.created',
      entityType: 'relationship_type',
      entityId: row.id,
      payload: {
        aLabel: row.aLabel,
        bLabel: row.bLabel,
        aEnd: row.aEnd,
        bEnd: row.bEnd,
        cardinality: row.cardinality,
        mutual: row.mutual,
        ...(kinds.size ? { kinds: [...kinds.values()] } : {}),
      },
      after: {
        name: typeName(row),
        aLabel: row.aLabel,
        bLabel: row.bLabel,
        cardinality: row.cardinality,
      },
    });
    return { relationshipTypeId: row.id };
  },
});

export const relationshipTypeUpdate = defineCommand({
  name: 'relationship_type.update',
  description:
    'Rename either end of a relationship type, change how many each end may have, or where it sits. Saying “one” is refused while a record already has more.',
  risk: 1,
  input: RelationshipTypeUpdateInput,
  output: RelationshipTypeUpdateOutput,
  permission: 'fields.manage',
  scope: inWorkspace,
  emits: ['relationship_type.updated'],
  async handler(ctx, input) {
    const current = await requireRelationshipType(
      ctx.tx,
      ctx.scope.workspaceId!,
      input.relationshipTypeId,
      {
        lock: true,
      },
    );
    const patch: Partial<typeof relationshipTypes.$inferInsert> = {};
    // A mutual type has one label, kept on both ends.
    const aLabel = input.aLabel ?? (current.mutual ? input.bLabel : undefined);
    const bLabel = current.mutual ? aLabel : input.bLabel;
    if (aLabel !== undefined && aLabel !== current.aLabel) patch.aLabel = aLabel;
    if (bLabel !== undefined && bLabel !== current.bLabel) patch.bLabel = bLabel;
    if (input.cardinality !== undefined && input.cardinality !== current.cardinality) {
      if (
        current.mutual &&
        input.cardinality !== 'one_to_one' &&
        input.cardinality !== 'many_to_many'
      )
        throw HfosError.validation([
          { path: 'cardinality', message: 'Each can have one, or each can have many.' },
        ]);
      patch.cardinality = input.cardinality;
    }
    if (input.position !== undefined && input.position !== current.position)
      patch.position = input.position;
    const updated = Object.keys(patch);
    if (!updated.length) return { relationshipTypeId: current.id, updated: [] };
    if (patch.aLabel !== undefined || patch.bLabel !== undefined)
      await assertTypeFree(
        ctx,
        {
          end: current.aEnd,
          recordTypeId: current.aRecordTypeId,
          label: patch.aLabel ?? current.aLabel,
        },
        {
          end: current.bEnd,
          recordTypeId: current.bRecordTypeId,
          label: patch.bLabel ?? current.bLabel,
        },
        current.id,
      );
    try {
      await ctx.tx.update(relationshipTypes).set(patch).where(eq(relationshipTypes.id, current.id));
    } catch (e) {
      if (isUniqueViolation(e))
        throw HfosError.conflict('That relationship is already set up.', 'relationship_type_taken');
      throw e;
    }
    await ctx.emit({
      type: 'relationship_type.updated',
      entityType: 'relationship_type',
      entityId: current.id,
      payload: {
        aLabel: patch.aLabel ?? current.aLabel,
        bLabel: patch.bLabel ?? current.bLabel,
        fields: updated,
      },
      before: {
        name: typeName(current),
        ...Object.fromEntries(updated.map((k) => [k, (current as Record<string, unknown>)[k]])),
      },
      after: {
        name: typeName({ ...current, ...patch }),
        ...Object.fromEntries(updated.map((k) => [k, (patch as Record<string, unknown>)[k]])),
      },
    });
    return { relationshipTypeId: current.id, updated };
  },
});

export const relationshipTypeArchive = defineCommand({
  name: 'relationship_type.archive',
  description:
    'Archive a relationship type: its pairs are hidden from every record, and nothing is deleted. Restoring brings them back.',
  risk: 2,
  input: RelationshipTypeArchiveInput,
  output: RelationshipTypeArchiveOutput,
  permission: 'fields.manage',
  scope: inWorkspace,
  emits: ['relationship_type.archived'],
  async handler(ctx, input) {
    const current = await requireRelationshipType(
      ctx.tx,
      ctx.scope.workspaceId!,
      input.relationshipTypeId,
      {
        lock: true,
      },
    );
    if (current.archivedAt) return { relationshipTypeId: current.id };
    await ctx.tx
      .update(relationshipTypes)
      .set({ archivedAt: new Date() })
      .where(eq(relationshipTypes.id, current.id));
    await ctx.emit({
      type: 'relationship_type.archived',
      entityType: 'relationship_type',
      entityId: current.id,
      payload: { aLabel: current.aLabel, bLabel: current.bLabel },
      before: { name: typeName(current), archived: false },
      after: { name: typeName(current), archived: true },
    });
    return { relationshipTypeId: current.id };
  },
});

export const relationshipTypeRestore = defineCommand({
  name: 'relationship_type.restore',
  description: 'Bring an archived relationship type back, with its pairs.',
  risk: 1,
  input: RelationshipTypeRestoreInput,
  output: RelationshipTypeRestoreOutput,
  permission: 'fields.manage',
  scope: inWorkspace,
  emits: ['relationship_type.restored'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const current = await requireRelationshipType(ctx.tx, ws, input.relationshipTypeId, {
      lock: true,
    });
    if (!current.archivedAt) return { relationshipTypeId: current.id };
    for (const kindId of [current.aRecordTypeId, current.bRecordTypeId])
      if (kindId) await requireRecordType(ctx.tx, ws, kindId, { live: true });
    await assertTypeFree(
      ctx,
      { end: current.aEnd, recordTypeId: current.aRecordTypeId, label: current.aLabel },
      { end: current.bEnd, recordTypeId: current.bRecordTypeId, label: current.bLabel },
      current.id,
    );
    await ctx.tx
      .update(relationshipTypes)
      .set({ archivedAt: null })
      .where(eq(relationshipTypes.id, current.id));
    await ctx.emit({
      type: 'relationship_type.restored',
      entityType: 'relationship_type',
      entityId: current.id,
      payload: { aLabel: current.aLabel, bLabel: current.bLabel },
      before: { name: typeName(current), archived: true },
      after: { name: typeName(current), archived: false },
    });
    return { relationshipTypeId: current.id };
  },
});

// ---- Pairs ----

/** What the kind of an end is called in a refusal: "pet", "customer", "company". */
async function kindWord(
  ctx: CommandContext,
  end: RelationshipEndKind,
  recordTypeId: string | null,
): Promise<string> {
  if (end === 'person') return 'customer';
  if (end === 'company') return 'company';
  const [k] = await ctx.tx
    .select({ singular: customRecordTypes.singular })
    .from(customRecordTypes)
    .where(eq(customRecordTypes.id, recordTypeId!));
  return k?.singular ?? 'record';
}

/** The two records a pair would join, found, of the kinds the type says, and not archived. */
async function pairEnds(
  ctx: CommandContext,
  type: RelationshipTypeRow,
  aId: string,
  bId: string,
): Promise<{ a: EndRecord; b: EndRecord }> {
  const found = await endRecords(ctx.tx, ctx.scope.workspaceId!, [
    { kind: type.aEnd, id: aId },
    { kind: type.bEnd, id: bId },
  ]);
  const check = async (
    side: 'a' | 'b',
    id: string,
    end: RelationshipEndKind,
    kindId: string | null,
  ): Promise<EndRecord> => {
    const r = found.get(id);
    if (!r || r.kind !== end || (kindId && r.recordType?.id !== kindId))
      throw HfosError.validation(
        [
          {
            path: `${side}Id`,
            message: `That isn’t ${await kindWord(ctx, end, kindId).then(articled)}.`,
          },
        ],
        'That record can’t go on that end of this relationship.',
      );
    if (r.archived)
      throw HfosError.rule(
        'record_archived',
        409,
        `${r.name} is archived. Restore it before relating it to anything.`,
      );
    return r;
  };
  return {
    a: await check('a', aId, type.aEnd, type.aRecordTypeId),
    b: await check('b', bId, type.bEnd, type.bRecordTypeId),
  };
}

const articled = (word: string) => `${/^[aeiou]/i.test(word) ? 'an' : 'a'} ${word.toLowerCase()}`;

/** The pairs of this type an end already has, from either column it could be in. */
async function pairsOn(
  ctx: CommandContext,
  typeId: string,
  side: 'a' | 'b' | 'either',
  id: string,
) {
  return ctx.tx
    .select({ id: relationships.id })
    .from(relationships)
    .where(
      and(
        eq(relationships.typeId, typeId),
        side === 'a'
          ? eq(relationships.aId, id)
          : side === 'b'
            ? eq(relationships.bId, id)
            : or(eq(relationships.aId, id), eq(relationships.bId, id)),
      ),
    )
    .limit(1);
}

/**
 * Refuses a pair an end has no room for, in the records' own words ("Max already has an owner. Each pet can have
 * only one."). The database checks the same under a lock, so this is for saying it well, not for keeping it true.
 */
async function assertRoom(
  ctx: CommandContext,
  type: RelationshipTypeRow,
  a: EndRecord,
  b: EndRecord,
): Promise<void> {
  const cardinality = type.cardinality as RelationshipCardinality;
  if (type.mutual) {
    if (cardinality !== 'one_to_one') return;
    for (const r of [a, b])
      if ((await pairsOn(ctx, type.id, 'either', r.id)).length)
        throw HfosError.conflict(
          endFullWords(r.name, type.aLabel, await kindWord(ctx, type.aEnd, type.aRecordTypeId)),
          'relationship_end_full',
        );
    return;
  }
  // Each A with one B at most: A is full when it has one already.
  if (!manyFor(cardinality, 'a') && (await pairsOn(ctx, type.id, 'a', a.id)).length)
    throw HfosError.conflict(
      endFullWords(a.name, type.bLabel, type.aLabel),
      'relationship_end_full',
    );
  if (!manyFor(cardinality, 'b') && (await pairsOn(ctx, type.id, 'b', b.id)).length)
    throw HfosError.conflict(
      endFullWords(b.name, type.aLabel, type.bLabel),
      'relationship_end_full',
    );
}

/** The ends of a pair as the timeline keeps them: named as they were then, with what each is. */
const pairMeta = (
  type: RelationshipTypeRow,
  relationshipId: string,
  a: EndRecord,
  b: EndRecord,
) => ({
  relationshipId,
  typeId: type.id,
  mutual: type.mutual,
  a: { kind: a.kind, id: a.id, name: a.name, label: type.aLabel },
  b: { kind: b.kind, id: b.id, name: b.name, label: type.bLabel },
});

/**
 * The entries for a pair made or taken apart, on both records' timelines. One entry reaches both when they're
 * different kinds (a customer and their pet); two when they're the same kind (spouses), the first with the event.
 */
async function logPair(
  ctx: CommandContext,
  subtype: 'related' | 'unrelated',
  meta: ReturnType<typeof pairMeta>,
  eventId: string,
): Promise<void> {
  const on = (r: { kind: RelationshipEndKind; id: string }) =>
    r.kind === 'person'
      ? { personId: r.id }
      : r.kind === 'company'
        ? { companyId: r.id }
        : { customRecordId: r.id };
  const entries =
    meta.a.kind === meta.b.kind ? [on(meta.a), on(meta.b)] : [{ ...on(meta.a), ...on(meta.b) }];
  let first = true;
  for (const where of entries) {
    await logSystemActivity(ctx, { subtype, ...where, meta, eventId: first ? eventId : null });
    first = false;
  }
}

export const relationshipCreate = defineCommand({
  name: 'relationship.create',
  description:
    'Relate two records the way a relationship type says: a customer and their pet, a parent and a student, two spouses. Refused where an end may have only one and already does.',
  risk: 1,
  input: RelationshipCreateInput,
  output: RelationshipCreateOutput,
  permission: 'records.write',
  scope: inWorkspace,
  emits: ['relationship.created'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const type = await requireRelationshipType(ctx.tx, ws, input.relationshipTypeId);
    if (type.archivedAt)
      throw HfosError.rule(
        'relationship_type_archived',
        409,
        'That relationship type is archived. Restore it in Settings → Relationships first.',
      );
    if (input.aId === input.bId)
      throw HfosError.rule('relationship_to_itself', 400, 'A record can’t be related to itself.');
    let { a, b } = await pairEnds(ctx, type, input.aId, input.bId);
    // A pair with no direction is kept one way round (the database turns it too).
    if (type.mutual && b.id < a.id) [a, b] = [b, a];
    const [already] = await ctx.tx
      .select({ id: relationships.id })
      .from(relationships)
      .where(
        and(
          eq(relationships.typeId, type.id),
          eq(relationships.aId, a.id),
          eq(relationships.bId, b.id),
        ),
      );
    if (already)
      throw HfosError.conflict(
        `${a.name} and ${b.name} are already related that way.`,
        'already_related',
      );
    await assertRoom(ctx, type, a, b);
    let row: { id: string } | undefined;
    try {
      [row] = await ctx.tx
        .insert(relationships)
        .values({
          workspaceId: ws,
          typeId: type.id,
          aPersonId: a.kind === 'person' ? a.id : null,
          aCompanyId: a.kind === 'company' ? a.id : null,
          aCustomRecordId: a.kind === 'custom_record' ? a.id : null,
          bPersonId: b.kind === 'person' ? b.id : null,
          bCompanyId: b.kind === 'company' ? b.id : null,
          bCustomRecordId: b.kind === 'custom_record' ? b.id : null,
          note: input.note ?? null,
          createdBy: requireHuman(ctx).userId,
        })
        .returning({ id: relationships.id });
    } catch (e) {
      if (isUniqueViolation(e))
        throw HfosError.conflict(
          `${a.name} and ${b.name} are already related that way.`,
          'already_related',
        );
      throw e;
    }
    if (!row) throw HfosError.forbidden();
    const meta = pairMeta(type, row.id, a, b);
    const eventId = await ctx.emit({
      type: 'relationship.created',
      entityType: 'relationship',
      entityId: row.id,
      payload: {
        typeId: type.id,
        a: { kind: a.kind, id: a.id, name: a.name },
        b: { kind: b.kind, id: b.id, name: b.name },
      },
      after: {
        a: a.name,
        aLabel: type.aLabel,
        b: b.name,
        bLabel: type.bLabel,
        note: input.note ?? null,
      },
    });
    await logPair(ctx, 'related', meta, eventId);
    return { relationshipId: row.id };
  },
});

/** A pair in this business, with its type and what each end is now. */
async function loadPair(
  ctx: CommandContext,
  relationshipId: string,
  opts: { lock?: boolean } = {},
) {
  const ws = ctx.scope.workspaceId!;
  const query = ctx.tx
    .select()
    .from(relationships)
    .where(and(eq(relationships.id, relationshipId), eq(relationships.workspaceId, ws)));
  const [pair] = opts.lock ? await query.for('update') : await query;
  if (!pair) throw HfosError.notFound('That relationship wasn’t found.');
  const type = await requireRelationshipType(ctx.tx, ws, pair.typeId);
  const kindOf = (person: string | null, company: string | null): RelationshipEndKind =>
    person ? 'person' : company ? 'company' : 'custom_record';
  const refs = [
    { kind: kindOf(pair.aPersonId, pair.aCompanyId), id: pair.aId! },
    { kind: kindOf(pair.bPersonId, pair.bCompanyId), id: pair.bId! },
  ];
  const found = await endRecords(ctx.tx, ws, refs);
  const named = (r: (typeof refs)[number]): EndRecord =>
    found.get(r.id) ?? { ...r, name: 'Someone', detail: null, archived: true, recordType: null };
  return { pair, type, a: named(refs[0]!), b: named(refs[1]!) };
}

export const relationshipUpdate = defineCommand({
  name: 'relationship.update',
  description: 'Change the note on a pair ("Primary driver", "Lease ends in August").',
  risk: 1,
  input: RelationshipUpdateInput,
  output: RelationshipUpdateOutput,
  permission: 'records.write',
  scope: inWorkspace,
  emits: ['relationship.updated'],
  async handler(ctx, input) {
    const { pair, a, b } = await loadPair(ctx, input.relationshipId, { lock: true });
    const note = input.note ?? null;
    if ((pair.note ?? null) === note) return { relationshipId: pair.id };
    await ctx.tx.update(relationships).set({ note }).where(eq(relationships.id, pair.id));
    await ctx.emit({
      type: 'relationship.updated',
      entityType: 'relationship',
      entityId: pair.id,
      payload: {
        typeId: pair.typeId,
        a: { kind: a.kind, id: a.id, name: a.name },
        b: { kind: b.kind, id: b.id, name: b.name },
        fields: ['note'],
      },
      before: { note: pair.note },
      after: { note },
    });
    return { relationshipId: pair.id };
  },
});

export const relationshipDelete = defineCommand({
  name: 'relationship.delete',
  description: 'Take a pair apart. Neither record is touched, and both timelines say who did it.',
  risk: 2,
  input: RelationshipDeleteInput,
  output: RelationshipDeleteOutput,
  permission: 'records.write',
  scope: inWorkspace,
  emits: ['relationship.deleted'],
  async handler(ctx, input) {
    const { pair, type, a, b } = await loadPair(ctx, input.relationshipId, { lock: true });
    await ctx.tx.delete(relationships).where(eq(relationships.id, pair.id));
    const meta = pairMeta(type, pair.id, a, b);
    const eventId = await ctx.emit({
      type: 'relationship.deleted',
      entityType: 'relationship',
      entityId: pair.id,
      payload: {
        typeId: type.id,
        a: { kind: a.kind, id: a.id, name: a.name },
        b: { kind: b.kind, id: b.id, name: b.name },
      },
      before: { a: a.name, aLabel: type.aLabel, b: b.name, bLabel: type.bLabel, note: pair.note },
      after: null,
    });
    await logPair(ctx, 'unrelated', meta, eventId);
    return { relationshipId: pair.id };
  },
});

export const relationshipCommands = [
  relationshipTypeCreate,
  relationshipTypeUpdate,
  relationshipTypeArchive,
  relationshipTypeRestore,
  relationshipCreate,
  relationshipUpdate,
  relationshipDelete,
] as const;
