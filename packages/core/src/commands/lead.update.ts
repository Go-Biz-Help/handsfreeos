import { and, eq } from 'drizzle-orm';
import { leads } from '@hfos/db/schema';
import { assertAiReach } from '../ai-team/reach';
import { logSystemActivity } from '../crm/activities';
import { requireCompany, requirePerson, userRef } from '../crm/records';
import { HfosError } from '../errors';
import { defineCommand } from '../kernel/define';
import { LeadUpdateInput, LeadUpdateOutput } from '../schemas/lead';

export const leadUpdate = defineCommand({
  name: 'lead.update',
  description:
    'Change a lead’s title, value, source, people, expected close date, assignee or next action.',
  risk: 1,
  input: LeadUpdateInput,
  output: LeadUpdateOutput,
  permission: 'records.write',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  emits: ['lead.updated', 'lead.assigned'],
  actors: ['human', 'workflow', 'ai_employee'],
  async handler(ctx, input) {
    const workspaceId = ctx.scope.workspaceId!;
    // The AI teammate changes only the next action on its own customer's lead.
    if (ctx.actor.type === 'ai_employee') {
      const other = (
        [
          'title',
          'personId',
          'companyId',
          'valueCents',
          'source',
          'assigneeUserId',
          'expectedCloseOn',
        ] as const
      ).filter((k) => input[k] !== undefined);
      if (other.length)
        throw HfosError.validation(
          other.map((path) => ({
            path,
            message: 'The AI teammate only changes a lead’s next action.',
          })),
        );
      await assertAiReach(ctx, { leadId: input.leadId });
    }
    const [current] = await ctx.tx
      .select()
      .from(leads)
      .where(and(eq(leads.id, input.leadId), eq(leads.workspaceId, workspaceId)));
    if (!current) throw HfosError.notFound('Lead not found.');
    if (input.personId) await requirePerson(ctx.tx, workspaceId, input.personId);
    if (input.companyId) await requireCompany(ctx.tx, workspaceId, input.companyId);
    const nextPerson = input.personId !== undefined ? input.personId : current.personId;
    const nextCompany = input.companyId !== undefined ? input.companyId : current.companyId;
    if (!nextPerson && !nextCompany)
      throw HfosError.validation([
        { path: 'personId', message: 'A lead needs a person or a company.' },
      ]);
    const patch: Record<string, unknown> = {};
    const set = (key: keyof typeof current, value: unknown) => {
      if (value !== undefined && value !== current[key]) patch[key] = value;
    };
    set('title', input.title);
    set('personId', input.personId);
    set('companyId', input.companyId);
    set('valueCents', input.valueCents);
    set('source', input.source);
    set('assigneeUserId', input.assigneeUserId);
    set('expectedCloseOn', input.expectedCloseOn);
    set('nextAction', input.nextAction);
    if (input.nextActionAt !== undefined) {
      const at = input.nextActionAt ? new Date(input.nextActionAt) : null;
      if ((at?.getTime() ?? null) !== (current.nextActionAt?.getTime() ?? null))
        patch.nextActionAt = at;
    }
    const updated = Object.keys(patch);
    if (updated.length === 0) return { leadId: current.id, updated: [] };
    await ctx.tx.update(leads).set(patch).where(eq(leads.id, current.id));
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    for (const k of updated) {
      before[k] = (current as Record<string, unknown>)[k];
      after[k] = patch[k];
    }
    const title = (patch.title as string | undefined) ?? current.title;
    await ctx.emit({
      type: 'lead.updated',
      entityType: 'lead',
      entityId: current.id,
      payload: { title, fields: updated },
      before: { title: current.title, ...before },
      after: { title, ...after },
    });
    if ('assigneeUserId' in patch) {
      const assignee = await userRef(ctx.tx, patch.assigneeUserId as string | null);
      const eventId = await ctx.emit({
        type: 'lead.assigned',
        entityType: 'lead',
        entityId: current.id,
        payload: {
          title,
          assigneeUserId: patch.assigneeUserId ?? null,
          assigneeName: assignee?.fullName ?? null,
        },
        before: { assigneeUserId: current.assigneeUserId },
        after: {
          assigneeUserId: patch.assigneeUserId ?? null,
          assigneeName: assignee?.fullName ?? null,
        },
      });
      await logSystemActivity(ctx, {
        subtype: 'assigned',
        leadId: current.id,
        personId: nextPerson,
        companyId: nextCompany,
        body: assignee ? `Assigned to ${assignee.fullName}` : 'Unassigned',
        meta: { assigneeUserId: patch.assigneeUserId ?? null },
        eventId,
      });
    }
    return { leadId: current.id, updated };
  },
});
