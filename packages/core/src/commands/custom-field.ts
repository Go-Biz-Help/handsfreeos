/**
 * Fields a business invents (M15, 0076): made, renamed and retired by owners and admins (fields.manage), and
 * filled in by anyone who can write the record (records.write).
 *
 * Until now a field could only arrive with a migration or be pointed at by a form, and a customer's page showed
 * none of them. These commands are the door for everyone else, and the same door serves every kind of record: a
 * customer's gate code, a company's account number, a lead's budget, a pet's breed.
 */
import { and, eq, sql as dsql } from 'drizzle-orm';
import { companies, customFields, customRecords, leads, people } from '@hfos/db/schema';
import {
  checkCustomValue,
  hasOptions,
  keyFromLabel,
  optionValueFrom,
  type CustomFieldOption,
  type CustomFieldType,
} from '../crm/custom-fields';
import { fullName } from '../crm/records';
import { HfosError } from '../errors';
import { requireHuman } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import { logNotApplied, type NotApplied } from '../kernel/field-merge';
import { changeMoment } from '../kernel/moment';
import { canonicalJson } from '../kernel/receipts';
import type { CommandContext } from '../kernel/types';
import { liveFields, requireRecordType, type LiveField } from '../relationships/store';
import {
  CustomFieldArchiveInput,
  CustomFieldArchiveOutput,
  CustomFieldCreateInput,
  CustomFieldCreateOutput,
  CustomFieldUpdateInput,
  CustomFieldUpdateOutput,
  RecordSetFieldsInput,
  RecordSetFieldsOutput,
  type FieldedRecordType,
} from '../schemas/custom-field';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

/** Something the person opened or picked that isn't there any more. */
const gone = (what: string) =>
  `That ${what} isn’t there anymore. It may have been deleted. Refresh and try again.`;

/**
 * A field's list of choices as it keeps them. A choice keeps the value it was given — that is what records hold —
 * and a new one gets a value made from its label, never one the field has used before, so a choice taken off the
 * list and a new one never read as each other.
 */
function choicesFor(
  type: CustomFieldType,
  given: readonly { readonly value?: string; readonly label: string }[] | undefined,
  current: readonly CustomFieldOption[] = [],
): CustomFieldOption[] {
  if (!hasOptions(type)) {
    if (given?.length)
      throw HfosError.validation([{ path: 'options', message: 'Only a list field has choices.' }]);
    return [];
  }
  if (!given?.length)
    throw HfosError.validation([{ path: 'options', message: 'Add at least one choice.' }]);
  const used = new Set(current.map((o) => o.value));
  const values = new Set<string>();
  const labels = new Set<string>();
  const kept = new Set(given.map((o) => o.value).filter((v): v is string => !!v));
  return given.map((o, i) => {
    const label = o.label.trim();
    if (labels.has(label.toLowerCase()))
      throw HfosError.validation([
        { path: `options.${i}.label`, message: 'Two choices have the same name.' },
      ]);
    labels.add(label.toLowerCase());
    let value = o.value?.trim() || null;
    if (!value || values.has(value)) value = optionValueFrom(label, [...used, ...values, ...kept]);
    values.add(value);
    return { value, label };
  });
}

/** Two live fields on the same kind of record can't share a name: filling in "Breed" twice helps nobody. */
async function assertLabelFree(
  ctx: CommandContext,
  where: { entity: FieldedRecordType; recordTypeId: string | null },
  label: string,
  exceptId?: string,
): Promise<void> {
  const fields = await liveFields(ctx.tx, ctx.scope.workspaceId!, where.entity, where.recordTypeId);
  const clash = fields.find(
    (f) => f.id !== exceptId && f.label.trim().toLowerCase() === label.trim().toLowerCase(),
  );
  if (clash)
    throw HfosError.conflict(
      `There’s already a field called “${clash.label}” here. Give this one a different name, or use that field.`,
      'field_label_taken',
    );
}

