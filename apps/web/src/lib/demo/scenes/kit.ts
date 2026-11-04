import type { DemoCall, DemoConversation, DemoPerson, DemoWorld } from '../world';
import type { DemoPlayer } from './types';

/** Small pieces the inbox scenes share. */

/** The scene's conversation, which an earlier step made up. */
export function conversationIn(w: DemoWorld, id: string): DemoConversation {
  const c = w.conversations.find((x) => x.id === id);
  if (!c) throw new Error('The scene’s conversation is missing.');
  return c;
}

/** A new conversation at the top of the inbox, opened by one message from the customer. */
export function startConversation(
  w: DemoWorld,
  at: number,
  c: {
    id: string;
    person: DemoPerson;
    firstId: string;
    body: string;
    /** It starts with a phone call rather than a text. */
    call?: DemoCall;
  } & Pick<DemoConversation, 'channel' | 'visitor' | 'known'>,
): void {
  w.conversations.unshift({
    id: c.id,
    person: c.person,
    channel: c.channel,
    visitor: c.visitor,
    known: c.known,
    createdAt: at,
    unread: 1,
    messages: [{ id: c.firstId, at, direction: 'inbound', body: c.body, call: c.call }],
    drafts: [],
    visits: [],
  });
}

/** A first name, for lines the customer reads: the presenter's, from the world or the player. */
export const firstName = (name: string) => name.trim().split(/\s+/)[0] || 'the owner';
export const myFirstName = (w: DemoWorld) => firstName(w.state.me.name);

/** How many days from `at` to the next `weekday` (0 Sunday … 6 Saturday) where the business is, never today. */
export function daysUntil(at: number, timeZone: string, weekday: number): number {
  const name = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(
    new Date(at),
  );
  const today = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(name);
  const ahead = (weekday - today + 7) % 7;
  return ahead === 0 ? 7 : ahead;
}

/** "Thursday, Nov 6" for a moment, where the business is. */
export const dayName = (ms: number, timeZone: string) =>
  new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  }).format(new Date(ms));

/** Points at the conversation's row, opens it, and waits for the thread. */
export async function openConversation(p: DemoPlayer, id: string): Promise<void> {
  await p.click(`@conversation-row-${id}`);
  await p.waitFor('@conversation');
}

/**
 * Types a reply in the composer and sends it, as the presenter. The step's change has already put the message in
 * the thread's answers; the composer shows its own copy at once and swaps it for that one after the refresh.
 */
export async function replyAsMe(p: DemoPlayer, text: string): Promise<void> {
  await p.type('[data-testid="composer"] textarea', text);
  await p.click('@composer-send');
  await p.wait(500);
  p.refresh(['message', 'conversation']);
}
