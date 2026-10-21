/**
 * Kinds of records a business makes up (0101) and the records themselves: a groomer's pets, a shop's vehicles, a
 * manager's properties and units. Owners and admins make the kinds (fields.manage, like the fields that describe
 * them); anyone who can write a customer adds records, and owners and admins archive them, as for customers.
 *
 * A record has what a customer has: a name, notes, its kind's fields, and its own timeline, tasks, files and
 * visits through the tables those already live in. What it's related to is `relationship.*`.
 */
import { and, eq, isNull, or, sql as dsql } from 'drizzle-orm';
import { customRecords, customRecordTypes, relationshipTypes } from '@hfos/db/schema';
import { logSystemActivity } from '../crm/activities';
import { keyFromLabel } from '../crm/custom-fields';
import { HfosError } from '../errors';
import { requireHuman, userIdOf } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import { executeCommandWithin } from '../kernel/execute';
import { logNotApplied, mergeColumns, mergeFields } from '../kernel/field-merge';
import { changeMoment } from '../kernel/moment';
import { isUniqueViolation } from '../kernel/pg-errors';
import type { CommandContext } from '../kernel/types';
import {
  liveFields,
  requireCustomRecord,
  requireRecordType,
  type CustomRecordTypeRow,
} from '../relationships/store';
import { pluralOf } from '../relationships/words';
import {
  CustomRecordArchiveInput,
  CustomRecordArchiveOutput,
  CustomRecordCreateInput,
  CustomRecordCreateOutput,
  CustomRecordRestoreInput,
  CustomRecordRestoreOutput,
  CustomRecordTypeArchiveInput,
  CustomRecordTypeArchiveOutput,
  CustomRecordTypeCreateInput,
  CustomRecordTypeCreateOutput,
  CustomRecordTypeRestoreInput,
  CustomRecordTypeRestoreOutput,
  CustomRecordTypeUpdateInput,
  CustomRecordTypeUpdateOutput,
  CustomRecordUpdateInput,
  CustomRecordUpdateOutput,
} from '../schemas/relationship';
import { checkedValues, customFieldCreate } from './custom-field';
import { relationshipCreate, relationshipTypeCreate } from './relationship';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

const nameTaken = (singular: string, fix = 'Pick a different name.') =>
  HfosError.conflict(
    `There’s already a kind of record called “${singular}”. ${fix}`,
    'record_type_taken',
  );

/** Its words on the timeline: "added this pet". */
const kindMeta = (t: CustomRecordTypeRow) => ({ kind: t.singular, typeId: t.id });

// ---- Kinds of records ----

export const customRecordTypeCreate = defineCommand({
  name: 'custom_record_type.create',
  description:
    'Make a kind of record the business keeps (pets, vehicles, properties), with its first fields and the relationship that ties it to customers.',
  risk: 1,
  input: CustomRecordTypeCreateInput,
  output: CustomRecordTypeCreateOutput,
  permission: 'fields.manage',
  scope: inWorkspace,
  emits: ['custom_record_type.created'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const existing = await ctx.tx
      .select({
        key: customRecordTypes.key,
        singular: customRecordTypes.singular,
        position: customRecordTypes.position,
        archivedAt: customRecordTypes.archivedAt,
      })
      .from(customRecordTypes)
      .where(eq(customRecordTypes.workspaceId, ws));
    if (
      existing.some(
        (t) => !t.archivedAt && t.singular.trim().toLowerCase() === input.singular.toLowerCase(),
      )
    )
      throw nameTaken(input.singular);
    const key = keyFromLabel(
      input.singular,
      existing.map((t) => t.key),
    );
    let row: CustomRecordTypeRow | undefined;
    try {
      [row] = await ctx.tx
        .insert(customRecordTypes)
        .values({
          workspaceId: ws,
          key,
          singular: input.singular,
          plural: input.plural ?? pluralOf(input.singular),
          nameLabel: input.nameLabel ?? 'Name',
          icon: input.icon,
          position: Math.min(1000, Math.max(-1, ...existing.map((t) => t.position)) + 1),
          createdBy: requireHuman(ctx).userId,
        })
        .returning();
    } catch (e) {
      if (isUniqueViolation(e)) throw nameTaken(input.singular);
      throw e;
    }
    if (!row) throw HfosError.forbidden();
    await ctx.emit({
      type: 'custom_record_type.created',
      entityType: 'custom_record_type',
      entityId: row.id,
      payload: { singular: row.singular, plural: row.plural, key },
      after: { name: row.plural, singular: row.singular, plural: row.plural, icon: row.icon },
    });
    // Its first fields and the tie to customers are each their own command, with their own events and audit rows.
    const customFieldIds: string[] = [];
    for (const f of input.fields ?? []) {
      const made = await executeCommandWithin(ctx, customFieldCreate, {
        workspaceId: ws,
        entity: 'custom_record',
        recordTypeId: row.id,
        label: f.label,
        type: f.type,
        options: f.options?.map((label) => ({ label })),
      });
      customFieldIds.push(made.output.customFieldId);
    }
    let relationshipTypeId: string | null = null;
    if (input.link) {
      const made = await executeCommandWithin(ctx, relationshipTypeCreate, {
        workspaceId: ws,
        a: { end: input.link.end, label: input.link.label },
        b: {
          end: 'custom_record',
          recordTypeId: row.id,
          label: input.link.recordLabel ?? row.singular,
        },
        cardinality: input.link.cardinality,
      });
      relationshipTypeId = made.output.relationshipTypeId;
    }
    return { customRecordTypeId: row.id, key, customFieldIds, relationshipTypeId };
  },
});

