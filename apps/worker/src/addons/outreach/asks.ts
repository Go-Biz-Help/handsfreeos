/**
 * Asking the extension (docs/outreach.md, decision 43; core's rules in packages/core/src/addons/outreach/asks.ts):
 * the first time something the person asked of their computer needs them (a step it can't find, or Facebook asking
 * for their password), their phone hears it at once: "Your computer needs you", with the extension's line. One push
 * per ask and state, to the person alone, on their add-ons switch; it opens the Live tab. No push when an ask ends:
 * the web shows it live.
 *
 * A code a network emailed them (decision 82) is a notification that stays up: an alert for the person alone, pushed
 * at any hour and never emailed, on Home and under the phone's notifications button, opening the code's own screen. It
 * goes once the code is typed, the ask moves on or ends, or after `ASK_CODE_MINUTES`. Where no code came in time, the
 * step handed to them (Try again) is one too. Neither ever carries the code, which only they have.
 */
import {
  ASK_CODE_MINUTES,
  askCodeAlertWords,
  askCodeHref,
  askCodeRanOut,
  askStuckPushWords,
} from '@hfos/core/addons/outreach/asks';
import type { Platform } from '@hfos/core/addons/outreach/networks';
import { asWorker, rows, sql } from '@hfos/db/client';
import { clearAddonAlert, pushAddonNotice, raiseAddonAlert } from '../alerts';
import type { AddonEventContext } from '../types';

const LIVE_HREF = '/a/outreach?view=live';

/** The notification while an ask waits on a code, and the one once it ran out. */
export const codeAlertKey = (askId: string) => `ask-code:${askId}`;
export const ranOutAlertKey = (askId: string) => `ask-again:${askId}`;

type AskNow = {
  readonly line: string | null;
  readonly state: string;
  readonly platform: Platform;
};

async function askNow(
  ctx: AddonEventContext,
  askId: string,
  userId: string,
): Promise<AskNow | null> {
  const [ask] = await asWorker(ctx.db, ctx.scope, (tx) =>
    rows<AskNow>(
      tx,
      sql`select line, state, platform from addon_outreach.asks
          where workspace_id = ${ctx.scope.workspaceId} and id = ${askId} and user_id = ${userId}`,
    ),
  );
  return ask ?? null;
}

/**
 * `outreach.ask.progressed`: an ask that now needs the person pushes to them, once for each way it needs them; one
 * waiting on a code, or whose code ran out, keeps its notification up instead, and one that moved on takes it down.
 */
export async function askProgressed(ctx: AddonEventContext): Promise<void> {
  const p = (ctx.event.payload ?? {}) as { userId?: unknown; state?: unknown; changed?: unknown };
  const askId = ctx.event.entityId;
  if (typeof p.userId !== 'string' || !askId) return;
  const userId = p.userId;
  const ask = await askNow(ctx, askId, userId);
  if (!ask) return;
  const ranOut = askCodeRanOut(ask);
  if (ask.state !== 'code') await clearAddonAlert(ctx, codeAlertKey(askId));
  if (!ranOut) await clearAddonAlert(ctx, ranOutAlertKey(askId));
  // Gone, or the person answered or stopped it before the worker got here: nothing to tell.
  if (p.changed !== true || ask.state !== p.state) return;
  if (ask.state === 'code' || ranOut) {
    await raiseAddonAlert(ctx, {
      key: ranOut ? ranOutAlertKey(askId) : codeAlertKey(askId),
      severity: 'critical',
      ...askCodeAlertWords(ask.platform, ranOut),
      href: askCodeHref(askId),
      permission: 'outreach.use',
      audienceUserIds: [userId],
      dueAt: ranOut ? null : new Date(Date.now() + ASK_CODE_MINUTES * 60_000),
      email: false,
    });
    return;
  }
  if (ask.state !== 'stuck' && ask.state !== 'typing') return;
  const state = ask.state;
  await asWorker(ctx.db, ctx.scope, (tx) =>
    pushAddonNotice(ctx, tx, {
      key: `ask-${state}:${askId}`,
      userIds: [userId],
      permission: 'outreach.use',
      ...askStuckPushWords(state, ask.line),
      href: LIVE_HREF,
      collapseKey: `ask-${askId}`,
    }),
  );
}

/** `outreach.ask.coded`: the code's typed, so its notification goes. */
export async function askCoded(ctx: AddonEventContext): Promise<void> {
  if (ctx.event.entityId) await clearAddonAlert(ctx, codeAlertKey(ctx.event.entityId));
}

/** `outreach.ask.ended` or `outreach.ask.cancelled`: nothing it waited on still waits. */
export async function askSettled(ctx: AddonEventContext): Promise<void> {
  const askId = ctx.event.entityId;
  if (!askId) return;
  await clearAddonAlert(ctx, codeAlertKey(askId), 'ended');
  await clearAddonAlert(ctx, ranOutAlertKey(askId), 'ended');
}
