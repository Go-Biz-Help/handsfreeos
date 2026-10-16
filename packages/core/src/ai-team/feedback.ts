/**
 * Feedback on the AI teammate's replies as the screens show it (HANDSFREEOS_AI_FEEDBACK_IMPLEMENTATION_PLAN.md):
 * each person's thumbs, words and what the worker made of them, with the rule it suggested. Read as the person,
 * so row-level security keeps it to the replies they may see. Server-only.
 */
import { rows, sql, type Tx } from '@hfos/db/client';
import { userNames, uuidArray } from '../calendar/load';
import { lessonConflictOf } from '../commands/teammate-lesson';
import {
  FEEDBACK_LEARN,
  type FeedbackLearn,
  type TeammateFeedbackOut,
} from '../schemas/teammate-feedback';

interface FeedbackRow extends Record<string, unknown> {
  id: string;
  run_id: string;
  message_id: string | null;
  is_test: boolean;
  rating: string;
  better_reply: string | null;
  note: string | null;
  learn: string;
  learn_why: string | null;
  question: string | null;
  choices: string[] | null;
  answer: string | null;
  lesson_id: string | null;
  line: string | null;
  why: string | null;
  lesson_status: string | null;
  conflict: unknown;
  created_by: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

const iso = (v: Date | string) => new Date(v).toISOString();
const learnOf = (v: string): FeedbackLearn =>
  (FEEDBACK_LEARN as readonly string[]).includes(v) ? (v as FeedbackLearn) : 'none';
const lessonStatusOf = (v: string | null): 'open' | 'applied' | 'dismissed' =>
  v === 'applied' || v === 'dismissed' ? v : 'open';

/** The feedback on these runs, or with these ids, oldest first. `me` marks the person's own. */
export async function loadFeedback(
  tx: Tx,
  workspaceId: string,
  me: string | null,
  by: { readonly runIds?: readonly string[]; readonly ids?: readonly string[] },
): Promise<TeammateFeedbackOut[]> {
  const runIds = by.runIds ?? [];
  const ids = by.ids ?? [];
  if (!runIds.length && !ids.length) return [];
  const list = await rows<FeedbackRow>(
    tx,
    sql`select f.id, f.run_id, f.message_id, f.is_test, f.rating, f.better_reply, f.note, f.learn, f.learn_why,
          f.question, f.choices, f.answer, f.lesson_id, l.line, l.why, l.status as lesson_status, l.conflict,
          f.created_by, f.created_at, f.updated_at
        from app.teammate_feedback f
        left join app.teammate_lessons l on l.id = f.lesson_id
        where f.workspace_id = ${workspaceId}
          and (f.run_id = any(${uuidArray([...runIds])}) or f.id = any(${uuidArray([...ids])}))
        order by f.created_at, f.id`,
  );
  const names = await userNames(
    tx,
    list.map((r) => r.created_by).filter((x): x is string => !!x),
  );
  return list.map((r) => ({
    id: r.id,
    runId: r.run_id,
    messageId: r.message_id,
    isTest: r.is_test,
    rating: r.rating === 'good' ? 'good' : 'bad',
    betterReply: r.better_reply,
    note: r.note,
    learn: learnOf(r.learn),
    learnWhy: r.learn_why,
    question: r.question,
    choices: r.choices ?? [],
    answer: r.answer,
    lesson:
      r.lesson_id && r.line
        ? {
            id: r.lesson_id,
            line: r.line,
            why: r.why,
            status: lessonStatusOf(r.lesson_status),
            conflict: lessonConflictOf(r.conflict),
          }
        : null,
    mine: !!me && r.created_by === me,
    by: r.created_by ? { id: r.created_by, name: names.get(r.created_by) ?? 'Someone' } : null,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  }));
}
