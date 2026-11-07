import {
  ASSISTANT_CONSENT_VERSION,
  ASSISTANT_WORDS,
  assistantAnswerAfterLastQuestion,
  assistantChatToReopen,
  assistantQuestionUnanswered,
  assistantWaitingOf,
  waitForAssistantAnswer,
  type AssistantCard,
  type AssistantDeviceChanges,
  type AssistantEvent,
  type AssistantNoticeCode,
  type AssistantWaiting,
  type PageRecord,
} from '@hfos/core';
import * as React from 'react';
import { AppState } from 'react-native';

import { toast } from '@/components/ui/toast';
import { api, ApiError, errorMessage, unwrap } from '@/lib/api';
import { deviceStore } from '@/lib/device-store';
import { useNetwork } from '@/lib/network';

import {
  AssistantError,
  assistantConfigured,
  stopRun,
  streamAnswer,
  warmAssistant,
} from './stream';

/**
 * Ask HandsFreeOS on the phone: the chat on screen, streamed in from the worker, and where each card stands. The
 * same shape as the web's panel (`apps/web/src/components/assistant/assistant-provider.tsx`), with two differences
 * the canvas asks for:
 *
 * - **It needs signal.** With none, the question stays in the chat and the answer says so, with Ask again. Nothing
 *   is queued: the outbox is for changes, and a question isn't one.
 * - **One chat at a time.** The phone opens a chat full screen rather than beside a page, so there is no docking,
 *   no keyboard shortcut and no page record to send.
 *
 * Asking and leaving works as on the web (`@hfos/core`'s `assistant/catch-up.ts`): the answer finishes on HandsFreeOS
 * whether or not the screen is still open, the question is remembered on the phone until its answer has been
 * shown, opening Ask HandsFreeOS again reopens that chat, and an answer still coming is checked on until it lands.
 * Coming back to the app mid-answer checks on it the same way, since the stream may not have lived through it.
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
const waitingKey = (userId: string, workspaceId: string) =>
  `person.${userId}.assistantWaiting.${workspaceId}`;

/** The question in this business whose answer this phone hasn't shown yet, if any. */
export function rememberedWaiting(userId: string, workspaceId: string): AssistantWaiting | null {
  return assistantWaitingOf(deviceStore.get(waitingKey(userId, workspaceId)));
}

function rememberWaiting(userId: string, workspaceId: string, waiting: AssistantWaiting): void {
  deviceStore.set(waitingKey(userId, workspaceId), waiting);
}

/** Its answer is on screen: forgotten, unless the question waiting is another chat's. */
function forgetWaiting(userId: string, workspaceId: string, threadId: string | null): void {
  const waiting = rememberedWaiting(userId, workspaceId);
  if (!waiting || !threadId || !waiting.threadId || waiting.threadId === threadId)
    deviceStore.remove(waitingKey(userId, workspaceId));
}

type SavedChat = Awaited<ReturnType<typeof loadChat>>;

async function loadChat(workspaceId: string, threadId: string) {
  return unwrap(
    await api.POST('/v1/queries/assistant_thread.get', { body: { workspaceId, threadId } }),
  );
}

const callsOf = (toolCalls: SavedChat['toolCalls']): Record<string, CallState> =>
  Object.fromEntries(
    toolCalls.map((c) => [
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
  );

const fromSaved = (m: SavedChat['messages'][number]): ChatMessage =>
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
      };

/** The step under an answer the phone is checking on rather than streaming. */
export const STILL_WORKING: Step = {
  id: 'still-working',
  label: ASSISTANT_WORDS.stillWorking,
  status: 'running',
};

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
  /** `silent`: a chat reopened on its own (for an answer waiting) says nothing if it can't be opened. */
  openThread(threadId: string, opts?: { readonly silent?: boolean }): Promise<void>;
  setCall(toolCallId: string, patch: Partial<CallState>): void;
  forgetThread(threadId: string): void;
}

const newKey = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/** The chat for one business. Lives for as long as the screen is open. */
/** When this phone last had the AI read ahead for each business; it keeps for five minutes. */
const warmedAt = new Map<string, number>();
const WARM_EVERY_MS = 4 * 60_000;

