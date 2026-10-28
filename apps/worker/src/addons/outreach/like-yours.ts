/**
 * The AI's pick of Instagram accounts like yours (docs/outreach.md, decision 110): the accounts the person's computer
 * found with Instagram's search (`outreach.like_yours.found`) queue one pick per business, and the AI keeps the best,
 * up to 5 kept in all, with why; the rest are passed over for good (`outreach.like_yours.pick`). Core holds what the
 * model is asked and what it may answer (packages/core/src/addons/outreach/like-yours.ts).
 */
import {
  checkedPicks,
  LIKE_YOURS_FOUND_MOST,
  LIKE_YOURS_MOST,
  LIKE_YOURS_PICK_SCHEMA,
  LIKE_YOURS_PICK_SYSTEM,
  LikeYoursPickAnswer,
  likeYoursPickPrompt,
} from '@hfos/core/addons/outreach/like-yours';
import { FOR_CUSTOMERS } from '@hfos/core/addons/outreach/ops/common';
import { likeYoursPick } from '@hfos/core/addons/outreach/ops/like-yours';
import {
  PlaybookDetails,
  runsOn,
  upgradePlaybookDetails,
} from '@hfos/core/addons/outreach/playbooks';
import { executeCommand } from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import type { JobResult } from '../../jobs';
import { AiAskError, askStructured } from '../../ai/ask';
import { scheduleAddonJob } from '../queue';
import type { AddonEventContext, AddonJobContext } from '../types';

export const PICK_LIKE_YOURS_JOB = 'outreach.pick_like_yours';
const HOUR = 3_600_000;

/** `outreach.like_yours.found`: the accounts waiting are looked at now. */
export async function likeYoursFound(ctx: AddonEventContext): Promise<void> {
  await asWorker(ctx.db, ctx.scope, (tx) =>
    scheduleAddonJob(
      tx,
      { id: ctx.manifest.id, generation: ctx.generation },
      {
        kind: PICK_LIKE_YOURS_JOB,
        dedupeKey: `${PICK_LIKE_YOURS_JOB}:${ctx.scope.workspaceId}`,
        runAt: new Date(),
        payload: {},
        workspaceId: ctx.scope.workspaceId,
        organizationId: ctx.scope.organizationId,
      },
      { pullEarlier: true },
    ),
  );
}

/** `outreach.pick_like_yours`: the AI picks the best of the accounts waiting, up to the room left of 5. */
export async function pickLikeYoursJob(ctx: AddonJobContext): Promise<JobResult> {
  const found = await asWorker(ctx.db, ctx.scope, async (tx) => ({
    business: (
      await rows<{ name: string }>(
        tx,
        sql`select name from app.workspaces where id = ${ctx.scope.workspaceId}`,
      )
    )[0],
    kept: (
      await rows<{ n: number }>(
        tx,
        sql`select count(*)::int as n from addon_outreach.like_yours
            where workspace_id = ${ctx.scope.workspaceId} and platform = 'instagram' and state = 'kept'`,
      )
    )[0]!.n,
    accounts: await rows<{ id: string; username: string; name: string | null; why: string | null }>(
      tx,
      sql`select id, username, name, why from addon_outreach.like_yours
          where workspace_id = ${ctx.scope.workspaceId} and platform = 'instagram' and state = 'candidate'
          order by found_at desc, username limit ${LIKE_YOURS_FOUND_MOST}`,
    ),
    playbooks: await rows<{ name: string; details: unknown }>(
      tx,
      sql`select name, details from addon_outreach.playbooks
          where workspace_id = ${ctx.scope.workspaceId} and archived_at is null and ${FOR_CUSTOMERS}
          order by created_at`,
    ),
  }));
  if (!found.accounts.length) return;
  const room = Math.max(0, LIKE_YOURS_MOST - found.kept);
  let picks: { id: string; why: string | null }[] = [];
  if (room) {
    const playbooks = found.playbooks.flatMap((p) => {
      const details = PlaybookDetails.safeParse(upgradePlaybookDetails(p.details));
      return details.success && runsOn(details.data, 'instagram')
        ? [{ name: p.name, details: details.data }]
        : [];
    });
    try {
      const { value } = await askStructured(ctx, ctx.scope, {
        system: LIKE_YOURS_PICK_SYSTEM,
        messages: [
          {
            role: 'user',
            content: likeYoursPickPrompt({
              business: found.business?.name ?? 'the business',
              playbooks,
              room,
              accounts: found.accounts.map((a) => ({
                username: a.username,
                name: a.name,
                words: a.why,
              })),
            }),
          },
        ],
        schema: LIKE_YOURS_PICK_SCHEMA,
        zod: LikeYoursPickAnswer,
        maxTokens: 600,
        usage: { source: 'addon', addonId: ctx.manifest.id },
      });
      picks = checkedPicks(value, found.accounts, room);
    } catch (e) {
      if (!(e instanceof AiAskError)) throw e;
      // The day's limit or an empty balance: they wait a few hours. Not set up: they wait for the next search.
      if (e.code === 'budget_reached' || e.code === 'wallet_empty')
        return { rescheduleAt: new Date(ctx.now + 6 * HOUR) };
      if (e.code === 'ai_unavailable') return;
      if (e.retryable) {
        if (ctx.attempt < 3) throw e;
        return { rescheduleAt: new Date(ctx.now + HOUR) };
      }
      // An answer it can't use: none of these is picked, and the next search brings others.
      picks = [];
    }
  }
  await executeCommand(
    ctx.db,
    likeYoursPick,
    {
      workspaceId: ctx.scope.workspaceId,
      picks,
      looked: found.accounts.map((a) => a.id),
    },
    ctx.actor,
    ctx.meta,
  );
}
