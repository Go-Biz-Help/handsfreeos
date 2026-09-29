import { and, asc, count, desc, eq, isNull } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { files, importErrors, imports, recordTags, tags, users } from '@hfos/db/schema';
import { findMatches } from '../crm/matching';
import { workspaceTimezone } from '../crm/records';
import { HfosError } from '../errors';
import { defineQuery } from '../kernel/define';
import {
  CrmMetricsInput,
  CrmMetricsOutput,
  CrmSummaryInput,
  CrmSummaryOutput,
  FindMatchesInput,
  FindMatchesOutput,
} from '../schemas/crm-queries';
import { FileListInput, FileListOutput } from '../schemas/file';
import {
  ImportGetInput,
  ImportGetOutput,
  ImportListInput,
  ImportListOutput,
  ImportOptions,
} from '../schemas/import';
import { TagListInput, TagListOutput } from '../schemas/tag';

export const tagList = defineQuery({
  name: 'tag.list',
  description: 'The workspace’s tags and how many records use each.',
  input: TagListInput,
  output: TagListOutput,
  permission: 'records.read',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  async handler(ctx, input) {
    const list = await ctx.tx
      .select({ id: tags.id, name: tags.name, color: tags.color, usage: count(recordTags.tagId) })
      .from(tags)
      .leftJoin(recordTags, eq(recordTags.tagId, tags.id))
      .where(eq(tags.workspaceId, input.workspaceId))
      .groupBy(tags.id)
      .orderBy(asc(tags.name));
    return { tags: list.map((t) => ({ ...t, usage: Number(t.usage) })) };
  },
});

export const fileList = defineQuery({
  name: 'file.list',
  description: 'Files attached to a person, company or lead.',
  input: FileListInput,
  output: FileListOutput,
  permission: 'records.read',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  async handler(ctx, input) {
    const list = await ctx.tx
      .select({ f: files, uploaderName: users.fullName, uploaderEmail: users.email })
      .from(files)
      .leftJoin(users, eq(users.id, files.createdBy))
      .where(
        and(
          eq(files.workspaceId, input.workspaceId),
          eq(files.recordType, input.recordType),
          eq(files.recordId, input.recordId),
          eq(files.status, 'ready'),
          isNull(files.deletedAt),
        ),
      )
      .orderBy(desc(files.createdAt));
    return {
      files: list.map(({ f, uploaderName, uploaderEmail }) => ({
        id: f.id,
        // The record asked for (knowledge files never match a person, company or lead).
        recordType: input.recordType,
        recordId: f.recordId,
        bucket: f.bucket,
        objectPath: f.objectPath,
        name: f.name,
        mimeType: f.mimeType,
        sizeBytes: f.sizeBytes === null ? null : Number(f.sizeBytes),
        isImage: (f.mimeType ?? '').startsWith('image/'),
        uploadedBy: f.createdBy
          ? { id: f.createdBy, fullName: uploaderName || uploaderEmail || 'Former member' }
          : null,
        createdAt: f.createdAt.toISOString(),
      })),
    };
  },
});

const importOut = (
  i: typeof imports.$inferSelect,
  creator: { fullName: string; email: string } | null,
) => ({
  id: i.id,
  kind: i.kind,
  fileName: i.fileName,
  status: i.status,
  mapping: Object.fromEntries(Object.entries(i.mapping).map(([k, v]) => [k, String(v)])),
  options: ImportOptions.parse(i.options),
  totalRows: i.totalRows,
  processedRows: i.processedRows,
  createdCount: i.createdCount,
  updatedCount: i.updatedCount,
  skippedCount: i.skippedCount,
  errorCount: i.errorCount,
  lastError: i.lastError,
  startedAt: i.startedAt?.toISOString() ?? null,
  finishedAt: i.finishedAt?.toISOString() ?? null,
  createdBy: i.createdBy
    ? { id: i.createdBy, fullName: creator?.fullName || creator?.email || 'Former member' }
    : null,
  createdAt: i.createdAt.toISOString(),
});