export const customFieldCreate = defineCommand({
  name: 'custom_field.create',
  description:
    'Make a field for customers, companies, leads or one kind of record (a pet’s breed, a car’s plate). Its key is made from its name.',
  risk: 1,
  input: CustomFieldCreateInput,
  output: CustomFieldCreateOutput,
  permission: 'fields.manage',
  scope: inWorkspace,
  emits: ['custom_field.created'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const recordTypeId = input.entity === 'custom_record' ? input.recordTypeId! : null;
    const kind = recordTypeId
      ? await requireRecordType(ctx.tx, ws, recordTypeId, { live: true })
      : null;
    await assertLabelFree(ctx, { entity: input.entity, recordTypeId }, input.label);
    // Keys are never reused while a field lives, archived ones included, and are unique across every kind of
    // record (0076's unique key): a car's "Color" after a pet's is color_2. Its place is among its own kind's.
    const existing = await ctx.tx
      .select({
        key: customFields.key,
        position: customFields.position,
        recordTypeId: customFields.recordTypeId,
      })
      .from(customFields)
      .where(and(eq(customFields.workspaceId, ws), eq(customFields.entity, input.entity)));
    const key = keyFromLabel(
      input.label,
      existing.map((f) => f.key),
    );
    const siblings = existing.filter((f) => f.recordTypeId === recordTypeId);
    const position = Math.min(1000, Math.max(-1, ...siblings.map((f) => f.position)) + 1);
    const [row] = await ctx.tx
      .insert(customFields)
      .values({
        workspaceId: ws,
        entity: input.entity,
        recordTypeId,
        key,
        label: input.label,
        type: input.type,
        options: choicesFor(input.type, input.options),
        help: input.help ?? '',
        position,
        alwaysShow: input.alwaysShow,
        createdBy: requireHuman(ctx).userId,
      })
      .returning({ id: customFields.id });
    if (!row) throw HfosError.forbidden();
    await ctx.emit({
      type: 'custom_field.created',
      entityType: 'custom_field',
      entityId: row.id,
      payload: {
        label: input.label,
        type: input.type,
        entity: input.entity,
        recordTypeId,
        ...(kind ? { kind: kind.singular } : {}),
      },
      after: { label: input.label, type: input.type, key },
    });
    return { customFieldId: row.id, key };
  },
});

export const customFieldUpdate = defineCommand({
  name: 'custom_field.update',
  description:
    'Rename a field, change its choices, its help line or where it sits, or whether it shows when empty. Its type stays.',
  risk: 1,
  input: CustomFieldUpdateInput,
  output: CustomFieldUpdateOutput,
  permission: 'fields.manage',
  scope: inWorkspace,
  emits: ['custom_field.updated'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const [current] = await ctx.tx
      .select()
      .from(customFields)
      .where(and(eq(customFields.id, input.customFieldId), eq(customFields.workspaceId, ws)))
      .for('update');
    if (!current) throw HfosError.notFound(gone('field'));
    if (current.archivedAt)
      throw HfosError.rule(
        'field_archived',
        409,
        `“${current.label}” was archived, so it can’t change. Add a new field if you still need one.`,
      );
    const patch: Partial<typeof customFields.$inferInsert> = {};
    if (input.label !== undefined && input.label !== current.label) {
      await assertLabelFree(
        ctx,
        { entity: current.entity, recordTypeId: current.recordTypeId },
        input.label,
        current.id,
      );
      patch.label = input.label;
    }
    if (input.options !== undefined) {
      const next = choicesFor(
        current.type as CustomFieldType,
        input.options,
        current.options as unknown as CustomFieldOption[],
      );
      if (canonicalJson(next) !== canonicalJson(current.options)) patch.options = next;
    }
    if (input.help !== undefined && input.help !== current.help) patch.help = input.help;
    if (input.alwaysShow !== undefined && input.alwaysShow !== current.alwaysShow)
      patch.alwaysShow = input.alwaysShow;
    if (input.position !== undefined && input.position !== current.position)
      patch.position = input.position;
    const updated = Object.keys(patch);
    if (!updated.length) return { customFieldId: current.id, updated: [] };
    await ctx.tx.update(customFields).set(patch).where(eq(customFields.id, current.id));
    await ctx.emit({
      type: 'custom_field.updated',
      entityType: 'custom_field',
      entityId: current.id,
      payload: { label: patch.label ?? current.label, fields: updated },
      before: {
        name: current.label,
        ...Object.fromEntries(updated.map((k) => [k, (current as Record<string, unknown>)[k]])),
      },
      after: {
        name: patch.label ?? current.label,
        ...Object.fromEntries(updated.map((k) => [k, (patch as Record<string, unknown>)[k]])),
      },
    });
    return { customFieldId: current.id, updated };
  },
});

