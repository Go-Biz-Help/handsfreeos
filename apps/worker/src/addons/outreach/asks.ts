/**
 * Asking the extension (docs/outreach.md, decision 43; core's rules in packages/core/src/addons/outreach/asks.ts):
 * the first time something the person asked of their computer needs them (a step it can't find, or Facebook asking
 * for their password), their phone hears it at once: "Your computer needs you", with the extension's line. A network
 * that emailed them a code to check it's them is "Look in your email", and the Live tab has the box to type it in;
 * the push never carries the code, which only they have. One push per ask and each time it needs them, to the person
 * alone, on their add-ons switch; it opens the Live tab. No push when an ask ends: the web shows it live.
 */
import { askStuckPushWords } from '@hfos/core/addons/outreach/asks';
import { asWorker, rows, sql } from '@hfos/db/client';
import { pushAddonNotice } from '../alerts';
import type { AddonEventContext } from '../types';

const LIVE_HREF = '/a/outreach?view=live';

/** `outreach.ask.progressed`: an ask that now needs the person pushes to them, once for each way it needs them. */
export async function askProgressed(ctx: AddonEventContext): Promise<void> {
  const p = (ctx.event.payload ?? {}) as { userId?: unknown; state?: unknown; changed?: unknown };
  if (p.changed !== true || (p.state !== 'stuck' && p.state !== 'typing' && p.state !== 'code'))
    return;
  if (typeof p.userId !== 'string') return;
  const state = p.state;
  const userId = p.userId;
  const askId = ctx.event.entityId;
  await asWorker(ctx.db, ctx.scope, async (tx) => {
    const [ask] = await rows<{ line: string | null; state: string }>(
      tx,
      sql`select line, state from addon_outreach.asks
          where workspace_id = ${ctx.scope.workspaceId} and id = ${askId} and user_id = ${userId}`,
    );
    // Gone, or the person answered or stopped it before the worker got here: nothing to tell.
    if (!ask || ask.state !== state) return;
    await pushAddonNotice(ctx, tx, {
      // A code that didn't work asks for the next one: each time it asks for a code pushes again.
      key: state === 'code' ? `ask-code:${askId}:${ctx.event.id}` : `ask-${state}:${askId}`,
      userIds: [userId],
      permission: 'outreach.use',
      ...askStuckPushWords(state, ask.line),
      href: LIVE_HREF,
      collapseKey: `ask-${askId}`,
    });
  });
}
