import { and, eq } from 'drizzle-orm';
import { leads } from '@hfos/db/schema';
import { logSystemActivity } from '../crm/activities';
import { HfosError } from '../errors';
import { defineCommand } from '../kernel/define';
import { LeadSetNextActionInput, LeadSetNextActionOutput } from '../schemas/lead';

export const leadSetNextAction = defineCommand({
  name: 'lead.set_next_action',
  description: 'Set or clear the one thing to do next on a lead, and when.',
  risk: 1,
  input: LeadSetNextActionInput,
  output: LeadSetNextActionOutput,
  permission: 'records.write',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  emits: ['lead.next_action_set', 'lead.next_action_cleared'],
  async handler(ctx, input) {
    const [current] = await ctx.tx
      .select()
      .from(leads)
      .where(and(eq(leads.id, input.leadId), eq(leads.workspaceId, ctx.scope.workspaceId!)));
    if (!current) throw HfosError.notFound('Lead not found.');
    const nextAction = input.text;
    const nextActionAt = nextAction ? (input.dueAt ? new Date(input.dueAt) : null) : null;
    await ctx.tx.update(leads).set({ nextAction, nextActionAt }).where(eq(leads.id, current.id));
    const cleared = !nextAction;
    const eventId = await ctx.emit({
      type: cleared ? 'lead.next_action_cleared' : 'lead.next_action_set',
      entityType: 'lead',
      entityId: current.id,
      payload: {
        title: current.title,
        nextAction,
        nextActionAt: nextActionAt?.toISOString() ?? null,
      },
      before: {
        nextAction: current.nextAction,
        nextActionAt: current.nextActionAt?.toISOString() ?? null,
      },
      after: { nextAction, nextActionAt: nextActionAt?.toISOString() ?? null },
    });
    if (!cleared) {
      await logSystemActivity(ctx, {
        subtype: 'next_action',
        leadId: current.id,
        personId: current.personId,
        companyId: current.companyId,
        body: nextAction,
        meta: { dueAt: nextActionAt?.toISOString() ?? null, title: current.title },
        eventId,
      });
    }
    return { leadId: current.id, nextAction, nextActionAt: nextActionAt?.toISOString() ?? null };
  },
});
