import { rows, sql } from '@hfos/db/client';
import { defineQuery } from '../kernel/define';
import { decodeCursor, page } from '../kernel/pagination';
import { TimelineListInput, TimelineListOutput } from '../schemas/activity';

type Row = {
  id: string;
  kind: string;
  subtype: string | null;
  body: string | null;
  occurred_at: Date;
  author_user_id: string | null;
  author_name: string | null;
  actor_type: string;
  person_id: string | null;
  company_id: string | null;
  lead_id: string | null;
  custom_record_id: string | null;
  meta: Record<string, unknown>;
  sort_key: string;
};

export const timelineList = defineQuery({
  name: 'timeline.list',
  description:
    'Everything that happened on a person, company or lead, or on a record like a pet, vehicle or property, newest first.',
  input: TimelineListInput,
  output: TimelineListOutput,
  permission: 'records.read',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  async handler(ctx, input) {
    const cursor = decodeCursor(input.cursor);
    const column =
      input.recordType === 'person'
        ? sql`a.person_id`
        : input.recordType === 'company'
          ? sql`a.company_id`
          : input.recordType === 'custom_record'
            ? sql`a.custom_record_id`
            : sql`a.lead_id`;
    const list = await rows<Row>(
      ctx.tx,
      sql`select a.id, a.kind::text as kind, a.subtype, a.body, a.occurred_at, a.author_user_id,
            coalesce(nullif(u.full_name, ''), u.email::text) as author_name, a.actor_type::text as actor_type,
            a.person_id, a.company_id, a.lead_id, a.custom_record_id, a.meta,
            to_char(a.occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as sort_key
          from app.activities a
          left join app.users u on u.id = a.author_user_id
          where a.workspace_id = ${input.workspaceId} and ${column} = ${input.recordId}
          ${cursor ? sql`and (to_char(a.occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), a.id) < (${cursor.sort}, ${cursor.id}::uuid)` : sql``}
          order by a.occurred_at desc, a.id desc
          limit ${input.limit + 1}`,
    );
    const result = page(list, input.limit, (r) => ({ sort: r.sort_key, id: r.id }));
    return {
      nextCursor: result.nextCursor,
      items: result.items.map((r) => ({
        id: r.id,
        entry: 'activity' as const,
        kind: r.kind,
        subtype: r.subtype,
        body: r.body,
        occurredAt: new Date(r.occurred_at).toISOString(),
        actor: r.author_user_id
          ? { id: r.author_user_id, fullName: r.author_name ?? 'Former member' }
          : null,
        actorType: r.actor_type,
        personId: r.person_id,
        companyId: r.company_id,
        leadId: r.lead_id,
        customRecordId: r.custom_record_id,
        meta: r.meta ?? {},
      })),
    };
  },
});
