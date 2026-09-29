import { and, eq } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { companies, people } from '@hfos/db/schema';
import { otherAddressesOut, otherEmailsOut, otherPhonesOut } from '../crm/contact-points';
import { addressOut, phoneOut, tagsByRecord, userRef } from '../crm/records';
import { TEAM } from './person';
import { HfosError } from '../errors';
import { defineQuery } from '../kernel/define';
import { decodeCursor, page } from '../kernel/pagination';
import {
  CompanyGetInput,
  CompanyGetOutput,
  CompanyListInput,
  CompanyListOutput,
  type CompanySummary,
} from '../schemas/company';
import { fullName } from '../crm/records';

/** Raw rows come back snake_case with timestamps as strings (drizzle's postgres driver leaves dates unparsed). */
type Row = {
  id: string;
  name: string;
  email: string | null;
  phone_e164: string | null;
  website: string | null;
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
  owner_user_id: string | null;
  archived_at: string | Date | null;
  created_at: string | Date;
  updated_at: string | Date;
  people_count: number;
  open_leads: number;
  owner_name: string | null;
  owner_email: string | null;
  team: { id: string; fullName: string | null }[] | null;
  sort_key: string;
};

function summary(r: Row, tags: CompanySummary['tags']): CompanySummary {
  return {
    id: r.id,
    name: r.name,
    email: r.email,
    phone: phoneOut(r.phone_e164),
    phoneE164: r.phone_e164,
    website: r.website,
    address: addressOut({
      addressLine1: r.address_line1,
      addressLine2: r.address_line2,
      city: r.city,
      state: r.state,
      postalCode: r.postal_code,
      country: r.country,
    }),
    otherEmails: otherEmailsOut(r.other_emails),
    otherPhones: otherPhonesOut(r.other_phones),
    otherAddresses: otherAddressesOut(r.other_addresses),
    source: r.source,
    owner: r.owner_user_id
      ? { id: r.owner_user_id, fullName: r.owner_name || r.owner_email || 'Former member' }
      : null,
    team: (r.team ?? []).map((m) => ({ id: m.id, fullName: m.fullName || 'Former member' })),
    tags,
    peopleCount: Number(r.people_count),
    openLeads: Number(r.open_leads),
    archivedAt: r.archived_at ? new Date(r.archived_at).toISOString() : null,
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}

const base = (workspaceId: string) => sql`
  select c.*, lower(c.name) as sort_key, u.full_name as owner_name, u.email::text as owner_email,
    ${TEAM('c')} as team,
    (select count(*) from app.people p where p.company_id = c.id and p.archived_at is null)::int as people_count,
    (select count(*) from app.leads l where l.company_id = c.id and l.status = 'open' and l.archived_at is null)::int as open_leads
  from app.companies c
  left join app.users u on u.id = c.owner_user_id
  where c.workspace_id = ${workspaceId}`;

export const companyList = defineQuery({
  name: 'company.list',
  description: 'Companies in the workspace, searchable, with people and open-lead counts.',
  input: CompanyListInput,
  output: CompanyListOutput,
  permission: 'records.read',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  async handler(ctx, input) {
    const cursor = decodeCursor(input.cursor);
    const q = input.q ? `%${input.q.toLowerCase()}%` : null;
    const list = await rows<Row>(
      ctx.tx,
      sql`select * from (${base(input.workspaceId)}
          ${input.includeArchived ? sql`` : sql`and c.archived_at is null`}
          ${q ? sql`and c.search_text like ${q}` : sql``}
          ${input.tagId ? sql`and exists (select 1 from app.record_tags rt where rt.record_type = 'company' and rt.record_id = c.id and rt.tag_id = ${input.tagId})` : sql``}
          ${input.assignedUserId ? sql`and (c.owner_user_id = ${input.assignedUserId} or c.team_user_ids @> array[${input.assignedUserId}::uuid])` : sql``}
        ) x
        ${cursor ? sql`where (x.sort_key, x.id) > (${cursor.sort}, ${cursor.id}::uuid)` : sql``}
        order by x.sort_key, x.id
        limit ${input.limit + 1}`,
    );
    const tags = await tagsByRecord(
      ctx.tx,
      input.workspaceId,
      'company',
      list.map((r) => r.id),
    );
    const result = page(list, input.limit, (r) => ({ sort: r.sort_key, id: r.id }));
    return {
      items: result.items.map((r) => summary(r, tags.get(r.id) ?? [])),
      nextCursor: result.nextCursor,
    };
  },
});

export const companyGet = defineQuery({
  name: 'company.get',
  description: 'One company with its details and people.',
  input: CompanyGetInput,
  output: CompanyGetOutput,
  permission: 'records.read',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  async handler(ctx, input) {
    const [c] = await ctx.tx
      .select()
      .from(companies)
      .where(and(eq(companies.id, input.companyId), eq(companies.workspaceId, input.workspaceId)));
    if (!c)
      throw HfosError.notFound(
        'That company isn’t there anymore. It may have been deleted. Refresh and try again.',
      );
    const [counts] = await rows<{ people_count: number; open_leads: number }>(
      ctx.tx,
      sql`select (select count(*) from app.people p where p.company_id = ${c.id} and p.archived_at is null)::int as people_count,
                 (select count(*) from app.leads l where l.company_id = ${c.id} and l.status = 'open' and l.archived_at is null)::int as open_leads`,
    );
    const owner = await userRef(ctx.tx, c.ownerUserId);
    const [team] = await rows<{ team: Row['team'] }>(
      ctx.tx,
      sql`select ${TEAM('c')} as team from app.companies c where c.id = ${c.id}`,
    );
    const tags = await tagsByRecord(ctx.tx, input.workspaceId, 'company', [c.id]);
    const members = await ctx.tx
      .select()
      .from(people)
      .where(eq(people.companyId, c.id))
      .orderBy(people.lastName, people.firstName);
    return {
      company: {
        ...summary(
          {
            id: c.id,
            name: c.name,
            email: c.email,
            phone_e164: c.phoneE164,
            website: c.website,
            address_line1: c.addressLine1,
            address_line2: c.addressLine2,
            city: c.city,
            state: c.state,
            postal_code: c.postalCode,
            country: c.country,
            other_emails: c.otherEmails,
            other_phones: c.otherPhones,
            other_addresses: c.otherAddresses,
            source: c.source,
            owner_user_id: c.ownerUserId,
            archived_at: c.archivedAt,
            created_at: c.createdAt,
            updated_at: c.updatedAt,
            people_count: counts?.people_count ?? 0,
            open_leads: counts?.open_leads ?? 0,
            owner_name: owner?.fullName ?? null,
            owner_email: null,
            team: team?.team ?? [],
            sort_key: '',
          },
          tags.get(c.id) ?? [],
        ),
        notes: c.notes,
        custom: c.custom ?? {},
      },
      people: members.map((p) => ({
        id: p.id,
        fullName: fullName(p.firstName, p.lastName),
        email: p.email,
        phone: phoneOut(p.phoneE164),
        archived: !!p.archivedAt,
      })),
    };
  },
});
