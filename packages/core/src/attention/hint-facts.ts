/**
 * What Home shows beside each attention item (M8; browser-safe since M10): a "Not confirmed" item's appointment and
 * when it starts, the channel the item would use with the customer ("Confirm by text", "Email Tom"), and whether a
 * money card offers a call first. The server looks the facts up for a whole list at once (`hints.ts`); the phone reads
 * them from its copy. Both work the hints out here, by the same rules as preview_handle (auto-plan.ts): an automatic
 * action (a confirmation request or a nudge) by the reach rule, a person's reply (a hot lead, an unanswered lead, a
 * waiting customer, a money follow-up) by the reply rule.
 */
import type { ConversationChannel } from '../schemas/conversation';
import { autoActionOf, type AttentionKind } from './kinds';
import {
  MONEY_KINDS,
  nudgeContact,
  reachChannel,
  reachRule,
  replyChannelRule,
  REPLY_KINDS,
  type ReachBusiness,
  type ReachContact,
} from './reach';
import { chipsOf, NO_HINTS, type AttentionRow, type ItemHints } from './view';

export type HintConsent = 'unknown' | 'opted_in' | 'opted_out';

/** A booked seat: its appointment, when it starts, and the booking's own contact details. */
export interface HintSeat {
  readonly id: string;
  readonly appointmentId: string;
  readonly startsAt: string;
  readonly phone: string | null;
  readonly email: string | null;
  readonly smsOk: boolean;
  /** The customer's own texting consent. */
  readonly consent: HintConsent;
}

export interface HintPerson {
  readonly id: string;
  readonly phone: string | null;
  readonly email: string | null;
  readonly consent: HintConsent;
}

export interface HintConversation {
  readonly id: string;
  readonly personId: string | null;
  readonly channel: ConversationChannel;
  readonly counterpart: string;
  /** Epoch ms, or null. */
  readonly lastMessageAt: number | null;
}

export interface HintFacts {
  readonly seats: ReadonlyMap<string, HintSeat>;
  readonly people: ReadonlyMap<string, HintPerson>;
  /** The items' conversations, and each customer's (the latest is a reply's when the item names none). */
  readonly conversations: readonly HintConversation[];
  /** Numbers that said STOP. */
  readonly stoppedNumbers: ReadonlySet<string>;
  /** Addresses email to is stopped, lower-cased. */
  readonly stoppedEmails: ReadonlySet<string>;
  /** Null when no item needs it (no automatic action with someone to reach). */
  readonly business: ReachBusiness | null;
  /** The business is open now (only money cards ask). */
  readonly openNow: boolean;
}

type HintRow = Pick<
  AttentionRow,
  'id' | 'kind' | 'reasons' | 'subjectType' | 'subjectId' | 'personId' | 'conversationId'
>;

/** What each item needs looked up: its automatic action, whether it's a money card, whether Handle is a reply. */
export function hintPlansOf(items: readonly HintRow[]) {
  return items.map((row) => {
    const kind = row.kind as AttentionKind;
    const auto = autoActionOf(kind, chipsOf(row));
    const money = MONEY_KINDS.has(kind);
    // A money card reaches the customer by the reply rules too: its Handle writes to them about the document.
    return { row, auto, money, reply: !auto && (REPLY_KINDS.has(kind) || money) };
  });
}

const unique = (list: readonly (string | null | undefined)[]): string[] => [
  ...new Set(list.filter((x): x is string => !!x)),
];

/** The seats, customers and conversations a list's hints need, by id. */
export function hintLookupsOf(items: readonly HintRow[]) {
  const plans = hintPlansOf(items);
  const replies = plans.filter((p) => p.reply);
  return {
    plans,
    seatIds: unique(items.filter((r) => r.subjectType === 'attendee').map((r) => r.subjectId)),
    personIds: unique(
      plans
        .filter((p) => (p.auto === 'nudge' || p.reply) && p.row.personId)
        .map((p) => p.row.personId),
    ),
    conversationIds: unique(replies.map((p) => p.row.conversationId)),
    /** Customers whose latest conversation a reply goes in, when the item names none. */
    conversationPeople: unique(
      replies.filter((p) => !p.row.conversationId).map((p) => p.row.personId),
    ),
    needsBusiness: plans.some((p) => p.auto !== null),
    needsOpenNow: plans.some((p) => p.money),
  };
}

/** The hints for each item, by item id (items without any get none). */
export function itemHintsOf(items: readonly HintRow[], facts: HintFacts): Map<string, ItemHints> {
  const out = new Map<string, ItemHints>();
  const plans = hintPlansOf(items);
  const convOf = new Map(facts.conversations.map((c) => [c.id, c]));
  const latestOf = new Map<string, HintConversation>();
  const at = (c: HintConversation) => c.lastMessageAt ?? 0;
  for (const c of facts.conversations)
    if (c.personId && (!latestOf.has(c.personId) || at(c) > at(latestOf.get(c.personId)!)))
      latestOf.set(c.personId, c);

  for (const p of plans) {
    const seat = p.row.subjectType === 'attendee' ? facts.seats.get(p.row.subjectId) : undefined;
    let contact: ReachContact | null = null;
    let reply: {
      conversationChannel: ConversationChannel | null;
      phone: string | null;
      email: string | null;
      textNumber: string | null;
      optedOut: boolean;
    } | null = null;
    const person = p.row.personId ? facts.people.get(p.row.personId) : undefined;
    if (p.auto === 'confirm_request') {
      if (seat)
        contact = {
          phone: seat.phone,
          email: seat.email,
          smsOk: seat.smsOk,
          personConsent: seat.consent,
        };
    } else if (p.auto === 'nudge') {
      contact = nudgeContact({
        phone: person?.phone ?? null,
        email: person?.email ?? null,
        consent: person?.consent ?? null,
      });
    } else if (p.reply) {
      const conv = p.row.conversationId
        ? convOf.get(p.row.conversationId)
        : p.row.personId
          ? latestOf.get(p.row.personId)
          : undefined;
      reply = {
        conversationChannel: conv?.channel ?? null,
        phone: person?.phone ?? null,
        email: person?.email ?? null,
        textNumber: conv?.channel === 'sms' ? conv.counterpart : (person?.phone ?? null),
        optedOut: person?.consent === 'opted_out',
      };
    }
    let reach: ItemHints['reach'] = null;
    if (contact && facts.business)
      reach = reachChannel(
        reachRule(
          contact,
          {
            optedOut: !!contact.phone && facts.stoppedNumbers.has(contact.phone),
            emailStopped: !!contact.email && facts.stoppedEmails.has(contact.email.toLowerCase()),
          },
          facts.business,
        ),
      );
    else if (reply)
      reach = replyChannelRule({
        conversationChannel: reply.conversationChannel,
        phone: reply.phone,
        email: reply.email,
        textStopped:
          reply.optedOut || (!!reply.textNumber && facts.stoppedNumbers.has(reply.textNumber)),
      });
    // A call comes first on a money card when there's a number to ring and the business is open. Nobody wants
    // the phone about an unpaid invoice at half past ten at night.
    const callable = p.money && facts.openNow && !!reply?.phone;
    if (!seat && reach === null && !callable) continue;
    out.set(p.row.id, {
      ...NO_HINTS,
      ...(seat ? { appointmentId: seat.appointmentId, startsAt: seat.startsAt } : {}),
      reach,
      callable,
    });
  }
  return out;
}
