import { rows, sql, type Tx } from '@hfos/db/client';
import type { companies, people } from '@hfos/db/schema';

/**
 * "This record has this number" and "this email", as conditions: the main one, or any of the others (0102). A
 * customer who texts from their office line, or writes from their other address, is still themselves. Each
 * arm has its index: (workspace_id, phone_e164) and (workspace_id, email) for the main ones, and a GIN index
 * on each list, probed with `@>`.
 */
export const hasPhone = (table: typeof people | typeof companies, e164: string) =>
  sql`(${table.phoneE164} = ${e164} or ${table.otherPhones} @> ${JSON.stringify([{ phone: e164 }])}::jsonb)`;

export const hasEmail = (table: typeof people | typeof companies, email: string) => {
  const lower = email.trim().toLowerCase();
  return sql`(${table.email} = ${lower}::extensions.citext or ${table.otherEmails} @> ${JSON.stringify([{ email: lower }])}::jsonb)`;
};

/** Ordering for the lookups above: a record whose main number (or email) it is comes before one where it's another. */
export const mainPhoneFirst = (table: typeof people | typeof companies, e164: string) =>
  sql`(${table.phoneE164} is not distinct from ${e164}) desc`;
export const mainEmailFirst = (table: typeof people | typeof companies, email: string) =>
  sql`(${table.email} is not distinct from ${email.trim().toLowerCase()}::extensions.citext) desc`;

export interface MatchQuery {
  readonly email?: string | null;
  readonly phoneE164?: string | null;
  readonly name?: string | null;
  readonly exceptId?: string | null;
}
export interface Match {
  readonly id: string;
  readonly name: string;
  readonly email: string | null;
  readonly phone: string | null;
  readonly matchedOn: 'email' | 'phone' | 'name';
}

/**
 * Existing records that look like the same person or company: same email, same phone (the main one or any other on
 * file), or (companies) the same name.
 */
export async function findMatches(
  tx: Tx,
  workspaceId: string,
  kind: 'person' | 'company',
  q: MatchQuery,
): Promise<Match[]> {
  const email = q.email?.trim().toLowerCase() || null;
  const phone = q.phoneE164?.trim() || null;
  const name = kind === 'company' ? q.name?.trim() || null : null;
  if (!email && !phone && !name) return [];
  const table = kind === 'person' ? sql`app.people` : sql`app.companies`;
  // The other emails and numbers count too (0102): a new customer whose number is on someone's list is them.
  const emailProbe = JSON.stringify([{ email: email ?? '' }]);
  const phoneProbe = JSON.stringify([{ phone: phone ?? '' }]);
  const display = kind === 'person' ? sql`btrim(first_name || ' ' || last_name)` : sql`name`;
  const list = await rows<{
    id: string;
    name: string;
    email: string | null;
    phone: string | null;
    matched_on: string;
  }>(
    tx,
    sql`select id, ${display} as name, email::text as email, phone_e164 as phone,
          case when ${email}::text is not null and (email = ${email}::extensions.citext
                 or other_emails @> ${emailProbe}::jsonb) then 'email'
               when ${phone}::text is not null and (phone_e164 = ${phone}
                 or other_phones @> ${phoneProbe}::jsonb) then 'phone'
               else 'name' end as matched_on
        from ${table}
        where workspace_id = ${workspaceId} and archived_at is null
          and (${q.exceptId ?? null}::uuid is null or id <> ${q.exceptId ?? null}::uuid)
          and ((${email}::text is not null and (email = ${email}::extensions.citext
                 or other_emails @> ${emailProbe}::jsonb))
            or (${phone}::text is not null and (phone_e164 = ${phone}
                 or other_phones @> ${phoneProbe}::jsonb))
            or (${name}::text is not null and lower(${display}) = lower(${name})))
        order by matched_on, name
        limit 5`,
  );
  return list.map((r) => ({
    id: r.id,
    name: r.name,
    email: r.email,
    phone: r.phone,
    matchedOn: r.matched_on as Match['matchedOn'],
  }));
}
