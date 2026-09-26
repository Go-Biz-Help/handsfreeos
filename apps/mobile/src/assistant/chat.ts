import {
  ASSISTANT_CONSENT_VERSION,
  ASSISTANT_WORDS,
  type AssistantCard,
  type AssistantEvent,
  type AssistantNoticeCode,
  type PageRecord,
} from '@hfos/core';
import * as React from 'react';

import { toast } from '@/components/ui/toast';
import { api, errorMessage, unwrap } from '@/lib/api';
import { deviceStore } from '@/lib/device-store';
import { useNetwork } from '@/lib/network';

import { AssistantError, assistantConfigured, stopRun, streamAnswer } from './stream';

/**
 * Ask HandsFreeOS on the phone: the chat on screen, streamed in from the worker, and where each card stands. The
 * same shape as the web's panel (`apps/web/src/components/assistant/assistant-provider.tsx`), with two differences
 * the canvas asks for:
 *
 * - **It needs signal.** With none, the question stays in the chat and the answer says so, with Ask again. Nothing
 *   is queued: the outbox is for changes, and a question isn't one.
 * - **One chat at a time.** The phone opens a chat full screen rather than beside a page, so there is no docking,
 *   no keyboard shortcut and no page record to send.
 */

export interface Step {
  readonly id: string;
  readonly label: string;
  readonly status: 'running' | 'done' | 'failed';
}

/** Why an answer stopped short. `no_signal` is the phone's own (design/m10/Assistant.dc.html). */
export type NoticeCode = AssistantNoticeCode | 'no_signal';
export interface Notice {
  readonly code: NoticeCode;
  readonly message: string;
}

export interface QuestionMessage {
  readonly key: string;
  readonly role: 'user';
  readonly text: string;
  readonly createdAt: string;
}
export interface AnswerMessage {
  readonly key: string;
  readonly role: 'assistant';
  readonly text: string;
  readonly cards: readonly AssistantCard[];
  /** What it looked at or did while answering. Not saved, so a reopened chat has none. */
  readonly steps: readonly Step[];
  readonly live: boolean;
  readonly notice: Notice | null;
  /** The question it answers, for Ask again. */
  readonly question: string | null;
  readonly createdAt: string;
}
export type ChatMessage = QuestionMessage | AnswerMessage;

export type ToolStatus =
  'done' | 'failed' | 'awaiting_confirmation' | 'confirmed' | 'cancelled' | 'expired';

/** Where a confirmation or "done" card stands (the worker's tool call). */
export interface CallState {
  readonly status: ToolStatus;
  readonly tool: string | null;
  readonly outcome: string | null;
  readonly error: string | null;
  readonly href: string | null;
  readonly undone?: boolean;
  /** Said on the card instead of the usual result line. */
  readonly note?: string | null;
}

/** missing: the worker has no model to answer with, or this build doesn't know where the worker is. */
/**
 * `missing` is the worker having no model; `not-in-build` is this copy of the app having no worker address at all
 * (`EXPO_PUBLIC_WORKER_URL`). Both stop the Assistant, but only one of them is something setting the Assistant up
 * would fix, so they say different things.
 */
export type Setup = 'unknown' | 'ready' | 'missing' | 'not-in-build';

/** Whether the Assistant is off, whichever of the two reasons it is. */
export function setupIsOff(setup: Setup): boolean {
  return setup === 'missing' || setup === 'not-in-build';
}

export function upsertStep(steps: readonly Step[], step: Step): Step[] {
  return steps.some((s) => s.id === step.id)
    ? steps.map((s) => (s.id === step.id ? step : s))
    : [...steps, step];
}

/** Steps still spinning when an answer ends: done if it finished, failed if it didn't. */
export const settleSteps = (steps: readonly Step[], finished: boolean): Step[] =>
  steps.map((s) => (s.status === 'running' ? { ...s, status: finished ? 'done' : 'failed' } : s));

/** Cards left waiting lapse once the person asks something else (the worker expires them too). */
export const lapseCalls = (calls: Record<string, CallState>): Record<string, CallState> =>
  Object.fromEntries(
    Object.entries(calls).map(([id, c]) => [
      id,
      c.status === 'awaiting_confirmation' ? { ...c, status: 'expired' as const } : c,
    ]),
  );