export function useAssistantChat(
  workspaceId: string,
  userId: string,
  page: PageRecord | null = null,
  /** The screen the mark was pressed on, inside the business (`assistantScreenPath`). */
  path: string | null = null,
  /** Changes on this phone as that screen shows them, sent with each question (`deviceChangesOf`). */
  deviceChanges: AssistantDeviceChanges | null = null,
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
  /** Checking on an answer rather than streaming it (follow): Stop then leaves it to land. */
  const followingRef = React.useRef(false);
  /** The run streaming now, once the worker named it: where an answer that stops streaming is picked up. */
  const startedRef = React.useRef<{ readonly runId: string; readonly threadId: string } | null>(
    null,
  );
  const pageRef = React.useRef(page);
  pageRef.current = page;
  const pathRef = React.useRef(path);
  pathRef.current = path;
  const deviceChangesRef = React.useRef(deviceChanges);
  deviceChangesRef.current = deviceChanges;
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
    followingRef.current = false;
    startedRef.current = null;
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

  /**
   * Puts a saved answer in place of the one on screen, once it has landed: everything after the chat's last question.
   * With nothing there, the answer was cut off, and it says so with Ask again.
   */
  const land = React.useCallback(
    (answerKey: string, got: SavedChat) => {
      const tail = assistantAnswerAfterLastQuestion(got.messages);
      setCalls((now) => ({ ...now, ...callsOf(got.toolCalls) }));
      setMessages((all) =>
        all.flatMap((m): ChatMessage[] =>
          m.key !== answerKey || m.role !== 'assistant'
            ? [m]
            : tail.length
              ? tail.map(fromSaved)
              : [
                  {
                    ...m,
                    live: false,
                    steps: settleSteps(m.steps, false),
                    notice: { code: 'unfinished', message: '' },
                  },
                ],
        ),
      );
      forgetWaiting(userId, workspaceId, got.thread.id);
    },
    [userId, workspaceId],
  );

  /**
   * Picks up an answer the phone isn't streaming: the chat was opened while it was still coming, the stream dropped,
   * or the app came back from the background mid-answer. It checks the saved chat until the answer lands there (it
   * always does, on the worker), and meanwhile says it's still working, with Stop where Send was.
   */
  const follow = React.useCallback(
    (threadId: string, answerKey: string, runId: string | null, first?: SavedChat) => {
      const controller = new AbortController();
      streamRef.current = controller;
      answerRef.current = answerKey;
      runRef.current = runId;
      followingRef.current = true;
      startedRef.current = null;
      setRunning(true);
      patchAnswer(answerKey, (m) => ({
        ...m,
        live: true,
        notice: null,
        steps: [...m.steps.filter((s) => s.status !== 'running'), STILL_WORKING],
      }));
      void (async () => {
        const got = await waitForAssistantAnswer(() => loadChat(workspaceId, threadId), {
          signal: controller.signal,
          ...(first ? { first } : {}),
        });
        // Stopped listening (a new chat, another chat opened, the screen closed): that already reset the chat.
        if (controller.signal.aborted || streamRef.current !== controller) return;
        if (got) land(answerKey, got);
        else
          patchAnswer(answerKey, (m) => ({
            ...m,
            live: false,
            steps: settleSteps(m.steps, false),
            notice: { code: 'dropped', message: 'The connection dropped.' },
          }));
        streamRef.current = null;
        runRef.current = null;
        answerRef.current = null;
        followingRef.current = false;
        setRunning(false);
      })();
    },
    [land, patchAnswer, workspaceId],
  );

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
      followingRef.current = false;
      startedRef.current = null;
      setRunning(true);
      // Remembered until its answer is on screen, so leaving now (closing the app, even) comes back to it.
      rememberWaiting(userId, workspaceId, { threadId: threadRef.current, askedAt: now });
      let started: { readonly runId: string; readonly threadId: string } | null = null;

      /** The answer had its last word (done, or an error the worker sent). */
      let finished = false;
      const finish = (notice: Notice | null) => {
        finished = true;
        patchAnswer(answerKey, (m) => ({
          ...m,
          live: false,
          steps: settleSteps(m.steps, !notice),
          notice: notice ?? m.notice,
        }));
        forgetWaiting(userId, workspaceId, started?.threadId ?? threadRef.current);
      };
      /** The stream stopped before the answer's last word: it goes on, and saves, on the worker. */
      const pickUp = (): boolean => {
        if (finished || !started || streamRef.current !== controller) return false;
        follow(started.threadId, answerKey, started.runId);
        return true;
      };

      const onEvent = (event: AssistantEvent) => {
        if (controller.signal.aborted) return;
        switch (event.type) {
          case 'run':
            runRef.current = event.runId;
            started = { runId: event.runId, threadId: event.threadId };
            startedRef.current = started;
            rememberWaiting(userId, workspaceId, { threadId: event.threadId, askedAt: now });
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
              path: pathRef.current,
              app: 'phone',
              ...(opts.spoken ? { spoken: true } : {}),
              ...(deviceChangesRef.current ? { deviceChanges: deviceChangesRef.current } : {}),
            },
            onEvent,
            controller.signal,
          );
          // The stream ended without a last word: the run goes on, and saves, on the worker, so it's picked up
          // from there.
          if (!controller.signal.aborted && !pickUp())
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
          // Signal lost mid-answer: picked up from the worker, which carries on regardless.
          if (noticeFor(error).code === 'no_signal' && pickUp()) return;
          if (error instanceof AssistantError && error.failure === 'not_configured') {
            forgetWaiting(userId, workspaceId, threadRef.current);
            setSetup('missing');
            setMessages((all) => all.filter((m) => m.key !== userKey && m.key !== answerKey));
            return;
          }
          // No OK on file after all (given elsewhere and taken back, or a newer wording): the step shows and the
          // question waits for it. Nothing reached the AI service.
          if (error instanceof AssistantError && error.failure === 'consent_required') {
            forgetWaiting(userId, workspaceId, threadRef.current);
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
            startedRef.current = null;
            setRunning(false);
          }
        }
      })();
      return true;
    },
    [consentNeeded, follow, patchAnswer, setCall, setThread, userId, workspaceId],
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
    // Being checked on, a run the worker can't reach has just ended: its answer lands at the next check.
    stopRun(runId)
      .then((r) => {
        if (!r.stopping && !followingRef.current) stopHere();
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
    async (id: string, opts: { readonly silent?: boolean } = {}) => {
      detach();
      const token = ++loadRef.current;
      setThread(id);
      setMessages([]);
      setCalls({});
      setLoading(true);
      try {
        const got = await loadChat(workspaceId, id);
        if (token !== loadRef.current) return;
        setCalls(callsOf(got.toolCalls));
        // Its last question still being answered (asked before the screen closed, or on the web), or cut off.
        const last = got.messages[got.messages.length - 1];
        const pending =
          last?.role === 'user' &&
          (got.answering || assistantQuestionUnanswered(got.messages, null))
            ? newKey('a')
            : null;
        setMessages([
          ...got.messages.map(fromSaved),
          ...(pending
            ? [
                {
                  key: pending,
                  role: 'assistant' as const,
                  text: '',
                  cards: [],
                  steps: [],
                  live: !!got.answering,
                  notice: got.answering ? null : { code: 'unfinished' as const, message: '' },
                  question: last!.text,
                  createdAt: last!.createdAt,
                },
              ]
            : []),
        ]);
        if (pending && got.answering) follow(id, pending, got.answering.runId, got);
        else forgetWaiting(userId, workspaceId, id);
      } catch (error) {
        // A chat that can't be opened (no signal, or it was archived elsewhere) says so and leaves a fresh chat.
        if (token !== loadRef.current) return;
        setThread(null);
        // Gone (archived, or another person's on this phone): nothing left to pick up.
        if (opts.silent) {
          if (error instanceof ApiError && error.status === 404)
            forgetWaiting(userId, workspaceId, id);
        } else toast.error(errorMessage(error));
      } finally {
        if (token === loadRef.current) setLoading(false);
      }
    },
    [detach, follow, setThread, userId, workspaceId],
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

  // Opening the Assistant has the AI read ahead while they type, so their first answer starts sooner: only after
  // their OK (the worker checks too), and once in a while, since what it read keeps for a few minutes.
  React.useEffect(() => {
    if (!online || consentNeeded !== false) return;
    const now = Date.now();
    if (now - (warmedAt.get(workspaceId) ?? 0) < WARM_EVERY_MS) return;
    warmedAt.set(workspaceId, now);
    void warmAssistant(workspaceId);
  }, [consentNeeded, online, workspaceId]);

  // The OK is kept: the question that was waiting for it is asked now.
  React.useEffect(() => {
    if (consentNeeded !== false || !waitingQuestion.current) return;
    const waiting = waitingQuestion.current;
    waitingQuestion.current = null;
    ask(waiting);
  }, [ask, consentNeeded]);

  // Opening Ask HandsFreeOS with a question whose answer hasn't been shown yet (asked before the screen or the app
  // was closed) reopens its chat, which picks the answer up. Once, with signal.
  const reopenedRef = React.useRef(false);
  React.useEffect(() => {
    if (!online || reopenedRef.current) return;
    reopenedRef.current = true;
    const waiting = rememberedWaiting(userId, workspaceId);
    if (!waiting || threadRef.current || streamRef.current) return;
    void (async () => {
      let id = waiting.threadId;
      if (!id) {
        // Asked in a new chat and closed before the worker said which: the newest chat, if it's that one.
        const newest = await api
          .POST('/v1/queries/assistant_thread.list', { body: { workspaceId, limit: 1 } })
          .then((r) => unwrap(r).items[0] ?? null)
          .catch(() => null);
        id = assistantChatToReopen(waiting, newest);
      }
      if (threadRef.current || streamRef.current) return;
      if (id) await openThread(id, { silent: true });
      else forgetWaiting(userId, workspaceId, null);
    })();
  }, [online, openThread, userId, workspaceId]);

  // Back from the background mid-answer: the stream may not have lived through it, so the answer is checked on in
  // the saved chat instead, where it carries on regardless.
  React.useEffect(() => {
    let away = false;
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'background') away = true;
      if (state !== 'active' || !away) return;
      away = false;
      const streaming = streamRef.current;
      const started = startedRef.current;
      const answerKey = answerRef.current;
      if (!streaming || followingRef.current || !started || !answerKey) return;
      follow(started.threadId, answerKey, started.runId);
      streaming.abort();
    });
    return () => sub.remove();
  }, [follow]);

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