export const customFieldArchive = defineCommand({
  name: 'custom_field.archive',
  description:
    'Retire a field. Its answers come off every record that has one (0076), so this is for a field nobody fills in any more.',
  risk: 3,
  input: CustomFieldArchiveInput,
  output: CustomFieldArchiveOutput,
  permission: 'fields.manage',
  scope: inWorkspace,
  emits: ['custom_field.archived'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const [current] = await ctx.tx
      .select()
      .from(customFields)
      .where(and(eq(customFields.id, input.customFieldId), eq(customFields.workspaceId, ws)))
      .for('update');
    if (!current) throw HfosError.notFound(gone('field'));
    if (current.archivedAt) return { customFieldId: current.id };
    // The trigger takes the field's value off the records that hold it, in this statement.
    await ctx.tx
      .update(customFields)
      .set({ archivedAt: new Date() })
      .where(eq(customFields.id, current.id));
    await ctx.emit({
      type: 'custom_field.archived',
      entityType: 'custom_field',
      entityId: current.id,
      payload: { label: current.label, entity: current.entity, recordTypeId: current.recordTypeId },
      before: { label: current.label, archived: false },
      after: { label: current.label, archived: true },
    });
    return { customFieldId: current.id };
  },
});

// ---- Filling them in ----

const TABLES = {
  person: people,
  company: companies,
  lead: leads,
  custom_record: customRecords,
} as const;

/** The record, locked, with what the merge and the event need: its values, their stamps, and what it's called. */
async function lockRecord(
  ctx: CommandContext,
  recordType: FieldedRecordType,
  recordId: string,
): Promise<{
  custom: Record<string, unknown>;
  fieldTimes: Record<string, string>;
  name: string;
  recordTypeId: string | null;
}> {
  const ws = ctx.scope.workspaceId!;
  switch (recordType) {
    case 'person': {
      const [p] = await ctx.tx
        .select()
        .from(people)
        .where(and(eq(people.id, recordId), eq(people.workspaceId, ws)))
        .for('update');
      if (!p) throw HfosError.notFound(gone('customer'));
      return { ...p, name: fullName(p.firstName, p.lastName), recordTypeId: null };
    }
    case 'company': {
      const [c] = await ctx.tx
        .select()
        .from(companies)
        .where(and(eq(companies.id, recordId), eq(companies.workspaceId, ws)))
        .for('update');
      if (!c) throw HfosError.notFound(gone('company'));
      return { ...c, recordTypeId: null };
    }
    case 'lead': {
      const [l] = await ctx.tx
        .select()
        .from(leads)
        .where(and(eq(leads.id, recordId), eq(leads.workspaceId, ws)))
        .for('update');
      if (!l) throw HfosError.notFound(gone('lead'));
      return { ...l, name: l.title, recordTypeId: null };
    }
    case 'custom_record': {
      const [r] = await ctx.tx
        .select()
        .from(customRecords)
        .where(and(eq(customRecords.id, recordId), eq(customRecords.workspaceId, ws)))
        .for('update');
      if (!r) throw HfosError.notFound(gone('record'));
      return { ...r, recordTypeId: r.typeId };
    }
  }
}

/**
 * Each value checked against its field, as the record will keep it; null for one being cleared. A field that isn't
 * on this kind of record, or a value that doesn't fit its field, is refused under `values.<field id>`.
 */
export function checkedValues(
  fields: readonly LiveField[],
  values: Readonly<Record<string, unknown>>,
): Map<string, { field: LiveField; value: unknown }> {
  const byId = new Map(fields.map((f) => [f.id, f]));
  const out = new Map<string, { field: LiveField; value: unknown }>();
  const problems: { path: string; message: string }[] = [];
  for (const [id, raw] of Object.entries(values)) {
    const field = byId.get(id);
    if (!field) {
      problems.push({
        path: `values.${id}`,
        message: 'That field isn’t on this record anymore. Refresh and try again.',
      });
      continue;
    }
    const checked = checkCustomValue(field, raw);
    if (!checked.ok) problems.push({ path: `values.${id}`, message: checked.message });
    else out.set(id, { field, value: checked.value });
  }
  if (problems.length) throw HfosError.validation(problems);
  return out;
}

