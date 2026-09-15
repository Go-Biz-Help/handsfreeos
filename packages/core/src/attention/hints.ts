/**
 * What Home shows beside each attention item, looked up for a whole list at once (M8): a "Not confirmed" item's
 * appointment and when it starts, and the channel the item would use with the customer ("Confirm by text",
 * "Email Tom"). The channel follows the same rules as preview_handle (auto-plan.ts): an automatic action (a
 * confirmation request or a nudge) by the reach rule, a person's reply (a hot lead, an unanswered lead, a
 * waiting customer) by the reply rule. Server-only.
 */
import { rows, sql, type Tx } from '@hfos/db/client';
import { uuidArray } from '../calendar/load';
import {
  nudgeContact,
  reachBusinessOf,
  reachChannel,
  reachRule,
  replyChannelRule,
  REPLY_KINDS,
  type ReachBusiness,
  type ReachContact,
} from './auto-plan';
import { chipsOf, NO_HINTS, type ItemHints } from './items';
import { autoActionOf, type AttentionKind } from './kinds';
import type { AttentionItemRow } from './load';

type Consent = 'unknown' | 'opted_in' | 'opted_out';

const unique = (list: readonly (string | null | undefined)[]): string[] => [
  ...new Set(list.filter((x): x is string => !!x)),
];
const textList = (list: readonly string[]) =>
  sql.join(
    list.map((x) => sql`${x}`),
    sql`, `,
  );

