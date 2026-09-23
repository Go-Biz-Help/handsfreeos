import { rows, sql } from '@hfos/db/client';
import { otherAddressesOut, otherEmailsOut, otherPhonesOut } from '../crm/contact-points';
import { addressOut, fullName, phoneOut, tagsByRecord } from '../crm/records';
import { HfosError } from '../errors';
import { defineQuery } from '../kernel/define';
import { decodeCursor, page } from '../kernel/pagination';
import {
  PersonGetInput,
  PersonGetOutput,
  PersonListInput,
  PersonListOutput,
  type PersonSummary,
} from '../schemas/person';

type Row = {
  id: string;
  first_name: string;
  last_name: string;
  email: string | null;
  phone_e164: string | null;
  phone_alt: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  country: string;
  other_emails: unknown;
  other_phones: unknown;
  other_addresses: unknown;
  source: string | null;
  notes: string | null;
  owner_user_id: string | null;
  owner_name: string | null;
  owner_email: string | null;
  company_id: string | null;
  company_name: string | null;
  company_archived: Date | null;
  open_leads: number;
  last_activity_at: Date | null;
  archived_at: Date | null;
  created_at: Date;
  updated_at: Date;
  sort_key: string;
};

function summary(r: Row, tags: PersonSummary['tags']): PersonSummary {
  const otherPhones = otherPhonesOut(r.other_phones);
  return {
    id: r.id,
    firstName: r.first_name,
    lastName: r.last_name,
    fullName: fullName(r.first_name, r.last_name),
    email: r.email,
    phone: phoneOut(r.phone_e164),
    phoneE164: r.phone_e164,
    phoneAlt: otherPhones[0]?.phone ?? r.phone_alt,
    address: addressOut({
      addressLine1: r.address_line1,
      addressLine2: r.address_line2,
      city: r.city,
      state: r.state,
      postalCode: r.postal_code,
      country: r.country,
    }),
    otherEmails: otherEmailsOut(r.other_emails),
    otherPhones,
    otherAddresses: otherAddressesOut(r.other_addresses),
    source: r.source,
    company: r.company_id
      ? { id: r.company_id, name: r.company_name ?? '', archived: !!r.company_archived }
      : null,
    owner: r.owner_user_id
      ? { id: r.owner_user_id, fullName: r.owner_name || r.owner_email || 'Former member' }
      : null,
    tags,
    openLeads: Number(r.open_leads),
    lastActivityAt: r.last_activity_at ? new Date(r.last_activity_at).toISOString() : null,
    archivedAt: r.archived_at ? new Date(r.archived_at).toISOString() : null,
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}

const base = (workspaceId: string, sort: 'name' | 'recent') => sql`
  select p.id, p.first_name, p.last_name, p.email::text as email, p.phone_e164, p.phone_alt, p.address_line1, p.address_line2, p.city, p.state, p.postal_code, p.country,
    p.other_emails, p.other_phones, p.other_addresses, p.source, p.notes, p.owner_user_id, u.full_name as owner_name, u.email::text as owner_email,
    p.company_id, c.name as company_name, c.archived_at as company_archived,
    (select count(*) from app.leads l where l.person_id = p.id and l.status = 'open' and l.archived_at is null)::int as open_leads,
    (select max(a.occurred_at) from app.activities a where a.person_id = p.id) as last_activity_at,
    p.archived_at, p.created_at, p.updated_at,
    ${sort === 'name' ? sql`lower(p.last_name || ' ' || p.first_name)` : sql`to_char(p.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`} as sort_key
  from app.people p
  left join app.users u on u.id = p.owner_user_id
  left join app.companies c on c.id = p.company_id
  where p.workspace_id = ${workspaceId}`;

export const personList = defineQuery({
  name: 'person.list',
  description:
    'People in the workspace: search by name, phone, email or street, filter by tag, company or owner.',
  input: PersonListInput,
  output: PersonListOutput,
  permission: 'records.read',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  async handler(ctx, input) {
    const cursor = decodeCursor(input.cursor);
    const q = input.q ? `%${input.q.toLowerCase()}%` : null;
    const recent = input.sort === 'recent';
    const list = await rows<Row>(
      ctx.tx,
      sql`select * from (${base(input.workspaceId, input.sort)}
          ${input.includeArchived ? sql`` : sql`and p.archived_at is null`}
          ${q ? sql`and p.search_text like ${q}` : sql``}
          ${input.companyId ? sql`and p.company_id = ${input.companyId}` : sql``}
          ${input.ownerUserId ? sql`and p.owner_user_id = ${input.ownerUserId}` : sql``}
          ${input.tagId ? sql`and exists (select 1 from app.record_tags rt where rt.record_type = 'person' and rt.record_id = p.id and rt.tag_id = ${input.tagId})` : sql``}
        ) x
        ${cursor ? (recent ? sql`where (x.sort_key, x.id) < (${cursor.sort}, ${cursor.id}::uuid)` : sql`where (x.sort_key, x.id) > (${cursor.sort}, ${cursor.id}::uuid)`) : sql``}
        order by ${recent ? sql`x.sort_key desc, x.id desc` : sql`x.sort_key, x.id`}
        limit ${input.limit + 1}`,
    );
    const tags = await tagsByRecord(
      ctx.tx,
      input.workspaceId,
      'person',
      list.map((r) => r.id),
    );
    const result = page(list, input.limit, (r) => ({ sort: r.sort_key, id: r.id }));
    return {
      items: result.items.map((r) => summary(r, tags.get(r.id) ?? [])),
      nextCursor: result.nextCursor,
    };
  },
});

export const personGet = defineQuery({
  name: 'person.get',
  description: 'One person with company, owner, tags and counts (the Customer 360 header).',
  input: PersonGetInput,
  output: PersonGetOutput,
  permission: 'records.read',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  async handler(ctx, input) {
    const [row] = await rows<Row>(
      ctx.tx,
      sql`${base(input.workspaceId, 'name')} and p.id = ${input.personId}`,
    );
    if (!row) throw HfosError.notFound('Person not found.');
    const tags = await tagsByRecord(ctx.tx, input.workspaceId, 'person', [row.id]);
    return { person: { ...summary(row, tags.get(row.id) ?? []), notes: row.notes } };
  },
});
