import { and, eq } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { companies, people } from '@hfos/db/schema';
import { addressOut, phoneOut, tagsByRecord, userRef } from '../crm/records';
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

type Row = typeof companies.$inferSelect & {
  people_count: number;
  open_leads: number;
  owner_name: string | null;
  owner_email: string | null;
  sort_key: string;
};

function summary(r: Row, tags: CompanySummary['tags']): CompanySummary {
  return {
    id: r.id,
    name: r.name,
    email: r.email,
    phone: phoneOut(r.phoneE164),
    phoneE164: r.phoneE164,
    website: r.website,
    address: addressOut(r),
    source: r.source,
    owner: r.ownerUserId
      ? { id: r.ownerUserId, fullName: r.owner_name || r.owner_email || 'Former member' }
      : null,
    tags,
    peopleCount: Number(r.people_count),
    openLeads: Number(r.open_leads),
    archivedAt: r.archivedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

const base = (workspaceId: string) => sql`
  select c.*, lower(c.name) as sort_key, u.full_name as owner_name, u.email::text as owner_email,
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
    const camel = list.map((r) => ({
      ...r,
      phoneE164: (r as unknown as { phone_e164: string | null }).phone_e164,
      ownerUserId: (r as unknown as { owner_user_id: string | null }).owner_user_id,
      archivedAt: (r as unknown as { archived_at: Date | null }).archived_at,
      createdAt: (r as unknown as { created_at: Date }).created_at,
      updatedAt: (r as unknown as { updated_at: Date }).updated_at,
      addressLine1: (r as unknown as { address_line1: string | null }).address_line1,
      addressLine2: (r as unknown as { address_line2: string | null }).address_line2,
      postalCode: (r as unknown as { postal_code: string | null }).postal_code,
    }));
    const result = page(camel, input.limit, (r) => ({ sort: r.sort_key, id: r.id }));
    return {
      items: result.items.map((r) => summary(r as Row, tags.get(r.id) ?? [])),
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
    if (!c) throw HfosError.notFound('Company not found.');
    const [counts] = await rows<{ people_count: number; open_leads: number }>(
      ctx.tx,
      sql`select (select count(*) from app.people p where p.company_id = ${c.id} and p.archived_at is null)::int as people_count,
                 (select count(*) from app.leads l where l.company_id = ${c.id} and l.status = 'open' and l.archived_at is null)::int as open_leads`,
    );
    const owner = await userRef(ctx.tx, c.ownerUserId);
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
            ...c,
            people_count: counts?.people_count ?? 0,
            open_leads: counts?.open_leads ?? 0,
            owner_name: owner?.fullName ?? null,
            owner_email: null,
            sort_key: '',
          },
          tags.get(c.id) ?? [],
        ),
        notes: c.notes,
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
