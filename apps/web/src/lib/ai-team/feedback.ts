'use client';
/**
 * Feedback on the AI teammate's replies, and its Instructions list (HANDSFREEOS_AI_FEEDBACK_IMPLEMENTATION_PLAN.md):
 * every call the screens make, and `useReplyFeedback`, which keeps the feedback on the replies on a screen and asks
 * again while the AI is reading the person's own.
 */
import { FEEDBACK_POLL_MS, FEEDBACK_SLOW_MS, feedbackPending } from '@hfos/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiBrowser, unwrap } from '@/lib/api/client';
import type { Ok } from '@/lib/api/types';

export type FeedbackList = Ok<'/v1/queries/ai_teammate.feedback'>;
export type ReplyFeedback = FeedbackList['feedback'][number];
export type ReviewPage = Ok<'/v1/queries/ai_teammate.review'>;
export type ReviewItem = ReviewPage['items'][number];
export type InstructionList = Ok<'/v1/queries/teammate_instruction.list'>;
export type Instruction = InstructionList['instructions'][number];
export type LessonSaved = Ok<'/v1/commands/teammate_lesson.apply'>;

export interface GiveFeedback {
  readonly runId?: string;
  readonly messageId?: string;
  readonly rating: 'good' | 'bad';
  readonly betterReply?: string | null;
  readonly note?: string | null;
  /** A test only: what the customer said. */
  readonly asked?: string | null;
}

export function feedbackActions(workspaceId: string) {
  const api = () => apiBrowser();
  return {
    give: async (input: GiveFeedback): Promise<ReplyFeedback> =>
      unwrap(
        await api().POST('/v1/commands/ai_teammate.give_feedback', {
          body: { workspaceId, ...input },
        }),
      ).feedback,
    answer: async (feedbackId: string, answer: string): Promise<ReplyFeedback> =>
      unwrap(
        await api().POST('/v1/commands/ai_teammate.answer_feedback', {
          body: { workspaceId, feedbackId, answer },
        }),
      ).feedback,
    list: async (by: {
      runIds?: readonly string[];
      messageIds?: readonly string[];
    }): Promise<FeedbackList> =>
      unwrap(
        await api().POST('/v1/queries/ai_teammate.feedback', {
          body: {
            workspaceId,
            runIds: [...(by.runIds ?? [])],
            messageIds: [...(by.messageIds ?? [])],
          },
        }),
      ),
    saveRule: async (
      lessonId: string,
      opts: { line?: string; replace?: boolean } = {},
    ): Promise<LessonSaved> =>
      unwrap(
        await api().POST('/v1/commands/teammate_lesson.apply', {
          body: { workspaceId, lessonId, ...opts },
        }),
      ),
    dropRule: async (lessonId: string): Promise<void> => {
      unwrap(
        await api().POST('/v1/commands/teammate_lesson.dismiss', {
          body: { workspaceId, lessonId },
        }),
      );
    },
    review: async (input: {
      show: 'unrated' | 'all';
      cursor: string | null;
    }): Promise<ReviewPage> =>
      unwrap(
        await api().POST('/v1/queries/ai_teammate.review', {
          body: {
            workspaceId,
            show: input.show,
            ...(input.cursor ? { cursor: input.cursor } : {}),
          },
        }),
      ),
    instructions: async (): Promise<InstructionList> =>
      unwrap(await api().POST('/v1/queries/teammate_instruction.list', { body: { workspaceId } })),
    addInstruction: async (body: string): Promise<Instruction> =>
      unwrap(
        await api().POST('/v1/commands/teammate_instruction.create', {
          body: { workspaceId, body },
        }),
      ).instruction,
    editInstruction: async (instructionId: string, body: string): Promise<Instruction> =>
      unwrap(
        await api().POST('/v1/commands/teammate_instruction.update', {
          body: { workspaceId, instructionId, body },
        }),
      ).instruction,
    deleteInstruction: async (instructionId: string): Promise<void> => {
      unwrap(
        await api().POST('/v1/commands/teammate_instruction.delete', {
          body: { workspaceId, instructionId },
        }),
      );
    },
  };
}
export type FeedbackActions = ReturnType<typeof feedbackActions>;

