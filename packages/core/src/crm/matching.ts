import { rows, sql, type Tx } from '@hfos/db/client';

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

/** Existing records that look like the same person or company: same email, same phone, or (companies) the same name. */
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
          case when ${email}::text is not null and email = ${email}::extensions.citext then 'email'
               when ${phone}::text is not null and phone_e164 = ${phone} then 'phone'
               else 'name' end as matched_on
        from ${table}
        where workspace_id = ${workspaceId} and archived_at is null
          and (${q.exceptId ?? null}::uuid is null or id <> ${q.exceptId ?? null}::uuid)
          and ((${email}::text is not null and email = ${email}::extensions.citext)
            or (${phone}::text is not null and phone_e164 = ${phone})
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
