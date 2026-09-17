/**
 * What Home shows beside each attention item, looked up for a whole list at once (M8): the facts the hints need,
 * read from the database, and worked out by the browser-safe rules in `hint-facts.ts` (the phone reads the same facts
 * from its copy). Server-only.
 */
import { rows, sql, type Tx } from '@hfos/db/client';
import { uuidArray } from '../calendar/load';
import { workspaceMessaging } from '../messaging/store';
import { openHoursOf } from '../schemas/workspace';
import { reachBusinessOf } from './auto-plan';
import {
  hintLookupsOf,
  itemHintsOf,
  type HintConsent,
  type HintConversation,
  type HintSeat,
} from './hint-facts';
import type { AttentionItemRow } from './load';
import { isOpenAt } from './open-time';
import type { ItemHints } from './view';

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
  if (!items.length) return new Map();
  const need = hintLookupsOf(items);
  // Is the business open? Only a money card asks, and only to decide whether to offer the call first.
  const openNow = need.needsOpenNow
    ? await (async () => {
        const m = await workspaceMessaging(tx, workspaceId);
        return isOpenAt(openHoursOf(m.rawSettings), m.timezone || 'UTC', Date.now());
      })()
    : false;

  // Booked seats: the appointment, its start, and the booking's own contact details.
  const seats = need.seatIds.length
    ? await rows<{
        id: string;
        appointment_id: string;
        starts_at: Date | string;
        phone: string | null;
        email: string | null;
        sms_ok: boolean;
        consent: HintConsent;
      }>(
        tx,
        sql`select t.id, t.appointment_id, p.starts_at, t.contact_phone_e164 as phone, t.contact_email as email,
              t.sms_ok, pp.sms_consent::text as consent
            from app.appointment_attendees t
            join app.appointments p on p.id = t.appointment_id
            join app.people pp on pp.id = t.person_id
            where t.workspace_id = ${workspaceId} and t.id = any(${uuidArray(need.seatIds)})`,
      )
    : [];

  // The customers a nudge or a reply would go to, and the conversations a reply would go in.
  const people = need.personIds.length
    ? await rows<{ id: string; phone: string | null; email: string | null; consent: HintConsent }>(
        tx,
        sql`select id, phone_e164 as phone, email::text as email, sms_consent::text as consent
            from app.people where workspace_id = ${workspaceId} and id = any(${uuidArray(need.personIds)})`,
      )
    : [];
  const convs =
    need.conversationIds.length || need.conversationPeople.length
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
                and (id = any(${uuidArray(need.conversationIds)}) or person_id = any(${uuidArray(need.conversationPeople)}))`,
        )
      : [];

  // The numbers and addresses to look up once.
  const phones = [
    ...new Set(
      [
        ...seats.map((s) => s.phone),
        ...people.map((p) => p.phone),
        ...convs.map((c) => c.counterpart),
      ].filter((x): x is string => !!x),
    ),
  ];
  const emails = [
    ...new Set(
      [...seats.map((s) => s.email), ...people.map((p) => p.email)]
        .filter((x): x is string => !!x)
        .map((e) => e.toLowerCase()),
    ),
  ];
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
  const business = need.needsBusiness ? await reachBusinessOf(tx, workspaceId) : null;

  return itemHintsOf(items, {
    seats: new Map<string, HintSeat>(
      seats.map((s) => [
        s.id,
        {
          id: s.id,
          appointmentId: s.appointment_id,
          startsAt: new Date(s.starts_at).toISOString(),
          phone: s.phone,
          email: s.email,
          smsOk: s.sms_ok,
          consent: s.consent,
        },
      ]),
    ),
    people: new Map(people.map((p) => [p.id, p])),
    conversations: convs.map((c): HintConversation => ({
      id: c.id,
      personId: c.person_id,
      channel: c.channel,
      counterpart: c.counterpart,
      lastMessageAt: c.last_message_at ? Date.parse(String(c.last_message_at)) : null,
    })),
    stoppedNumbers,
    stoppedEmails,
    business,
    openNow,
  });
}
