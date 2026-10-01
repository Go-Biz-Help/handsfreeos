import { and, eq } from 'drizzle-orm';
import { activities, leads } from '@hfos/db/schema';
import { assertAiReach } from '../ai-team/reach';
import { actorMeta } from '../crm/activities';
import { insertWithId, madeBefore } from '../crm/client-ids';
import { requireCompany, requirePerson } from '../crm/records';
import { HfosError } from '../errors';
import { storedActorType, userIdOf } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import { changeMoment } from '../kernel/moment';
import { requireCustomRecord } from '../relationships/store';
import {
  ActivityDeleteInput,
  ActivityDeleteOutput,
  ActivityLogInput,
  ActivityLogOutput,
  ActivityUpdateInput,
  ActivityUpdateOutput,
} from '../schemas/activity';

export const activityLog = defineCommand({
  name: 'activity.log',
  description:
    'Log a note, call or visit on a person, company or lead, or on a record like a pet, vehicle or property.',
  risk: 1,
  input: ActivityLogInput,
  output: ActivityLogOutput,
  permission: 'records.write',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  emits: ['activity.logged'],
  actors: ['human', 'workflow', 'ai_employee'],
  offline: 'anytime',
  async handler(ctx, input) {
    const workspaceId = ctx.scope.workspaceId!;
    // The AI teammate adds notes to its own customer's timeline, nothing else.
    if (ctx.actor.type === 'ai_employee') {
      if (input.kind !== 'note')
        throw HfosError.validation(
          [{ path: 'kind', message: 'The AI teammate can only add notes. Log this as a note.' }],
          'The AI teammate can only add notes to a timeline. Log this as a note instead.',
        );
      await assertAiReach(ctx, input);
    }
    const earlier = await madeBefore(ctx.tx, 'activities', input.id, workspaceId);
    if (earlier) return { activityId: earlier.id };
    if (input.personId) await requirePerson(ctx.tx, workspaceId, input.personId);
    if (input.companyId) await requireCompany(ctx.tx, workspaceId, input.companyId);
    if (input.leadId) {
      const [lead] = await ctx.tx
        .select({ id: leads.id })
        .from(leads)
        .where(and(eq(leads.id, input.leadId), eq(leads.workspaceId, workspaceId)));
      if (!lead)
        throw HfosError.notFound(
          'That lead isn’t there anymore. It may have been deleted. Refresh and try again.',
        );
    }
    if (input.customRecordId) await requireCustomRecord(ctx.tx, workspaceId, input.customRecordId);
    const [row] = await insertWithId('activities', input.id, () =>
      ctx.tx
        .insert(activities)
        .values({
          ...(input.id ? { id: input.id } : {}),
          workspaceId,
          kind: input.kind,
          body: input.body,
          // A note taken on the phone happened when it was written, not when the phone found signal.
          occurredAt: input.occurredAt ? new Date(input.occurredAt) : changeMoment(ctx.meta),
          personId: input.personId ?? null,
          companyId: input.companyId ?? null,
          leadId: input.leadId ?? null,
          customRecordId: input.customRecordId ?? null,
          authorUserId: userIdOf(ctx.actor),
          actorType: storedActorType(ctx.actor),
          meta: actorMeta(ctx.actor),
        })
        .returning({ id: activities.id }),
    );
    if (!row) throw HfosError.forbidden();
    await ctx.emit({
      type: 'activity.logged',
      entityType: 'activity',
      entityId: row.id,
      payload: {
        kind: input.kind,
        personId: input.personId ?? null,
        companyId: input.companyId ?? null,
        leadId: input.leadId ?? null,
        customRecordId: input.customRecordId ?? null,
      },
      after: { kind: input.kind, body: input.body.slice(0, 200) },
      broadcast: true,
    });
    return { activityId: row.id };
  },
});

export const activityUpdate = defineCommand({
  name: 'activity.update',
  description: 'Edit a note, call or visit you logged.',
  risk: 1,
  input: ActivityUpdateInput,
  output: ActivityUpdateOutput,
  permission: 'records.write',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  emits: ['activity.updated'],
  async handler(ctx, input) {
    const [current] = await ctx.tx
      .select()
      .from(activities)
      .where(
        and(
          eq(activities.id, input.activityId),
          eq(activities.workspaceId, ctx.scope.workspaceId!),
        ),
      );
    if (!current)
      throw HfosError.notFound(
        'That timeline entry isn’t there anymore. It may have been deleted. Refresh and try again.',
      );
    if (current.kind === 'system')
      throw HfosError.forbidden(
        'HandsFreeOS added this entry on its own, so it can’t be edited. Add a note of your own instead.',
      );
    const patch: { body?: string; occurredAt?: Date } = {};
    if (input.body !== undefined && input.body !== current.body) patch.body = input.body;
    if (
      input.occurredAt !== undefined &&
      new Date(input.occurredAt).getTime() !== current.occurredAt.getTime()
    )
      patch.occurredAt = new Date(input.occurredAt);
    const updated = Object.keys(patch);
    if (updated.length === 0) return { activityId: current.id, updated: [] };
    const rows = await ctx.tx
      .update(activities)
      .set(patch)
      .where(eq(activities.id, current.id))
      .returning({ id: activities.id });
    if (rows.length === 0)
      throw HfosError.forbidden(
        'Only the person who logged this entry can edit it. Ask them to change it, or add a note of your own.',
      );
    await ctx.emit({
      type: 'activity.updated',
      entityType: 'activity',
      entityId: current.id,
      payload: { kind: current.kind, fields: updated },
      before: { body: current.body?.slice(0, 200) },
      after: { body: (patch.body ?? current.body)?.slice(0, 200) },
    });
    return { activityId: current.id, updated };
  },
});

export const activityDelete = defineCommand({
  name: 'activity.delete',
  description: 'Delete a note, call or visit (yours, or any as an owner or admin).',
  risk: 2,
  input: ActivityDeleteInput,
  output: ActivityDeleteOutput,
  permission: 'records.write',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  emits: ['activity.deleted'],
  async handler(ctx, input) {
    const [current] = await ctx.tx
      .select()
      .from(activities)
      .where(
        and(
          eq(activities.id, input.activityId),
          eq(activities.workspaceId, ctx.scope.workspaceId!),
        ),
      );
    if (!current)
      throw HfosError.notFound(
        'That timeline entry isn’t there anymore. It may have been deleted. Refresh and try again.',
      );
    if (current.kind === 'system')
      throw HfosError.forbidden(
        'HandsFreeOS added this entry on its own, so it can’t be deleted. It keeps a record of what happened.',
      );
    const rows = await ctx.tx
      .delete(activities)
      .where(eq(activities.id, current.id))
      .returning({ id: activities.id });
    if (rows.length === 0)
      throw HfosError.forbidden(
        'Only the person who logged this entry, or an owner or admin of this business, can delete it. Ask one of them.',
      );
    await ctx.emit({
      type: 'activity.deleted',
      entityType: 'activity',
      entityId: current.id,
      payload: { kind: current.kind },
      before: { kind: current.kind, body: current.body?.slice(0, 200) },
      after: null,
    });
    return { activityId: current.id };
  },
});
