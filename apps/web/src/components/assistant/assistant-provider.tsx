'use client';
import {
  ASSISTANT_CONSENT_VERSION,
  ASSISTANT_WORDS,
  type AssistantCard,
  type AssistantEvent,
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
import type { AssistantSavedMessage, AssistantToolStatus } from '@/lib/api/types';
import { usePageRecord, type PageRecord } from '@/lib/assistant/page-record';
import { stopRun, streamAnswer } from '@/lib/assistant/stream';
import { useMatches } from '@/lib/use-media';

export interface Step {
  readonly id: string;
  readonly label: string;
  readonly status: 'running' | 'done' | 'failed';
}

/** Why an answer stopped short; each has its own card (design/m4/States.dc.html). */
export type NoticeCode =
  | 'budget_reached'
  | 'busy'
  | 'already_running'
  | 'failed'
  | 'stopped'
  | 'unreachable'
  | 'dropped'
  | 'forbidden';
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
   * Anthropic's Claude (account.me's assistantConsent, or the worker's assistant_consent_required refusal).
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
  ask(text: string): void;
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
  ask: noop,
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

function isMac(): boolean {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  return /mac|iphone|ipad|ipod/i.test(nav.userAgentData?.platform || nav.platform || '');
}

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

  const ask = useCallback(
    (raw: string) => {
      const text = raw.trim();
      if (!text || !enabled || streamRef.current) return;
      // Nothing goes to Claude before the person's OK: the question waits for it.
      if (consentNeeded) {
        waitingQuestionRef.current = text;
        setView('chat');
        return;
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
      setRunning(true);

      const finish = (notice: Notice | null) =>
        patchAnswer(answerKey, (m) => ({
          ...m,
          live: false,
          steps: settle(m.steps, !notice),
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
                    steps: settle(m.steps, false),
                    notice: { code: 'dropped', message: 'The connection dropped.' },
                  }
                : m,
            );
        } catch (e) {
          if (controller.signal.aborted) return;
          if (e instanceof ApiError && e.rule === 'assistant_not_configured') {
            setSetup('missing');
            setMessages((all) => all.filter((m) => m.key !== userKey && m.key !== answerKey));
            return;
          }
          // No OK on file after all (given on another device and taken back, or a newer wording): the consent
          // step shows, and the question waits for it. Nothing reached Claude.
          if (e instanceof ApiError && e.rule === 'assistant_consent_required') {
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
    },
    [consentNeeded, enabled, patchAnswer, setCall, setThread, workspaceId],
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
    // The worker ends the run and says "stopped" on the stream; if it can't reach the run, stop listening.
    stopRun(runId)
      .then((r) => {
        if (!r.stopping) stopHere();
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
        const saved: Record<string, CallState> = Object.fromEntries(
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
        );
        const asked = askedWhileLoadingRef.current;
        setMessages((now) => [...got.messages.map(fromSaved), ...now]);
        setCalls((now) => ({ ...(asked ? lapse(saved) : saved), ...now }));
      } catch (e) {
        if (token !== loadRef.current) return;
        if (e instanceof ApiError && e.status === 404 && !askedWhileLoadingRef.current)
          setThread(null);
        if (!opts.silent) toast.error(errorMessage(e));
      } finally {
        if (token === loadRef.current) {
          loadingRef.current = false;
          setLoading(false);
        }
      }
    },
    [detach, setThread, workspaceId],
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

  // The chat from before a reload comes back the first time the panel opens.
  useEffect(() => {
    if (!open || restoredRef.current) return;
    restoredRef.current = true;
    const id = rememberedThread(workspaceId);
    if (id && !threadRef.current && !streamRef.current) void openThread(id, { silent: true });
  }, [open, openThread, workspaceId]);

  // ⌘J on a Mac, Ctrl+J elsewhere. Browsers keep only a few shortcuts for themselves (new tab or window,
  // close, switching tabs); Ctrl+J (Downloads) reaches the page, and preventDefault keeps Downloads shut.
  // The label shows once the listener is on, so the shortcut works as soon as it's shown.
  useEffect(() => {
    const onMac = isMac();
    setMac(onMac);
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 'j' || e.altKey || e.shiftKey || e.repeat) return;
      if (onMac ? !e.metaKey || e.ctrlKey : !e.ctrlKey || e.metaKey) return;
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