export const importGet = defineQuery({
  name: 'import.get',
  description: 'An import’s progress, result and the rows that failed.',
  input: ImportGetInput,
  output: ImportGetOutput,
  permission: 'records.import',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  async handler(ctx, input) {
    const [row] = await ctx.tx
      .select({ i: imports, fullName: users.fullName, email: users.email })
      .from(imports)
      .leftJoin(users, eq(users.id, imports.createdBy))
      .where(and(eq(imports.id, input.importId), eq(imports.workspaceId, input.workspaceId)));
    if (!row)
      throw HfosError.notFound(
        'That import isn’t there anymore. Refresh Settings → Imports and try again.',
      );
    const errors = await ctx.tx
      .select()
      .from(importErrors)
      .where(eq(importErrors.importId, row.i.id))
      .orderBy(asc(importErrors.rowNumber))
      .limit(100);
    return {
      import: importOut(
        row.i,
        row.fullName !== null ? { fullName: row.fullName, email: row.email ?? '' } : null,
      ),
      errors: errors.map((e) => ({
        rowNumber: e.rowNumber,
        message: e.message,
        raw: (e.raw as Record<string, unknown> | null) ?? null,
      })),
    };
  },
});

export const importList = defineQuery({
  name: 'import.list',
  description: 'Recent imports in the workspace.',
  input: ImportListInput,
  output: ImportListOutput,
  permission: 'records.import',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  async handler(ctx, input) {
    const list = await ctx.tx
      .select({ i: imports, fullName: users.fullName, email: users.email })
      .from(imports)
      .leftJoin(users, eq(users.id, imports.createdBy))
      .where(eq(imports.workspaceId, input.workspaceId))
      .orderBy(desc(imports.createdAt))
      .limit(50);
    return {
      imports: list.map((r) =>
        importOut(r.i, r.fullName !== null ? { fullName: r.fullName, email: r.email ?? '' } : null),
      ),
    };
  },
});

export const crmFindMatches = defineQuery({
  name: 'crm.find_matches',
  description:
    'Existing people or companies that look like the one being typed (same email, phone or name).',
  input: FindMatchesInput,
  output: FindMatchesOutput,
  permission: 'records.read',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  async handler(ctx, input) {
    const matches = await findMatches(ctx.tx, input.workspaceId, input.kind, {
      email: input.email,
      phoneE164: input.phone,
      name: input.name,
      exceptId: input.exceptId,
    });
    return { matches };
  },
});

export const crmSummary = defineQuery({
  name: 'crm.summary',
  description:
    'The numbers on the home screen: open leads and value, leads without a next action, tasks due and overdue.',
  input: CrmSummaryInput,
  output: CrmSummaryOutput,
  permission: 'records.read',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  async handler(ctx, input) {
    const tz = await workspaceTimezone(ctx.tx, input.workspaceId);
    const [s] = await rows<{
      open_leads: number;
      open_value: number;
      without_next: number;
      due_today: number;
      overdue: number;
      people: number;
      companies: number;
    }>(
      ctx.tx,
      sql`select
          (select count(*) from app.leads l where l.workspace_id = ${input.workspaceId} and l.status = 'open' and l.archived_at is null)::int as open_leads,
          (select coalesce(sum(l.value_cents), 0) from app.leads l where l.workspace_id = ${input.workspaceId} and l.status = 'open' and l.archived_at is null)::bigint as open_value,
          (select count(*) from app.leads l where l.workspace_id = ${input.workspaceId} and l.status = 'open' and l.archived_at is null and l.next_action is null)::int as without_next,
          (select count(*) from app.tasks t where t.workspace_id = ${input.workspaceId} and t.done_at is null and t.due_at is not null
             and (t.due_at at time zone ${tz})::date = (now() at time zone ${tz})::date
             and not ((not t.all_day) and t.due_at < now()))::int as due_today,
          (select count(*) from app.tasks t where t.workspace_id = ${input.workspaceId} and t.done_at is null and t.due_at is not null
             and ((t.all_day and (t.due_at at time zone ${tz})::date < (now() at time zone ${tz})::date) or (not t.all_day and t.due_at < now())))::int as overdue,
          (select count(*) from app.people p where p.workspace_id = ${input.workspaceId} and p.archived_at is null)::int as people,
          (select count(*) from app.companies c where c.workspace_id = ${input.workspaceId} and c.archived_at is null)::int as companies`,
    );
    return {
      openLeads: s?.open_leads ?? 0,
      openValueCents: Number(s?.open_value ?? 0),
      leadsWithoutNextAction: s?.without_next ?? 0,
      tasksDueToday: s?.due_today ?? 0,
      tasksOverdue: s?.overdue ?? 0,
      people: s?.people ?? 0,
      companies: s?.companies ?? 0,
    };
  },
});