/** What went wrong, as the notice card reads it. */
export function noticeFor(error: unknown): Notice {
  if (error instanceof AssistantError) {
    switch (error.failure) {
      case 'no_signal':
        return { code: 'no_signal', message: ASSISTANT_WORDS.offline.body };
      case 'not_configured':
        return { code: 'failed', message: error.message };
      case 'unauthenticated':
        return { code: 'forbidden', message: error.message };
      case 'already_running':
        return { code: 'already_running', message: error.message };
      case 'budget_reached':
        return { code: 'budget_reached', message: error.message };
      case 'busy':
        return { code: 'busy', message: error.message };
      default:
        return { code: 'failed', message: error.message };
    }
  }
  if (error instanceof TypeError)
    return { code: 'no_signal', message: ASSISTANT_WORDS.offline.body };
  return { code: 'failed', message: 'Something went wrong. Try again.' };
}

const consentKey = (userId: string) => `person.${userId}.assistantConsent`;

/** The OK as this phone last saw it, so the step doesn't flash before the answer comes back. */
export function rememberedConsent(userId: string): boolean | null {
  const stored = deviceStore.get<{ version: number }>(consentKey(userId));
  return stored ? stored.version >= ASSISTANT_CONSENT_VERSION : null;
}

function rememberConsent(userId: string, given: boolean): void {
  if (given) deviceStore.set(consentKey(userId), { version: ASSISTANT_CONSENT_VERSION });
  else deviceStore.remove(consentKey(userId));
}

export interface AssistantChat {
  readonly messages: readonly ChatMessage[];
  readonly calls: Readonly<Record<string, CallState>>;
  readonly threadId: string | null;
  readonly running: boolean;
  readonly loading: boolean;
  readonly setup: Setup;
  readonly paused: boolean;
  readonly online: boolean;
  /** Null until the phone knows whether the person has said OK. */
  readonly consentNeeded: boolean | null;
  giveConsent(): Promise<void>;
  /**
   * Asks a question; `spoken` when it was said out loud, so the answer is written to be heard. Answers whether it
   * went (not while another answer is coming, or before the person's OK).
   */
  ask(text: string, opts?: { readonly spoken?: boolean }): boolean;
  retry(answerKey: string): void;
  stop(): void;
  newChat(): void;
  openThread(threadId: string): Promise<void>;
  setCall(toolCallId: string, patch: Partial<CallState>): void;
  forgetThread(threadId: string): void;
}