export const customRecordTypeUpdate = defineCommand({
  name: 'custom_record_type.update',
  description:
    'Rename a kind of record, change its picture, what its name is called, or where it sits.',
  risk: 1,
  input: CustomRecordTypeUpdateInput,
  output: CustomRecordTypeUpdateOutput,
  permission: 'fields.manage',
  scope: inWorkspace,
  emits: ['custom_record_type.updated'],
  async handler(ctx, input) {
    const current = await requireRecordType(
      ctx.tx,
      ctx.scope.workspaceId!,
      input.customRecordTypeId,
      {
        lock: true,
      },
    );
    const patch: Partial<typeof customRecordTypes.$inferInsert> = {};
    if (input.singular !== undefined && input.singular !== current.singular)
      patch.singular = input.singular;
    if (input.plural !== undefined && input.plural !== current.plural) patch.plural = input.plural;
    if (input.nameLabel !== undefined && input.nameLabel !== current.nameLabel)
      patch.nameLabel = input.nameLabel;
    if (input.icon !== undefined && input.icon !== current.icon) patch.icon = input.icon;
    if (input.position !== undefined && input.position !== current.position)
      patch.position = input.position;
    const updated = Object.keys(patch);
    if (!updated.length) return { customRecordTypeId: current.id, updated: [] };
    try {
      await ctx.tx.update(customRecordTypes).set(patch).where(eq(customRecordTypes.id, current.id));
    } catch (e) {
      if (isUniqueViolation(e)) throw nameTaken(patch.singular ?? current.singular);
      throw e;
    }
    await ctx.emit({
      type: 'custom_record_type.updated',
      entityType: 'custom_record_type',
      entityId: current.id,
      payload: { singular: patch.singular ?? current.singular, fields: updated },
      before: {
        name: current.plural,
        ...Object.fromEntries(updated.map((k) => [k, (current as Record<string, unknown>)[k]])),
      },
      after: {
        name: patch.plural ?? current.plural,
        ...Object.fromEntries(updated.map((k) => [k, (patch as Record<string, unknown>)[k]])),
      },
    });
    return { customRecordTypeId: current.id, updated };
  },
});

/** The relationship types with this kind on an end. */
const typesOnKind = (kindId: string) =>
  or(eq(relationshipTypes.aRecordTypeId, kindId), eq(relationshipTypes.bRecordTypeId, kindId));

export const customRecordTypeArchive = defineCommand({
  name: 'custom_record_type.archive',
  description:
    'Archive a kind of record: its tab, its records and its relationships are hidden, and nothing is deleted. Restoring brings them all back.',
  risk: 2,
  input: CustomRecordTypeArchiveInput,
  output: CustomRecordTypeArchiveOutput,
  permission: 'fields.manage',
  scope: inWorkspace,
  emits: ['custom_record_type.archived'],
  async handler(ctx, input) {
    const current = await requireRecordType(
      ctx.tx,
      ctx.scope.workspaceId!,
      input.customRecordTypeId,
      {
        lock: true,
      },
    );
    if (current.archivedAt) return { customRecordTypeId: current.id, archivedRelationshipTypes: 0 };
    const at = new Date();
    await ctx.tx
      .update(customRecordTypes)
      .set({ archivedAt: at })
      .where(eq(customRecordTypes.id, current.id));
    // Archived at the same moment as the kind, so restoring the kind brings back exactly these.
    const archived = await ctx.tx
      .update(relationshipTypes)
      .set({ archivedAt: at })
      .where(and(typesOnKind(current.id), isNull(relationshipTypes.archivedAt)))
      .returning({ id: relationshipTypes.id });
    await ctx.emit({
      type: 'custom_record_type.archived',
      entityType: 'custom_record_type',
      entityId: current.id,
      payload: { singular: current.singular, archivedRelationshipTypes: archived.length },
      before: { name: current.plural, singular: current.singular, archived: false },
      after: { name: current.plural, singular: current.singular, archived: true },
    });
    return { customRecordTypeId: current.id, archivedRelationshipTypes: archived.length };
  },
});

