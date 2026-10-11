/**
 * Groups, theirs first, then new ones (docs/outreach.md, decision 48), in the worker:
 *
 * - **The AI's check of a group** (`outreach.check_groups`): what its About page, rules and latest posts said, read
 *   for whether the playbooks' people are there and post. What the extension reads (`outreach.group.looked`) queues
 *   one check per business; each takes a batch, the oldest first, and `outreach.group.check` keeps the answer. At the
 *   day's AI limit the rest wait a few hours; an answer it can't use marks that group as failed, tried again in a week.
 * - **Answers to a group's questions** (`outreach.join.answer`, decision 31): when the person's computer asks to join a
 *   group that asks questions, the AI answers them from the playbook, honestly and briefly, on its own. Nothing is
 *   saved here: the extension types them in, and `outreach.join.note` keeps them with the ask.
 *
 * Core holds what the model is asked and what it may answer (packages/core/src/addons/outreach/group-checks.ts).
 */
import {
  checkedGroupAnswer,
  checkedJoinAnswers,
  GROUP_CHECK_SCHEMA,
  GROUP_CHECK_SYSTEM,
  GroupCheckAnswer,
  groupCheckPrompt,
  JOIN_ANSWER_SCHEMA,
  JOIN_ANSWER_SYSTEM,
  JoinAnswerAnswer,
  JoinAnswerInput,
  joinAnswerPrompt,
  type GroupCheckPlaybook,
  type JoinAnswerOutput,
} from '@hfos/core/addons/outreach/group-checks';
import { groupCheck } from '@hfos/core/addons/outreach/ops/group-checks';
import { PlaybookDetails, upgradePlaybookDetails } from '@hfos/core/addons/outreach/playbooks';
import { executeCommand, HfosError } from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import type { JobResult } from '../../jobs';
import {
  AI_BUDGET_MESSAGE,
  AI_BUSY_MESSAGE,
  AI_UNAVAILABLE_MESSAGE,
  AiAskError,
  askStructured,
} from '../../ai/ask';
import { scheduleAddonJob } from '../queue';
import type { AddonEventContext, AddonJobContext, AddonWorkerAction } from '../types';

export const CHECK_GROUPS_JOB = 'outreach.check_groups';
export const JOIN_ANSWER_ACTION = 'outreach.join.answer';
/** How many groups one check takes. */
export const CHECK_GROUPS_BATCH = 10;
const HOUR = 3_600_000;

/** The business's playbooks in use, as the AI reads them. */
async function playbooksOf(tx: Parameters<typeof rows>[0], ws: string) {
  const kept = await rows<{ id: string; name: string; details: unknown }>(
    tx,
    sql`select id, name, details from addon_outreach.playbooks
        where workspace_id = ${ws} and archived_at is null order by created_at`,
  );
  return kept.flatMap((p) => {
    const read = PlaybookDetails.safeParse(upgradePlaybookDetails(p.details));
    return read.success ? [{ id: p.id, name: p.name, details: read.data }] : [];
  });
}

/** `outreach.group.looked`: the groups waiting are checked now. */
export async function groupLooked(ctx: AddonEventContext): Promise<void> {
  await asWorker(ctx.db, ctx.scope, (tx) =>
    scheduleAddonJob(
      tx,
      { id: ctx.manifest.id, generation: ctx.generation },
      {
        kind: CHECK_GROUPS_JOB,
        dedupeKey: `${CHECK_GROUPS_JOB}:${ctx.scope.workspaceId}`,
        runAt: new Date(),
        payload: {},
        workspaceId: ctx.scope.workspaceId,
        organizationId: ctx.scope.organizationId,
      },
      { pullEarlier: true },
    ),
  );
}

