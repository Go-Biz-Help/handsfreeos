/**
 * Coaching the AI teammate (HANDSFREEOS_AI_FEEDBACK_IMPLEMENTATION_PLAN.md): the feedback on the replies on a
 * screen, Review (what it sent on its own, to rate), and its Instructions list.
 */
import { and, asc, eq } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { teammateInstructions } from '@hfos/db/schema';
import { loadFeedback } from '../ai-team/feedback';
import { loadTeammate } from '../ai-team/load';
import { userNames, uuidArray } from '../calendar/load';
import { instructionOut } from '../commands/teammate-instruction';
import { userIdOf } from '../kernel/actor';
import { defineQuery } from '../kernel/define';
import { scopeCan } from '../kernel/execute';
import { decodeCursor, page } from '../kernel/pagination';
import {
  AiTeammateFeedbackListInput,
  AiTeammateFeedbackListOutput,
  AiTeammateReviewInput,
  AiTeammateReviewOutput,
  INSTRUCTIONS_MAX,
  TeammateInstructionListInput,
  TeammateInstructionListOutput,
  type ReviewItemOut,
} from '../schemas/teammate-feedback';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

const iso = (v: Date | string) => new Date(v).toISOString();
const SORT_KEY = (column: ReturnType<typeof sql>) =>
  sql`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/** How far back Review's count of unrated replies looks. */
export const REVIEW_DAYS = 30;

export const aiTeammateFeedbackList = defineQuery({
  name: 'ai_teammate.feedback',
  description:
    'The feedback people gave on these replies of the AI teammate, with what the AI made of it: a rule waiting for an OK, a question, or nothing to learn.',
  input: AiTeammateFeedbackListInput,
  output: AiTeammateFeedbackListOutput,
  permission: 'inbox.use',
  scope: inWorkspace,
  async handler(ctx, input) {
    const messageRuns = input.messageIds.length
      ? await rows<{ messageId: string; runId: string }>(
          ctx.tx,
          sql`select m.id as "messageId", m.ai_run_id as "runId" from app.messages m
              where m.workspace_id = ${input.workspaceId} and m.id = any(${uuidArray(input.messageIds)})
                and m.ai_run_id is not null`,
        )
      : [];
    return {
      feedback: await loadFeedback(ctx.tx, input.workspaceId, userIdOf(ctx.actor), {
        runIds: [...new Set([...input.runIds, ...messageRuns.map((m) => m.runId)])],
      }),
      messageRuns,
      canSaveRules: scopeCan(ctx.scope, 'ai_team.manage'),
    };
  },
});

interface ReviewRow extends Record<string, unknown> {
  run_id: string;
  message_id: string;
  conversation_id: string | null;
  channel: string | null;
  person_id: string | null;
  person_name: string;
  triggered_by: string;
  has_asked: boolean;
  asked: string | null;
  reply: string;
  sent_at: Date | string;
  sort_key: string;
}

const whyOf = (r: ReviewRow): ReviewItemOut['why'] => {
  if (r.has_asked) return 'answer';
  if (r.triggered_by === 'lead.created' || r.triggered_by === 'workflow') return 'first_message';
  if (r.triggered_by.includes('follow')) return 'follow_up';
  return 'other';
};

const clip = (s: string | null, max: number) =>
  s && s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;

export const aiTeammateReview = defineQuery({
  name: 'ai_teammate.review',
  description:
    'What the AI teammate sent on its own (no person approved it), newest first, with what the customer said and any feedback on it; by default only replies nobody has rated yet.',
  input: AiTeammateReviewInput,
  output: AiTeammateReviewOutput,
  permission: 'inbox.use',
  scope: inWorkspace,
  async handler(ctx, input) {
    const ws = input.workspaceId;
    const cursor = decodeCursor(input.cursor);
    // The first message each run sent that no person approved; row-level security keeps it to the threads this
    // person may see. A live call's words aren't a message, so they aren't here.
    const sentAlone = sql`
      from app.ai_teammate_runs r
      join lateral (
        select m.id, m.channel, m.occurred_at, m.body_text from app.messages m
        where m.ai_run_id = r.id and m.direction = 'outbound' and m.approved_by is null
        order by m.created_at limit 1
      ) m on true
      left join app.people p on p.id = r.person_id
      where r.workspace_id = ${ws} and not r.is_test and r.outcome = 'replied'`;
    const unrated = sql`not exists (select 1 from app.teammate_feedback f where f.run_id = r.id)`;
    const [count] = await rows<{ n: number }>(
      ctx.tx,
      sql`select count(*)::int as n ${sentAlone}
            and m.occurred_at > now() - ${`${REVIEW_DAYS} days`}::interval and ${unrated}`,
    );
    const list = await rows<ReviewRow>(
      ctx.tx,
      sql`select * from (
            select r.id as run_id, m.id as message_id, r.conversation_id, m.channel::text as channel,
              r.person_id,
              coalesce(nullif(btrim(p.first_name || ' ' || p.last_name), ''), 'Customer') as person_name,
              r.triggered_by, coalesce(cardinality(r.message_ids), 0) > 0 as has_asked,
              (select string_agg(nullif(btrim(cm.body_text), ''), E'\n' order by cm.occurred_at, cm.created_at)
                from app.messages cm where cm.id = any(r.message_ids)) as asked,
              coalesce(nullif(btrim(m.body_text), ''), r.reply_text, '') as reply,
              m.occurred_at as sent_at, ${SORT_KEY(sql`m.occurred_at`)} as sort_key
            ${sentAlone}
            ${input.show === 'unrated' ? sql`and ${unrated}` : sql``}
          ) x
          ${cursor ? sql`where (x.sort_key, x.run_id) < (${cursor.sort}, ${cursor.id}::uuid)` : sql``}
          order by x.sort_key desc, x.run_id desc
          limit ${input.limit + 1}`,
    );
    const result = page(list, input.limit, (r) => ({ sort: r.sort_key, id: r.run_id }));
    const feedback = await loadFeedback(ctx.tx, ws, userIdOf(ctx.actor), {
      runIds: result.items.map((r) => r.run_id),
    });
    return {
      items: result.items.map((r) => ({
        runId: r.run_id,
        messageId: r.message_id,
        conversationId: r.conversation_id,
        channel: r.channel,
        person: r.person_id ? { id: r.person_id, fullName: r.person_name } : null,
        why: whyOf(r),
        asked: clip(r.asked, 1000),
        reply: r.reply,
        sentAt: iso(r.sent_at),
        feedback: feedback.filter((f) => f.runId === r.run_id),
      })),
      unrated: count?.n ?? 0,
      nextCursor: result.nextCursor,
      canSaveRules: scopeCan(ctx.scope, 'ai_team.manage'),
    };
  },
});

export const teammateInstructionList = defineQuery({
  name: 'teammate_instruction.list',
  description:
    'The AI teammate’s Instructions list, oldest first: the rules it reads in full on every reply, call and test, and where each came from.',
  input: TeammateInstructionListInput,
  output: TeammateInstructionListOutput,
  permission: 'workspace.read',
  scope: inWorkspace,
  async handler(ctx, input) {
    const teammate = await loadTeammate(ctx.tx, input.workspaceId);
    const canManage = scopeCan(ctx.scope, 'ai_team.manage');
    if (!teammate)
      return { teammateId: null, name: null, instructions: [], max: INSTRUCTIONS_MAX, canManage };
    const list = await ctx.tx
      .select()
      .from(teammateInstructions)
      .where(
        and(
          eq(teammateInstructions.workspaceId, input.workspaceId),
          eq(teammateInstructions.teammateId, teammate.id),
        ),
      )
      .orderBy(asc(teammateInstructions.createdAt), asc(teammateInstructions.id));
    const names = await userNames(
      ctx.tx,
      list.map((i) => i.createdBy).filter((x): x is string => !!x),
    );
    return {
      teammateId: teammate.id,
      name: teammate.name,
      instructions: list.map((i) =>
        instructionOut(i, i.createdBy ? (names.get(i.createdBy) ?? null) : null),
      ),
      max: INSTRUCTIONS_MAX,
      canManage,
    };
  },
});
