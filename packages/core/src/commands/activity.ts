import { and, eq } from 'drizzle-orm';
import { activities, leads } from '@hfos/db/schema';
import { actorMeta } from '../crm/activities';
import { requireCompany, requirePerson } from '../crm/records';
import { HfosError } from '../errors';
import { userIdOf } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
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
  description: 'Log a note, call or visit on a person, company or lead.',
  risk: 1,
  input: ActivityLogInput,
  output: ActivityLogOutput,
  permission: 'records.write',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  emits: ['activity.logged'],
  actors: ['human', 'workflow'],
  async handler(ctx, input) {
    const workspaceId = ctx.scope.workspaceId!;
    if (input.personId) await requirePerson(ctx.tx, workspaceId, input.personId);
    if (input.companyId) await requireCompany(ctx.tx, workspaceId, input.companyId);
    if (input.leadId) {
      const [lead] = await ctx.tx
        .select({ id: leads.id })
        .from(leads)
        .where(and(eq(leads.id, input.leadId), eq(leads.workspaceId, workspaceId)));
      if (!lead) throw HfosError.notFound('Lead not found.');
    }
    const [row] = await ctx.tx
      .insert(activities)
      .values({
        workspaceId,
        kind: input.kind,
        body: input.body,
        occurredAt: input.occurredAt ? new Date(input.occurredAt) : new Date(),
        personId: input.personId ?? null,
        companyId: input.companyId ?? null,
        leadId: input.leadId ?? null,
        authorUserId: userIdOf(ctx.actor),
        actorType: ctx.actor.type,
        meta: actorMeta(ctx.actor),
      })
      .returning({ id: activities.id });
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
    if (!current) throw HfosError.notFound('Activity not found.');
    if (current.kind === 'system')
      throw HfosError.forbidden('System timeline entries cannot be changed.');
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
    if (rows.length === 0) throw HfosError.forbidden('Only the author can edit this entry.');
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
    if (!current) throw HfosError.notFound('Activity not found.');
    if (current.kind === 'system')
      throw HfosError.forbidden('System timeline entries cannot be deleted.');
    const rows = await ctx.tx
      .delete(activities)
      .where(eq(activities.id, current.id))
      .returning({ id: activities.id });
    if (rows.length === 0)
      throw HfosError.forbidden('Only the author, or an owner or admin, can delete this entry.');
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
