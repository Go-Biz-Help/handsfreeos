import { sql } from '@hfos/db/client';

/**
 * Leads and clients, as the Contacts page filters them. A client is someone the business is working for, has worked
 * for, or has been paid by; everyone else is a lead it is still winning. Any one of these makes a person a client:
 *
 *   - a lead of theirs marked won;
 *   - a job for them underway or done (a job that is only booked may still be a quote visit);
 *   - a visit they came to;
 *   - a maintenance plan they are on;
 *   - money they have paid on a bill.
 *
 * A company is a client when a lead of its own was won, or when one of its people is a client.
 *
 * Read with the viewer's own sight (row-level security): someone who can't see the business's bills is told only
 * what the rest says, and never learns from this that a bill was paid.
 */
export const personIsClient = (alias: 'p' | 'cp') => {
  const p = sql.raw(alias);
  return sql`(
    exists (select 1 from app.leads cl where cl.person_id = ${p}.id and cl.status = 'won' and cl.archived_at is null)
    or exists (select 1 from app.jobs cj where cj.person_id = ${p}.id
      and cj.status in ('on_the_way', 'in_progress', 'waiting_on_parts', 'done'))
    or exists (select 1 from app.appointment_attendees ca join app.appointments cap on cap.id = ca.appointment_id
      where ca.person_id = ${p}.id and (ca.status = 'attended' or (ca.status = 'booked' and cap.status = 'completed')))
    or exists (select 1 from app.subscriptions cs where cs.person_id = ${p}.id
      and cs.status in ('active', 'past_due', 'paused', 'unmanaged'))
    or exists (select 1 from app.invoices ci where ci.person_id = ${p}.id and ci.status <> 'void' and ci.amount_paid_cents > 0)
  )`;
};

export const companyIsClient = (alias: 'c') => {
  const c = sql.raw(alias);
  return sql`(
    exists (select 1 from app.leads cl where cl.company_id = ${c}.id and cl.status = 'won' and cl.archived_at is null)
    or exists (select 1 from app.people cp where cp.company_id = ${c}.id and cp.bin_item_id is null
      and ${personIsClient('cp')})
  )`;
};
