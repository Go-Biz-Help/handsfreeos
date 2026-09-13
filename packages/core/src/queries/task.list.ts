import { rows, sql } from '@hfos/db/client';
import { workspaceTimezone } from '../crm/records';
import { requireHuman } from '../kernel/actor';
import { defineQuery } from '../kernel/define';
import { decodeCursor, page } from '../kernel/pagination';
import { TaskListInput, TaskListOutput, type TaskOut } from '../schemas/task';

type Row = {
  id: string;
  title: string;
  notes: string | null;
  due_at: Date | null;
  all_day: boolean;
  bucket: TaskOut['dueBucket'];
  assignee_id: string | null;
  assignee_name: string | null;
  person_id: string | null;
  person_name: string | null;
  person_archived: Date | null;
  company_id: string | null;
  company_name: string | null;
  company_archived: Date | null;
  lead_id: string | null;
  lead_title: string | null;
  done_at: Date | null;
  done_by: string | null;
  done_by_name: string | null;
  created_by: string | null;
  created_by_name: string | null;
  created_at: Date;
  updated_at: Date;
  sort_key: string;
};

export const taskList = defineQuery({
  name: 'task.list',
  description:
    'Tasks for you or everyone, open or done, with due buckets in the workspace’s time zone.',
  input: TaskListInput,
  output: TaskListOutput,
  permission: 'records.read',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  async handler(ctx, input) {
    const tz = await workspaceTimezone(ctx.tx, input.workspaceId);
    const me = requireHuman(ctx).userId;
    const cursor = decodeCursor(input.cursor);
    const doneOrder = input.status === 'done';
    const list = await rows<Row>(
      ctx.tx,
      sql`select * from (
          select t.id, t.title, t.notes, t.due_at, t.all_day,
            case
              when t.due_at is null then 'none'
              when t.done_at is not null then 'none'
              when (t.all_day and (t.due_at at time zone ${tz})::date < (now() at time zone ${tz})::date) or (not t.all_day and t.due_at < now()) then 'overdue'
              when (t.due_at at time zone ${tz})::date = (now() at time zone ${tz})::date then 'today'
              when (t.due_at at time zone ${tz})::date < (now() at time zone ${tz})::date + 7 then 'week'
              else 'later' end as bucket,
            t.assignee_user_id as assignee_id, coalesce(nullif(a.full_name, ''), a.email::text) as assignee_name,
            t.person_id, btrim(p.first_name || ' ' || p.last_name) as person_name, p.archived_at as person_archived,
            t.company_id, c.name as company_name, c.archived_at as company_archived,
            t.lead_id, l.title as lead_title,
            t.done_at, t.done_by, coalesce(nullif(d.full_name, ''), d.email::text) as done_by_name,
            t.created_by, coalesce(nullif(cb.full_name, ''), cb.email::text) as created_by_name,
            t.created_at, t.updated_at,
            ${
              doneOrder
                ? sql`to_char(coalesce(t.done_at, t.created_at) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`
                : sql`to_char(coalesce(t.due_at, 'infinity'::timestamptz) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`
            } as sort_key
          from app.tasks t
          left join app.users a on a.id = t.assignee_user_id
          left join app.users d on d.id = t.done_by
          left join app.users cb on cb.id = t.created_by
          left join app.people p on p.id = t.person_id
          left join app.companies c on c.id = t.company_id
          left join app.leads l on l.id = t.lead_id
          where t.workspace_id = ${input.workspaceId}
            ${input.scope === 'mine' ? sql`and (t.assignee_user_id = ${me} or (t.assignee_user_id is null and t.created_by = ${me}))` : sql``}
            ${input.status === 'open' ? sql`and t.done_at is null` : input.status === 'done' ? sql`and t.done_at is not null` : sql``}
            ${input.assigneeUserId ? sql`and t.assignee_user_id = ${input.assigneeUserId}` : sql``}
            ${input.personId ? sql`and t.person_id = ${input.personId}` : sql``}
            ${input.companyId ? sql`and t.company_id = ${input.companyId}` : sql``}
            ${input.leadId ? sql`and t.lead_id = ${input.leadId}` : sql``}
        ) x
        ${cursor ? (doneOrder ? sql`where (x.sort_key, x.id) < (${cursor.sort}, ${cursor.id}::uuid)` : sql`where (x.sort_key, x.id) > (${cursor.sort}, ${cursor.id}::uuid)`) : sql``}
        order by ${doneOrder ? sql`x.sort_key desc, x.id desc` : sql`x.sort_key, x.id`}
        limit ${input.limit + 1}`,
    );
    const result = page(list, input.limit, (r) => ({ sort: r.sort_key, id: r.id }));
    const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);
    return {
      timezone: tz,
      nextCursor: result.nextCursor,
      items: result.items.map((r) => ({
        id: r.id,
        title: r.title,
        notes: r.notes,
        dueAt: iso(r.due_at),
        allDay: r.all_day,
        dueBucket: r.bucket,
        assignee: r.assignee_id
          ? { id: r.assignee_id, fullName: r.assignee_name ?? 'Former member' }
          : null,
        person: r.person_id
          ? { id: r.person_id, fullName: r.person_name ?? '', archived: !!r.person_archived }
          : null,
        company: r.company_id
          ? { id: r.company_id, name: r.company_name ?? '', archived: !!r.company_archived }
          : null,
        lead: r.lead_id ? { id: r.lead_id, title: r.lead_title ?? '' } : null,
        doneAt: iso(r.done_at),
        doneBy: r.done_by ? { id: r.done_by, fullName: r.done_by_name ?? 'Former member' } : null,
        createdBy: r.created_by
          ? { id: r.created_by, fullName: r.created_by_name ?? 'Former member' }
          : null,
        createdAt: new Date(r.created_at).toISOString(),
        updatedAt: new Date(r.updated_at).toISOString(),
      })),
    };
  },
});
