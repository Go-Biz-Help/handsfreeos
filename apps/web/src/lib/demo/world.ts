import type { DemoState } from './state';

/**
 * What a scene has made up so far: the people, conversations, drafts, visits and campaigns its steps added, and what
 * the Assistant says to the next question. Built again from the cookie for every answer, by running each step's
 * `change` in order, so the server and the browser always agree.
 */

/** Every made-up record's id starts like this, so an answer for one is never confused with a real record. */
const PREFIX = 'de300000-0000-4000-8000-';
export const isDemoId = (id: unknown): id is string =>
  typeof id === 'string' && id.startsWith(PREFIX);
/** A made-up record's id: the scene's own number keeps two scenes' records apart. */
export const demoId = (n: number) => `${PREFIX}${n.toString(16).padStart(12, '0')}`;
/** True when a request body names a made-up record anywhere. */
export const namesDemoRecord = (body: string) => body.includes(PREFIX);

export interface DemoPerson {
  readonly id: string;
  readonly firstName: string;
  readonly lastName: string;
  /** E.164. */
  readonly phone: string;
  readonly city: string;
  readonly tags: readonly string[];
  /** Null for someone new. */
  readonly customerSince: number | null;
}

export interface DemoMessage {
  readonly id: string;
  readonly at: number;
  readonly direction: 'inbound' | 'outbound';
  readonly body: string;
  /** Written by the AI teammate; `approved` once the person said OK to it. */
  readonly teammate?: boolean;
  readonly approved?: boolean;
  readonly draftId?: string;
}

export interface DemoDraft {
  readonly id: string;
  readonly at: number;
  readonly body: string;
  status: 'pending' | 'approved';
  decidedAt?: number;
  readonly inReplyTo: string;
  /** Approving it books this visit. */
  readonly book?: { readonly startsAt: number; readonly minutes: number; readonly summary: string };
}

export interface DemoVisit {
  readonly id: string;
  readonly title: string;
  readonly startsAt: number;
  readonly minutes: number;
  readonly bookedAt: number;
}

export interface DemoConversation {
  readonly id: string;
  readonly person: DemoPerson;
  readonly createdAt: number;
  unread: number;
  readonly messages: DemoMessage[];
  readonly drafts: DemoDraft[];
  readonly visits: DemoVisit[];
}

export interface DemoRecipient {
  readonly id: string;
  readonly person: DemoPerson;
  readonly draft: string;
  removed?: boolean;
  /** Left out from the start, and why (`opted_out`, `no_phone`). */
  readonly skipReason?: string;
}

export interface DemoCampaign {
  readonly id: string;
  readonly name: string;
  readonly goal: string;
  readonly createdAt: number;
  readonly perHour: number;
  /** How long the AI takes to write every text, in ms: the page shows them written one by one. */
  readonly writingMs: number;
  approvedAt?: number;
  readonly recipients: DemoRecipient[];
}

/** One scripted answer from the Assistant: what it says it's doing, its words, then a card. */
export interface DemoAnswer {
  readonly steps: readonly { readonly id: string; readonly label: string }[];
  readonly text: string;
  readonly card?: DemoConfirmCard;
}

export interface DemoConfirmCard {
  readonly toolCallId: string;
  readonly tool: string;
  readonly title: string;
  readonly fields: readonly { readonly label: string; readonly value: string }[];
  readonly confirmLabel: string;
  readonly note?: string;
  /** What Confirm says it did, and the page it opens (in the business, e.g. `campaigns/<id>`). */
  readonly outcome: string;
  readonly opens?: string;
}

export interface DemoWorld {
  readonly state: DemoState;
  readonly workspaceId: string;
  readonly conversations: DemoConversation[];
  readonly campaigns: DemoCampaign[];
  /** What the Assistant answers the next question with; null leaves questions to the real Assistant. */
  answer: DemoAnswer | null;
  /** Every card the scene has shown, by tool call id, for Confirm. */
  readonly cards: Record<string, DemoConfirmCard>;
  /** Ask HandsFreeOS's chat so far, so a page reloaded mid-scene shows it again. */
  readonly chat: { readonly question: string; readonly answer: DemoAnswer; readonly at: number }[];
  /** The cards the presenter has confirmed, by tool call id. */
  readonly confirmed: string[];
}

/** The wall-clock time `hour:minute`, `days` from `at`'s date, in `timeZone`, as ms since the epoch. */
export function wallTime(
  at: number,
  timeZone: string,
  days: number,
  hour: number,
  minute = 0,
): number {
  const parts = (t: number) => {
    const p = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).formatToParts(new Date(t));
    const get = (type: string) => Number(p.find((x) => x.type === type)?.value ?? 0);
    return { y: get('year'), m: get('month'), d: get('day'), h: get('hour'), min: get('minute') };
  };
  const today = parts(at);
  const wanted = Date.UTC(today.y, today.m - 1, today.d + days, hour, minute);
  // The zone's offset at that moment, found from what the zone's clock reads there (twice, for a DST change).
  let guess = wanted;
  for (let i = 0; i < 2; i++) {
    const p = parts(guess);
    const reads = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min);
    guess += wanted - reads;
  }
  return guess;
}

export const fullName = (p: DemoPerson) => `${p.firstName} ${p.lastName}`;

/** The business's name inside a sentence: "Bayou Plumbing Co." would end it with two periods. */
export const businessOf = (w: DemoWorld) => w.state.business.trim().replace(/\.+$/, '');

/** `+15125550142` as `(512) 555-0142`. */
export function phoneDisplay(e164: string): string {
  const d = e164.replace(/^\+1/, '');
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : e164;
}