export interface ReplyFeedbackState {
  /** Everyone's feedback on these replies. */
  readonly list: readonly ReplyFeedback[];
  /** Each message's run (when the replies are named by message). */
  readonly runOf: ReadonlyMap<string, string>;
  readonly canSaveRules: boolean;
  /** The AI has been reading this person's feedback for a while. */
  readonly slow: boolean;
  /** Puts one feedback in (what a command just answered), and keeps asking while it's being read. */
  readonly put: (f: ReplyFeedback) => void;
  /** Asks again now. */
  readonly refresh: () => void;
}

/**
 * The feedback on a screen's replies, by run or by message. While the person's own is being read it asks again every
 * moment, and says so when it takes longer than it should.
 */
export function useReplyFeedback(
  workspaceId: string,
  by: { readonly runIds?: readonly string[]; readonly messageIds?: readonly string[] },
  initial?: { readonly list: readonly ReplyFeedback[]; readonly canSaveRules: boolean },
): ReplyFeedbackState {
  const actions = useMemo(() => feedbackActions(workspaceId), [workspaceId]);
  const runKey = (by.runIds ?? []).join(',');
  const messageKey = (by.messageIds ?? []).join(',');
  const [list, setList] = useState<readonly ReplyFeedback[]>(initial?.list ?? []);
  const [runOf, setRunOf] = useState<ReadonlyMap<string, string>>(new Map());
  const [canSaveRules, setCanSaveRules] = useState(initial?.canSaveRules ?? false);
  const [tick, setTick] = useState(0);
  const [slow, setSlow] = useState(false);
  const since = useRef<number | null>(null);

  useEffect(() => {
    const runIds = runKey ? runKey.split(',') : [];
    const messageIds = messageKey ? messageKey.split(',') : [];
    if (!runIds.length && !messageIds.length) return;
    let live = true;
    actions
      .list({ runIds, messageIds })
      .then((out) => {
        if (!live) return;
        setList(out.feedback);
        setRunOf(new Map(out.messageRuns.map((m) => [m.messageId, m.runId])));
        setCanSaveRules(out.canSaveRules);
      })
      .catch(() => {
        // The thumbs still work; what others said shows next time.
      });
    return () => {
      live = false;
    };
  }, [actions, runKey, messageKey, tick]);

  const pending = feedbackPending(list);
  useEffect(() => {
    if (!pending) {
      since.current = null;
      setSlow(false);
      return;
    }
    since.current ??= Date.now();
    const t = setTimeout(() => {
      if (since.current && Date.now() - since.current > FEEDBACK_SLOW_MS) setSlow(true);
      setTick((n) => n + 1);
    }, FEEDBACK_POLL_MS);
    return () => clearTimeout(t);
  }, [pending, list]);

  const put = useCallback((f: ReplyFeedback) => {
    setList((now) => [...now.filter((x) => x.id !== f.id), f]);
    if (f.messageId) setRunOf((now) => new Map(now).set(f.messageId!, f.runId));
  }, []);
  const refresh = useCallback(() => setTick((n) => n + 1), []);
  return { list, runOf, canSaveRules, slow, put, refresh };
}

/** The person's own feedback on one reply, by its run or its message. */
export function myFeedback(
  state: Pick<ReplyFeedbackState, 'list' | 'runOf'>,
  reply: { readonly runId?: string | null; readonly messageId?: string | null },
): ReplyFeedback | null {
  const runId = reply.runId ?? (reply.messageId ? state.runOf.get(reply.messageId) : undefined);
  return (
    state.list.find(
      (f) =>
        f.mine && (f.runId === runId || (!!reply.messageId && f.messageId === reply.messageId)),
    ) ?? null
  );
}

/** Everyone's feedback on one reply. */
export function feedbackOn(
  state: Pick<ReplyFeedbackState, 'list' | 'runOf'>,
  reply: { readonly runId?: string | null; readonly messageId?: string | null },
): ReplyFeedback[] {
  const runId = reply.runId ?? (reply.messageId ? state.runOf.get(reply.messageId) : undefined);
  return state.list.filter(
    (f) => f.runId === runId || (!!reply.messageId && f.messageId === reply.messageId),
  );
}
