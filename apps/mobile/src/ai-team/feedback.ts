import {
  AiTeammateFeedbackListOutput,
  FEEDBACK_POLL_MS,
  FEEDBACK_SLOW_MS,
  feedbackPending,
  type TeammateFeedbackOut,
} from '@hfos/core';
import * as React from 'react';

import { change, type ChangeResult } from '@/changes';
import { api, unwrap } from '@/lib/api';
import { useNetwork } from '@/lib/network';

/**
 * Feedback on the AI teammate's replies from the phone (HANDSFREEOS_AI_FEEDBACK_IMPLEMENTATION_PLAN.md), as the web's
 * lib/ai-team/feedback.ts makes it: a thumbs up or down, the answer to its quick question, and saving or dropping the
 * rule it suggests, each an online command (`change`), never queued, since what comes next is HandsFreeOS's to say
 * while the person waits; and the feedback on a screen's replies, asked for straight from the API. With no signal
 * a command says "This needs signal.", and the feedback already shown stays.
 */

export type ReplyFeedback = TeammateFeedbackOut;
export type FeedbackList = ReturnType<typeof AiTeammateFeedbackListOutput.parse>;
export type RuleSaved = ChangeResult<'teammate_lesson.apply'>['output'];

export interface GiveFeedback {
  readonly runId?: string;
  /** A conversation's message: the phone doesn't keep which run wrote it, and HandsFreeOS finds it. */
  readonly messageId?: string;
  readonly rating: 'good' | 'bad';
  readonly betterReply?: string | null;
  readonly note?: string | null;
  /** A test only: what the customer said. */
  readonly asked?: string | null;
}

/** What "Retry with the fix" sends the test console: the reply, what it should have said, and why. */
export interface Coaching {
  readonly reply: string;
  readonly better: string | null;
  readonly why: string | null;
}

export function feedbackCalls(workspaceId: string) {
  return {
    give: async (input: GiveFeedback): Promise<ReplyFeedback> =>
      (await change('ai_teammate.give_feedback', { workspaceId, ...input })).output.feedback,
    answer: async (feedbackId: string, answer: string): Promise<ReplyFeedback> =>
      (await change('ai_teammate.answer_feedback', { workspaceId, feedbackId, answer })).output
        .feedback,
    saveRule: async (
      lessonId: string,
      opts: { line?: string; replace?: boolean } = {},
    ): Promise<RuleSaved> =>
      (await change('teammate_lesson.apply', { workspaceId, lessonId, ...opts })).output,
    dropRule: async (lessonId: string): Promise<void> => {
      await change('teammate_lesson.dismiss', { workspaceId, lessonId });
    },
    /** Read through core's schema, so the feedback is in the shape core's words take. */
    list: async (by: {
      runIds?: readonly string[];
      messageIds?: readonly string[];
    }): Promise<FeedbackList> =>
      AiTeammateFeedbackListOutput.parse(
        unwrap(
          await api.POST('/v1/queries/ai_teammate.feedback', {
            body: {
              workspaceId,
              runIds: [...(by.runIds ?? [])],
              messageIds: [...(by.messageIds ?? [])],
            },
          }),
        ),
      ),
  };
}
export type FeedbackCalls = ReturnType<typeof feedbackCalls>;

export interface ReplyFeedbackState {
  readonly calls: FeedbackCalls;
  /** Everyone's feedback on these replies. */
  readonly list: readonly ReplyFeedback[];
  /** Each message's run (when the replies are named by message). */
  readonly runOf: ReadonlyMap<string, string>;
  /** Whether this person may save a rule it suggests (ai_team.manage, as HandsFreeOS says). */
  readonly canSaveRules: boolean;
  /** The AI has been reading this person's feedback for a while. */
  readonly slow: boolean;
  /** Puts one feedback in (what a command just answered), and keeps asking while it's being read. */
  readonly put: (f: ReplyFeedback) => void;
}

/**
 * The feedback on a screen's replies, by run (the test console) or by message (a conversation). While the person's
 * own is being read it asks again every moment, says so when it takes longer than it should, and asks again as soon
 * as signal comes back.
 */
export function useReplyFeedback(
  workspaceId: string,
  by: { readonly runIds?: readonly string[]; readonly messageIds?: readonly string[] },
  initial?: { readonly canSaveRules: boolean },
): ReplyFeedbackState {
  const calls = React.useMemo(() => feedbackCalls(workspaceId), [workspaceId]);
  const { online } = useNetwork();
  const runKey = (by.runIds ?? []).join(',');
  const messageKey = (by.messageIds ?? []).join(',');
  const [list, setList] = React.useState<readonly ReplyFeedback[]>([]);
  const [runOf, setRunOf] = React.useState<ReadonlyMap<string, string>>(new Map());
  const [canSaveRules, setCanSaveRules] = React.useState(initial?.canSaveRules ?? false);
  /** Bumped to ask again; `asked` counts the answers (or failures), so a dropped one is asked again too. */
  const [tick, setTick] = React.useState(0);
  const [asked, setAsked] = React.useState(0);
  const [slow, setSlow] = React.useState(false);
  const since = React.useRef<number | null>(null);

  React.useEffect(() => {
    const runIds = runKey ? runKey.split(',') : [];
    const messageIds = messageKey ? messageKey.split(',') : [];
    if ((!runIds.length && !messageIds.length) || !online) return;
    let live = true;
    calls
      .list({ runIds, messageIds })
      .then((out) => {
        if (!live) return;
        setList(out.feedback);
        setRunOf(new Map(out.messageRuns.map((m) => [m.messageId, m.runId])));
        setCanSaveRules(out.canSaveRules);
      })
      .catch(() => {
        // The thumbs still work; what others said shows next time.
      })
      .finally(() => {
        if (live) setAsked((n) => n + 1);
      });
    return () => {
      live = false;
    };
  }, [calls, runKey, messageKey, online, tick]);

  const pending = feedbackPending(list);
  React.useEffect(() => {
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
  }, [pending, list, asked]);

  const put = React.useCallback((f: ReplyFeedback) => {
    setList((now) => [...now.filter((x) => x.id !== f.id), f]);
    if (f.messageId) setRunOf((now) => new Map(now).set(f.messageId!, f.runId));
  }, []);
  return { calls, list, runOf, canSaveRules, slow, put };
}

/** Which reply: a test's run, or a conversation's message. */
export interface ReplyRef {
  readonly runId?: string | null;
  readonly messageId?: string | null;
}

const isOn = (state: Pick<ReplyFeedbackState, 'runOf'>, reply: ReplyRef) => {
  const runId = reply.runId ?? (reply.messageId ? state.runOf.get(reply.messageId) : undefined);
  return (f: ReplyFeedback) =>
    (!!runId && f.runId === runId) || (!!reply.messageId && f.messageId === reply.messageId);
};

/** The person's own feedback on one reply. */
export function myFeedback(
  state: Pick<ReplyFeedbackState, 'list' | 'runOf'>,
  reply: ReplyRef,
): ReplyFeedback | null {
  const on = isOn(state, reply);
  return state.list.find((f) => f.mine && on(f)) ?? null;
}

/** Everyone's feedback on one reply. */
export function feedbackOn(
  state: Pick<ReplyFeedbackState, 'list' | 'runOf'>,
  reply: ReplyRef,
): ReplyFeedback[] {
  return state.list.filter(isOn(state, reply));
}
