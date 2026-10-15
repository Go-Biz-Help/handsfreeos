/**
 * The AI's read of the people a person already knows on Facebook (docs/outreach.md, decision 46): whether each of
 * their friends, or someone they've chatted with, fits one of the business's playbooks, why, who they are and a first
 * step. Core holds what the model is asked and what it may answer (packages/core/src/addons/outreach/checks.ts), and
 * `outreach.check.save` keeps it and lets go of what their pages said.
 *
 * - What the extension reads off their pages (`outreach.check.looked`) queues one read per business, so a morning's
 *   checks are read together.
 * - Each read takes a batch, the oldest first, with what HandsFreeOS knows of them and the person's own chat with them.
 *   At the day's AI limit the rest wait a few hours; an answer it can't use marks that one as failed, tried again in
 *   a week, rather than trying it forever.
 */
import {
  CHECK_SCHEMA,
  checkSystem,
  CheckAnswer,
  checkedAnswer,
  checkPrompt,
  type CheckPlaybook,
} from '@hfos/core/addons/outreach/checks';
import type { DownloadMessage } from '@hfos/core/addons/outreach/download';
import { checkSave } from '@hfos/core/addons/outreach/ops/checks';
import { NETWORKS, type Platform } from '@hfos/core/addons/outreach/networks';
import { PlaybookDetails, upgradePlaybookDetails } from '@hfos/core/addons/outreach/playbooks';
import { executeCommand } from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import type { JobResult } from '../../jobs';
import { AiAskError, askStructured } from '../../ai/ask';
import { scheduleAddonJob } from '../queue';
import type { AddonEventContext, AddonJobContext } from '../types';

export const CHECK_PEOPLE_JOB = 'outreach.check_people';
/** How many people one read takes. */
export const CHECK_PEOPLE_BATCH = 20;
const HOUR = 3_600_000;

/** `outreach.check.looked`: the people waiting are read now. */
export async function checkLooked(ctx: AddonEventContext): Promise<void> {
  await asWorker(ctx.db, ctx.scope, (tx) =>
    scheduleAddonJob(
      tx,
      { id: ctx.manifest.id, generation: ctx.generation },
      {
        kind: CHECK_PEOPLE_JOB,
        dedupeKey: `${CHECK_PEOPLE_JOB}:${ctx.scope.workspaceId}`,
        runAt: new Date(),
        payload: {},
        workspaceId: ctx.scope.workspaceId,
        organizationId: ctx.scope.organizationId,
      },
      { pullEarlier: true },
    ),
  );
}

/** `outreach.check_people`: reads a batch of the business's people waiting, and comes back for the rest. */
export async function checkPeopleJob(ctx: AddonJobContext): Promise<JobResult> {
  const ws = ctx.scope.workspaceId;
  const found = await asWorker(ctx.db, ctx.scope, async (tx) => ({
    business: (
      await rows<{ name: string }>(tx, sql`select name from app.workspaces where id = ${ws}`)
    )[0],
    waiting: await rows<{
      id: string;
      looked_at: Date | string;
      lines: string[];
      name: string;
      platform: Platform;
      intro: string[];
      mutual_friends: number | null;
      group_name: string | null;
      group_lines: string[] | null;
      summary: string | null;
      recent: DownloadMessage[] | null;
    }>(
      tx,
      // Each person's own chat with them: the check is theirs, and so is the chat it reads.
      sql`select ch.id, ch.looked_at, ch.lines, p.name, p.platform, p.intro, p.mutual_friends, g.name as group_name,
            (select gp.lines from addon_outreach.group_people gp where gp.profile_id = p.id
              order by gp.seen_at desc limit 1) as group_lines,
            c.summary, c.recent
          from addon_outreach.checks ch
          join addon_outreach.profiles p on p.id = ch.profile_id
          left join addon_outreach.groups g on g.id = p.group_id
          left join lateral (
            select c.summary, c.recent from addon_outreach.file_chats c
            where c.profile_id = p.id and c.user_id = ch.user_id order by c.last_at desc limit 1
          ) c on true
          where ch.workspace_id = ${ws} and ch.verdict = 'waiting'
          order by ch.looked_at limit ${CHECK_PEOPLE_BATCH + 1}`,
    ),
    playbooks: await rows<{ id: string; name: string; details: unknown }>(
      tx,
      sql`select id, name, details from addon_outreach.playbooks
          where workspace_id = ${ws} and archived_at is null order by created_at`,
    ),
  }));
  if (!found.waiting.length) return;
  const playbooks = found.playbooks.flatMap((p) => {
    const read = PlaybookDetails.safeParse(upgradePlaybookDetails(p.details));
    return read.success ? [{ id: p.id, name: p.name, details: read.data }] : [];
  });
  const told: CheckPlaybook[] = playbooks.map((p) => ({
    name: p.name,
    offer: p.details.offer,
    audience: p.details.audience,
    signs: p.details.signs,
    skip: p.details.skip,
  }));

  for (const person of found.waiting.slice(0, CHECK_PEOPLE_BATCH)) {
    let answer: ReturnType<typeof checkedAnswer> | null;
    try {
      const { value } = await askStructured(ctx, ctx.scope, {
        system: checkSystem(person.platform),
        messages: [
          {
            role: 'user',
            content: checkPrompt({
              business: found.business?.name ?? 'the business',
              name: person.name,
              facts: [
                ...(person.group_lines ?? []),
                ...person.intro,
                ...(person.group_name ? [`Found in the group ${person.group_name}`] : []),
                ...(person.mutual_friends
                  ? [
                      `${person.mutual_friends.toLocaleString('en-US')} mutual ${NETWORKS[person.platform].words.friends}`,
                    ]
                  : []),
              ],
              lines: person.lines,
              chat:
                person.summary || person.recent?.length
                  ? { summary: person.summary, recent: person.recent ?? [] }
                  : null,
              playbooks: told,
              platform: person.platform,
            }),
          },
        ],
        schema: CHECK_SCHEMA,
        zod: CheckAnswer,
        maxTokens: 400,
        usage: { source: 'addon', addonId: ctx.manifest.id },
      });
      answer = checkedAnswer(value, playbooks);
    } catch (e) {
      if (!(e instanceof AiAskError)) throw e;
      // The day's limit or an empty balance: the rest wait a few hours. Not set up: they wait for the next look.
      if (e.code === 'budget_reached' || e.code === 'wallet_empty')
        return { rescheduleAt: new Date(ctx.now + 6 * HOUR) };
      if (e.code === 'ai_unavailable') return;
      // A busy model is worth another try; one still busy waits an hour.
      if (e.retryable) {
        if (ctx.attempt < 3) throw e;
        return { rescheduleAt: new Date(ctx.now + HOUR) };
      }
      answer = null;
    }
    await executeCommand(
      ctx.db,
      checkSave,
      {
        workspaceId: ws,
        checkId: person.id,
        lookedAt: new Date(person.looked_at).toISOString(),
        answer,
      },
      ctx.actor,
      ctx.meta,
    );
  }
  if (found.waiting.length > CHECK_PEOPLE_BATCH) return { rescheduleAt: new Date(ctx.now) };
}
