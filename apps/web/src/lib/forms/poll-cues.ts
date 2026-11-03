'use client';
/**
 * The AI writing a live poll's when-to-ask phrases (HANDSFREEOS_WEBINARS_IMPLEMENTATION_PLAN.md, part 3): the worker
 * writes them (apps/worker/src/forms/poll-cue-routes.ts), and the editor puts them in the draft as ordinary edits, so
 * they're saved, undone and changed like any other. A poll with slides (part 4) has them read too, and each question
 * gets the slide it goes with.
 */
import {
  aiLimitReached,
  allQuestions,
  liveOf,
  type FormDefinition,
  type FormOp,
  type Question,
} from '@hfos/core';
import { ApiError, errorMessage } from '@/lib/api/errors';
import { workerPost } from '@/lib/api/worker';

interface CueAnswer {
  readonly questions: readonly {
    readonly id: string;
    readonly cues: readonly string[];
    readonly slide?: number | null;
  }[];
}

const forModel = (q: Question) => {
  const config = q.config as Record<string, unknown>;
  return {
    id: q.id,
    type: q.type,
    title: q.title,
    help: q.help,
    choices:
      q.type === 'choice' || q.type === 'checkboxes'
        ? (config.choices as { label: string }[]).map((c) => c.label)
        : q.type === 'button'
          ? [String(config.label ?? '')]
          : [],
  };
};

/** The questions with no phrases yet, or just the one asked for. */
export function questionsWanting(definition: FormDefinition, only?: string): Question[] {
  return allQuestions(definition).filter((q) =>
    only ? q.id === only : liveOf(q).cues.length === 0,
  );
}

/** Asks the AI for phrases for these questions, and hands back the edits that put them in. */
export async function writeCues(
  workspaceId: string,
  definition: FormDefinition,
  questions: readonly Question[],
): Promise<FormOp[]> {
  if (!questions.length) return [];
  const answer = await workerPost<CueAnswer>('/v1/forms/ai/cues', {
    workspaceId,
    title: definition.title,
    questions: questions.slice(0, 30).map(forModel),
    slidesFileId: definition.slides?.fileId ?? null,
  });
  const byId = new Map(questions.map((q) => [q.id, q]));
  return answer.questions.flatMap((a) => {
    const q = byId.get(a.id);
    if (!q || (!a.cues.length && !a.slide)) return [];
    const live = liveOf(q);
    return [
      {
        op: 'update_question' as const,
        questionId: q.id,
        patch: {
          live: {
            ...live,
            cues: a.cues.length ? [...a.cues] : live.cues,
            // The slide the AI picked; with none, the one the business picked stays.
            slide: a.slide ?? live.slide ?? null,
          },
        },
      },
    ];
  });
}

/** Why the phrases didn't come, in plain words. */
export function cueErrorMessage(e: unknown): string {
  if (!(e instanceof ApiError)) return errorMessage(e);
  const why = e.rule ?? e.code;
  if (e.status === 0) return 'The AI isn’t reachable right now. Try again in a minute.';
  if (e.status === 403) return 'Only people who can change forms can write these.';
  if (why === 'budget_reached') return e.message || aiLimitReached();
  return (
    e.message || 'The AI couldn’t write the phrases this time. Try again, or write them yourself.'
  );
}