/** `outreach.check_groups`: checks a batch of the business's groups waiting, and comes back for the rest. */
export async function checkGroupsJob(ctx: AddonJobContext): Promise<JobResult> {
  const ws = ctx.scope.workspaceId;
  const found = await asWorker(ctx.db, ctx.scope, async (tx) => ({
    business: (
      await rows<{ name: string }>(tx, sql`select name from app.workspaces where id = ${ws}`)
    )[0],
    waiting: await rows<{
      id: string;
      name: string | null;
      members: number | null;
      privacy: 'public' | 'private' | null;
      about: string[];
      rules: string[];
      check_lines: string[];
      about_at: Date | string;
    }>(
      tx,
      sql`select id, name, members, privacy, about, rules, check_lines, about_at
          from addon_outreach.groups
          where workspace_id = ${ws} and check_state = 'waiting'
          order by about_at limit ${CHECK_GROUPS_BATCH + 1}`,
    ),
    playbooks: await playbooksOf(tx, ws),
  }));
  if (!found.waiting.length) return;
  const told: GroupCheckPlaybook[] = found.playbooks.map((p) => ({
    name: p.name,
    offer: p.details.offer,
    audience: p.details.audience,
    signs: p.details.signs,
    area: p.details.area,
  }));
  for (const group of found.waiting.slice(0, CHECK_GROUPS_BATCH)) {
    let answer: ReturnType<typeof checkedGroupAnswer> | null;
    try {
      const { value } = await askStructured(ctx, ctx.scope, {
        system: GROUP_CHECK_SYSTEM,
        messages: [
          {
            role: 'user',
            content: groupCheckPrompt({
              business: found.business?.name ?? 'the business',
              group: { name: group.name, members: group.members, privacy: group.privacy },
              about: group.about,
              rules: group.rules,
              posts: group.check_lines,
              playbooks: told,
            }),
          },
        ],
        schema: GROUP_CHECK_SCHEMA,
        zod: GroupCheckAnswer,
        maxTokens: 400,
        usage: { source: 'addon', addonId: ctx.manifest.id },
      });
      answer = checkedGroupAnswer(value, found.playbooks);
    } catch (e) {
      if (!(e instanceof AiAskError)) throw e;
      if (e.code === 'budget_reached' || e.code === 'wallet_empty')
        return { rescheduleAt: new Date(ctx.now + 6 * HOUR) };
      if (e.code === 'ai_unavailable') return;
      if (e.retryable) {
        if (ctx.attempt < 3) throw e;
        return { rescheduleAt: new Date(ctx.now + HOUR) };
      }
      answer = null;
    }
    await executeCommand(
      ctx.db,
      groupCheck,
      {
        workspaceId: ws,
        groupId: group.id,
        aboutAt: new Date(group.about_at).toISOString(),
        answer,
      },
      ctx.actor,
      ctx.meta,
    );
  }
  if (found.waiting.length > CHECK_GROUPS_BATCH) return { rescheduleAt: new Date(ctx.now) };
}

export const joinAnswer: AddonWorkerAction<JoinAnswerInput> = {
  permission: 'outreach.use',
  input: JoinAnswerInput,
  async run(ctx, raw): Promise<JoinAnswerOutput> {
    const input = JoinAnswerInput.parse(raw);
    const ws = ctx.scope.workspaceId!;
    const found = await asWorker(ctx.db, ctx.scope, async (tx) => ({
      business: (
        await rows<{ name: string }>(tx, sql`select name from app.workspaces where id = ${ws}`)
      )[0],
      group: (
        await rows<{ name: string | null; rules: string[]; check_playbook_id: string | null }>(
          tx,
          sql`select name, rules, check_playbook_id from addon_outreach.groups
              where workspace_id = ${ws} and id = ${input.groupId}`,
        )
      )[0],
      playbooks: await playbooksOf(tx, ws),
    }));
    if (!found.group)
      throw HfosError.notFound('That group isn’t kept here anymore. Save your groups again.');
    const business = found.business?.name ?? 'the business';
    const playbook =
      found.playbooks.find((p) => p.id === found.group!.check_playbook_id) ??
      found.playbooks[0] ??
      null;
    const fallback = playbook?.details.offer
      ? `I run ${business}: ${playbook.details.offer}. I joined to learn and help where I can.`
      : `I run ${business}, and I joined to learn and help where I can.`;
    try {
      const { value } = await askStructured(ctx, ctx.scope, {
        system: JOIN_ANSWER_SYSTEM,
        messages: [
          {
            role: 'user',
            content: joinAnswerPrompt({
              business,
              group: found.group.name,
              playbook: playbook
                ? {
                    name: playbook.name,
                    offer: playbook.details.offer,
                    audience: playbook.details.audience,
                    area: playbook.details.area,
                  }
                : null,
              rules: found.group.rules,
              questions: input.questions,
            }),
          },
        ],
        schema: JOIN_ANSWER_SCHEMA,
        zod: JoinAnswerAnswer,
        maxTokens: 800,
        usage: { source: 'addon', addonId: ctx.manifest.id },
      });
      return { answers: checkedJoinAnswers(value.answers, input.questions, fallback) };
    } catch (e) {
      if (!(e instanceof AiAskError)) throw e;
      if (e.code === 'budget_reached' || e.code === 'wallet_empty')
        throw HfosError.rule('budget_reached', 429, e.message || AI_BUDGET_MESSAGE);
      if (e.code === 'ai_unavailable')
        throw HfosError.rule('ai_not_configured', 503, AI_UNAVAILABLE_MESSAGE);
      if (e.retryable) throw HfosError.rule('ai_busy', 503, AI_BUSY_MESSAGE);
      throw HfosError.rule(
        'ai_failed',
        502,
        'The AI couldn’t answer the group’s questions just now. Try again, or join it yourself.',
      );
    }
  },
};