/** The hints for each item, by item id (items without any get none). */
export async function loadItemHints(
  tx: Tx,
  workspaceId: string,
  items: readonly AttentionItemRow[],
): Promise<Map<string, ItemHints>> {
  const out = new Map<string, ItemHints>();
  if (!items.length) return out;
  const plans = items.map((row) => {
    const kind = row.kind as AttentionKind;
    const auto = autoActionOf(kind, chipsOf(row));
    return { row, auto, reply: !auto && REPLY_KINDS.has(kind) };
  });

  // Booked seats: the appointment, its start, and the booking's own contact details.
  const seatIds = unique(items.filter((r) => r.subjectType === 'attendee').map((r) => r.subjectId));
  const seats = seatIds.length
    ? await rows<{
        id: string;
        appointment_id: string;
        starts_at: Date | string;
        phone: string | null;
        email: string | null;
        sms_ok: boolean;
        consent: Consent;
      }>(
        tx,
        sql`select t.id, t.appointment_id, p.starts_at, t.contact_phone_e164 as phone, t.contact_email as email,
              t.sms_ok, pp.sms_consent::text as consent
            from app.appointment_attendees t
            join app.appointments p on p.id = t.appointment_id
            join app.people pp on pp.id = t.person_id
            where t.workspace_id = ${workspaceId} and t.id = any(${uuidArray(seatIds)})`,
      )
    : [];
  const seatOf = new Map(seats.map((s) => [s.id, s]));

  // The customers a nudge or a reply would go to, and the conversations a reply would go in.
  const personIds = unique(
    plans
      .filter((p) => (p.auto === 'nudge' || p.reply) && p.row.personId)
      .map((p) => p.row.personId),
  );
  const people = personIds.length
    ? await rows<{ id: string; phone: string | null; email: string | null; consent: Consent }>(
        tx,
        sql`select id, phone_e164 as phone, email::text as email, sms_consent::text as consent
            from app.people where workspace_id = ${workspaceId} and id = any(${uuidArray(personIds)})`,
      )
    : [];
  const personOf = new Map(people.map((p) => [p.id, p]));
  const replies = plans.filter((p) => p.reply);
  const convIds = unique(replies.map((p) => p.row.conversationId));
  const convPeople = unique(
    replies.filter((p) => !p.row.conversationId).map((p) => p.row.personId),
  );
  const convs =
    convIds.length || convPeople.length
      ? await rows<{
          id: string;
          person_id: string | null;
          channel: 'sms' | 'email' | 'chat';
          counterpart: string;
          last_message_at: Date | string | null;
        }>(
          tx,
          sql`select id, person_id, channel::text as channel, counterpart, last_message_at
              from app.conversations
              where workspace_id = ${workspaceId}
                and (id = any(${uuidArray(convIds)}) or person_id = any(${uuidArray(convPeople)}))`,
        )
      : [];
  const convOf = new Map(convs.map((c) => [c.id, c]));
  const latestOf = new Map<string, (typeof convs)[number]>();
  const at = (c: (typeof convs)[number]) =>
    c.last_message_at ? Date.parse(String(c.last_message_at)) : 0;
  for (const c of convs)
    if (c.person_id && (!latestOf.has(c.person_id) || at(c) > at(latestOf.get(c.person_id)!)))
      latestOf.set(c.person_id, c);

  // Who each item would reach, and the numbers and addresses to look up once.
  const contacts = new Map<string, ReachContact>();
  const replyTargets = new Map<
    string,
    {
      conversationChannel: 'sms' | 'email' | 'chat' | null;
      phone: string | null;
      email: string | null;
      textNumber: string | null;
      optedOut: boolean;
    }
  >();
  for (const p of plans) {
    if (p.auto === 'confirm_request') {
      const s = seatOf.get(p.row.subjectId);
      if (s)
        contacts.set(p.row.id, {
          phone: s.phone,
          email: s.email,
          smsOk: s.sms_ok,
          personConsent: s.consent,
        });
    } else if (p.auto === 'nudge') {
      const person = p.row.personId ? personOf.get(p.row.personId) : undefined;
      contacts.set(
        p.row.id,
        nudgeContact({
          phone: person?.phone ?? null,
          email: person?.email ?? null,
          consent: person?.consent ?? null,
        }),
      );
    } else if (p.reply) {
      const person = p.row.personId ? personOf.get(p.row.personId) : undefined;
      const conv = p.row.conversationId
        ? convOf.get(p.row.conversationId)
        : p.row.personId
          ? latestOf.get(p.row.personId)
          : undefined;
      replyTargets.set(p.row.id, {
        conversationChannel: conv?.channel ?? null,
        phone: person?.phone ?? null,
        email: person?.email ?? null,
        textNumber: conv?.channel === 'sms' ? conv.counterpart : (person?.phone ?? null),
        optedOut: person?.consent === 'opted_out',
      });
    }
  }
  const phones = unique([
    ...[...contacts.values()].map((c) => c.phone),
    ...[...replyTargets.values()].map((r) => r.textNumber),
  ]);
  const emails = unique([...contacts.values()].map((c) => c.email?.toLowerCase()));
  const stoppedNumbers = new Set(
    phones.length
      ? (
          await rows<{ n: string }>(
            tx,
            sql`select counterpart_e164 as n from app.opt_outs
                where workspace_id = ${workspaceId} and opted_out and counterpart_e164 in (${textList(phones)})`,
          )
        ).map((r) => r.n)
      : [],
  );
  const stoppedEmails = new Set(
    emails.length
      ? (
          await rows<{ a: string }>(
            tx,
            sql`select lower(address::text) as a from app.email_suppressions
                where workspace_id = ${workspaceId} and released_at is null
                  and lower(address::text) in (${textList(emails)})`,
          )
        ).map((r) => r.a)
      : [],
  );
  const business: ReachBusiness | null = contacts.size
    ? await reachBusinessOf(tx, workspaceId)
    : null;

  for (const p of plans) {
    const seat = p.row.subjectType === 'attendee' ? seatOf.get(p.row.subjectId) : undefined;
    let reach: ItemHints['reach'] = null;
    const contact = contacts.get(p.row.id);
    const reply = replyTargets.get(p.row.id);
    if (contact && business)
      reach = reachChannel(
        reachRule(
          contact,
          {
            optedOut: !!contact.phone && stoppedNumbers.has(contact.phone),
            emailStopped: !!contact.email && stoppedEmails.has(contact.email.toLowerCase()),
          },
          business,
        ),
      );
    else if (reply)
      reach = replyChannelRule({
        conversationChannel: reply.conversationChannel,
        phone: reply.phone,
        email: reply.email,
        textStopped: reply.optedOut || (!!reply.textNumber && stoppedNumbers.has(reply.textNumber)),
      });
    if (!seat && reach === null) continue;
    out.set(p.row.id, {
      ...NO_HINTS,
      ...(seat
        ? {
            appointmentId: seat.appointment_id,
            startsAt: new Date(seat.starts_at).toISOString(),
          }
        : {}),
      reach,
    });
  }
  return out;
}
