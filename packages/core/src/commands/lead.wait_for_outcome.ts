/**
 * A deal a person marks won or lost themselves (20261027015700): Automations' "Move deals along for you" never takes
 * its done visit for a win, though a quote accepted still counts. Social Outreach's leads from a demo ask for it (its
 * decision 106): after the demo, the lead moves on and waits for the person to say how it went.
 */
import { and, eq } from 'drizzle-orm';
import { leads } from '@hfos/db/schema';
import { HfosError } from '../errors';
import { defineCommand } from '../kernel/define';
import { LeadWaitForOutcomeInput, LeadWaitForOutcomeOutput } from '../schemas/lead';

export const leadWaitForOutcome = defineCommand({
  name: 'lead.wait_for_outcome',
  description:
    'HandsFreeOS: a person marks this deal won or lost themselves, so a done visit never wins it on its own.',
  risk: 1,
  input: LeadWaitForOutcomeInput,
  output: LeadWaitForOutcomeOutput,
  permission: 'records.write',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  emits: [],
  actors: ['system'],
  async handler(ctx, input) {
    const [row] = await ctx.tx
      .update(leads)
      .set({ wonByHand: input.waits })
      .where(and(eq(leads.id, input.leadId), eq(leads.workspaceId, ctx.scope.workspaceId!)))
      .returning({ id: leads.id });
    if (!row)
      throw HfosError.notFound(
        'That lead isn’t there anymore. It may have been deleted. Refresh and try again.',
      );
    return { leadId: row.id, waits: input.waits };
  },
});
