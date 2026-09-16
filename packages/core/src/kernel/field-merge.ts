/**
 * Newest wins, one detail at a time (M10, 0055). Two people can edit the same customer with no signal, so the
 * update commands for people, companies, leads, tasks and appointments merge each edited detail on its own:
 * - an edit sends only the details it changed, each with the value the person saw (`base`);
 * - the row is locked, and a detail still as the person saw it takes the edit;
 * - a detail someone changed since takes the edit only if the edit was made later: `field_times` holds, per
 *   column, the moment its value was really made (a phone's moment, corrected for its clock), and a column never
 *   stamped can't be compared, so the edit applies;
 * - every detail that changes is stamped with the edit's moment, and an edit a later change beat is written on
 *   the record's timeline with both values, and whose change stayed when that can be told.
 * An edit without a moment of its own (the web, the Assistant, a workflow, the AI teammate) is made now: it always
 * applies, and stamps what it changes too.
 */
import { and, desc, eq, getTableColumns, sql } from 'drizzle-orm';
import type { Tx } from '@hfos/db/client';
import { events } from '@hfos/db/schema';
import { logSystemActivity } from '../crm/activities';
import { formatPhone, normalizePhone } from '../crm/phone';
import { userRef } from '../crm/records';
import { canonicalJson } from './receipts';
import type { CommandContext, RequestMeta } from './types';

/** How a detail's values are compared. */
export type MergeKind =
  'text' | 'email' | 'phone' | 'id' | 'number' | 'date' | 'time' | 'flag' | 'json';

export interface MergeField {
  /** The detail as the input names it ('phone', 'address.city'): its key in `base`, and on the timeline. */
  readonly key: string;
  /** The column it writes: the table's property name ('phoneE164'). */
  readonly column: string;
  /** The new value as the input schema left it; undefined when the edit doesn't touch this detail. */
  readonly value: unknown;
  /** What the person saw; undefined when the edit didn't say. */
  readonly base: unknown;
  readonly kind: MergeKind;
  /** Plain words for the timeline ("phone number"). */
  readonly label: string;
  /** Other columns written with it when it applies (the formatted number beside the E.164 one). */
  readonly also?: Readonly<Record<string, unknown>>;
}

/** An edit that didn't apply, because the detail changed later than it was made. */
export interface NotApplied {
  readonly key: string;
  readonly column: string;
  readonly label: string;
  readonly kind: MergeKind;
  /** What the edit wanted. */
  readonly wanted: unknown;
  /** What stays. */
  readonly stays: unknown;
  /** When the value that stays was made. */
  readonly staysSince: string;
}

export interface Merged {
  /** What to set on the row: the details that apply, their companions, and `fieldTimes` when anything applies. */
  readonly patch: Record<string, unknown>;
  /** The details that change, by column property name, in the order given. */
  readonly applied: readonly string[];
  readonly notApplied: readonly NotApplied[];
}

/** When an edit was made: the phone's corrected moment, or now. */
export const editMoment = (meta: RequestMeta): Date => meta.occurredAt ?? new Date();

function comparable(kind: MergeKind, v: unknown): string | number | boolean | null {
  if (v === undefined || v === null) return null;
  switch (kind) {
    case 'text': {
      const s = String(v).trim();
      return s || null;
    }
    case 'email': {
      const s = String(v).trim().toLowerCase();
      return s || null;
    }
    case 'phone': {
      const s = String(v).trim();
      return s ? (normalizePhone(s) ?? s) : null;
    }
    case 'id':
      return String(v).toLowerCase();
    case 'number':
      return Number(v);
    case 'date':
      return String(v).slice(0, 10);
    case 'time': {
      const ms = v instanceof Date ? v.getTime() : Date.parse(String(v));
      return Number.isNaN(ms) ? String(v) : ms;
    }
    case 'flag':
      return Boolean(v);
    case 'json':
      return canonicalJson(v);
  }
}

const same = (kind: MergeKind, a: unknown, b: unknown): boolean =>
  comparable(kind, a) === comparable(kind, b);

/**
 * Merges an edit into a locked row. `columns` is the table's (getTableColumns), which names each stamp's key;
 * `meta` says when the edit was made.
 */