export const customRecordTypeRestore = defineCommand({
  name: 'custom_record_type.restore',
  description:
    'Bring an archived kind of record back, with the relationships archived along with it.',
  risk: 1,
  input: CustomRecordTypeRestoreInput,
  output: CustomRecordTypeRestoreOutput,
  permission: 'fields.manage',
  scope: inWorkspace,
  emits: ['custom_record_type.restored'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const current = await requireRecordType(ctx.tx, ws, input.customRecordTypeId, { lock: true });
    if (!current.archivedAt) return { customRecordTypeId: current.id };
    const [clash] = await ctx.tx
      .select({ id: customRecordTypes.id })
      .from(customRecordTypes)
      .where(
        and(
          eq(customRecordTypes.workspaceId, ws),
          isNull(customRecordTypes.archivedAt),
          dsql`lower(btrim(${customRecordTypes.singular})) = lower(btrim(${current.singular}))`,
        ),
      );
    if (clash)
      throw nameTaken(
        current.singular,
        'Rename that one in Settings → Relationships first, then restore this one.',
      );
    await ctx.tx
      .update(customRecordTypes)
      .set({ archivedAt: null })
      .where(eq(customRecordTypes.id, current.id));
    // Only the relationship types that went with it: one archived on its own before stays archived.
    await ctx.tx
      .update(relationshipTypes)
      .set({ archivedAt: null })
      .where(and(typesOnKind(current.id), eq(relationshipTypes.archivedAt, current.archivedAt)));
    await ctx.emit({
      type: 'custom_record_type.restored',
      entityType: 'custom_record_type',
      entityId: current.id,
      payload: { singular: current.singular },
      before: { name: current.plural, singular: current.singular, archived: true },
      after: { name: current.plural, singular: current.singular, archived: false },
    });
    return { customRecordTypeId: current.id };
  },
});

// ---- Records ----

export const customRecordCreate = defineCommand({
  name: 'custom_record.create',
  description:
    'Add a record of one of the business’s own kinds (a pet, a vehicle, a property), with its fields, and relate it to a customer as it is made.',
  risk: 1,
  input: CustomRecordCreateInput,
  output: CustomRecordCreateOutput,
  permission: 'records.write',
  scope: inWorkspace,
  emits: ['custom_record.created'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const kind = await requireRecordType(ctx.tx, ws, input.typeId, { live: true });
    if (!kind.keptToTeam && (input.ownerUserId || input.teamUserIds?.length))
      throw HfosError.rule(
        'record_not_private',
        400,
        `Everyone in this business sees ${kind.plural.toLowerCase()}, so nobody needs to be put on one.`,
      );
    const fields = await liveFields(ctx.tx, ws, 'custom_record', kind.id);
    const checked = checkedValues(fields, input.values ?? {});
    const custom = Object.fromEntries(
      [...checked].filter(([, v]) => v.value !== null).map(([id, v]) => [id, v.value]),
    );
    const [row] = await ctx.tx
      .insert(customRecords)
      .values({
        workspaceId: ws,
        typeId: kind.id,
        name: input.name,
        notes: input.notes ?? null,
        custom,
        createdBy: userIdOf(ctx.actor),
        // A private kind's (Real Estate step 4): its maker is its owner unless someone else is named.
        ...(input.ownerUserId ? { ownerUserId: input.ownerUserId } : {}),
        ...(input.teamUserIds ? { teamUserIds: input.teamUserIds } : {}),
      })
      .returning();
    if (!row) throw HfosError.forbidden();
    const eventId = await ctx.emit({
      type: 'custom_record.created',
      entityType: 'custom_record',
      entityId: row.id,
      payload: { name: row.name, typeId: kind.id, kind: kind.singular },
      after: { name: row.name, kind: kind.singular },
    });
    await logSystemActivity(ctx, {
      subtype: 'created',
      customRecordId: row.id,
      eventId,
      meta: kindMeta(kind),
    });
    let relationshipId: string | null = null;
    if (input.relateTo) {
      const { side, recordId, relationshipTypeId, note } = input.relateTo;
      const made = await executeCommandWithin(ctx, relationshipCreate, {
        workspaceId: ws,
        relationshipTypeId,
        aId: side === 'a' ? row.id : recordId,
        bId: side === 'a' ? recordId : row.id,
        note: note ?? null,
      });
      relationshipId = made.output.relationshipId;
    }
    return { customRecordId: row.id, relationshipId };
  },
});

