/**
 * Guided setups save as you go (the owner, 22 Nov 2026): the answers of a setup that isn't finished, kept as they are
 * given, so someone who leaves comes back to their choices. One row per business and setup; nothing in it is acted on.
 * A setup each person runs for themselves (My calendar) keeps its answers in their own `users.settings` instead,
 * by business, so teammates never share one.
 */
import { and, eq } from 'drizzle-orm';
import { guidedSetupDrafts, users } from '@hfos/db/schema';
import { HfosError } from '../errors';
import {
  GuidedSetupClearDraftInput,
  GuidedSetupClearDraftOutput,
  GuidedSetupSaveDraftInput,
  GuidedSetupSaveDraftOutput,
  guidedSetupPermission,
  isPersonalGuidedSetup,
  withPersonalGuidedDraft,
  type GuidedDraftKey,
  type PersonalGuidedDraft,
  type PersonalGuidedSetupKey,
} from '../guided-setup/index';
import { requireHuman, userIdOf } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import { scopeCan } from '../kernel/execute';
import type { CommandContext } from '../kernel/types';
import { missingPermissionMessage } from '../permissions';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

/** Each setup's answers belong to the people who may change what it sets up. */
function assertMaySetUp(ctx: CommandContext, setup: GuidedDraftKey): void {
  const permission = guidedSetupPermission(setup);
  if (ctx.actor.type === 'human' && !scopeCan(ctx.scope, permission))
    throw HfosError.forbidden(missingPermissionMessage(permission, ctx.scope.workspaceRole));
}

/**
 * Keeps (or, with null, forgets) one of the person's own setups' answers in this business, in their own
 * `users.settings`, with their row held so two saves never undo each other. True when there was one to forget.
 */
export async function keepPersonalDraft(
  ctx: CommandContext,
  setup: PersonalGuidedSetupKey,
  draft: PersonalGuidedDraft | null,
): Promise<boolean> {
  const userId = requireHuman(ctx).userId;
  const workspaceId = ctx.scope.workspaceId!;
  const [u] = await ctx.tx
    .select({ settings: users.settings })
    .from(users)
    .where(eq(users.id, userId))
    .for('update');
  if (!u)
    throw HfosError.notFound(
      'We couldn’t find your account. Sign out, sign in again and try once more.',
    );
  const settings = (u.settings ?? {}) as Record<string, unknown>;
  const next = withPersonalGuidedDraft(settings, workspaceId, setup, draft);
  if (JSON.stringify(next) === JSON.stringify(settings)) return false;
  await ctx.tx.update(users).set({ settings: next }).where(eq(users.id, userId));
  return true;
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
    if (isPersonalGuidedSetup(input.setup)) {
      await keepPersonalDraft(ctx, input.setup, {
        answers: input.answers,
        savedAt: now.toISOString(),
      });
      return { savedAt: now.toISOString() };
    }
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
    if (isPersonalGuidedSetup(input.setup))
      return { cleared: await keepPersonalDraft(ctx, input.setup, null) };
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