const newKey = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/** The chat for one business. Lives for as long as the screen is open. */
export function useAssistantChat(
  workspaceId: string,
  userId: string,
  page: PageRecord | null = null,
): AssistantChat {
  const { online } = useNetwork();
  const [messages, setMessages] = React.useState<ChatMessage[]>([]);
  const [calls, setCalls] = React.useState<Record<string, CallState>>({});
  const [threadId, setThreadId] = React.useState<string | null>(null);
  const [running, setRunning] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [setup, setSetup] = React.useState<Setup>(
    assistantConfigured() ? 'unknown' : 'not-in-build',
  );
  const [paused, setPaused] = React.useState(false);
  const [consentNeeded, setConsentNeeded] = React.useState<boolean | null>(() => {
    const known = rememberedConsent(userId);
    return known === null ? null : !known;
  });

  const threadRef = React.useRef<string | null>(null);
  const streamRef = React.useRef<AbortController | null>(null);
  const runRef = React.useRef<string | null>(null);
  const answerRef = React.useRef<string | null>(null);
  const waitingQuestion = React.useRef<string | null>(null);
  const pageRef = React.useRef(page);
  pageRef.current = page;
  const loadRef = React.useRef(0);

  const setThread = React.useCallback((id: string | null) => {
    threadRef.current = id;
    setThreadId(id);
  }, []);

  const detach = React.useCallback(() => {
    streamRef.current?.abort();
    streamRef.current = null;
    runRef.current = null;
    answerRef.current = null;
    setRunning(false);
  }, []);

  const patchAnswer = React.useCallback((key: string, fn: (m: AnswerMessage) => AnswerMessage) => {
    setMessages((all) => all.map((m) => (m.key === key && m.role === 'assistant' ? fn(m) : m)));
  }, []);

  const setCall = React.useCallback((id: string, patch: Partial<CallState>) => {
    setCalls((all) => ({
      ...all,
      [id]: {
        ...{
          status: 'awaiting_confirmation' as ToolStatus,
          tool: null,
          outcome: null,
          error: null,
          href: null,
        },
        ...all[id],
        ...patch,
      },
    }));
  }, []);

  const ask = React.useCallback(
    (raw: string, opts: { readonly spoken?: boolean } = {}): boolean => {
      const text = raw.trim();
      if (!text || streamRef.current) return false;
      // Nothing goes to the AI service before the person's OK: the question waits for it.
      if (consentNeeded) {
        waitingQuestion.current = text;
        return false;
      }
      const now = new Date().toISOString();
      const userKey = newKey('q');
      const answerKey = newKey('a');
      if (threadRef.current) setCalls(lapseCalls);
      setMessages((all) => [
        ...all,
        { key: userKey, role: 'user', text, createdAt: now },
        {
          key: answerKey,
          role: 'assistant',
          text: '',
          cards: [],
          steps: [],
          live: true,
          notice: null,
          question: text,
          createdAt: now,
        },
      ]);
      const controller = new AbortController();
      streamRef.current = controller;
      answerRef.current = answerKey;
      runRef.current = null;
      setRunning(true);

      const finish = (notice: Notice | null) =>
        patchAnswer(answerKey, (m) => ({
          ...m,
          live: false,
          steps: settleSteps(m.steps, !notice),
          notice: notice ?? m.notice,
        }));

      const onEvent = (event: AssistantEvent) => {
        if (controller.signal.aborted) return;
        switch (event.type) {
          case 'run':
            runRef.current = event.runId;
            if (threadRef.current !== event.threadId) setThread(event.threadId);
            setSetup('ready');
            break;
          case 'step':
            patchAnswer(answerKey, (m) => ({
              ...m,
              steps: upsertStep(m.steps, {
                id: event.id,
                label: event.label,
                status: event.status,
              }),
            }));
            break;
          case 'text':
            patchAnswer(answerKey, (m) => ({ ...m, text: m.text + event.delta }));
            break;
          case 'card': {
            const card = event.card;
            if (card.type === 'confirm')
              setCall(card.toolCallId, { status: 'awaiting_confirmation', tool: card.tool });
            else if (card.type === 'done')
              setCall(card.toolCallId, { status: 'done', undone: false });
            patchAnswer(answerKey, (m) => ({ ...m, cards: [...m.cards, card] }));
            break;
          }
          case 'done':
            finish(null);
            break;
          case 'error':
            if (event.code === 'budget_reached') setPaused(true);
            if (event.code === 'not_configured') setSetup('missing');
            finish({
              code: event.code === 'not_configured' ? 'failed' : event.code,
              message: event.message,
            });
            break;
        }
      };

      void (async () => {
        try {
          const current = threadRef.current;
          await streamAnswer(
            {
              workspaceId,
              ...(current ? { threadId: current } : {}),
              text,
              page: pageRef.current,
              ...(opts.spoken ? { spoken: true } : {}),
            },
            onEvent,
            controller.signal,
          );
          // The stream ended without a last word: the run goes on, and saves, on the worker.
          if (!controller.signal.aborted)
            patchAnswer(answerKey, (m) =>
              m.live
                ? {
                    ...m,
                    live: false,
                    steps: settleSteps(m.steps, false),
                    notice: { code: 'dropped', message: 'The connection dropped.' },
                  }
                : m,
            );
        } catch (error) {
          if (controller.signal.aborted) return;
          if (error instanceof AssistantError && error.failure === 'not_configured') {
            setSetup('missing');
            setMessages((all) => all.filter((m) => m.key !== userKey && m.key !== answerKey));
            return;
          }
          // No OK on file after all (given elsewhere and taken back, or a newer wording): the step shows and the
          // question waits for it. Nothing reached the AI service.
          if (error instanceof AssistantError && error.failure === 'consent_required') {
            setMessages((all) => all.filter((m) => m.key !== userKey && m.key !== answerKey));
            waitingQuestion.current = text;
            rememberConsent(userId, false);
            setConsentNeeded(true);
            return;
          }
          const notice = noticeFor(error);
          if (notice.code === 'budget_reached') setPaused(true);
          finish(notice);
        } finally {
          if (streamRef.current === controller) {
            streamRef.current = null;
            runRef.current = null;
            answerRef.current = null;
            setRunning(false);
          }
        }
      })();
      return true;
    },
    [consentNeeded, patchAnswer, setCall, setThread, userId, workspaceId],
  );

  const retry = React.useCallback(
    (answerKey: string) => {
      const m = messages.find((x) => x.key === answerKey);
      if (m?.role !== 'assistant' || !m.question) return;
      // Asking again replaces the answer that failed, so the question isn't asked twice in the chat.
      setMessages((all) => {
        const at = all.findIndex((x) => x.key === answerKey);
        return at <= 0 ? all : all.slice(0, at - 1);
      });
      ask(m.question);
    },
    [ask, messages],
  );

  const stop = React.useCallback(() => {
    const controller = streamRef.current;
    if (!controller) return;
    const answerKey = answerRef.current;
    const stopHere = () => {
      if (streamRef.current !== controller) return;
      if (answerKey)
        patchAnswer(answerKey, (m) => ({
          ...m,
          live: false,
          steps: settleSteps(m.steps, false),
          notice: { code: 'stopped', message: ASSISTANT_WORDS.stopped },
        }));
      detach();
    };
    const runId = runRef.current;
    if (!runId) {
      stopHere();
      return;
    }
    stopRun(runId)
      .then((r) => {
        if (!r.stopping) stopHere();
      })
      .catch(stopHere);
  }, [detach, patchAnswer]);

  const newChat = React.useCallback(() => {
    loadRef.current++;
    detach();
    setMessages([]);
    setCalls({});
    setThread(null);
    setLoading(false);
  }, [detach, setThread]);

  const openThread = React.useCallback(
    async (id: string) => {
      detach();
      const token = ++loadRef.current;
      setThread(id);
      setMessages([]);
      setCalls({});
      setLoading(true);
      try {
        const got = unwrap(
          await api.POST('/v1/queries/assistant_thread.get', {
            body: { workspaceId, threadId: id },
          }),
        );
        if (token !== loadRef.current) return;
        setCalls(
          Object.fromEntries(
            got.toolCalls.map((c) => [
              c.id,
              {
                status: c.status,
                tool: c.tool,
                outcome: c.outcome,
                error: c.error,
                href: c.href,
                undone: c.undone,
              },
            ]),
          ),
        );
        setMessages(
          got.messages.map((m) =>
            m.role === 'user'
              ? { key: m.id, role: 'user', text: m.text, createdAt: m.createdAt }
              : {
                  key: m.id,
                  role: 'assistant',
                  text: m.text,
                  cards: m.cards as AssistantCard[],
                  steps: [],
                  live: false,
                  notice: null,
                  question: null,
                  createdAt: m.createdAt,
                },
          ),
        );
      } catch (error) {
        // A chat that can't be opened (no signal, or it was archived elsewhere) says so and leaves a fresh chat.
        if (token !== loadRef.current) return;
        setThread(null);
        toast.error(errorMessage(error));
      } finally {
        if (token === loadRef.current) setLoading(false);
      }
    },
    [detach, setThread, workspaceId],
  );

  const forgetThread = React.useCallback(
    (id: string) => {
      if (threadRef.current === id) newChat();
    },
    [newChat],
  );

  const giveConsent = React.useCallback(async () => {
    unwrap(
      await api.POST('/v1/commands/assistant.consent', {
        body: { version: ASSISTANT_CONSENT_VERSION },
      }),
    );
    rememberConsent(userId, true);
    setConsentNeeded(false);
  }, [userId]);

  // Whether the OK is still needed comes from the account itself, so an OK given on the web is seen here. With no
  // signal the screen says the Assistant needs signal anyway, so the question doesn't arise.
  React.useEffect(() => {
    if (!online) return;
    let cancelled = false;
    api
      .POST('/v1/queries/account.me', { body: {} })
      .then((result) => {
        const needed = unwrap(result).assistantConsent.needed;
        if (cancelled) return;
        rememberConsent(userId, !needed);
        setConsentNeeded(needed);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [online, userId]);

  // The OK is kept: the question that was waiting for it is asked now.
  React.useEffect(() => {
    if (consentNeeded !== false || !waitingQuestion.current) return;
    const waiting = waitingQuestion.current;
    waitingQuestion.current = null;
    ask(waiting);
  }, [ask, consentNeeded]);

  React.useEffect(() => () => streamRef.current?.abort(), []);

  return {
    messages,
    calls,
    threadId,
    running,
    loading,
    setup,
    paused,
    online,
    consentNeeded,
    giveConsent,
    ask,
    retry,
    stop,
    newChat,
    openThread,
    setCall,
    forgetThread,
  };
}
