'use client';
import {
  ASSISTANT_CONSENT_VERSION,
  ASSISTANT_WORDS,
  assistantAnswerAfterLastQuestion,
  assistantChatToReopen,
  assistantQuestionUnanswered,
  assistantWaitingOf,
  waitForAssistantAnswer,
  type AssistantCard,
  type AssistantEvent,
  type AssistantWaiting,
} from '@hfos/core';
import { usePathname } from 'next/navigation';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { toast } from 'sonner';
import { apiBrowser, ApiError, errorMessage, unwrap } from '@/lib/api/client';
import type {
  AssistantSavedMessage,
  AssistantThreadGet,
  AssistantToolCall,
  AssistantToolStatus,
} from '@/lib/api/types';
import { usePageRecord, type PageRecord } from '@/lib/assistant/page-record';
import { stopRun, streamAnswer, warmAssistant } from '@/lib/assistant/stream';
import { isMac, isShortcut } from '@/lib/keys';
import { useMatches } from '@/lib/use-media';

export interface Step {
  readonly id: string;
  readonly label: string;
  readonly status: 'running' | 'done' | 'failed';
}

/** Why an answer stopped short; each has its own card (design/m4/States.dc.html). */
export type NoticeCode =
  | 'budget_reached'
  | 'wallet_empty'
  | 'busy'
  | 'already_running'
  | 'failed'
  | 'stopped'
  | 'unreachable'
  | 'dropped'
  | 'forbidden'
  | 'unfinished';
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
  /** Still streaming in. */
  readonly live: boolean;
  readonly notice: Notice | null;
  /** The question it answers, for Try again. */
  readonly question: string | null;
  readonly createdAt: string;
}
export type ChatMessage = QuestionMessage | AnswerMessage;

/** Where a confirmation or "done" card stands (the worker's tool call). */
export interface CallState {
  readonly status: AssistantToolStatus;
  readonly tool: string | null;
  readonly outcome: string | null;
  readonly error: string | null;
  readonly href: string | null;
  /** A task or note it added on its own, taken back with Undo. */
  readonly undone?: boolean;
  /** Said on the card instead of the usual result line ("You sent your own version instead."). */
  readonly note?: string | null;
}

/** missing: the worker has no model to answer with (it said so with a 503). */
export type Setup = 'unknown' | 'ready' | 'missing';
export type View = 'chat' | 'history';

export interface Shortcut {
  /** "⌘J" or "Ctrl J", on the sidebar button. */
  readonly label: string;
  /** "Meta+J" or "Control+J", for aria-keyshortcuts. */
  readonly aria: string;
  /** "⌘J" or "Ctrl+J", in tooltips. */
  readonly title: string;
}

export interface AssistantValue {
  /** The person may use the Assistant here (assistant.use). */
  readonly enabled: boolean;
  /**
   * The consent step shows before any question: the person hasn't said OK yet to what they ask about going to
   * an AI service (account.me's assistantConsent, or the worker's assistant_consent_required refusal).
   */
  readonly consentNeeded: boolean;
  /** "OK, continue": keeps the OK with the account, then asks the question that was waiting, if any. */
  giveConsent(): Promise<void>;
  /** "Not now": closes the panel; the step shows again next time. */
  declineConsent(): void;
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly open: boolean;
  /** Open beside the page rather than over it. */
  readonly docked: boolean;
  /** Null until the browser says whether it's a Mac. */
  readonly shortcut: Shortcut | null;
  readonly view: View;
  readonly threadId: string | null;
  readonly messages: readonly ChatMessage[];
  readonly calls: Readonly<Record<string, CallState>>;
  readonly running: boolean;
  /** A past chat is being opened. */
  readonly loading: boolean;
  readonly setup: Setup;
  /** Today's token budget is spent. */
  readonly paused: boolean;
  readonly page: PageRecord | null;
  readonly draft: string;
  readonly composerRef: RefObject<HTMLTextAreaElement | null>;
  /** The H in the phone header: focus goes back to it when the full-screen panel closes. */
  readonly triggerRef: RefObject<HTMLButtonElement | null>;
  setDraft(text: string): void;
  setOpen(open: boolean): void;
  toggle(): void;
  setView(view: View): void;
  /**
   * Asks a question; `spoken` when it was said out loud, so the answer is written to be heard. Answers whether it
   * went (not while another answer is coming, or before the person's OK).
   */
  ask(text: string, opts?: { readonly spoken?: boolean }): boolean;
  /** Asks an answer's question again (Try again). */
  retry(answerKey: string): void;
  stop(): void;
  newChat(): void;
  openThread(threadId: string, opts?: { silent?: boolean }): Promise<void>;
  setCall(toolCallId: string, patch: Partial<CallState>): void;
  /** Before following one of the panel's links: close it if it would cover the page it goes to. */
  closeIfCovering(href?: string): void;
  /** A chat was archived: start fresh if it's the one open. */
  forgetThread(threadId: string): void;
}

