/**
 * The person menu on someone's name (docs/outreach.md, decision 91): wherever the app shows someone kept in Social
 * Outreach (Waiting for you, Today, the Pipeline, Chats, Friends), their name opens it. Its page on their network
 * first, which works with no signal, their chat second, then the Pipeline's moves, Contacts, **Mark as client**, Demo
 * booked, **Later** (decision 100), Don't pitch and Never contact, each showing where they stand now
 * (`outreach.profile.marks`) so it can be undone. `personMenuItems` decides the order, what shows, what's pressable
 * and the words, once, for the web and the phone.
 *
 * Later is each person's own: it takes someone off their Today for `LATER_DAYS`, then they're back on their own.
 * Their replies, and their friend request to confirm, still come; the person's own messages to them waiting for an OK
 * are skipped (`outreach.later.set`).
 *
 * A client is core's (crm/clients.ts): the Client tag on their customer in Contacts, or anything else Contacts counts.
 * It ends outreach, never replies (`CLIENT_SKIPPED_KINDS`).
 *
 * Browser-safe and pure: the shapes of `outreach.client.set` and `outreach.profile.marks`, and the menu.
 */
import { z } from 'zod';
import { CLIENT_CAUSES, type ClientCause } from '../../crm/record-words';
import { SEND_KINDS, type MessageKind, type SendKind } from './automation';
import { Journey } from './journey';
import { chatUrlOn, openChatWords, openPageWords } from './network-words';
import { PLATFORM_KEYS, type Platform } from './networks';
import { OWNER_WORDS, TeamOwner } from './owners';
import { DontPitch, NeverContact } from './saves';
import { OUTREACH_WORDS } from './words';

const P = OUTREACH_WORDS.person;

/**
 * The messages a client never gets, and Mark as client skips while they wait for an OK or are OK'd and not sent,
 * anyone's: outreach (a first message, Reconnect, the link, the video, a follow-up, a check-in). A reply and a
 * partner's messages stay. Don't pitch from the menu skips them too (Chris, 26 Oct 2026, decision 91), as Never contact
 * skips every message.
 */
export const CLIENT_SKIPPED_KINDS = [
  'opener',
  'reconnect',
  'pitch',
  'video',
  'follow_up',
  'check_in',
] as const satisfies readonly MessageKind[];
export type ClientSkippedKind = (typeof CLIENT_SKIPPED_KINDS)[number];
export const isClientSkipped = (kind: string): kind is ClientSkippedKind =>
  (CLIENT_SKIPPED_KINDS as readonly string[]).includes(kind);

/**
 * Taking someone off Don't pitch or Never contact is for whoever put them on, or an owner or admin
 * (`outreach.manage`): it can't undo a teammate's family. `by` is who put them on, null when nobody's known.
 */
export const mayTakeOff = (by: string | null, me: string, manages: boolean): boolean =>
  !by || by === me || manages;

/** How long Later takes someone off the person's Today (decision 100, the owner's pick 30a): 2 weeks. */
export const LATER_DAYS = 14;

/** The person's own messages to someone that Later skips while they wait for an OK: all but a reply. */
export const LATER_SKIPPED_KINDS: readonly SendKind[] = SEND_KINDS.filter(
  (k) => k !== 'reply' && k !== 'partner_reply',
);

// ------------------------------------------------------------------------------------------------- shapes

export const LaterSetInput = z.object({
  workspaceId: z.uuid(),
  profileId: z.uuid(),
  /** Later, or Take off Later: back on Today now. */
  later: z.boolean(),
});
export type LaterSetInput = z.input<typeof LaterSetInput>;

export const LaterSetOutput = z.object({
  profileId: z.uuid(),
  /** When they're back on Today: null when they're not on Later. */
  until: z.iso.datetime().nullable(),
  /** How many of the person's own messages to them, waiting for an OK or OK'd and not sent, were skipped. */
  skipped: z.number().int().min(0),
});
export type LaterSetOutput = z.output<typeof LaterSetOutput>;

export const ClientSetInput = z.object({
  workspaceId: z.uuid(),
  profileId: z.uuid(),
  /** Mark as client, or Not a client after all. */
  client: z.boolean(),
  /** The customer they are, when the person said "It’s them" before they were marked: else a new one. */
  personId: z.uuid().nullable().optional(),
});
export type ClientSetInput = z.input<typeof ClientSetInput>;

const Cause = z.enum(CLIENT_CAUSES);