export const customRecordUpdate = defineCommand({
  name: 'custom_record.update',
  description:
    'Change a record’s name or notes: only what was edited, each with what the editor saw, and the newest change to each wins.',
  risk: 1,
  input: CustomRecordUpdateInput,
  output: CustomRecordUpdateOutput,
  permission: 'records.write',
  scope: inWorkspace,
  emits: ['custom_record.updated'],
  async handler(ctx, input) {
    const current = await requireCustomRecord(
      ctx.tx,
      ctx.scope.workspaceId!,
      input.customRecordId,
      {
        lock: true,
      },
    );
    const seen: NonNullable<typeof input.base> = input.base ?? {};
    const merged = mergeFields(
      current,
      [
        {
          key: 'name',
          column: 'name',
          value: input.name,
          base: seen.name,
          kind: 'text',
          label: 'name',
        },
        {
          key: 'notes',
          column: 'notes',
          value: input.notes === undefined ? undefined : (input.notes ?? null),
          base: seen.notes,
          kind: 'text',
          label: 'notes',
        },
      ],
      mergeColumns(customRecords),
      ctx.meta,
    );
    const notApplied = merged.notApplied.map((n) => n.key);
    await logNotApplied(
      ctx,
      merged.notApplied,
      { type: 'custom_record', id: current.id },
      { customRecordId: current.id },
    );
    const updated = [...merged.applied];
    if (!updated.length) return { customRecordId: current.id, updated: [], notApplied };
    await ctx.tx.update(customRecords).set(merged.patch).where(eq(customRecords.id, current.id));
    const name = (merged.patch.name as string | undefined) ?? current.name;
    await ctx.emit({
      type: 'custom_record.updated',
      entityType: 'custom_record',
      entityId: current.id,
      payload: { name, fields: updated },
      before: {
        name: current.name,
        ...Object.fromEntries(updated.map((k) => [k, (current as Record<string, unknown>)[k]])),
      },
      after: { name, ...Object.fromEntries(updated.map((k) => [k, merged.patch[k]])) },
    });
    return { customRecordId: current.id, updated, notApplied };
  },
});

async function setArchived(
  ctx: CommandContext,
  customRecordId: string,
  archived: boolean,
): Promise<string> {
  const ws = ctx.scope.workspaceId!;
  const current = await requireCustomRecord(ctx.tx, ws, customRecordId, { lock: true });
  if (!!current.archivedAt === archived) return current.id;
  const kind = await requireRecordType(ctx.tx, ws, current.typeId);
  if (!archived && kind.archivedAt)
    throw HfosError.rule(
      'record_type_archived',
      409,
      `${kind.plural} are archived. Restore them in Settings → Relationships first.`,
    );
  // When the person did it: on a phone, perhaps before it had signal.
  await ctx.tx
    .update(customRecords)
    .set({ archivedAt: archived ? changeMoment(ctx.meta) : null })
    .where(eq(customRecords.id, current.id));
  const eventId = await ctx.emit({
    type: archived ? 'custom_record.archived' : 'custom_record.restored',
    entityType: 'custom_record',
    entityId: current.id,
    payload: { name: current.name, kind: kind.singular },
    before: { name: current.name, archived: !archived },
    after: { name: current.name, archived },
  });
  await logSystemActivity(ctx, {
    subtype: archived ? 'archived' : 'restored',
    customRecordId: current.id,
    eventId,
    meta: kindMeta(kind),
  });
  return current.id;
}

export const customRecordArchive = defineCommand({
  name: 'custom_record.archive',
  description:
    'Archive a record: hidden from lists, found in search under Archived, its history, tasks, files and relationships kept.',
  risk: 3,
  input: CustomRecordArchiveInput,
  output: CustomRecordArchiveOutput,
  permission: 'records.archive',
  scope: inWorkspace,
  emits: ['custom_record.archived'],
  async handler(ctx, input) {
    return { customRecordId: await setArchived(ctx, input.customRecordId, true) };
  },
});

export const customRecordRestore = defineCommand({
  name: 'custom_record.restore',
  description: 'Restore an archived record.',
  risk: 1,
  input: CustomRecordRestoreInput,
  output: CustomRecordRestoreOutput,
  permission: 'records.archive',
  scope: inWorkspace,
  emits: ['custom_record.restored'],
  async handler(ctx, input) {
    return { customRecordId: await setArchived(ctx, input.customRecordId, false) };
  },
});

export const customRecordCommands = [
  customRecordTypeCreate,
  customRecordTypeUpdate,
  customRecordTypeArchive,
  customRecordTypeRestore,
  customRecordCreate,
  customRecordUpdate,
  customRecordArchive,
  customRecordRestore,
] as const;