const noop = () => undefined;
const NONE: AssistantValue = {
  enabled: false,
  workspaceId: '',
  workspaceName: '',
  open: false,
  docked: false,
  shortcut: null,
  view: 'chat',
  threadId: null,
  messages: [],
  calls: {},
  running: false,
  loading: false,
  setup: 'unknown',
  paused: false,
  page: null,
  draft: '',
  composerRef: { current: null },
  triggerRef: { current: null },
  setDraft: noop,
  setOpen: noop,
  toggle: noop,
  setView: noop,
  ask: () => false,
  retry: noop,
  stop: noop,
  newChat: noop,
  openThread: async () => undefined,
  setCall: noop,
  closeIfCovering: noop,
  forgetThread: noop,
  consentNeeded: false,
  giveConsent: async () => undefined,
  declineConsent: noop,
};

const AssistantContext = createContext<AssistantValue | null>(null);

export function useAssistant(): AssistantValue {
  return useContext(AssistantContext) ?? NONE;
}

/**
 * The panel docks beside the page from 1024 px. The inbox's panes need more room: there it docks from
 * 1600 px, where the conversation keeps about 620 px with the customer pane folded away (at 1440 px its
 * header squeezed the customer's name to a letter); below that it lies over the page.
 */
/** The provider keeps what the AI read ahead for five minutes; asking again a little before is enough. */
const WARM_EVERY_MS = 4 * 60_000;
const DOCK = '(min-width: 1024px)';
const DOCK_ON_INBOX = '(min-width: 1600px)';
const onInbox = (path: string, workspaceId: string) =>
  path.startsWith(`/app/w/${workspaceId}/inbox`);

const storageKey = (workspaceId: string) => `hfos.assistant.${workspaceId}`;
function rememberedThread(workspaceId: string): string | null {
  try {
    return sessionStorage.getItem(storageKey(workspaceId));
  } catch {
    return null;
  }
}
function rememberThread(workspaceId: string, threadId: string | null): void {
  try {
    if (threadId) sessionStorage.setItem(storageKey(workspaceId), threadId);
    else sessionStorage.removeItem(storageKey(workspaceId));
  } catch {
    // Private windows: the chat just isn't reopened after a reload.
  }
}

/**
 * The question whose answer this browser hasn't shown yet (assistant/catch-up.ts), kept in localStorage so that
 * coming back in a new tab, after closing the last one, reopens its chat. Per workspace; gone once it's on screen.
 */
