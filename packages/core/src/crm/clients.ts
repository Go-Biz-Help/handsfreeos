import { sql } from '@hfos/db/client';
import type { SQL } from 'drizzle-orm';
import {
  CLIENT_CAUSES,
  CLIENT_TAG,
  CONTACTS_CLIENT_CAUSES,
  type ClientCause,
} from './record-words';

/**
 * Leads and clients, as the Contacts page filters them. A client is someone the business is working for, has worked
 * for, or has been paid by; everyone else is a lead it is still winning. Any one of these makes a person a client
 * (`CLIENT_CAUSES`, in this order):
 *
 *   - a lead of theirs marked won;
 *   - a job for them underway or done (a job that is only booked may still be a quote visit);
 *   - a visit they came to;
 *   - a maintenance plan they are on;
 *   - money they have paid on a bill;
 *   - the Client tag on them (`CLIENT_TAG`, any capitals: Social Outreach's Mark as client puts it on).
 *
 * Contacts counts `CONTACTS_CLIENT_CAUSES` (./record-words.ts), every one of them; a caller may name fewer.
 *
 * A company is a client when a lead of its own was won, or when one of its people is a client.
 *
 * Read with the viewer's own sight (row-level security): someone who can't see the business's bills is told only
 * what the rest says, and never learns from this that a bill was paid.
 */
const CAUSE_SQL: Readonly<Record<ClientCause, (p: SQL) => SQL>> = {
  won: (p) =>
    sql`exists (select 1 from app.leads cl where cl.person_id = ${p}.id and cl.status = 'won' and cl.archived_at is null)`,
  job: (p) => sql`exists (select 1 from app.jobs cj where cj.person_id = ${p}.id
      and cj.status in ('on_the_way', 'in_progress', 'waiting_on_parts', 'done'))`,
  visit: (p) => sql`exists (select 1 from app.appointment_attendees ca
      join app.appointments cap on cap.id = ca.appointment_id
      where ca.person_id = ${p}.id and (ca.status = 'attended' or (ca.status = 'booked' and cap.status = 'completed')))`,
  plan: (p) => sql`exists (select 1 from app.subscriptions cs where cs.person_id = ${p}.id
      and cs.status in ('active', 'past_due', 'paused', 'unmanaged'))`,
  paid: (p) =>
    sql`exists (select 1 from app.invoices ci where ci.person_id = ${p}.id and ci.status <> 'void' and ci.amount_paid_cents > 0)`,
  // By the record's own index (workspace, type, id). The name is citext, whose own = isn't on an app session's search
  // path: compared without capitals instead.
  tagged: (p) => sql`exists (select 1 from app.record_tags crt
      join app.tags ctg on ctg.id = crt.tag_id
      where crt.workspace_id = ${p}.workspace_id and crt.record_type = 'person' and crt.record_id = ${p}.id
        and lower(ctg.name::text) = lower(${CLIENT_TAG}))`,
};

/** The causes asked for, in `CLIENT_CAUSES`' order. */
const inOrder = (causes: readonly ClientCause[]) => CLIENT_CAUSES.filter((c) => causes.includes(c));

/** Whether a person is a client, for any of `causes` (Contacts' own by default). `alias` is the person's row. */
export const personIsClient = (
  alias: 'p' | 'cp',
  causes: readonly ClientCause[] = CONTACTS_CLIENT_CAUSES,
) => {
  const p = sql.raw(alias);
  const any = inOrder(causes);
  if (!any.length) return sql`false`;
  return sql`(${sql.join(
    any.map((c) => CAUSE_SQL[c](p)),
    sql` or `,
  )})`;
};

/**
 * The first of `causes` that makes a person a client, as a `ClientCause`, or null when none does: "A client in
 * Contacts: they paid a bill". `alias` is the person's row.
 */
export const personClientCause = (
  alias: string,
  causes: readonly ClientCause[] = CONTACTS_CLIENT_CAUSES,
) => {
  const p = sql.raw(alias);
  const any = inOrder(causes);
  if (!any.length) return sql`null::text`;
  return sql`(case ${sql.join(
    any.map((c) => sql`when ${CAUSE_SQL[c](p)} then ${sql.raw(`'${c}'`)}`),
    sql` `,
  )} else null end)`;
};

export const companyIsClient = (alias: 'c') => {
  const c = sql.raw(alias);
  return sql`(
    exists (select 1 from app.leads cl where cl.company_id = ${c}.id and cl.status = 'won' and cl.archived_at is null)
    or exists (select 1 from app.people cp where cp.company_id = ${c}.id and cp.bin_item_id is null
      and ${personIsClient('cp')})
  )`;
};