/** Where someone stands as a client, for Social Outreach (`clientOf`). */
export const ClientStanding = z.object({
  /** A client: they, their customer, or a profile under the same name on the same network. */
  on: z.boolean(),
  /** Their customer carries the Client tag (`CLIENT_TAG`): Not a client after all takes it off. */
  tagged: z.boolean(),
  /** Contacts' own reason they're a client besides the tag (a paid bill…), first in `CLIENT_CAUSES`' order. */
  because: Cause.nullable(),
});
export type ClientStanding = z.output<typeof ClientStanding>;

export const ClientSetOutput = z.object({
  profileId: z.uuid(),
  /** The customer they're saved to: one added for this, or tied, when they had none. */
  personId: z.uuid().nullable(),
  /** A client now, as Social Outreach counts (`ClientStanding.on`). */
  client: z.boolean(),
  tagged: z.boolean(),
  /** Contacts still counts them a client for this reason, whatever the tag: the menu shows it as a line. */
  because: Cause.nullable(),
  /** A new customer was added to Contacts for them. */
  addedPerson: z.boolean(),
  /** How many messages waiting for an OK, or OK'd and not sent, were skipped. */
  skipped: z.number().int().min(0),
});
export type ClientSetOutput = z.output<typeof ClientSetOutput>;

export const ProfileMarksInput = z.object({ workspaceId: z.uuid(), profileId: z.uuid() });
export type ProfileMarksInput = z.input<typeof ProfileMarksInput>;

export const ProfileMarksOutput = z.object({
  profileId: z.uuid(),
  name: z.string(),
  platform: z.enum(PLATFORM_KEYS),
  /** Their page on their network. */
  url: z.string(),
  /** The customer they're saved to in Contacts. */
  personId: z.uuid().nullable(),
  /** Found as a partner (decision 81), or a twin of one: asked to partner, so no Client or Demo booked. */
  partner: z.boolean(),
  /** The person marked them as having booked a demo (`outreach.demo.mark`). */
  demoBooked: z.boolean(),
  client: ClientStanding,
  /** On the person's own Later until then (decision 100): null when they're not. */
  laterUntil: z.iso.datetime().nullable(),
  dontPitch: DontPitch.nullable(),
  neverContact: NeverContact.nullable(),
  /** Whether the person asking may take them off each list here (`mayTakeOff`), from this profile's own mark. */
  canTakeOff: z.object({ dontPitch: z.boolean(), neverContact: z.boolean() }),
  /**
   * Whoever reached them first (decision 107): null when nobody has, or they no longer use Social Outreach. Left out
   * by builds from before it.
   */
  owner: TeamOwner.nullable().optional(),
  /** For an owner or admin: the teammates they can be given to (`outreach.owner.move`); none for anyone else. */
  moveTo: z.array(TeamOwner).optional(),
  /**
   * Everything about them, for the person panel (decision 128): their way so far (./journey.ts: where they stand and
   * why, the groups they were found in, the chat as the AI read it, and every step), what their page's intro says, and
   * their mutual friends. Left out by builds from before it.
   */
  journey: Journey.optional(),
  intro: z.array(z.string()).optional(),
  mutualFriends: z.number().int().nullable().optional(),
});
export type ProfileMarksOutput = z.output<typeof ProfileMarksOutput>;

// ------------------------------------------------------------------------------------------------- the menu

/** What a list knows of the row the name is on, before the marks come. */
export interface PersonMenuRow {
  /** Their page on their network: Open on {Network}, first. */
  readonly url: string | null;
  readonly platform: Platform;
  /** Their chat, where the list knows it: Open in {messages}, second. */
  readonly threadKey?: string | null;
  /** Found as a partner (decision 81): no Client or Demo booked. */
  readonly partner?: boolean;
  /** The customer they're saved to, where the list says; left out where it doesn't. */
  readonly personId?: string | null;
  /** They booked a demo, where the list says. */
  readonly demoBooked?: boolean;
}

/** A move to another stage on the Pipeline: Ready to pitch, Pitched, Not a fit, Back in play. */
export interface PersonMenuMove {
  readonly key: string;
  readonly label: string;
  readonly danger?: boolean;
}

export interface PersonMenuInput {
  readonly row: PersonMenuRow;
  /** `outreach.profile.marks`' answer: null while it's asked for, or with no signal. */
  readonly marks: ProfileMarksOutput | null;
  /** The Pipeline's moves, on its rows only. */
  readonly moves?: readonly PersonMenuMove[];
  /** Add and edit customers (`records.write`): Add to Contacts and Mark as client need it. */
  readonly contactsWrite: boolean;
  /** Signal: with none, only the Open items can be pressed. */
  readonly online: boolean;
  /** The row has its own Don't pitch and Never contact switches (Friends, Chats): the menu leaves them out. */
  readonly ownSwitches?: boolean;
}

