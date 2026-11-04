import type { AssistantCard, ConversationHandoffReason } from '@hfos/core';
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
  readonly email?: string;
}

/**
 * Photos a scene's customers send are files in the web app's own `public/demo/`, never in Storage: a thread's media
 * in this bucket is shown from `objectPath` as it is (`useSignedUrl`).
 */
export const DEMO_MEDIA_BUCKET = 'hfos-demo';

export interface DemoMedia {
  readonly name: string;
  readonly contentType: string;
  /** Under the web app, e.g. `/demo/water-heater-leak.svg`. */
  readonly path: string;
  readonly sizeBytes: number;
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
  /** The business's hand-off line, which the teammate sends when it hands the conversation to a person. */
  readonly handoffLine?: boolean;
  /** Sent by the presenter, from the composer. */
  readonly byMe?: boolean;
  /** A phone call rather than a text: how far it has got, and what it left behind once it's over. */
  readonly call?: DemoCall;
  /** The photos it came with (a text with a photo goes as MMS). */
  readonly media?: readonly DemoMedia[];
  /** An email's subject. */
  readonly subject?: string;
}

export interface DemoCall {
  /** missed: nobody picked up, and it isn't over to the AI teammate. */
  status: 'ringing' | 'in_progress' | 'completed' | 'missed';
  /** The AI teammate picked up. */
  answeredByAi: boolean;
  seconds: number | null;
  transcript: string | null;
}

/** Why the AI teammate handed a conversation to a person, and when. Cleared once someone takes it. */
export interface DemoHandoff {
  readonly since: number;
  readonly reason: ConversationHandoffReason;
  readonly note: string;
}

/** A website chat's visitor, as they typed it and where they are on the site. */
export interface DemoVisitor {
  readonly id: string;
  readonly name: string;
  readonly site: string;
  readonly pagePath: string;
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
  /** What else approving does, as the card says it: moves or cancels one of their visits, or sends a quote's link. */
  readonly action?: DemoDraftAction;
  /** The presenter changed the words before sending it: `body` is what the teammate wrote. */
  edited?: string;
  /** What it used from what the AI knows, as the card lists it. */
  readonly knowledge?: readonly string[];
  /** An email reply's subject. */
  readonly subject?: string;
}

export type DemoDraftAction =
  | {
      readonly kind: 'reschedule';
      readonly visitId: string;
      readonly startsAt: number;
      readonly summary: string;
    }
  | { readonly kind: 'cancel'; readonly visitId: string; readonly summary: string }
  | { readonly kind: 'share_link'; readonly estimateId: string; readonly summary: string };

export interface DemoVisit {
  readonly id: string;
  readonly title: string;
  startsAt: number;
  readonly minutes: number;
  readonly bookedAt: number;
  cancelled?: boolean;
  /** The job is done: marked complete on its sheet. */
  completed?: boolean;
  /** Who booked it, as the sheet's chip says ("Booked online", "Booked by AI"); the AI teammate unless said. */
  readonly source?: 'staff' | 'booking_page' | 'ai_teammate';
  /** What the visit costs, for the bill after it. */
  readonly priceCents?: number;
  /** At the customer's home. */
  readonly address?: string;
  /** A video call rather than a visit, and whether it's recorded: its words come back as the call's notes. */
  readonly video?: 'zoom' | 'handsfree';
  /** What the AI made of the call once it was over. */
  readonly notes?: DemoCallNotes;
  /** The reminders it set: a confirmation, then each reminder by its key (`day_before`, `before_120`). */
  readonly reminders?: { readonly confirmedAt: number; readonly keys: readonly string[] };
  /** Everyone booked into it, when it's more than the one person (a webinar's seats). */
  readonly seats?: readonly DemoPerson[];
  /** A webinar: its call, its live poll, and how it scored everyone who came. */
  readonly webinar?: DemoWebinar;
}

