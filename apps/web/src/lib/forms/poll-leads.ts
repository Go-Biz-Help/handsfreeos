'use client';
/**
 * The AI helping set up a live poll for who to follow up with (HANDSFREEOS_WEBINARS_IMPLEMENTATION_PLAN.md, parts 4
 * and 5): points suggested for each answer, and the poll's questions drafted from the webinar's goal and its slides.
 * The worker answers (apps/worker/src/forms/poll-draft-routes.ts); the editor puts what comes back in the draft as
 * ordinary edits, so they're saved, undone and changed like any other.
 */
import {
  aiLimitReached,
  liveOf,
  newChoiceId,
  newQuestionId,
  pointsKeysOf,
  pollLeadsOf,
  QUESTION_CONFIGS,
  type FormDefinition,
  type FormOp,
  type Question,
  type QuestionInput,
  type QuestionType,
} from '@hfos/core';
import { ApiError, errorMessage } from '@/lib/api/errors';
import { workerPost } from '@/lib/api/worker';

interface Lines {
  readonly stayed: number;
  readonly hot: number;
  readonly warm: number;
}

interface PointsAnswer {
  readonly questions: readonly { readonly id: string; readonly points: Record<string, number> }[];
  readonly lines: Lines;
}

interface DraftAnswer {
  readonly questions: readonly {
    readonly type: QuestionType;
    readonly title: string;
    readonly choices: readonly string[];
    readonly cues: readonly string[];
    readonly slide: number | null;
    readonly points: Record<string, number>;
  }[];
  readonly lines: Lines;
}

/** The poll's own follow-up with the AI's lines in it: what staying is worth, and Hot and Warm. */
const leadsOp = (definition: FormDefinition, lines: Lines): FormOp => ({
  op: 'set_form',
  patch: { leads: { ...pollLeadsOf(definition), ...lines } },
});

/**
 * Asks the AI what each answer of these questions is worth (and the poll's lines, when it's every question), and
 * hands back the edits that put them in.
 */
export async function suggestPoints(
  workspaceId: string,
  definition: FormDefinition,
  questions: readonly Question[],
  goal = '',
): Promise<FormOp[]> {
  const scorable = questions.filter((q) => pointsKeysOf(q).length).slice(0, 30);
  if (!scorable.length) return [];
  const answer = await workerPost<PointsAnswer>('/v1/forms/ai/points', {
    workspaceId,
    title: definition.title,
    goal,
    questions: scorable.map((q) => ({
      id: q.id,
      type: q.type,
      title: q.title,
      answers: pointsKeysOf(q).slice(0, 60),
    })),
  });
  const byId = new Map(scorable.map((q) => [q.id, q]));
  const ops: FormOp[] = answer.questions.flatMap((a) => {
    const q = byId.get(a.id);
    if (!q) return [];
    return [
      {
        op: 'update_question' as const,
        questionId: q.id,
        patch: { live: { ...liveOf(q), points: { ...a.points } } },
      },
    ];
  });
  // The lines fit the whole poll, so they come only with every question's points.
  return scorable.length > 1 ? [...ops, leadsOp(definition, answer.lines)] : ops;
}

/** Asks the AI to draft the poll's questions from the goal (and the slides), and hands back the edits that add them. */
export async function draftPoll(
  workspaceId: string,
  definition: FormDefinition,
  goal: string,
  count: number,
): Promise<FormOp[]> {
  const answer = await workerPost<DraftAnswer>('/v1/forms/ai/draft-poll', {
    workspaceId,
    title: definition.title,
    goal,
    slidesFileId: definition.slides?.fileId ?? null,
    count,
  });
  const page = definition.pages[definition.pages.length - 1]!;
  const ops: FormOp[] = answer.questions.flatMap((d) => {
    const ids = d.choices.map(() => newChoiceId());
    // A choice's points come keyed by its number; here it gets its id.
    const points = Object.fromEntries(
      Object.entries(d.points).map(([key, n]) =>
        d.type === 'choice' || d.type === 'checkboxes'
          ? [ids[Number(key) - 1] ?? key, n]
          : [key, n],
      ),
    );
    const config = QUESTION_CONFIGS[d.type].safeParse(
      d.type === 'choice' || d.type === 'checkboxes'
        ? { choices: d.choices.map((label, i) => ({ id: ids[i], label })) }
        : d.type === 'button'
          ? { action: 'talk', label: d.choices[0] ?? 'Talk to someone' }
          : {},
    );
    if (!config.success) return [];
    return [
      {
        op: 'add_question' as const,
        pageId: page.id,
        index: null,
        question: {
          id: newQuestionId(),
          type: d.type,
          title: d.title,
          config: config.data,
          live: { cues: [...d.cues], slide: d.slide, points },
        } as QuestionInput,
      },
    ];
  });
  return ops.length ? [...ops, leadsOp(definition, answer.lines)] : [];
}

/** Why the AI's suggestion didn't come, in plain words. */
export function pollAiErrorMessage(e: unknown, fallback: string): string {
  if (!(e instanceof ApiError)) return errorMessage(e);
  const why = e.rule ?? e.code;
  if (e.status === 0) return 'The AI isn’t reachable right now. Try again in a minute.';
  if (e.status === 403) return 'Only people who can change forms can do this.';
  if (why === 'budget_reached') return e.message || aiLimitReached();
  return e.message || fallback;
}