export type PersonMenuKey =
  | 'open-page'
  | 'open-chat'
  | 'move-to'
  | `move-${string}`
  | 'in-contacts'
  | 'add-contact'
  | 'mark-client'
  | 'not-client'
  | 'client-line'
  | 'demo'
  | 'not-demo'
  | 'later'
  | 'not-later'
  | 'dont-pitch'
  | 'not-dont-pitch'
  | 'dont-pitch-line'
  | 'never-contact'
  | 'not-never-contact'
  | 'never-contact-line'
  | `owner-${string}`;

export interface PersonMenuItem {
  readonly key: PersonMenuKey;
  /**
   * `open`: a link out (`url`), in a new tab or the phone's browser, with or without signal. `action`: a press that
   * changes something here or goes to Contacts. `line`: words only, never pressed (a heading, or why it can't be
   * undone here).
   */
  readonly kind: 'open' | 'action' | 'line';
  readonly label: string;
  /** An open item's link. */
  readonly url?: string;
  /** A move's mark (`PersonMenuMove.key`). */
  readonly move?: string;
  /** The teammate a give goes to (`outreach.owner.move`). */
  readonly owner?: string;
  /** Shown as a warning: it puts them on a list (Don't pitch, Never contact) or a move says so. */
  readonly danger: boolean;
  /** It needs signal: with none it shows greyed out under the needs-signal note. */
  readonly needsSignal: boolean;
  /** Pressable now. A line never is. */
  readonly enabled: boolean;
  /** Its test id, the same on the web and the phone. */
  readonly testId: string;
}

/**
 * The person menu's items, in order: Open on {Network}; Open in {messages} when their chat is known; the Pipeline's
 * moves; In Contacts or Add to Contacts; Mark as client, Not a client after all, or why they're a client; Demo booked
 * or Not a demo after all; Later or Take off Later; who reached them first, and for an owner or admin each teammate to
 * give them to (decision 107); Don't pitch, Take off Don't pitch, or who put them on; Never contact, Take off Never
 * contact, or who put them on. A partner has no Client or Demo booked; without `contactsWrite` there's no Add to
 * Contacts or Client to press; a row with its own switches has no Don't pitch or Never contact. The marks' toggles wait
 * for `marks`, and everything but the Open items waits for signal.
 */