export const crmMetrics = defineQuery({
  name: 'crm.metrics',
  description:
    'Counts for a period: leads that came in, won and lost (with the won value), new customers, and texts, emails and calls in and out, with missed calls.',
  input: CrmMetricsInput,
  output: CrmMetricsOutput,
  permission: 'records.read',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  async handler(ctx, input) {
    const ws = input.workspaceId;
    // Outbound messages that failed never left; a missed call is an inbound one that ended with
    // nobody answering (voicemails included), the same rule as the call.missed event. A call through someone's
    // own cell counts once the customer's phone was dialed (their own cell not answering isn't a call out).
    const [m] = await rows<{
      leads_created: number;
      leads_won: number;
      leads_lost: number;
      won_value: number;
      new_people: number;
      texts_in: number;
      texts_out: number;
      emails_in: number;
      emails_out: number;
      calls_in: number;
      calls_out: number;
      calls_missed: number;
    }>(
      ctx.tx,
      sql`with w as (select ${input.since}::timestamptz as since, coalesce(${input.until ?? null}::timestamptz, now()) as until)
        select
          (select count(*) from app.leads l where l.workspace_id = ${ws} and l.archived_at is null and l.created_at >= w.since and l.created_at < w.until)::int as leads_created,
          (select count(*) from app.leads l where l.workspace_id = ${ws} and l.archived_at is null and l.won_at >= w.since and l.won_at < w.until)::int as leads_won,
          (select count(*) from app.leads l where l.workspace_id = ${ws} and l.archived_at is null and l.lost_at >= w.since and l.lost_at < w.until)::int as leads_lost,
          (select coalesce(sum(l.value_cents), 0) from app.leads l where l.workspace_id = ${ws} and l.archived_at is null and l.won_at >= w.since and l.won_at < w.until)::bigint as won_value,
          (select count(*) from app.people p where p.workspace_id = ${ws} and p.archived_at is null and p.created_at >= w.since and p.created_at < w.until)::int as new_people,
          ms.*, cl.*
        from w
        cross join lateral (
          select
            count(*) filter (where m.channel = 'sms' and m.direction = 'inbound')::int as texts_in,
            count(*) filter (where m.channel = 'sms' and m.direction = 'outbound' and m.status <> 'failed')::int as texts_out,
            count(*) filter (where m.channel = 'email' and m.direction = 'inbound')::int as emails_in,
            count(*) filter (where m.channel = 'email' and m.direction = 'outbound' and m.status <> 'failed')::int as emails_out
          from app.messages m
          where m.workspace_id = ${ws} and m.occurred_at >= w.since and m.occurred_at < w.until
        ) ms
        cross join lateral (
          select
            count(*) filter (where c.direction = 'inbound')::int as calls_in,
            count(*) filter (where c.direction = 'outbound'
              and (c.answered_via is distinct from 'bridge' or c.answered_by_user_id is not null))::int as calls_out,
            count(*) filter (where c.direction = 'inbound' and c.answered_at is null
              and c.status in ('completed', 'no_answer', 'busy', 'failed', 'canceled'))::int as calls_missed
          from app.calls c
          where c.workspace_id = ${ws} and c.started_at >= w.since and c.started_at < w.until
        ) cl`,
    );
    return {
      leadsCreated: m?.leads_created ?? 0,
      leadsWon: m?.leads_won ?? 0,
      leadsLost: m?.leads_lost ?? 0,
      wonValueCents: Number(m?.won_value ?? 0),
      newPeople: m?.new_people ?? 0,
      textsIn: m?.texts_in ?? 0,
      textsOut: m?.texts_out ?? 0,
      emailsIn: m?.emails_in ?? 0,
      emailsOut: m?.emails_out ?? 0,
      callsIn: m?.calls_in ?? 0,
      callsOut: m?.calls_out ?? 0,
      callsMissed: m?.calls_missed ?? 0,
    };
  },
});