/** The stamp a field's value carries in field_times (0055), beside the columns'. */
const stampKey = (fieldId: string) => `custom.${fieldId}`;

export const recordSetFields = defineCommand({
  name: 'record.set_fields',
  description:
    'Fill in or clear the fields a business invented on a customer, company, lead or record: only the ones edited, each checked against its field, and the newest change to each wins.',
  risk: 1,
  input: RecordSetFieldsInput,
  output: RecordSetFieldsOutput,
  permission: 'records.write',
  scope: inWorkspace,
  emits: ['person.updated', 'company.updated', 'lead.updated', 'custom_record.updated'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const record = await lockRecord(ctx, input.recordType, input.recordId);
    const fields = await liveFields(ctx.tx, ws, input.recordType, record.recordTypeId);
    const checked = checkedValues(fields, input.values);
    const at = changeMoment(ctx.meta);
    const madeNow = !ctx.meta.occurredAt;
    const next: Record<string, unknown> = { ...record.custom };
    const stamps: Record<string, string> = {};
    const updated: string[] = [];
    const notApplied: NotApplied[] = [];
    for (const [id, { field, value }] of checked) {
      const current = record.custom[id] ?? null;
      if (canonicalJson(value) === canonicalJson(current)) continue;
      // Newest wins, as for every other detail (kernel/field-merge): an edit made before a later change it didn't
      // see leaves that change standing.
      const stamp = record.fieldTimes[stampKey(id)];
      const seen = input.base?.[id];
      const asSeen = seen !== undefined && canonicalJson(seen ?? null) === canonicalJson(current);
      if (!madeNow && !asSeen && stamp && Date.parse(stamp) > at.getTime()) {
        notApplied.push({
          key: stampKey(id),
          column: stampKey(id),
          label: field.label,
          kind: 'json',
          wanted: value,
          stays: current,
          staysSince: stamp,
        });
        continue;
      }
      if (value === null) delete next[id];
      else next[id] = value;
      stamps[stampKey(id)] = at.toISOString();
      updated.push(id);
    }
    const on = {
      personId: input.recordType === 'person' ? input.recordId : null,
      companyId: input.recordType === 'company' ? input.recordId : null,
      leadId: input.recordType === 'lead' ? input.recordId : null,
      customRecordId: input.recordType === 'custom_record' ? input.recordId : null,
    };
    await logNotApplied(ctx, notApplied, { type: input.recordType, id: input.recordId }, on);
    const skipped = notApplied.map((n) => n.column.slice('custom.'.length));
    if (!updated.length) return { recordId: input.recordId, updated: [], notApplied: skipped };
    const table = TABLES[input.recordType];
    await ctx.tx
      .update(table)
      .set({
        custom: next,
        fieldTimes: dsql`field_times || ${JSON.stringify(stamps)}::jsonb`,
      })
      .where(eq(table.id, input.recordId));
    // Keyed by the field's own key in the audit log, so a field named like a secret ("Alarm password") is left
    // out of it the way every other credential-looking key is (kernel/redact).
    const byKey = (values: Record<string, unknown>) =>
      Object.fromEntries(
        updated.map((id) => [`custom.${checked.get(id)!.field.key}`, values[id] ?? null]),
      );
    await ctx.emit({
      type: `${input.recordType}.updated`,
      entityType: input.recordType,
      entityId: input.recordId,
      payload: { name: record.name, fields: updated.map(stampKey) },
      before: { name: record.name, ...byKey(record.custom) },
      after: { name: record.name, ...byKey(next) },
      broadcast: true,
    });
    return { recordId: input.recordId, updated, notApplied: skipped };
  },
});

export const customFieldCommands = [
  customFieldCreate,
  customFieldUpdate,
  customFieldArchive,
  recordSetFields,
] as const;
