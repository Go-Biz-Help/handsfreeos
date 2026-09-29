import { sql } from '@hfos/db/client';

/**
 * Leads and clients, as Contacts filters them on the web and on the phone. A client is someone the business is
 * working for, has worked for, or has been paid by; everyone else is a lead it is still winning. Any one of these
 * makes a person a client:
 *
 *   - a lead of theirs marked won;
 *   - a job for them underway or done (a job that is only booked may still be a quote visit);
 *   - a visit they came to;
 *   - a maintenance plan they are on;
 *   - money they have paid on a bill.
 *
 * A company is a client when a lead of its own was won, or when one of its people is a client.
 *
 * The database keeps the answer (migration 20261013000900, `private.person_is_client`): one row in `app.client_marks`
 * per client, kept by triggers, which the phone's copy carries too. So the rule is written once, there, and these
 * only read it. Everyone who can open the business sees the same answer.
 */
export const personIsClient = (alias: 'p') =>
  sql`exists (select 1 from app.client_marks cm where cm.id = ${sql.raw(alias)}.id)`;

export const companyIsClient = (alias: 'c') =>
  sql`exists (select 1 from app.client_marks cm where cm.id = ${sql.raw(alias)}.id)`;
