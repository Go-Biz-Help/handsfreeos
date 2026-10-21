/**
 * Calendar (workspace.read): appointments across the whole business, newest first, with no 62-day limit: an
 * attendee's phone or email exactly; the title folded; the place's address, an attendee's name; and the notes.
 * Cancelled ones stay, marked, after the rest. Row security hides appointments sealed to a private record; a
 * turned-off add-on's record hides its appointments too (`RECORD_READS`: `appointments_select` checks only sealing).
 * A meeting's transcript and its AI summary are never read (decision 15).
 */
import { sql } from 'drizzle-orm';
import type { SearchHit } from '../../../schemas/search';
import { explainAppointment } from '../../explain';
import { searchHref } from '../../href';
import { hitOf, isoOf } from '../hit';
import type { KindSearcher, SearchPlan } from '../run';
import { LIVE_PERSON, likeAll, RECORD_READS, startsAll } from '../sql';

interface Row extends Record<string, unknown> {
  id: string;
  title: string;
  status: string;
  starts_at: Date;
  ends_at: Date;
  day: string;
  address: string | null;
  notes: string | null;
  attendees: string | null;
  who: string | null;
  exact_phone: boolean;
  exact_email: boolean;
  updated_at: Date;
}

function hitFrom(r: Row, plan: SearchPlan): SearchHit {
  return hitOf({
    kind: 'calendar',
    id: r.id,
    title: r.title,
    href: searchHref(plan.workspaceId, { type: 'appointment', id: r.id, day: r.day }),
    ...explainAppointment(r, plan.p),
    badges: r.status === 'cancelled' ? ['cancelled'] : [],
    at: isoOf(r.starts_at),
    facts: {
      startsAt: isoOf(r.starts_at)!,
      endsAt: isoOf(r.ends_at)!,
      status: r.status,
      ...(r.who ? { who: r.who } : {}),
      ...(r.address ? { where: r.address } : {}),
    },
  });
}

export const calendarSearcher: KindSearcher = {
  key: 'calendar',
  async find(db, plan) {
    const { p } = plan;
    // Appointments aren't archived; the Archived page has nothing here.
    if (plan.archivedOnly) return [{ kind: 'calendar', label: null, icon: null, hits: [] }];
    const exactPhone = p.phoneE164
      ? sql`exists (select 1 from app.appointment_attendees x
          where x.appointment_id = a.id and x.contact_phone_e164 = ${p.phoneE164})`
      : sql`false`;
    const exactEmail = p.email
      ? sql`exists (select 1 from app.appointment_attendees x
          where x.appointment_id = a.id and lower(x.contact_email) = ${p.email})`
      : sql`false`;
    const byTitle = sql`(${startsAll(sql`att.fname`, p.starts)} or ${likeAll(sql`att.fname`, p.folds)})`;
    const address = sql`concat_ws(' ', a.location ->> 'address', a.location ->> 'postalCode')`;
    // Who's coming is folded (decision 23): "jose garcia" finds José García. Typed with its accents, a name is found
    // by its folded words alone.
    const words = sql`(${likeAll(
      sql`concat_ws(' ', lower(concat_ws(' ', a.title, ${address}, a.notes)), att.fnames)`,
      p.likes,
    )} or ${likeAll(sql`att.fnames`, p.folds)})`;
    const tier = sql`case
        when ${exactPhone} or ${exactEmail} then 0
        when ${startsAll(sql`att.fname`, p.starts)} then 1
        when ${likeAll(sql`att.fname`, p.folds)} then 2
        else 3 end`;
    const order =
      plan.sort === 'name'
        ? sql`lower(a.title), a.id`
        : plan.sort === 'recent'
          ? sql`a.starts_at desc, a.id desc`
          : sql`tier, (a.status = 'cancelled'), a.starts_at desc, a.id`;
    const mine =
      plan.onlyMine && plan.me
        ? sql`and (a.owner_user_id = ${plan.me} or exists (select 1 from app.appointment_staff s
            where s.appointment_id = a.id and s.user_id = ${plan.me}))`
        : sql``;
    const list = await db.rows<Row>(
      sql`select a.id, a.title, a.status::text as status, a.starts_at, a.ends_at, a.notes, a.updated_at,
            -- The day the calendar opens on, where the business is.
            to_char(a.starts_at at time zone (select w.timezone from app.workspaces w where w.id = ${plan.workspaceId}),
              'YYYY-MM-DD') as day,
            nullif(${address}, '') as address, att.names as attendees, att.who,
            ${exactPhone} as exact_phone, ${exactEmail} as exact_email, ${tier} as tier
          from app.appointments a
          -- The title folded once a row, and who's coming read and folded once: their names, phones and emails,
          -- customers in the bin, erased names and merged shells lending none of theirs. One lateral, so nothing
          -- joins above it.
          cross join lateral (
            select private.search_fold(a.title) as fname, coming.names, private.search_fold(coming.names) as fnames,
              coming.who
            from (
              select string_agg(concat_ws(' ', p.first_name, p.last_name, x.contact_phone_e164, x.contact_email),
                  ' ') as names,
                string_agg(nullif(concat_ws(' ', p.first_name, p.last_name), ''), ', ' order by x.created_at) as who
              from app.appointment_attendees x
              left join app.people p on p.id = x.person_id and ${LIVE_PERSON('p')}
              where x.appointment_id = a.id
            ) coming
            offset 0
          ) att
          where a.workspace_id = ${plan.workspaceId}
            and ${RECORD_READS(sql`a.custom_record_id`)}
            and (${exactPhone} or ${exactEmail} or ${byTitle} or ${words})
            ${mine}
          order by ${order}
          limit ${plan.limit}`,
    );
    return [{ kind: 'calendar', label: null, icon: null, hits: list.map((r) => hitFrom(r, plan)) }];
  },
};
