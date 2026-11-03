/**
 * Asking and leaving. The worker finishes and saves every question it's asked, whether or not anyone is still
 * listening: closing the panel, the tab or the phone app stops nothing. These are the rules the web's panel
 * (`apps/web/src/components/assistant/assistant-provider.tsx`) and the phone's Ask HandsFreeOS screen
 * (`apps/mobile/src/assistant/chat.ts`) share for picking an answer back up:
 *
 * - **They remember the question** (`AssistantWaiting`) from the moment it's sent until its answer is on screen,
 *   in the browser's storage or the phone's own.
 * - **Coming back reopens that chat.** If they never heard which chat it went in (it was sent from a new chat and
 *   they left at once), it's the newest chat, when that was touched since the question (`assistantChatToReopen`).
 * - **While the answer is still coming,** the chat says so (`ASSISTANT_WORDS.stillWorking`) and checks the saved
 *   chat (`assistant_thread.get`'s `answering`) until it lands (`waitForAssistantAnswer`). A stream that drops
 *   mid-answer does the same rather than saying the connection dropped.
 * - **A question left with no answer and nothing answering it** was cut off: it says so, with Try again
 *   (`assistantQuestionUnanswered`).
 *
 * Browser-safe: no database, no Node.
 */

/** How often a screen checks on an answer it isn't streaming: every 2 seconds, every 5 after a minute, never after 10. */
export const ASSISTANT_CATCH_UP = {
  everyMs: 2_000,
  slowEveryMs: 5_000,
  slowAfterMs: 60_000,
  giveUpAfterMs: 10 * 60_000,
} as const;

/** A question whose answer this browser or phone hasn't shown yet. */
export interface AssistantWaiting {
  /** Null until the worker says which chat it went in: a new chat's question, sent just before leaving. */
  readonly threadId: string | null;
  readonly askedAt: string;
}

/** A remembered question is picked back up for a day; after that it's left to the chats list. */
export const ASSISTANT_WAITING_KEEP_MS = 24 * 60 * 60_000;

/** What was stored, if it's still a question worth picking up (anything else, or anything older, is dropped). */
export function assistantWaitingOf(value: unknown, now = Date.now()): AssistantWaiting | null {
  if (!value || typeof value !== 'object') return null;
  const { threadId, askedAt } = value as Record<string, unknown>;
  if (typeof askedAt !== 'string' || (threadId !== null && typeof threadId !== 'string'))
    return null;
  const at = Date.parse(askedAt);
  if (!Number.isFinite(at) || now - at > ASSISTANT_WAITING_KEEP_MS || at - now > 60_000)
    return null;
  return { threadId, askedAt };
}

/**
 * How early a chat's last message may be and still be the one the question went in: the worker stamps the chat
 * when it saves the question, by its own clock, which can be a little behind the one that remembered it.
 */
const CLOCKS_APART_MS = 60_000;

/**
 * The chat to reopen for a waiting question: its own, or the newest chat (`assistant_thread.list` with a limit of 1)
 * when it went in a new chat this device never heard the name of, as long as that chat was touched since.
 */
export function assistantChatToReopen(
  waiting: AssistantWaiting,
  newest: { readonly id: string; readonly lastMessageAt: string } | null,
): string | null {
  if (waiting.threadId) return waiting.threadId;
  if (!newest) return null;
  return Date.parse(newest.lastMessageAt) >= Date.parse(waiting.askedAt) - CLOCKS_APART_MS
    ? newest.id
    : null;
}

const pause = (ms: number, signal: AbortSignal) =>
  new Promise<void>((done) => {
    if (signal.aborted) return done();
    const timer = setTimeout(finish, ms);
    function finish() {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      done();
    }
    signal.addEventListener('abort', finish);
  });

/**
 * Checks the saved chat until nothing is answering in it, and resolves with it then: its answer is saved by the
 * time its run ends. Null when `signal` stops it first, or after `giveUpAfterMs`. A check that fails (no signal for
 * a moment) is tried again at the next one. `first`, when given, is a chat already read, so the first check waits.
 */
export async function waitForAssistantAnswer<T extends { readonly answering: unknown }>(
  load: () => Promise<T>,
  opts: {
    readonly signal: AbortSignal;
    readonly first?: T;
    /** Stand-ins for tests. */
    readonly now?: () => number;
    readonly wait?: (ms: number, signal: AbortSignal) => Promise<void>;
  },
): Promise<T | null> {
  const now = opts.now ?? Date.now;
  const wait = opts.wait ?? pause;
  const started = now();
  let got: T | undefined = opts.first;
  for (;;) {
    if (opts.signal.aborted) return null;
    if (got && !got.answering) return got;
    const waited = now() - started;
    if (waited >= ASSISTANT_CATCH_UP.giveUpAfterMs) return null;
    await wait(
      waited >= ASSISTANT_CATCH_UP.slowAfterMs
        ? ASSISTANT_CATCH_UP.slowEveryMs
        : ASSISTANT_CATCH_UP.everyMs,
      opts.signal,
    );
    if (opts.signal.aborted) return null;
    try {
      got = await load();
    } catch {
      got = undefined;
    }
  }
}

/** The answer a saved chat ends with: everything after its last question, which replaces the one on screen. */
export function assistantAnswerAfterLastQuestion<M extends { readonly role: 'user' | 'assistant' }>(
  messages: readonly M[],
): M[] {
  let at = messages.length - 1;
  while (at >= 0 && messages[at]!.role !== 'user') at--;
  return messages.slice(at + 1);
}

/** The chat ends with a question that has no answer and nothing answering it: the answer was cut off. */
export function assistantQuestionUnanswered(
  messages: readonly { readonly role: 'user' | 'assistant' }[],
  answering: unknown,
): boolean {
  return !answering && messages.length > 0 && messages[messages.length - 1]!.role === 'user';
}
