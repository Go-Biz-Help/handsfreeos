import { and, eq } from 'drizzle-orm';
import { guidedSetupDrafts } from '@hfos/db/schema';
import { HfosError } from '../errors';
import {
  GUIDED_SETUPS,
  GuidedSetupGetDraftInput,
  GuidedSetupGetDraftOutput,
} from '../guided-setup/index';
import { defineQuery } from '../kernel/define';
import { scopeCan } from '../kernel/execute';
import { missingPermissionMessage } from '../permissions';

/** A guided setup's answers as they were left (guided_setup.save_draft), for its screens to pick up. */
export const guidedSetupGetDraft = defineQuery({
  name: 'guided_setup.get_draft',
  description:
    'A guided setup’s answers as they were left (setup: phone or email), and when they were last saved. Null when nothing is saved: the setup isn’t started, or it was finished.',
  input: GuidedSetupGetDraftInput,
  output: GuidedSetupGetDraftOutput,
  // Each setup has its own (GUIDED_SETUPS), checked below; the table's row-level security holds it too.
  permission: null,
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  async handler(ctx, input) {
    const { permission } = GUIDED_SETUPS[input.setup];
    // Someone only looking at the business (support's view) has no role to check: the read rules answer for them.
    if (ctx.actor.type === 'human' && !ctx.scope.viewAs && !scopeCan(ctx.scope, permission))
      throw HfosError.forbidden(missingPermissionMessage(permission, ctx.scope.workspaceRole));
    const [row] = await ctx.tx
      .select({ answers: guidedSetupDrafts.answers, updatedAt: guidedSetupDrafts.updatedAt })
      .from(guidedSetupDrafts)
      .where(
        and(
          eq(guidedSetupDrafts.workspaceId, input.workspaceId),
          eq(guidedSetupDrafts.setup, input.setup),
        ),
      );
    return {
      answers: row ? (row.answers as Record<string, unknown>) : null,
      savedAt: row ? row.updatedAt.toISOString() : null,
    };
  },
});