const waitingKey = (workspaceId: string) => `hfos.assistant.${workspaceId}.waiting`;
function rememberedWaiting(workspaceId: string): AssistantWaiting | null {
  try {
    const raw = localStorage.getItem(waitingKey(workspaceId));
    return assistantWaitingOf(raw ? JSON.parse(raw) : null);
  } catch {
    return null;
  }
}
function rememberWaiting(workspaceId: string, waiting: AssistantWaiting): void {
  try {
    localStorage.setItem(waitingKey(workspaceId), JSON.stringify(waiting));
  } catch {
    // Storage off: the answer is still saved, in Your chats.
  }
}
/** Its answer is on screen: forgotten, unless the question waiting is another chat's (asked in another tab). */
function forgetWaiting(workspaceId: string, threadId: string | null): void {
  try {
    const waiting = rememberedWaiting(workspaceId);
    if (!waiting || !threadId || !waiting.threadId || waiting.threadId === threadId)
      localStorage.removeItem(waitingKey(workspaceId));
  } catch {
    // Nothing to forget.
  }
}

const callsOf = (toolCalls: readonly AssistantToolCall[]): Record<string, CallState> =>
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

/** The step under an answer this tab is checking on rather than streaming. */
const STILL_WORKING: Step = {
  id: 'still-working',
  label: ASSISTANT_WORDS.stillWorking,
  status: 'running',
};

const fromSaved = (m: AssistantSavedMessage): ChatMessage =>
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

function upsertStep(steps: readonly Step[], step: Step): Step[] {
  return steps.some((s) => s.id === step.id)
    ? steps.map((s) => (s.id === step.id ? step : s))
    : [...steps, step];
}

/** Steps still spinning when an answer ends: done if it finished, failed if it didn't. */
const settle = (steps: readonly Step[], finished: boolean): Step[] =>
  steps.map((s) => (s.status === 'running' ? { ...s, status: finished ? 'done' : 'failed' } : s));

/** Cards left waiting lapse once the person asks something else (the worker expires them too). */
const lapse = (calls: Record<string, CallState>): Record<string, CallState> =>
  Object.fromEntries(
    Object.entries(calls).map(([id, c]) => [
      id,
      c.status === 'awaiting_confirmation' ? { ...c, status: 'expired' as const } : c,
    ]),
  );

function noticeFor(e: unknown): Notice {
  if (!(e instanceof ApiError)) return { code: 'failed', message: errorMessage(e) };
  if (e.status === 0)
    return { code: e.code === 'dropped' ? 'dropped' : 'unreachable', message: e.message };
  if (e.status === 401 || e.status === 403) return { code: 'forbidden', message: e.message };
  if (e.status === 409) return { code: 'already_running', message: e.message };
  if (e.status === 429) return { code: 'budget_reached', message: e.message };
  if (e.status === 503) return { code: 'busy', message: e.message };
  return { code: 'failed', message: e.message };
}

/**
 * The Assistant for one workspace: whether the panel is open, the chat on screen (streamed in from the
 * worker), where each card stands, and ⌘J on a Mac or Ctrl+J elsewhere. It lives in the workspace layout, so
 * a chat keeps going while people move between pages.
 */
