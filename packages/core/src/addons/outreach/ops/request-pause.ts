/**
 * A network's own monthly limit on the person's requests (docs/outreach.md, decision 147; ../request-pause.ts).
 *
 * - `outreach.requests.pause`: the extension saw the network say the person reached their monthly limit (Alignable's
 *   box after Connect, asking them to upgrade). New requests there wait till the 1st of next month, the business's day,
 *   with the likes before them; nothing else slows or stops. Seen again while paused, it's left as it was.
 * - `outreach.requests.start_again`: Start again, under Today's note, after an upgrade. Hit again, it pauses again.
 *
 * Today's list (./today.ts) and the day's goal (./goal.ts) read it with `requestsPauseOf`.
 */
import { and, eq, gt, isNull } from 'drizzle-orm';
import { localDateOf, localInstant } from '../../../calendar/engine/zoned';
import { workspaceTimezone } from '../../../crm/records';
import { HfosError } from '../../../errors';
import { requireHuman } from '../../../kernel/actor';
import { changeMoment } from '../../../kernel/moment';
import { defineAddonCommand } from '../../server';
import { outreachAddon } from '../manifest';
import { NETWORKS, type Platform } from '../networks';
import {
  pauseEndsOn,
  pausesRequests,
  RequestsAgainInput,
  RequestsAgainOutput,
  RequestsPauseInput,
  RequestsPauseOutput,
} from '../request-pause';
import { requestPauses } from '../tables';
import { inWorkspace, type Ctx } from './common';

/** A pause on now: till when, the business day it ends on ("2026-12-01"), and the network's words. */
export interface RequestsPause {
  readonly until: Date;
  readonly day: string;
  readonly words: readonly string[];
}

/** The person's pause on a network, while it's on: null once it ended, or Start again ended it. */
export async function requestsPauseOf(
  ctx: Ctx,
  me: string,
  platform: Platform,
  now = Date.now(),
): Promise<RequestsPause | null> {
  if (!pausesRequests(platform)) return null;
  const ws = ctx.scope.workspaceId!;
  const [kept] = await ctx.tx
    .select({
      until: requestPauses.until,
      endedAt: requestPauses.endedAt,
      words: requestPauses.words,
    })
    .from(requestPauses)
    .where(
      and(
        eq(requestPauses.workspaceId, ws),
        eq(requestPauses.userId, me),
        eq(requestPauses.platform, platform),
      ),
    )
    .limit(1);
  if (!kept || kept.endedAt !== null || kept.until.getTime() <= now) return null;
  const timeZone = await workspaceTimezone(ctx.tx, ws);
  return { until: kept.until, day: localDateOf(kept.until.getTime(), timeZone), words: kept.words };
}

export const requestsPause = defineAddonCommand(outreachAddon, {
  name: 'outreach.requests.pause',
  description:
    'Note that a social network told the person they reached their monthly limit of requests there (Alignable’s connection requests), in its own words, as the extension read it: new requests on that network wait till the 1st of next month, with the likes before them. Likes, comments and messages go on, and nothing else slows down.',
  risk: 1,
  input: RequestsPauseInput,
  output: RequestsPauseOutput,
  permission: 'outreach.use',
  scope: inWorkspace,
  offline: 'anytime',
  emits: ['outreach.requests.paused'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const kit = NETWORKS[input.platform];
    if (!pausesRequests(input.platform))
      throw HfosError.rule(
        'outreach_pause_follows',
        409,
        `${kit.name}’s ${kit.words.friendRequests} wait for nobody’s answer, so there’s nothing to pause.`,
      );
    const at = changeMoment(ctx.meta);
    const now = at.getTime();
    const timeZone = await workspaceTimezone(ctx.tx, ws);
    const mine = and(
      eq(requestPauses.workspaceId, ws),
      eq(requestPauses.userId, me),
      eq(requestPauses.platform, input.platform),
    );
    const [kept] = await ctx.tx
      .select({ until: requestPauses.until, endedAt: requestPauses.endedAt })
      .from(requestPauses)
      .where(mine)
      .limit(1);
    // Seen again while paused (another computer, or a step already going): left as it was.
    if (kept && kept.endedAt === null && kept.until.getTime() > now)
      return { until: localDateOf(kept.until.getTime(), timeZone), already: true };
    // When the last one ended, by its date or by Start again: hit again within a week, it waits a week, not a month.
    const lastEnded = kept
      ? Math.min(kept.until.getTime(), kept.endedAt?.getTime() ?? Infinity)
      : null;
    const day = pauseEndsOn(now, timeZone, lastEnded);
    const until = new Date(localInstant(day, '00:00', timeZone));
    const words = [...new Set(input.words)];
    await ctx.tx
      .insert(requestPauses)
      .values({ workspaceId: ws, userId: me, platform: input.platform, words, at, until })
      .onConflictDoUpdate({
        target: [requestPauses.workspaceId, requestPauses.userId, requestPauses.platform],
        set: { words, at, until, endedAt: null, updatedAt: at },
      });
    await ctx.emit({
      type: 'outreach.requests.paused',
      entityType: 'workspace',
      entityId: ws,
      payload: { platform: input.platform, userId: me, until: day },
    });
    return { until: day, already: false };
  },
});

export const requestsStartAgain = defineAddonCommand(outreachAddon, {
  name: 'outreach.requests.start_again',
  description:
    'Start new requests again on a social network (Alignable’s connection requests) before the 1st, after the person upgraded there: the pause its monthly limit put on them ends now. If the network says the limit is still reached, they pause again.',
  risk: 1,
  input: RequestsAgainInput,
  output: RequestsAgainOutput,
  permission: 'outreach.use',
  ai: {
    tool: 'outreach_start_requests_again',
    autonomy: 'confirm',
    keywords: [
      'start connection requests again',
      'upgraded alignable',
      'monthly connection limit',
      'resume requests',
    ],
  },
  scope: inWorkspace,
  emits: ['outreach.requests.started_again'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const at = changeMoment(ctx.meta);
    const ended = await ctx.tx
      .update(requestPauses)
      .set({ endedAt: at, updatedAt: at })
      .where(
        and(
          eq(requestPauses.workspaceId, ws),
          eq(requestPauses.userId, me),
          eq(requestPauses.platform, input.platform),
          // Only one still on: one that ended already stays as it was.
          isNull(requestPauses.endedAt),
          gt(requestPauses.until, at),
        ),
      )
      .returning({ id: requestPauses.id });
    if (!ended.length) return { ended: false };
    await ctx.emit({
      type: 'outreach.requests.started_again',
      entityType: 'workspace',
      entityId: ws,
      payload: { platform: input.platform, userId: me },
    });
    return { ended: true };
  },
});

export const requestPauseCommands = [requestsPause, requestsStartAgain] as const;
