import { COMPOSE_WORDS, type ComposeChannel } from '@hfos/core';

import { change, changes } from '@/changes';
import { networkSnapshot } from '@/lib/network';

/**
 * Starting a conversation with someone from the phone (the Inbox's New message, and Text and Email on a customer's
 * page): the conversation to open, as the web's `conversation.open` picks it.
 *
 * - **They have one on this phone:** it opens at once, signal or none. HandsFreeOS files a text or an email under the
 *   number or address it's with, so that's what it's found by: the team's most recent thread on that channel, the
 *   same order `latestConversation` uses on the server.
 * - **They have none:** HandsFreeOS starts it, which needs signal. The change is sent straight away, its answer names
 *   the conversation, and this waits a moment for it to reach the phone's copy, so the screen it opens isn't empty.
 */

export interface StartConversationInput {
  readonly workspaceId: string;
  readonly personId: string;
  /** Their name, for the words when it can't start. */
  readonly name: string;
  readonly channel: ComposeChannel;
  /** The number (E.164) or email (lower case) the conversation is kept under: core's `composeTargets`. */
  readonly counterpart: string;
}

export type StartedConversation =
  | { readonly ok: true; readonly conversationId: string }
  | { readonly ok: false; readonly message: string };

/** The team's most recent thread with a number or address: a thread that has carried a message comes first. */
export const LATEST_THREAD_SQL = `
  SELECT id, person_id FROM conversations
  WHERE workspace_id = ? AND channel = ? AND counterpart = ? AND private_to IS NULL
  ORDER BY last_message_at IS NULL, last_message_at DESC, created_at DESC LIMIT 1`;

const HERE_SQL = `SELECT id FROM conversations WHERE id = ?`;

/** How long to wait for a conversation HandsFreeOS just started to reach this phone, and how often to look. */
const ARRIVES_WITHIN_MS = 8000;
const LOOK_EVERY_MS = 250;

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function conversationIdOf(answer: string | null): string | null {
  if (!answer) return null;
  try {
    const id = (JSON.parse(answer) as { conversationId?: unknown }).conversationId;
    return typeof id === 'string' ? id : null;
  } catch {
    return null;
  }
}

export async function startConversation(
  input: StartConversationInput,
): Promise<StartedConversation> {
  const db = changes.open?.db;
  if (!db) return { ok: false, message: 'This phone’s copy of your business isn’t open yet.' };
  const open = { workspaceId: input.workspaceId, personId: input.personId, channel: input.channel };

  const here = await db.getOptional<{ id: string; person_id: string | null }>(LATEST_THREAD_SQL, [
    input.workspaceId,
    input.channel,
    input.counterpart,
  ]);
  if (here) {
    // A thread with their number or address that nobody has linked to them yet: opening it links it, as on the web.
    // That can wait for signal, and it isn't what the person asked for, so it never stops the thread opening.
    if (!here.person_id) void change('conversation.open', open).catch(() => undefined);
    return { ok: true, conversationId: here.id };
  }

  if (!networkSnapshot().online)
    return { ok: false, message: COMPOSE_WORDS.needsSignal(input.name) };
  const made = await change('conversation.open', open);
  const row = await changes.sendQueuedNow(made.id);
  const conversationId = row?.state === 'sent' ? conversationIdOf(row.answer) : null;
  if (!conversationId) {
    // It didn't get through, or HandsFreeOS said no. It isn't left waiting on the phone: sent later, it would start a
    // conversation nobody is looking at.
    await changes.discard([made.id]);
    return {
      ok: false,
      message: row?.state === 'refused' && row.reason ? row.reason : COMPOSE_WORDS.notReached,
    };
  }

  const deadline = Date.now() + ARRIVES_WITHIN_MS;
  for (;;) {
    if (await db.getOptional<{ id: string }>(HERE_SQL, [conversationId]))
      return { ok: true, conversationId };
    if (Date.now() >= deadline) return { ok: false, message: COMPOSE_WORDS.notHereYet };
    await pause(LOOK_EVERY_MS);
  }
}