/** One person who came to a webinar, scored from the live poll and what they said in the chat. */
export interface DemoWebinarLead {
  readonly id: string;
  readonly person: DemoPerson;
  readonly label: 'hot' | 'warm' | 'cold';
  readonly points: number;
  /** Stayed to the end, and how long they were on. */
  readonly stayed: boolean;
  readonly seconds: number;
  /** What earned the points, a line each. */
  readonly parts: readonly { readonly what: string; readonly points: number }[];
  /** The hot ones' reason, in a line. */
  readonly reason: string | null;
  /** What the AI teammate did about it: `sent` a text, or nothing yet. */
  readonly outcome: 'sent' | null;
}

export interface DemoWebinar {
  readonly callId: string;
  /** The live poll's question. */
  readonly poll: string;
  /** The scores a lead needs to be Hot or Warm. */
  readonly hot: number;
  readonly warm: number;
  readonly leads: readonly DemoWebinarLead[];
}

/** A visit on the calendar with nobody's conversation behind it (a call booked by hand, a job from last week). */
export interface DemoCalendarVisit extends DemoVisit {
  readonly person: DemoPerson;
}

/** One thing the AI suggests after a recorded call, waiting for a person to approve or dismiss it. */
export interface DemoSuggestion {
  readonly id: string;
  readonly kind: 'task' | 'follow_up';
  /** A task's `title`; a follow-up email's `subject` and `body`. */
  readonly preview: Readonly<Record<string, string>>;
  status: 'pending' | 'approved' | 'dismissed';
}

/** What the AI heard on a recorded call: the summary, the words, and what it suggests doing next. */
export interface DemoCallNotes {
  readonly id: string;
  readonly at: number;
  readonly summary: string;
  readonly transcript: string;
  readonly suggestions: readonly DemoSuggestion[];
}

/** A HandsFreeOS video call that wasn't for an appointment: its own line on the customer's timeline. */
export interface DemoVideoCall {
  readonly id: string;
  /** When it ended. */
  readonly at: number;
  readonly seconds: number;
  readonly notes: DemoCallNotes;
  /** What was typed in the call's chat, oldest first. */
  readonly chat: readonly {
    readonly id: string;
    readonly at: number;
    readonly side: 'team' | 'customer';
    readonly name: string;
    readonly body: string;
  }[];
}

/** A time the presenter's own Google Calendar has them busy: the calendar shows it, and nobody can book over it. */
export interface DemoBusy {
  readonly startsAt: number;
  readonly endsAt: number;
}

/** A Messenger or Instagram ad the customer tapped before they wrote: where they came from. */
export interface DemoAd {
  readonly name: string;
  readonly campaign: string;
  readonly headline: string;
  readonly body: string;
  readonly at: number;
}

/** A lead the scene made, shown beside its conversation. */
export interface DemoLead {
  readonly id: string;
  readonly title: string;
  readonly stage: string;
  readonly valueCents: number;
}

/** A lead with a page of its own (Pipeline → the lead), on one of the business's own stages by name. */
export interface DemoLeadRecord {
  readonly id: string;
  readonly title: string;
  readonly person: DemoPerson;
  /** A stage of the business's pipeline, e.g. `New`. */
  readonly stage: string;
  readonly valueCents: number;
  /** Where it came from, as the lead's Source reads: "Referred by Carla Benson". */
  readonly source: string | null;
  readonly at: number;
  /** A video call with them, on the lead's timeline. */
  readonly videoCall?: DemoVideoCall;
  /** It shows on the Pipeline board too, in its stage (or the first open one). */
  readonly onBoard?: boolean;
}

/**
 * Somebody a customer said needs the business ("my neighbor Sue needs her heater looked at"), waiting on Home as a
 * Referral card until Create lead makes them a customer and a lead.
 */
export interface DemoReferral {
  readonly id: string;
  /** The customer who mentioned them, and where they said it. */
  readonly from: DemoPerson;
  readonly conversationId: string;
  readonly name: string;
  readonly relation: string;
  readonly need: string;
  readonly quote: string;
  readonly at: number;
  /** The lead Create lead made (in `leads`). */
  leadId?: string;
}

