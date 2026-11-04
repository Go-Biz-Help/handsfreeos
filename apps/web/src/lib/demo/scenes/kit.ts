import type { DemoCall, DemoConversation, DemoPerson, DemoWorld } from '../world';
import type { DemoPlayer } from './types';

/** Small pieces the scenes share. */

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

/** "Thu, Nov 6", as the Assistant's cards write a day. */
export const shortDay = (ms: number, timeZone: string) =>
  new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(new Date(ms));

/** "1:30 PM". */
export const clock = (ms: number, timeZone: string) =>
  new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' }).format(
    new Date(ms),
  );

/** "Central Time", beside a day on the Assistant's cards. */
export function zoneName(timeZone: string, at: number): string {
  const part = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longGeneric' })
    .formatToParts(new Date(at))
    .find((x) => x.type === 'timeZoneName');
  return part?.value ?? timeZone;
}

/** 0 for Sunday … 6 for Saturday, where the business is. */
export function weekdayOf(ms: number, timeZone: string): number {
  const name = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(
    new Date(ms),
  );
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(name);
}

/**
 * A conversation that a text from the presenter started, as Ask HandsFreeOS sends one: it reads as theirs, and
 * nothing in it is new to them.
 */
export function textedConversation(
  w: DemoWorld,
  at: number,
  c: { id: string; person: DemoPerson; messageId: string; body: string },
): void {
  w.conversations.unshift({
    id: c.id,
    person: c.person,
    createdAt: at,
    unread: 0,
    messages: [{ id: c.messageId, at, direction: 'outbound', byMe: true, body: c.body }],
    drafts: [],
    visits: [],
  });
}

/** Waits until Ask HandsFreeOS has finished answering: its Stop button has gone. */
export async function answered(p: DemoPlayer, ms = 30_000): Promise<void> {
  await p.wait(500);
  const end = Date.now() + ms;
  while (document.querySelector('[data-testid="assistant-stop"]') && Date.now() < end)
    await p.wait(150);
}

const CARD = '[data-testid="assistant-card-confirm"]';

/**
 * Presses Confirm on the Assistant's waiting cards, one after another, each once the one before says it's done.
 * The step's change has already counted them as confirmed.
 */
export async function confirmEach(p: DemoPlayer, count: number): Promise<void> {
  const done = () => document.querySelectorAll(`${CARD}[data-status="confirmed"]`).length;
  const before = done();
  for (let i = 1; i <= count; i++) {
    await p.click(`${CARD}:not([data-status="confirmed"]) [data-testid="assistant-confirm"]`);
    for (let t = 0; t < 80 && done() < before + i; t++) await p.wait(100);
    await p.wait(250);
  }
}

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
