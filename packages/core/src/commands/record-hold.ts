/**
 * Legal holds (Real Estate round six, 20261022000200): an owner or admin (records.hold) keeps a record's files and
 * history exactly as they are, with a reason, until someone lifts the hold, with a reason. While it's on, nobody
 * deletes or renames its files or changes its timeline; new ones can be added. The business can't be deleted, and
 * nor can the data of the add-on whose record it is. Each is an event, an audit line and a line on the record.
 *
 * Retention holds are the add-on's own (its worker, through private.set_retention_hold), never a person's.
 */
import { rows, sql } from '@hfos/db/client';
import { logSystemActivity } from '../crm/activities';
import { HfosError } from '../errors';
import { intlTimeZone } from '../intl/engine-zones';
import { defineCommand } from '../kernel/define';
import type { CommandContext } from '../kernel/types';
import { userIdOf } from '../kernel/actor';
import {
  RecordHoldLiftInput,
  RecordHoldLiftOutput,
  RecordHoldOutput,
  RecordHoldPlaceInput,
} from '../schemas/record-hold';

const when = (d: Date | string) =>
  new Date(d).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: intlTimeZone('UTC'),
  });

async function nameOf(ctx: CommandContext, userId: string | null): Promise<string> {
  if (!userId) return 'Someone';
  const [u] = await rows<{ name: string }>(
    ctx.tx,
    sql`select coalesce(nullif(full_name, ''), email::text) as name from app.users where id = ${userId}::uuid`,
  );
  return u?.name ?? 'Someone';
}

export const recordHoldPlace = defineCommand({
  name: 'record_hold.place',
  description:
    'Put a record on legal hold, with a reason: its files and history stay exactly as they are until the hold is lifted. New ones can still be added. Owners and admins.',
  risk: 2,
  input: RecordHoldPlaceInput,
  output: RecordHoldOutput,
  permission: 'records.hold',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  emits: ['record_hold.placed'],
  async handler(ctx, input) {
    const [record] = await rows<{ id: string; name: string }>(
      ctx.tx,
      sql`select id, name from app.custom_records
          where id = ${input.customRecordId}::uuid and workspace_id = ${input.workspaceId}::uuid`,
    );
    if (!record)
      throw HfosError.notFound(
        'That record isn’t there anymore, or you’re not on it. Refresh and try again.',
      );
    const [already] = await rows<{ placed_at: Date | string; placed_by: string | null }>(
      ctx.tx,
      sql`select placed_at, placed_by from app.record_holds
          where custom_record_id = ${record.id}::uuid and kind = 'legal' and lifted_at is null`,
    );
    if (already)
      throw HfosError.rule(
        'record_already_held',
        409,
        `${record.name} has been on legal hold since ${when(already.placed_at)}, placed by ${await nameOf(ctx, already.placed_by)}. Nothing more to do.`,
      );
    const placedBy = userIdOf(ctx.actor);
    const [hold] = await rows<{ id: string; placed_at: Date | string }>(
      ctx.tx,
      sql`insert into app.record_holds (workspace_id, custom_record_id, kind, reason, placed_by)
          values (${input.workspaceId}::uuid, ${record.id}::uuid, 'legal', ${input.reason}, ${placedBy}::uuid)
          returning id, placed_at`,
    );
    if (!hold) throw HfosError.forbidden();
    const eventId = await ctx.emit({
      type: 'record_hold.placed',
      entityType: 'custom_record',
      entityId: record.id,
      payload: { holdId: hold.id, name: record.name, reason: input.reason },
      before: { name: record.name, legalHold: 'none' },
      after: { name: record.name, legalHold: input.reason },
    });
    await logSystemActivity(ctx, {
      subtype: 'legal_hold_placed',
      customRecordId: record.id,
      body: input.reason,
      eventId,
    });
    return {
      hold: {
        id: hold.id,
        customRecordId: record.id,
        recordName: record.name,
        kind: 'legal' as const,
        heldUntil: null,
        reason: input.reason,
        placedBy: placedBy ? { id: placedBy, fullName: await nameOf(ctx, placedBy) } : null,
        placedAt: new Date(hold.placed_at).toISOString(),
      },
    };
  },
});

export const recordHoldLift = defineCommand({
  name: 'record_hold.lift',
  description:
    'Lift a legal hold, with a reason kept on the record: its files and history can be changed and deleted again. Owners and admins.',
  risk: 3,
  input: RecordHoldLiftInput,
  output: RecordHoldLiftOutput,
  permission: 'records.hold',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  emits: ['record_hold.lifted'],
  async handler(ctx, input) {
    const [hold] = await rows<{
      id: string;
      custom_record_id: string;
      kind: 'legal' | 'retention';
      lifted_at: string | null;
      reason: string | null;
      name: string;
    }>(
      ctx.tx,
      sql`select h.id, h.custom_record_id, h.kind, h.lifted_at, h.reason, r.name
          from app.record_holds h join app.custom_records r on r.id = h.custom_record_id
          where h.id = ${input.holdId}::uuid and h.workspace_id = ${input.workspaceId}::uuid
          for update of h`,
    );
    if (!hold)
      throw HfosError.notFound('That hold isn’t there anymore. Refresh to see the record’s holds.');
    if (hold.kind !== 'legal')
      throw HfosError.rule(
        'record_hold_is_retention',
        409,
        `${hold.name} is kept for the years your business keeps closed records, which nobody lifts by hand. Change how long in the add-on’s settings.`,
      );
    if (hold.lifted_at)
      throw HfosError.rule(
        'record_hold_lifted',
        409,
        `The legal hold on ${hold.name} was already lifted. Nothing more to do.`,
      );
    const liftedBy = userIdOf(ctx.actor);
    const [lifted] = await rows<{ lifted_at: Date | string }>(
      ctx.tx,
      sql`update app.record_holds
          set lifted_at = now(), lifted_by = ${liftedBy}::uuid, lift_reason = ${input.reason}
          where id = ${hold.id}::uuid returning lifted_at`,
    );
    if (!lifted) throw HfosError.forbidden();
    const eventId = await ctx.emit({
      type: 'record_hold.lifted',
      entityType: 'custom_record',
      entityId: hold.custom_record_id,
      payload: { holdId: hold.id, name: hold.name, reason: input.reason },
      before: { name: hold.name, legalHold: hold.reason },
      after: { name: hold.name, legalHold: 'none' },
    });
    await logSystemActivity(ctx, {
      subtype: 'legal_hold_lifted',
      customRecordId: hold.custom_record_id,
      body: input.reason,
      eventId,
    });
    return { holdId: hold.id, liftedAt: new Date(lifted.lifted_at).toISOString() };
  },
});

export const recordHoldCommands = [recordHoldPlace, recordHoldLift];