/** A line of guidance the AI teammate made of the presenter's change, waiting on Home to be added. */
export interface DemoLesson {
  readonly id: string;
  readonly line: string;
  readonly why: string;
  readonly at: number;
  applied?: boolean;
}

export interface DemoConversation {
  readonly id: string;
  readonly person: DemoPerson;
  /** False while a website chat's visitor hasn't said who they are: no contact is linked yet. */
  known?: boolean;
  /** `sms` unless said otherwise. */
  readonly channel?: 'sms' | 'chat' | 'email' | 'messenger' | 'instagram';
  /** Messenger and Instagram: who wrote, as Meta names them, and the ad they came from. */
  readonly social?: {
    readonly name: string;
    readonly username: string | null;
    readonly ad?: DemoAd;
  };
  /** The lead it made (or the one it's about). */
  openLead?: DemoLead | null;
  readonly visitor?: DemoVisitor;
  readonly createdAt: number;
  unread: number;
  readonly messages: DemoMessage[];
  readonly drafts: DemoDraft[];
  readonly visits: DemoVisit[];
  /** Waiting for a person since the teammate handed it over. */
  handoff?: DemoHandoff | null;
  /** The presenter took it over from the teammate. */
  takenOver?: boolean;
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

/** A line on an estimate or invoice. */
export interface DemoLine {
  readonly name: string;
  readonly description: string | null;
  readonly quantity: number;
  readonly unitPriceCents: number;
}

/** An estimate the scene made up: sent and opened, and approved once the customer types their name. */
export interface DemoEstimate {
  readonly id: string;
  readonly number: string;
  readonly title: string;
  readonly person: DemoPerson;
  readonly email: string;
  readonly lines: readonly DemoLine[];
  readonly createdAt: number;
  readonly sentAt: number;
  readonly viewedAt: number;
  /** Its last good day, `YYYY-MM-DD`. */
  readonly expiresOn: string;
  accepted?: { readonly at: number; readonly name: string };
}

/**
 * An invoice: raised from a made-up estimate (its lines and customer are the estimate's), or written for a visit
 * with its own. A draft until the presenter sends it.
 */
export interface DemoInvoice {
  readonly id: string;
  readonly number: string;
  readonly estimateId?: string;
  /** Written for one visit (Invoice this visit, or a booking's deposit): the visit's sheet shows it. */
  readonly appointmentId?: string;
  readonly purpose?: 'standard' | 'deposit';
  /** Its own, when it isn't from an estimate. */
  readonly title?: string;
  readonly person?: DemoPerson;
  readonly email?: string | null;
  readonly lines?: readonly DemoLine[];
  readonly createdAt: number;
  sentAt?: number;
  /** `YYYY-MM-DD`. */
  readonly dueOn: string;
  /** Paid in full, by card on their phone. */
  paid?: { readonly at: number; readonly brand: string; readonly last4: string };
}

/** A contract sent to sign (docs/documents.md), on a PDF in the web app's own `public/demo/`. */
export interface DemoDocument {
  readonly id: string;
  readonly name: string;
  readonly person: DemoPerson;
  readonly email: string;
  /** Under the web app, e.g. `/demo/install-agreement.pdf`, with its pages' size in points. */
  readonly pdf: string;
  readonly pages: readonly { readonly width: number; readonly height: number }[];
  /** Where her signature, name and date go: fractions of the page, from the top left. */
  readonly spots: {
    readonly signature: { x: number; y: number; w: number; h: number };
    readonly name: { x: number; y: number; w: number; h: number };
    readonly date: { x: number; y: number; w: number; h: number };
  };
  readonly sentAt: number;
  openedAt?: number;
  /** Signed: when, on what, and the picture of the signature (under the web app). */
  signed?: { readonly at: number; readonly device: string; readonly image: string };
}

/**
 * One scripted answer from the Assistant: what it says it's doing, what it looked up (`shows`: the cards a look-up
 * returns, like what you're owed or a day's appointments), its words, then a card for each thing it asks to do.
 */
export interface DemoAnswer {
  readonly steps: readonly { readonly id: string; readonly label: string }[];
  readonly shows?: readonly AssistantCard[];
  readonly text: string;
  readonly cards?: readonly DemoConfirmCard[];
}

export interface DemoConfirmCard {
  readonly toolCallId: string;
  readonly tool: string;
  readonly title: string;
  readonly fields: readonly { readonly label: string; readonly value: string }[];
  readonly confirmLabel: string;
  /** A text or email's words, under the fields. */
  readonly body?: string;
  readonly note?: string;
  /** Rules shown before saying yes, as the worker words them (a caution, a note), after `note`. */
  readonly warnings?: readonly { readonly kind: string; readonly text: string }[];
  /** A lead's move, shown as from → to. */
  readonly stageFrom?: string;
  readonly stageTo?: string;
  /** What Confirm says it did, and the page it opens (in the business, e.g. `campaigns/<id>`). */
  readonly outcome: string;
  readonly opens?: string;
}

/** A service the business offers, added from Ask HandsFreeOS. */
export interface DemoService {
  readonly id: string;
  readonly name: string;
  readonly minutes: number;
  readonly priceCents: number;
}

/** A Google review, as Reviews lists it; `reply` once it's answered. */
export interface DemoReview {
  readonly id: string;
  readonly author: string;
  readonly stars: number;
  readonly body: string;
  readonly postedAt: number;
  reply?: { readonly body: string; readonly at: number };
}

/** An offer in Knowledge → Offers, running from `startsOn` to `endsOn` (YYYY-MM-DD). */
export interface DemoOffer {
  readonly id: string;
  readonly name: string;
  readonly details: string;
  readonly startsOn: string;
  readonly endsOn: string;
  readonly at: number;
}

/** A spreadsheet brought in from another CRM, and the people it made. */
export interface DemoImport {
  readonly id: string;
  readonly fileName: string;
  readonly at: number;
  readonly people: readonly DemoPerson[];
}

/** A note on a customer's page: its first line is its title, as Search and the timeline show it. */
export interface DemoNote {
  readonly id: string;
  readonly person: DemoPerson;
  readonly body: string;
  readonly at: number;
}

export interface DemoWorld {
  readonly state: DemoState;
  readonly workspaceId: string;
  readonly conversations: DemoConversation[];
  readonly campaigns: DemoCampaign[];
  readonly estimates: DemoEstimate[];
  readonly invoices: DemoInvoice[];
  readonly services: DemoService[];
  readonly lessons: DemoLesson[];
  readonly leads: DemoLeadRecord[];
  readonly referrals: DemoReferral[];
  /** Visits on the calendar with no conversation behind them; a conversation's own visits show there too. */
  readonly visits: DemoCalendarVisit[];
  /** The presenter's Google Calendar: connected, and the times it has them busy. */
  readonly google: { connected: boolean; readonly busy: DemoBusy[] };
  readonly documents: DemoDocument[];
  /** What the Assistant answers the next question with; null leaves questions to the real Assistant. */
  answer: DemoAnswer | null;
  /** Every card the scene has shown, by tool call id, for Confirm. */
  readonly cards: Record<string, DemoConfirmCard>;
  /** Ask HandsFreeOS's chat so far, so a page reloaded mid-scene shows it again. */
  readonly chat: { readonly question: string; readonly answer: DemoAnswer; readonly at: number }[];
  /** The cards the presenter has confirmed, by tool call id. */
  readonly confirmed: string[];
  /** The scene shows the AI teammate past its training, replying on its own: its status reads automatic. */
  teammateAutomatic: boolean;
  /** Google reviews, and whether Google shows as connected on Reviews. */
  readonly reviews: DemoReview[];
  reviewsConnected: boolean;
  readonly offers: DemoOffer[];
  readonly imports: DemoImport[];
  /** Notes on the scene's customers, which Search finds by their words. */
  readonly notes: DemoNote[];
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
