/** The AI teammate's jobs, keys and timings (plan M7, "Worker runtime"). */
import type { TeammateChannel } from '@hfos/core/server';

export const TEAMMATE_JOBS = {
  /** Answers a conversation's unanswered messages: one pending per conversation, debounced. */
  reply: 'ai_teammate.reply',
  /** Sends an approved draft that quiet hours held back, once they end. */
  sendDraft: 'ai_teammate.send_draft',
} as const;

export const replyJobKey = (conversationId: string): string => `ai-reply:${conversationId}`;
export const sendDraftJobKey = (draftId: string): string => `ai-send-draft:${draftId}`;

/** How long a reply waits for the customer to finish (people often send three texts in a row). */
export const REPLY_DELAY_MS: Readonly<Record<TeammateChannel, number>> = {
  chat: 3_000,
  sms: 20_000,
  email: 60_000,
};
/** A reply never waits longer than this after the first message it answers. */
export const REPLY_CEILING_MS = 90_000;
/** What waits for quiet hours goes this long after they end. */
export const QUIET_GRACE_MS = 2 * 60_000;

/** The customer messages one run answers at most (the newest ones). */
export const BATCH_MAX = 20;
/** The history the model reads: the last 20 messages, from the last 7 days. */
export const HISTORY_MAX = 20;
export const HISTORY_DAYS = 7;
/** Knowledge offered up front, and returned per search. */
export const KNOWLEDGE_MATCHES = 5;
export const SEARCH_MATCHES = 5;
/** Open times one find_times shows the model, and the longest stretch it searches. */
export const TIMES_SHOWN = 12;
export const TIMES_MAX_DAYS = 14;
/** Customer-facing changes one reply may hold. */
export const HELD_MAX = 3;
/** Tokens per model call. */
export const MAX_TOKENS = 1024;

/** Loop detection: messages that arrived within this window... */
export const LOOP_WINDOW_MS = 10 * 60_000;
/** ...the same one this many times... */
export const LOOP_REPEATS = 3;
/** ...or this many in all. */
export const LOOP_FLOOD = 10;
