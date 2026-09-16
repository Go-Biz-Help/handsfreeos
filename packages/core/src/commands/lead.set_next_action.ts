import { and, eq } from 'drizzle-orm';
import { leads } from '@hfos/db/schema';
import { assertAiReach } from '../ai-team/reach';
import { logSystemActivity } from '../crm/activities';
import { HfosError } from '../errors';
import { defineCommand } from '../kernel/define';
import { logNotApplied, mergeColumns, mergeFields } from '../kernel/field-merge';
import { LeadSetNextActionInput, LeadSetNextActionOutput } from '../schemas/lead';

export const leadSetNextAction = defineCommand({
  name: 'lead.set_next_action',
  description:
    'Set or clear the one thing to do next on a lead, and when. One set later than this (from the phone, say) stays.',
  risk: 1,
  input: LeadSetNextActionInput,
  output: LeadSetNextActionOutput,
  permission: 'records.write',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  emits: ['lead.next_action_set', 'lead.next_action_cleared'],
  actors: ['human', 'workflow', 'ai_employee'],
  offline: 'anytime',
  async handler(ctx, input) {
    await assertAiReach(ctx, { leadId: input.leadId });
    const [current] = await ctx.tx
      .select()
      .from(leads)
      .where(and(eq(leads.id, input.leadId), eq(leads.workspaceId, ctx.scope.workspaceId!)))
      .for('update');
    if (!current) throw HfosError.notFound('Lead not found.');
    const nextAction = input.text;
    const nextActionAt = nextAction ? (input.dueAt ? new Date(input.dueAt) : null) : null;
    // The next action and its time go together: a later change to either keeps both as they are.
    const merged = mergeFields(
      current,
      [
        {
          key: 'nextAction',
          column: 'nextAction',
          value: nextAction,
          base: undefined,
          kind: 'text',
          label: 'next action',
        },
        {
          key: 'nextActionAt',
          column: 'nextActionAt',
          value: nextActionAt,
          base: undefined,
          kind: 'time',
          label: 'next action time',
        },
      ],
      mergeColumns(leads),
      ctx.meta,
    );
    if (merged.notApplied.length) {
      await logNotApplied(
        ctx,
        merged.notApplied,
        { type: 'lead', id: current.id },
        { leadId: current.id, personId: current.personId, companyId: current.companyId },
      );
      return {
        leadId: current.id,
        nextAction: current.nextAction,
        nextActionAt: current.nextActionAt?.toISOString() ?? null,
      };
    }
    await ctx.tx
      .update(leads)
      .set({
        nextAction,
        nextActionAt,
        ...(merged.applied.length
          ? { fieldTimes: merged.patch.fieldTimes as Record<string, string> }
          : {}),
      })
      .where(eq(leads.id, current.id));
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