export function mergeFields(
  row: Readonly<Record<string, unknown>> & {
    readonly fieldTimes: Readonly<Record<string, string>>;
  },
  fields: readonly MergeField[],
  columns: Readonly<Record<string, { readonly name: string }>>,
  meta: RequestMeta,
): Merged {
  const at = editMoment(meta);
  const madeNow = !meta.occurredAt;
  const patch: Record<string, unknown> = {};
  const stamps: Record<string, string> = {};
  const applied: string[] = [];
  const notApplied: NotApplied[] = [];
  for (const f of fields) {
    if (f.value === undefined) continue;
    const current = row[f.column];
    // Already so: nothing changes, and nothing is stamped.
    if (same(f.kind, f.value, current)) continue;
    const name = columns[f.column]?.name ?? f.column;
    const stamp = row.fieldTimes[name];
    const asSeen = f.base !== undefined && same(f.kind, f.base, current);
    if (!madeNow && !asSeen && stamp && Date.parse(stamp) > at.getTime()) {
      notApplied.push({
        key: f.key,
        column: f.column,
        label: f.label,
        kind: f.kind,
        wanted: f.value,
        stays: current,
        staysSince: stamp,
      });
      continue;
    }
    patch[f.column] = f.value;
    Object.assign(patch, f.also ?? {});
    stamps[name] = at.toISOString();
    applied.push(f.column);
  }
  if (applied.length) patch.fieldTimes = { ...row.fieldTimes, ...stamps };
  return { patch, applied, notApplied };
}

/** `getTableColumns`, typed for mergeFields. */
export const mergeColumns = (table: Parameters<typeof getTableColumns>[0]) =>
  getTableColumns(table) as Readonly<Record<string, { readonly name: string }>>;

/** Stamps columns a command changed outside an update (a next action set on its own): `field_times || {…}`. */
export const stampSql = (columnNames: readonly string[], at: Date) =>
  sql`field_times || ${JSON.stringify(Object.fromEntries(columnNames.map((c) => [c, at.toISOString()])))}::jsonb`;

/** A value as the timeline shows it, when it has words at all (names, notes, numbers and addresses do). */
function shown(kind: MergeKind, v: unknown): string | null {
  if (v === undefined || v === null || v === '') return '';
  if (kind === 'phone') return formatPhone(String(v)) || String(v);
  if (kind !== 'text' && kind !== 'email') return null;
  const s = String(v).replace(/\s+/g, ' ').trim();
  return s.length > 80 ? `${s.slice(0, 79)}…` : s;
}

/**
 * Who made the change that stays, when this person may see it: the latest event on the record naming the detail
 * (an update lists it in `fields`; a next action set on its own carries it), made no earlier than its stamp. A
 * member reads only their own events, so an older one of theirs is never taken for someone else's.
 */
async function whoChanged(
  tx: Tx,
  entity: { readonly type: string; readonly id: string },
  column: string,
  since: string,
): Promise<string | null> {
  const [e] = await tx
    .select({ actorType: events.actorType, actorId: events.actorId })
    .from(events)
    .where(
      and(
        eq(events.entityType, entity.type),
        eq(events.entityId, entity.id),
        sql`(${events.payload}->'fields' ? ${column} or ${events.payload} ? ${column})`,
        sql`coalesce(${events.occurredAt}, ${events.createdAt}) >= ${new Date(Date.parse(since) - 5_000).toISOString()}::timestamptz`,
      ),
    )
    .orderBy(desc(sql`coalesce(${events.occurredAt}, ${events.createdAt})`))
    .limit(1);
  if (!e || e.actorType !== 'human') return null;
  return (await userRef(tx, e.actorId))?.fullName ?? null;
}

/**
 * The timeline entries for edits a later change beat: one per detail, on the record's customer, company or lead,
 * saying what the edit wanted, what stays and (when it can be told) whose change that was.
 */
export async function logNotApplied(
  ctx: CommandContext,
  notApplied: readonly NotApplied[],
  entity: {
    readonly type: 'person' | 'company' | 'lead' | 'task' | 'appointment';
    readonly id: string;
  },
  on: {
    readonly personId?: string | null;
    readonly companyId?: string | null;
    readonly leadId?: string | null;
  },
): Promise<void> {
  if (!notApplied.length || (!on.personId && !on.companyId && !on.leadId)) return;
  for (const n of notApplied) {
    const by = await whoChanged(ctx.tx, entity, n.column, n.staysSince);
    const wanted = shown(n.kind, n.wanted);
    const stays = shown(n.kind, n.stays);
    const later = by ? `${by}’s later change` : 'a later change';
    const Label = n.label.charAt(0).toUpperCase() + n.label.slice(1);
    const body =
      wanted === null || stays === null
        ? `${Label} wasn’t changed: ${later} was kept.`
        : `${Label} wasn’t ${wanted ? `changed to “${wanted}”` : 'cleared'}: ${later}${stays ? ` to “${stays}”` : ', which cleared it,'} was kept.`;
    await logSystemActivity(ctx, {
      subtype: 'edit_not_applied',
      personId: on.personId ?? null,
      companyId: on.companyId ?? null,
      leadId: on.leadId ?? null,
      body,
      meta: {
        entityType: entity.type,
        entityId: entity.id,
        field: n.key,
        label: n.label,
        wanted,
        stays,
        staysSince: n.staysSince,
        keptBy: by,
        madeAt: editMoment(ctx.meta).toISOString(),
      },
    });
  }
}
