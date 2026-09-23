/** The AI teammate's jobs, keys and timings (plan M7, "Worker runtime"). */
import type { TeammateChannel } from '@hfos/core/server';

export const TEAMMATE_JOBS = {
  /** Answers a conversation's unanswered messages: one pending per conversation, debounced. */
  reply: 'ai_teammate.reply',
  /** Sends an approved draft that quiet hours held back, once they end. */
  sendDraft: 'ai_teammate.send_draft',
  /** A first message to someone with no conversation yet: a new lead, or a person a workflow handed over. */
  outreach: 'ai_teammate.outreach',
  /** A nudge when the customer went quiet after the teammate asked them something. */
  followUp: 'ai_teammate.follow_up',
  /** The hand-off line quiet hours held back, sent once they end. */
  handoffLine: 'ai_teammate.handoff_line',
  /** One business's drafts nobody decided in time: expired, and their conversations go to a person. */
  expireDrafts: 'ai_teammate.expire_drafts',
  /** A hand-off's text to one person's verified cell (M18). */
  handoffText: 'ai_teammate.handoff_text',
  /** The business's fixed words (hand-off line, emergency steps) in a customer's language (M18). */
  translate: 'ai_teammate.translate',
} as const;

export const replyJobKey = (conversationId: string): string => `ai-reply:${conversationId}`;
export const sendDraftJobKey = (draftId: string): string => `ai-send-draft:${draftId}`;
/** One first message per lead (`<leadId>`), or per workflow step (`wf:<runId>:<stepKey>`). */
export const outreachJobKey = (key: string): string => `ai-outreach:${key}`;
export const followUpJobKey = (conversationId: string): string => `ai-follow-up:${conversationId}`;
export const handoffLineJobKey = (conversationId: string): string =>
  `ai-handoff-line:${conversationId}`;
export const expireDraftsJobKey = (workspaceId: string): string =>
  `ai-expire-drafts:${workspaceId}`;
/** The hand-off line's clientId: one per hand-off (the epoch the hand-off moves the conversation to). */
export const handoffClientId = (conversationId: string, epoch: number): string =>
  `handoff:${conversationId}:${epoch}`;

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
/** The history the model reads: the last 20 messages and calls, from the last 7 days. */
export const HISTORY_MAX = 20;
export const HISTORY_DAYS = 7;
/**
 * How much of a call's words the history carries. A voicemail is a sentence or two and fits whole; a
 * three-minute call runs to hundreds of words, and twenty of those would crowd out everything else the model
 * reads. What doesn't fit is a `read_call_transcript` away.
 */
export const CALL_WORDS_MAX = 700;
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

/** A handed-off conversation nobody answers for this much open time sets off M3's unanswered alert. */
export const HANDOFF_UNANSWERED_MS = 15 * 60_000;
/** A text or call from them this recently lets the teammate text first (the M6 consent rule). */
export const RECENT_CONTACT_MS = 24 * 3_600_000;
/**
 * Nudges: the first goes this long after the question they didn't answer, and each later one this long after
 * the last. Either moves to the teammate's next working time when it falls outside it.
 */
export const FIRST_NUDGE_MS = 4 * 3_600_000;
export const LATER_NUDGE_MS = 24 * 3_600_000;

/** The most plans and price-list items a run's context lists (M18). */
export const PLANS_MAX = 10;
export const OFFERS_MAX = 10;
export const CATALOGUE_MAX = 60;
/** The most bills or quotes my_bills and my_quotes return, newest first. */
export const MONEY_LIST_MAX = 10;

/** One hand-off's text to one person: once, however often the hand-off's event is delivered. */
export const handoffTextJobKey = (eventId: string, userId: string): string =>
  `handoff-text:${eventId}:${userId}`;
