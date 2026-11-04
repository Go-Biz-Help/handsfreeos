import type { ConversationListRow, MessageThreadRow, PushData, TeammateDraftRow } from '@hfos/core';

import type { PhoneDemo } from './state';

/**
 * The made-up rows a scene adds to the phone's own screens (src/demo): rows shaped as the phone's copy holds them, so
 * the inbox, a thread and the AI teammate's draft card draw them as they draw real ones. Worked out again from the
 * scene and its played steps every time, never written to the copy.
 */

export type DemoConversationRow = ConversationListRow & {
  readonly draft_waiting: number | null;
  readonly last_inbound_at: string | null;
};

/** A made-up customer, as the thread's person query reads one. */
export interface DemoPersonRow {
  readonly id: string;
  readonly first_name: string | null;
  readonly last_name: string | null;
  readonly phone: string | null;
  readonly phone_e164: string | null;
  readonly email: string | null;
  readonly sms_consent: string | null;
  readonly archived_at: string | null;
  readonly created_at: string | null;
  readonly address_line1: string | null;
  readonly city: string | null;
  readonly state: string | null;
  readonly postal_code: string | null;
  readonly notes: string | null;
}

export interface PhoneDemoWorld {
  conversations: DemoConversationRow[];
  messages: MessageThreadRow[];
  drafts: TeammateDraftRow[];
  people: DemoPersonRow[];
}

export const emptyWorld = (): PhoneDemoWorld => ({
  conversations: [],
  messages: [],
  drafts: [],
  people: [],
});

/** What a step's change knows: the scene as it's playing, and when this step played. */
export interface StepContext {
  readonly demo: PhoneDemo;
  readonly at: number;
}

/** What a step can do on the phone as it plays. */
export interface PhoneDemoPlayer {
  readonly demo: PhoneDemo;
  /** Opens a screen of the business: `inbox`, `inbox/<conversation>`. */
  open(path: string): void;
  /** Shows a made-up push in a few seconds, as the worker's would look, buttons and all. */
  push(data: PushData, inSeconds: number): Promise<void>;
  /** Takes the scene's notifications away, shown or still to come. */
  clearPushes(): Promise<void>;
}

/** A button on a scene's notification that plays its step: Approve, or a tap on the notification itself. */
export type DemoPress = 'approve' | 'open';

export interface PhoneDemoStep {
  readonly label: string;
  /** What to say over it, for a video or a live show. */
  readonly voiceover: string;
  /** What the presenter does now, when it's something on the phone rather than Next. */
  readonly cue?: string;
  /** What it adds to the made-up world, replayed in order each time. */
  readonly change?: (world: PhoneDemoWorld, ctx: StepContext) => void;
  /** What playing it does: a screen opens, a notification is on its way. */
  readonly run?: (player: PhoneDemoPlayer) => void | Promise<void>;
  /** Pressing this on the scene's notification plays the step (Next does too). */
  readonly press?: DemoPress;
}

export interface PhoneDemoScene {
  readonly id: string;
  /** Its number in the list of scenes (the web's are 1 to 66; the phone's are 54 and 55). */
  readonly number: number;
  readonly title: string;
  readonly summary: string;
  readonly steps: readonly PhoneDemoStep[];
}

const iso = (at: number) => new Date(at).toISOString();

/** A made-up conversation's row, with nothing set beyond what's given. */
export function conversationRow(
  fields: Partial<DemoConversationRow> & Pick<DemoConversationRow, 'id' | 'counterpart'>,
  at: number,
): DemoConversationRow {
  return {
    channel: 'sms',
    status: 'open',
    person_id: null,
    first_name: null,
    last_name: null,
    assignee_user_id: null,
    unread_count: 1,
    last_message_at: iso(at),
    last_preview: null,
    last_direction: 'inbound',
    awaiting_reply_since: null,
    snoozed_until: null,
    created_at: iso(at),
    handled_by: 'ai',
    ai_teammate_id: null,
    teammate_name: null,
    needs_person_since: null,
    handoff_reason: null,
    handoff_note: null,
    taken_over_by: null,
    draft_waiting: 0,
    last_inbound_at: null,
    ...fields,
  };
}

export function personRow(
  fields: Pick<DemoPersonRow, 'id' | 'first_name' | 'last_name' | 'phone_e164'> &
    Partial<DemoPersonRow>,
  at: number,
): DemoPersonRow {
  return {
    phone: null,
    email: null,
    sms_consent: 'granted',
    archived_at: null,
    created_at: iso(at),
    address_line1: null,
    city: null,
    state: null,
    postal_code: null,
    notes: null,
    ...fields,
  };
}

/** A made-up text in a thread. */
export function messageRow(
  fields: Partial<MessageThreadRow> &
    Pick<MessageThreadRow, 'id' | 'conversation_id' | 'direction' | 'body_text'>,
  at: number,
): MessageThreadRow {
  return {
    channel: 'sms',
    status: fields.direction === 'outbound' ? 'delivered' : 'received',
    from_address: null,
    to_addresses: null,
    cc_addresses: null,
    subject: null,
    media: null,
    error_code: null,
    error_message: null,
    sent_by: null,
    sent_by_teammate_id: null,
    approved_by: null,
    client_id: null,
    delivered_at: fields.direction === 'outbound' ? iso(at) : null,
    ...fields,
    occurred_at: iso(at),
  };
}

/** Changes a made-up conversation in place. */
export function patchConversation(
  world: PhoneDemoWorld,
  id: string,
  fields: Partial<DemoConversationRow>,
): void {
  world.conversations = world.conversations.map((c) => (c.id === id ? { ...c, ...fields } : c));
}

/** A conversation's last-message columns after a message, as the copy keeps them. */
export function lastMessage(m: MessageThreadRow): Partial<DemoConversationRow> {
  return {
    last_message_at: m.occurred_at,
    last_preview: m.body_text,
    last_direction: m.direction,
    ...(m.direction === 'inbound' ? { last_inbound_at: m.occurred_at } : {}),
  };
}

/** "Bayou Plumbing Co." ends a sentence once, not twice. */
export const inSentence = (business: string): string => business.trim().replace(/\.+$/, '');

/** The presenter's first name from their full name; empty when the phone doesn't know it. */
export const firstNameOf = (fullName: string): string => fullName.trim().split(/\s+/)[0] ?? '';