export function AssistantProvider({
  workspaceId,
  workspaceName,
  enabled,
  consentNeeded: consentNeededAtLoad = false,
  children,
}: {
  workspaceId: string;
  workspaceName: string;
  enabled: boolean;
  /** account.me's assistantConsent.needed when the page loaded. */
  consentNeeded?: boolean;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const page = usePageRecord(workspaceId);
  const wide = useMatches(onInbox(pathname, workspaceId) ? DOCK_ON_INBOX : DOCK);
  const [consentNeeded, setConsentNeeded] = useState(consentNeededAtLoad);
  /** A question asked while the consent step was up (or refused for want of it): asked once the person says OK. */
  const waitingQuestionRef = useRef<string | null>(null);
  const [open, setOpenState] = useState(false);
  const [view, setView] = useState<View>('chat');
  const [threadId, setThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [calls, setCalls] = useState<Record<string, CallState>>({});
  const [running, setRunning] = useState(false);
  const [loading, setLoading] = useState(false);
  const [setup, setSetup] = useState<Setup>('unknown');
  const [paused, setPaused] = useState(false);
  const [draft, setDraft] = useState('');
  const [mac, setMac] = useState<boolean | null>(null);

  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const threadRef = useRef<string | null>(null);
  const pageRef = useRef(page);
  pageRef.current = page;
  const streamRef = useRef<AbortController | null>(null);
  const runRef = useRef<string | null>(null);
  const answerRef = useRef<string | null>(null);
  /** Checking on an answer rather than streaming it (follow): Stop then leaves it to land. */
  const followingRef = useRef(false);
  /** Bumped whenever the chat on screen changes, so a slow load can't land on the wrong one. */
  const loadRef = useRef(0);
  const loadingRef = useRef(false);
  const askedWhileLoadingRef = useRef(false);
  const restoredRef = useRef(false);

  const setThread = useCallback(
    (id: string | null) => {
      threadRef.current = id;
      setThreadId(id);
      rememberThread(workspaceId, id);
    },
    [workspaceId],
  );

  /** Stops listening to the answer on screen. The run itself finishes and saves on the worker. */
  const detach = useCallback(() => {
    streamRef.current?.abort();
    streamRef.current = null;
    runRef.current = null;
    answerRef.current = null;
    followingRef.current = false;
    setRunning(false);
  }, []);

  const endLoading = useCallback(() => {
    loadRef.current++;
    loadingRef.current = false;
    setLoading(false);
  }, []);

  const patchAnswer = useCallback((key: string, fn: (m: AnswerMessage) => AnswerMessage) => {
    setMessages((all) => all.map((m) => (m.key === key && m.role === 'assistant' ? fn(m) : m)));
  }, []);

  const setCall = useCallback((id: string, patch: Partial<CallState>) => {
    setCalls((all) => ({
      ...all,
      [id]: {
        status: 'awaiting_confirmation',
        tool: null,
        outcome: null,
        error: null,
        href: null,
        ...all[id],
        ...patch,
      },
    }));
  }, []);

  /**
   * Puts a saved answer in place of the one on screen (`answerKey`), once it has landed: everything after the chat's
   * last question. With nothing there, the answer was cut off, and it says so with Try again.
   */
  const land = useCallback(
    (answerKey: string, got: AssistantThreadGet) => {
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
                    steps: settle(m.steps, false),
                    notice: { code: 'unfinished', message: '' },
                  },
                ],
        ),
      );
      forgetWaiting(workspaceId, got.thread.id);
    },
    [workspaceId],
  );

  /**
   * Picks up an answer this tab isn't streaming: the chat was opened while it was still coming, or the stream
   * dropped mid-answer. It checks the saved chat until the answer lands there (it always does, on the worker), and
   * meanwhile says it's still working, with Stop where Send was.
   */
  const follow = useCallback(
    (threadId: string, answerKey: string, runId: string | null, first?: AssistantThreadGet) => {
      const controller = new AbortController();
      streamRef.current = controller;
      answerRef.current = answerKey;
      runRef.current = runId;
      followingRef.current = true;
      setRunning(true);
      patchAnswer(answerKey, (m) => ({
        ...m,
        live: true,
        notice: null,
        steps: [...m.steps.filter((s) => s.status !== 'running'), STILL_WORKING],
      }));
      void (async () => {
        const got = await waitForAssistantAnswer(
          async () =>
            unwrap(
              await apiBrowser().POST('/v1/queries/assistant_thread.get', {
                body: { workspaceId, threadId },
              }),
            ),
          { signal: controller.signal, ...(first ? { first } : {}) },
        );
        // Stopped listening (a new chat, another chat opened): that already reset what's on screen.
        if (controller.signal.aborted || streamRef.current !== controller) return;
        if (got) land(answerKey, got);
        else
          patchAnswer(answerKey, (m) => ({
            ...m,
            live: false,
            steps: settle(m.steps, false),
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

  const ask = useCallback(
    (raw: string, opts: { readonly spoken?: boolean } = {}): boolean => {
      const text = raw.trim();
      if (!text || !enabled || streamRef.current) return false;
      // Nothing goes to the AI service before the person's OK: the question waits for it.
      if (consentNeeded) {
        waitingQuestionRef.current = text;
        setView('chat');
        return false;
      }
      const now = new Date().toISOString();
      const userKey = `q-${crypto.randomUUID()}`;
      const answerKey = `a-${crypto.randomUUID()}`;
      if (loadingRef.current) askedWhileLoadingRef.current = true;
      if (threadRef.current) setCalls(lapse);
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
      setView('chat');
      const controller = new AbortController();
      streamRef.current = controller;
      answerRef.current = answerKey;
      runRef.current = null;
      followingRef.current = false;
      setRunning(true);
      // Remembered until its answer is on screen, so leaving now (closing the tab, even) comes back to it.
      rememberWaiting(workspaceId, { threadId: threadRef.current, askedAt: now });
      /** The run the worker started for it, once it says so: an answer that stops streaming is picked up there. */
      let started: { readonly runId: string; readonly threadId: string } | null = null;

      /** The answer had its last word (done, or an error the worker sent). */
      let finished = false;
      const finish = (notice: Notice | null) => {
        finished = true;
        patchAnswer(answerKey, (m) => ({
          ...m,
          live: false,
          steps: settle(m.steps, !notice),
          notice: notice ?? m.notice,
        }));
        forgetWaiting(workspaceId, started?.threadId ?? threadRef.current);
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
            rememberWaiting(workspaceId, { threadId: event.threadId, askedAt: now });
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
          // The stream ended without a last word: the run goes on, and saves, on the worker, so it's picked up
          // from there.
          if (!controller.signal.aborted && !pickUp())
            patchAnswer(answerKey, (m) =>
              m.live
                ? {
                    ...m,
                    live: false,
                    steps: settle(m.steps, false),
                    notice: { code: 'dropped', message: 'The connection dropped.' },
                  }
                : m,
            );
        } catch (e) {
          if (controller.signal.aborted) return;
          // The connection went mid-answer (a laptop asleep, the network changed): picked up from the worker.
          if (e instanceof ApiError && e.status === 0 && pickUp()) return;
          if (e instanceof ApiError && e.rule === 'assistant_not_configured') {
            forgetWaiting(workspaceId, threadRef.current);
            setSetup('missing');
            setMessages((all) => all.filter((m) => m.key !== userKey && m.key !== answerKey));
            return;
          }
          // No OK on file after all (given on another device and taken back, or a newer wording): the consent
          // step shows, and the question waits for it. Nothing reached the AI service.
          if (e instanceof ApiError && e.rule === 'assistant_consent_required') {
            forgetWaiting(workspaceId, threadRef.current);
            setMessages((all) => all.filter((m) => m.key !== userKey && m.key !== answerKey));
            waitingQuestionRef.current = text;
            setConsentNeeded(true);
            return;
          }
          const notice = noticeFor(e);
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
    [consentNeeded, enabled, follow, patchAnswer, setCall, setThread, workspaceId],
  );

  const retry = useCallback(
    (answerKey: string) => {
      const m = messages.find((x) => x.key === answerKey);
      if (m?.role === 'assistant' && m.question) ask(m.question);
    },
    [ask, messages],
  );

  const stop = useCallback(() => {
    const controller = streamRef.current;
    if (!controller) return;
    const answerKey = answerRef.current;
    const stopHere = () => {
      if (streamRef.current !== controller) return;
      if (answerKey)
        patchAnswer(answerKey, (m) => ({
          ...m,
          live: false,
          steps: settle(m.steps, false),
          notice: { code: 'stopped', message: ASSISTANT_WORDS.stopped },
        }));
      detach();
    };
    const runId = runRef.current;
    if (!runId) {
      stopHere();
      return;
    }
    // The worker ends the run and says "stopped" on the stream (or in the saved chat, for an answer being checked
    // on); if it can't reach the run, stop listening, unless the answer is being checked on: then the run has just
    // ended, and its answer lands at the next check.
    stopRun(runId)
      .then((r) => {
        if (!r.stopping && !followingRef.current) stopHere();
      })
      .catch(stopHere);
  }, [detach, patchAnswer]);

  const newChat = useCallback(() => {
    endLoading();
    detach();
    setMessages([]);
    setCalls({});
    setThread(null);
    setView('chat');
    setDraft('');
  }, [detach, endLoading, setThread]);

  const openThread = useCallback(
    async (id: string, opts: { silent?: boolean } = {}) => {
      detach();
      const token = ++loadRef.current;
      loadingRef.current = true;
      askedWhileLoadingRef.current = false;
      // A question asked while it loads continues this chat; the saved messages go in above it.
      setThread(id);
      setMessages([]);
      setCalls({});
      setView('chat');
      setLoading(true);
      try {
        const got = unwrap(
          await apiBrowser().POST('/v1/queries/assistant_thread.get', {
            body: { workspaceId, threadId: id },
          }),
        );
        if (token !== loadRef.current) return;
        const saved = callsOf(got.toolCalls);
        const asked = askedWhileLoadingRef.current;
        // Its last question still being answered (asked here before a reload, or on the phone), or cut off.
        const last = got.messages[got.messages.length - 1];
        const pending =
          !asked &&
          last?.role === 'user' &&
          (got.answering || assistantQuestionUnanswered(got.messages, null))
            ? `a-${crypto.randomUUID()}`
            : null;
        setMessages((now) => [
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
          ...now,
        ]);
        setCalls((now) => ({ ...(asked ? lapse(saved) : saved), ...now }));
        if (pending && got.answering) follow(id, pending, got.answering.runId, got);
        else forgetWaiting(workspaceId, id);
      } catch (e) {
        if (token !== loadRef.current) return;
        if (e instanceof ApiError && e.status === 404 && !askedWhileLoadingRef.current) {
          setThread(null);
          forgetWaiting(workspaceId, id);
        }
        if (!opts.silent) toast.error(errorMessage(e));
      } finally {
        if (token === loadRef.current) {
          loadingRef.current = false;
          setLoading(false);
        }
      }
    },
    [detach, follow, setThread, workspaceId],
  );

  const forgetThread = useCallback(
    (id: string) => {
      if (threadRef.current !== id) return;
      endLoading();
      detach();
      setMessages([]);
      setCalls({});
      setThread(null);
    },
    [detach, endLoading, setThread],
  );

  const setOpen = useCallback((next: boolean) => setOpenState(enabled && next), [enabled]);
  const toggle = useCallback(() => setOpenState((o) => enabled && !o), [enabled]);
  const closeIfCovering = useCallback(
    (href?: string) => {
      const inbox = onInbox(href ?? window.location.pathname, workspaceId);
      if (!window.matchMedia(inbox ? DOCK_ON_INBOX : DOCK).matches) setOpenState(false);
    },
    [workspaceId],
  );

  // The first time the panel opens: a question whose answer hasn't been shown yet (asked before the tab was closed
  // or reloaded) reopens its chat, which picks the answer up; otherwise the chat from before a reload comes back.
  useEffect(() => {
    if (!open || restoredRef.current) return;
    restoredRef.current = true;
    if (threadRef.current || streamRef.current) return;
    const waiting = rememberedWaiting(workspaceId);
    if (!waiting) {
      const id = rememberedThread(workspaceId);
      if (id) void openThread(id, { silent: true });
      return;
    }
    void (async () => {
      let id = waiting.threadId;
      if (!id) {
        // Asked in a new chat and left before the worker said which: the newest chat, if it's that one.
        const newest = await apiBrowser()
          .POST('/v1/queries/assistant_thread.list', { body: { workspaceId, limit: 1 } })
          .then((r) => unwrap(r).items[0] ?? null)
          .catch(() => null);
        id = assistantChatToReopen(waiting, newest);
      }
      if (threadRef.current || streamRef.current) return;
      if (id) await openThread(id, { silent: true });
      else forgetWaiting(workspaceId, null);
    })();
  }, [open, openThread, workspaceId]);

  // Opening the panel has the AI read ahead while they type, so their first answer starts sooner. Not before
  // their OK to use the AI (the worker checks too), and it keeps for a few minutes, so once in a while is enough.
  const warmedAtRef = useRef(0);
  useEffect(() => {
    if (!open || !enabled || consentNeeded) return;
    if (Date.now() - warmedAtRef.current < WARM_EVERY_MS) return;
    warmedAtRef.current = Date.now();
    void warmAssistant(workspaceId);
  }, [consentNeeded, enabled, open, workspaceId]);

  // ⌘J on a Mac, Ctrl+J elsewhere. Browsers keep only a few shortcuts for themselves (new tab or window,
  // close, switching tabs); Ctrl+J (Downloads) reaches the page, and preventDefault keeps Downloads shut.
  // The label shows once the listener is on, so the shortcut works as soon as it's shown.
  useEffect(() => {
    const onMac = isMac();
    setMac(onMac);
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (!isShortcut(e, 'j', onMac)) return;
      e.preventDefault();
      setOpenState((o) => !o);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled]);

  useEffect(() => () => streamRef.current?.abort(), []);

  const giveConsent = useCallback(async () => {
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/assistant.consent', {
          body: { version: ASSISTANT_CONSENT_VERSION },
        }),
      );
      setConsentNeeded(false);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }, []);
  const declineConsent = useCallback(() => {
    waitingQuestionRef.current = null;
    setOpenState(false);
  }, []);
  // Opening the panel with the step to show: the OK may have been given since the page loaded (on the phone, or
  // in another tab), and then the step never shows.
  useEffect(() => {
    if (!open || !consentNeeded || !enabled) return;
    let cancelled = false;
    apiBrowser()
      .POST('/v1/queries/account.me', { body: {} })
      .then((r) => {
        if (!cancelled && !unwrap(r).assistantConsent.needed) setConsentNeeded(false);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [consentNeeded, enabled, open]);
  // The OK is kept: the question that was waiting for it is asked now.
  useEffect(() => {
    if (consentNeeded || !waitingQuestionRef.current) return;
    const waiting = waitingQuestionRef.current;
    waitingQuestionRef.current = null;
    ask(waiting);
  }, [ask, consentNeeded]);

  const shortcut = useMemo<Shortcut | null>(
    () =>
      mac === null
        ? null
        : mac
          ? { label: '⌘J', aria: 'Meta+J', title: '⌘J' }
          : { label: 'Ctrl J', aria: 'Control+J', title: 'Ctrl+J' },
    [mac],
  );

  const isOpen = enabled && open;
  const value = useMemo<AssistantValue>(
    () => ({
      enabled,
      workspaceId,
      workspaceName,
      open: isOpen,
      docked: isOpen && wide,
      shortcut,
      view,
      threadId,
      messages,
      calls,
      running,
      loading,
      setup,
      paused,
      page,
      draft,
      composerRef,
      triggerRef,
      setDraft,
      setOpen,
      toggle,
      setView,
      ask,
      retry,
      stop,
      newChat,
      openThread,
      setCall,
      closeIfCovering,
      forgetThread,
      consentNeeded,
      giveConsent,
      declineConsent,
    }),
    [
      enabled,
      consentNeeded,
      giveConsent,
      declineConsent,
      workspaceId,
      workspaceName,
      isOpen,
      wide,
      shortcut,
      view,
      threadId,
      messages,
      calls,
      running,
      loading,
      setup,
      paused,
      page,
      draft,
      setOpen,
      toggle,
      ask,
      retry,
      stop,
      newChat,
      openThread,
      setCall,
      closeIfCovering,
      forgetThread,
    ],
  );
  return <AssistantContext.Provider value={value}>{children}</AssistantContext.Provider>;
}
