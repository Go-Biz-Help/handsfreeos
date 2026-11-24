import { and, eq } from 'drizzle-orm';
import { guidedSetupDrafts, users } from '@hfos/db/schema';
import { HfosError } from '../errors';
import {
  GuidedSetupGetDraftInput,
  GuidedSetupGetDraftOutput,
  guidedSetupPermission,
  isPersonalGuidedSetup,
  personalGuidedDraftOf,
} from '../guided-setup/index';
import { defineQuery } from '../kernel/define';
import { scopeCan } from '../kernel/execute';
import { missingPermissionMessage } from '../permissions';

/** A guided setup's answers as they were left (guided_setup.save_draft), for its screens to pick up. */
export const guidedSetupGetDraft = defineQuery({
  name: 'guided_setup.get_draft',
  description:
    'A guided setup’s answers as they were left (setup: phone, email, calendar, payments, chat, facebook, or my_calendar, which is your own), and when they were last saved. Null when nothing is saved: the setup isn’t started, or it was finished.',
  input: GuidedSetupGetDraftInput,
  output: GuidedSetupGetDraftOutput,
  // Each setup has its own (GUIDED_SETUPS), checked below; the table's row-level security holds it too.
  permission: null,
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  async handler(ctx, input) {
    const permission = guidedSetupPermission(input.setup);
    // Someone only looking at the business (support's view) has no role to check: the read rules answer for them.
    if (ctx.actor.type === 'human' && !ctx.scope.viewAs && !scopeCan(ctx.scope, permission))
      throw HfosError.forbidden(missingPermissionMessage(permission, ctx.scope.workspaceRole));
    // A person's own setup: their answers in this business, from their own settings; nobody else's.
    if (isPersonalGuidedSetup(input.setup)) {
      if (ctx.actor.type !== 'human' || ctx.scope.viewAs) return { answers: null, savedAt: null };
      const [u] = await ctx.tx
        .select({ settings: users.settings })
        .from(users)
        .where(eq(users.id, ctx.actor.userId));
      const draft = personalGuidedDraftOf(
        (u?.settings ?? null) as Record<string, unknown> | null,
        input.workspaceId,
        input.setup,
      );
      return { answers: draft?.answers ?? null, savedAt: draft?.savedAt ?? null };
    }
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