export function personMenuItems(input: PersonMenuInput): PersonMenuItem[] {
  const { row, marks, online, contactsWrite } = input;
  const items: PersonMenuItem[] = [];
  const known = marks !== null;
  const partner = marks?.partner ?? row.partner ?? false;
  const press = (
    key: PersonMenuKey,
    label: string,
    testId: string,
    o: { readonly danger?: boolean; readonly waitsForMarks?: boolean; readonly move?: string } = {},
  ): PersonMenuItem => ({
    key,
    kind: 'action',
    label,
    ...(o.move !== undefined ? { move: o.move } : {}),
    danger: o.danger ?? false,
    needsSignal: true,
    enabled: online && (o.waitsForMarks === false || known),
    testId,
  });
  const line = (key: PersonMenuKey, label: string, testId: string): PersonMenuItem => ({
    key,
    kind: 'line',
    label,
    danger: false,
    needsSignal: false,
    enabled: false,
    testId,
  });

  // 1 and 2: their page, then their chat: links out, with or without signal.
  const url = row.url || marks?.url || null;
  if (url)
    items.push({
      key: 'open-page',
      kind: 'open',
      label: openPageWords(row.platform),
      url,
      danger: false,
      needsSignal: false,
      enabled: true,
      testId: 'person-open-page',
    });
  const chat = chatUrlOn(row.platform, row.threadKey ?? null);
  if (chat)
    items.push({
      key: 'open-chat',
      kind: 'open',
      label: openChatWords(row.platform),
      url: chat,
      danger: false,
      needsSignal: false,
      enabled: true,
      testId: 'person-open-chat',
    });

  // 3: the Pipeline's moves.
  const moves = input.moves ?? [];
  if (moves.length) {
    items.push(line('move-to', P.moveTo, 'person-move-to'));
    for (const m of moves)
      items.push(
        press(`move-${m.key}`, m.label, `pipeline-mark-${m.key}`, {
          danger: m.danger ?? false,
          waitsForMarks: false,
          move: m.key,
        }),
      );
  }

  // 4: Contacts. Before the marks come, a list that says who they're saved to is believed.
  const personId = marks ? marks.personId : (row.personId ?? null);
  const personKnown = known || row.personId !== undefined;
  if (personId)
    items.push(press('in-contacts', P.inContacts, 'person-in-contacts', { waitsForMarks: false }));
  else if (contactsWrite)
    items.push({
      ...press('add-contact', P.addToContacts, 'person-add-contact', { waitsForMarks: false }),
      enabled: online && personKnown,
    });

  // 5: Client. Only the tag can be taken off here, and only when it's all that makes them one.
  if (!partner) {
    const client = marks?.client ?? null;
    if (client?.on && client.tagged && !client.because) {
      if (contactsWrite) items.push(press('not-client', P.notClient, 'person-client'));
      else items.push(line('client-line', P.clientLine('tagged'), 'person-client-line'));
    } else if (client?.on)
      items.push(
        line(
          'client-line',
          P.clientLine(client.because ?? (client.tagged ? 'tagged' : null)),
          'person-client-line',
        ),
      );
    else if (contactsWrite) items.push(press('mark-client', P.markClient, 'person-client'));
  }

  // 6: Demo booked.
  if (!partner) {
    const booked = marks?.demoBooked ?? row.demoBooked ?? false;
    items.push(
      booked
        ? press('not-demo', P.notDemo, 'person-demo-mark')
        : press('demo', P.demoBooked, 'person-demo-mark'),
    );
  }

  // 7: Later, the person's own (decision 100), on any row.
  const laterUntil = marks?.laterUntil ?? null;
  items.push(
    laterUntil
      ? press('not-later', P.notLater(laterUntil), 'person-later')
      : press('later', P.later, 'person-later'),
  );

  // 8: whose they are (decision 107): who reached them first, and each teammate an owner or admin can give them to.
  const owner = marks?.owner ?? null;
  if (owner) items.push(line('owner-line', OWNER_WORDS.person(owner), 'person-owner-line'));
  (marks?.moveTo ?? [])
    .filter((t) => t.userId !== owner?.userId)
    .forEach((t, i) =>
      items.push({
        ...press(`owner-${t.userId}`, OWNER_WORDS.giveTo(t), `person-owner-${i}`),
        owner: t.userId,
      }),
    );

  // 9 and 10: the lists, unless the row has its own switches.
  if (!input.ownSwitches) {
    const dontPitch = marks?.dontPitch ?? null;
    if (!dontPitch)
      items.push(press('dont-pitch', P.dontPitch, 'person-dont-pitch', { danger: true }));
    else if (marks?.canTakeOff.dontPitch)
      items.push(press('not-dont-pitch', P.notDontPitch, 'person-dont-pitch'));
    else
      items.push(
        line(
          'dont-pitch-line',
          !dontPitch.by && dontPitch.tagged ? P.taggedFamily : P.putOnBy(P.dontPitch, dontPitch.by),
          'person-dont-pitch-line',
        ),
      );
    const never = marks?.neverContact ?? null;
    if (!never)
      items.push(press('never-contact', P.neverContact, 'person-never-contact', { danger: true }));
    else if (marks?.canTakeOff.neverContact)
      items.push(press('not-never-contact', P.notNeverContact, 'person-never-contact'));
    else
      items.push(
        line(
          'never-contact-line',
          P.putOnBy(P.neverContact, never.by),
          'person-never-contact-line',
        ),
      );
  }
  return items;
}

/**
 * The menu's note with no signal, from the items it shows: what opens now, their page or their chat, or that nothing
 * does, when the list didn't know their page and where they stand can't be asked.
 */
export function personMenuOfflineWords(items: readonly PersonMenuItem[]): string {
  return P.needsSignal(
    items.some((i) => i.key === 'open-page')
      ? 'page'
      : items.some((i) => i.key === 'open-chat')
        ? 'chat'
        : null,
  );
}

/**
 * What the web and the phone say after `outreach.client.set`: a client now; no longer one; or, after Not a client
 * after all, still one, for Contacts' own reason or the same name as a client on this network (`because` null).
 */
export function clientSetWords(
  name: string,
  marked: boolean,
  out: Pick<ClientSetOutput, 'client' | 'because'>,
): string {
  if (marked) return P.clientDone(name);
  return out.client ? P.clientStill(name, out.because) : P.clientOff(name);
}

/** What the web and the phone say after `outreach.later.set`: off Today until a day, or back on it now. */
export function laterSetWords(name: string, out: Pick<LaterSetOutput, 'until'>): string {
  return out.until ? P.laterDone(name, out.until) : P.laterOff(name);
}

/** The causes a client has, as `ClientCause`s, for a screen that names them. */
export type { ClientCause };
