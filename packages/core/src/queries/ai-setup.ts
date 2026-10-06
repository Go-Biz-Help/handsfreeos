/**
 * Quick setup's query (HANDSFREEOS_AI_QUICK_SETUP_IMPLEMENTATION_PLAN.md §5): what the business has today, and
 * where the screens start, from what someone answered so far or else from today's picks.
 */
import { eq } from 'drizzle-orm';
import { workspaces } from '@hfos/db/schema';
import { aiSetupOf, resumeAiSetup } from '../ai-setup/answers';
import { loadAiSetupState } from '../ai-setup/load';
import { startingAiSetupAnswers } from '../ai-setup/plan';
import { defineQuery } from '../kernel/define';
import { AiSetupGetInput, AiSetupGetOutput } from '../schemas/ai-setup';

export const aiSetupGet = defineQuery({
  name: 'ai_setup.get',
  description:
    'Quick setup for the AI teammate: what the business has today (its kind, website, open hours, profile, services, calendars, chat and teammate), the answers to start from (what someone answered so far, else picks for its kind of business), and how far it got.',
  input: AiSetupGetInput,
  output: AiSetupGetOutput,
  // The answers become the teammate's settings, so it's for those who may change them.
  permission: 'ai_team.manage',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  async handler(ctx, input) {
    const state = await loadAiSetupState(ctx.tx, input.workspaceId);
    const [w] = await ctx.tx
      .select({ settings: workspaces.settings })
      .from(workspaces)
      .where(eq(workspaces.id, input.workspaceId));
    const record = aiSetupOf((w?.settings ?? {}) as Record<string, unknown>);
    const starting = startingAiSetupAnswers(state);
    return {
      state: {
        ...state,
        teammate: state.teammate && {
          ...state.teammate,
          config: state.teammate.config as unknown as Record<string, unknown>,
        },
      },
      answers: resumeAiSetup(starting, record, state.kind),
      starting,
      reached: record.draft ? record.reached : null,
      started: record.started,
      finished: record.finished,
      runs: record.runs,
    };
  },
});
