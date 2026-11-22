/**
 * Guided setups save as you go (the owner, 22 Nov 2026): the answers of a setup that isn't finished, kept as they are
 * given, so someone who leaves comes back to their choices. One row per business and setup; nothing in it is acted on.
 */
import { and, eq } from 'drizzle-orm';
import { guidedSetupDrafts } from '@hfos/db/schema';
import { HfosError } from '../errors';
import {
  GUIDED_SETUPS,
  GuidedSetupClearDraftInput,
  GuidedSetupClearDraftOutput,
  GuidedSetupSaveDraftInput,
  GuidedSetupSaveDraftOutput,
  type GuidedSetupKey,
} from '../guided-setup/index';
import { userIdOf } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import { scopeCan } from '../kernel/execute';
import type { CommandContext } from '../kernel/types';
import { missingPermissionMessage } from '../permissions';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

/** Each setup's answers belong to the people who may change what it sets up. */
function assertMaySetUp(ctx: CommandContext, setup: GuidedSetupKey): void {
  const { permission } = GUIDED_SETUPS[setup];
  if (ctx.actor.type === 'human' && !scopeCan(ctx.scope, permission))
    throw HfosError.forbidden(missingPermissionMessage(permission, ctx.scope.workspaceRole));
}

export const guidedSetupSaveDraft = defineCommand({
  name: 'guided_setup.save_draft',
  description:
    'Keep a guided setup’s answers while they are being given (the phone number’s, the email’s), so a refresh or coming back later picks up where it was left. Nothing is bought or changed until the setup’s last screen.',
  risk: 1,
  input: GuidedSetupSaveDraftInput,
  output: GuidedSetupSaveDraftOutput,
  // Each setup has its own (GUIDED_SETUPS), checked below and again by the table's row-level security.
  permission: null,
  scope: inWorkspace,
  emits: [],
  async handler(ctx, input) {
    assertMaySetUp(ctx, input.setup);
    const workspaceId = ctx.scope.workspaceId!;
    const now = new Date();
    await ctx.tx
      .insert(guidedSetupDrafts)
      .values({
        workspaceId,
        setup: input.setup,
        answers: input.answers,
        updatedBy: userIdOf(ctx.actor),
      })
      .onConflictDoUpdate({
        target: [guidedSetupDrafts.workspaceId, guidedSetupDrafts.setup],
        set: { answers: input.answers, updatedBy: userIdOf(ctx.actor), updatedAt: now },
      });
    return { savedAt: now.toISOString() };
  },
});

export const guidedSetupClearDraft = defineCommand({
  name: 'guided_setup.clear_draft',
  description:
    'Forget a guided setup’s saved answers: it is finished, or the person chose Start over. Nothing already set up changes.',
  risk: 1,
  input: GuidedSetupClearDraftInput,
  output: GuidedSetupClearDraftOutput,
  permission: null,
  scope: inWorkspace,
  emits: [],
  async handler(ctx, input) {
    assertMaySetUp(ctx, input.setup);
    const gone = await ctx.tx
      .delete(guidedSetupDrafts)
      .where(
        and(
          eq(guidedSetupDrafts.workspaceId, ctx.scope.workspaceId!),
          eq(guidedSetupDrafts.setup, input.setup),
        ),
      )
      .returning({ setup: guidedSetupDrafts.setup });
    return { cleared: gone.length > 0 };
  },
});
