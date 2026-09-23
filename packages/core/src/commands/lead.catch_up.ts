/**
 * The "Deal in the wrong stage" card's one press: the deal moves to the stage what happened to it says (a quote
 * out, a visit booked, a yes), as the person who pressed it. The same rule as Automations' own moves, so it only
 * ever moves a deal forward.
 */
import { eq } from 'drizzle-orm';
import { workspaces } from '@hfos/db/schema';
import { dealFacts } from '../automations/pipeline-load';
import { dealMoveOf } from '../automations/pipeline-roles';
import { automationSettingsOf } from '../automations/settings';
import { HfosError } from '../errors';
import { requireHuman } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import { executeCommandWithin } from '../kernel/execute';
import { LeadCatchUpInput, LeadCatchUpOutput } from '../schemas/lead';
import { leadMoveStage } from './lead.move_stage';

export const leadCatchUp = defineCommand({
  name: 'lead.catch_up',
  description:
    'Move a deal to the stage that matches what happened to it (a quote sent, a visit booked, a quote accepted or a job done). Forward only.',
  risk: 1,
  input: LeadCatchUpInput,
  output: LeadCatchUpOutput,
  permission: 'records.write',
  scope: (i) => ({ kind: 'workspace' as const, workspaceId: i.workspaceId }),
  emits: [],
  async handler(ctx, input) {
    requireHuman(ctx);
    const ws = ctx.scope.workspaceId!;
    const [deal] = await dealFacts(ctx.tx, ws, { leadIds: [input.leadId] });
    if (!deal) throw HfosError.rule('lead_not_open', 409, 'This deal is closed or archived.');
    const [w] = await ctx.tx
      .select({ settings: workspaces.settings })
      .from(workspaces)
      .where(eq(workspaces.id, ws));
    const roles = automationSettingsOf(w?.settings as Record<string, unknown> | null).pipeline
      .roles;
    const move = dealMoveOf(deal, deal.stages, roles, deal.evidence);
    if (!move) throw HfosError.rule('already_there', 409, 'This deal is already where it belongs.');
    await executeCommandWithin(ctx, leadMoveStage, {
      workspaceId: ws,
      leadId: deal.leadId,
      stageId: move.stage.id,
    });
    return { leadId: deal.leadId, stageId: move.stage.id, stageName: move.stage.name };
  },
});
