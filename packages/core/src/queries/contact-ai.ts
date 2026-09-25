/**
 * The AI's upkeep of customers' tags and details (0107): how its pass over the list is going, and the log of every
 * look it took (app.contact_ai_reviews), what it changed and what it left alone.
 */
import { rows, sql, type Tx } from '@hfos/db/client';
import { automationSettingsOf } from '../automations/settings';
import { uuidArray } from '../calendar/load';
import { fullName } from '../crm/records';
import { defineQuery } from '../kernel/define';
import {
  ContactAiPreviewInput,
  ContactAiPreviewOutput,
  ContactAiReviewsInput,
  ContactAiReviewsOutput,
  ContactAiStatusInput,
  ContactAiStatusOutput,
  type ContactAiReviewOut,
  type ContactAiSweepOut,
  type ContactAiSweepStatus,
} from '../schemas/contact-ai';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});
const iso = (d: Date | string | null): string | null => (d ? new Date(d).toISOString() : null);
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const list = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v) ? v.filter(isRecord) : [];

interface SweepRow extends Record<string, unknown> {
  id: string;
  status: ContactAiSweepStatus;
  instructions: string;
  tag_ids: string[];
  only_tag_id: string | null;
  fix_details: boolean;
  total: number;
  reviewed: number;
  changed: number;
  tags_added: number;
  tags_removed: number;
  details_changed: number;
  note: string | null;
  requested_by: string | null;
  requested_name: string | null;
  created_at: Date;
  finished_at: Date | null;
}

async function sweepsOf(tx: Tx, workspaceId: string, limit: number): Promise<ContactAiSweepOut[]> {
  const found = await rows<SweepRow>(
    tx,
    sql`select s.id, s.status, s.instructions, s.tag_ids, s.only_tag_id, s.fix_details, s.total, s.reviewed,
          s.changed, s.tags_added, s.tags_removed, s.details_changed, s.note, s.requested_by,
          coalesce(nullif(u.full_name, ''), u.email::text) as requested_name, s.created_at, s.finished_at
        from app.contact_ai_sweeps s left join app.users u on u.id = s.requested_by
        where s.workspace_id = ${workspaceId}
        order by (s.status = 'running') desc, s.created_at desc
        limit ${limit}`,
  );
  const ids = [
    ...new Set(found.flatMap((s) => [...s.tag_ids, ...(s.only_tag_id ? [s.only_tag_id] : [])])),
  ];
  const tagRows = ids.length
    ? await rows<{ id: string; name: string; color: string }>(
        tx,
        sql`select id, name::text as name, color from app.tags
            where workspace_id = ${workspaceId} and id = any(${uuidArray(ids)})`,
      )
    : [];
  const byId = new Map(tagRows.map((t) => [t.id, t]));
  return found.map((s) => ({
    id: s.id,
    status: s.status,
    instructions: s.instructions,
    tags: s.tag_ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : [])),
    onlyTag: s.only_tag_id ? (byId.get(s.only_tag_id) ?? null) : null,
    fixDetails: s.fix_details,
    total: s.total,
    reviewed: s.reviewed,
    changed: s.changed,
    tagsAdded: s.tags_added,
    tagsRemoved: s.tags_removed,
    detailsChanged: s.details_changed,
    note: s.note,
    requestedBy: s.requested_by
      ? { id: s.requested_by, fullName: s.requested_name ?? 'Former member' }
      : null,
    createdAt: iso(s.created_at)!,
    finishedAt: iso(s.finished_at),
  }));
}

export const contactAiStatus = defineQuery({
  name: 'contact_ai.status',
  description:
    'How the AI’s upkeep of customers’ tags and details is going: the pass over the list going now and the last few, whether it tags and fixes details on its own, and its last week.',
  input: ContactAiStatusInput,
  output: ContactAiStatusOutput,
  permission: 'records.read',
  scope: inWorkspace,
  async handler(ctx, input) {
    const recent = await sweepsOf(ctx.tx, input.workspaceId, 5);
    const [ws] = await rows<{ settings: Record<string, unknown> | null }>(
      ctx.tx,
      sql`select settings from app.workspaces where id = ${input.workspaceId}`,
    );
    const switches = automationSettingsOf(ws?.settings).switches;
    const [week] = await rows<{ reviewed: number; changed: number }>(
      ctx.tx,
      sql`select count(*)::int as reviewed, count(*) filter (where outcome = 'changed')::int as changed
          from app.contact_ai_reviews
          where workspace_id = ${input.workspaceId} and outcome <> 'skipped'
            and created_at > now() - interval '7 days'`,
    );
    return {
      running: recent.find((s) => s.status === 'running') ?? null,
      recent,
      switches: { tags: switches.aiTags, details: switches.aiDetails },
      lastWeek: { reviewed: week?.reviewed ?? 0, changed: week?.changed ?? 0 },
    };
  },
});

interface ReviewRow extends Record<string, unknown> {
  id: string;
  person_id: string;
  first_name: string;
  last_name: string;
  trigger: 'activity' | 'sweep';
  sweep_id: string | null;
  outcome: ContactAiReviewOut['outcome'];
  applied: unknown;
  note: string | null;
  created_at: Date;
}

/** One look as the log shows it, from what was done (`applied`). */
function reviewOut(r: ReviewRow): ContactAiReviewOut {
  const a = isRecord(r.applied) ? r.applied : {};
  const tagsOf = (k: string) =>
    list(a[k]).map((t) => ({ name: str(t['name']), reason: str(t['reason']) }));
  return {
    id: r.id,
    person: { id: r.person_id, fullName: fullName(r.first_name, r.last_name) },
    trigger: r.trigger,
    sweepId: r.sweep_id,
    outcome: r.outcome,
    addedTags: tagsOf('addTags'),
    removedTags: tagsOf('removeTags'),
    details: list(a['details']).map((d) => ({
      field: str(d['field']),
      from: strOrNull(d['from']),
      to: strOrNull(d['to']),
      reason: str(d['reason']),
    })),
    skipped: list(a['skipped']).map((s) => ({ what: str(s['what']), why: str(s['why']) })),
    note: r.note,
    createdAt: iso(r.created_at)!,
  };
}

export const contactAiReviews = defineQuery({
  name: 'contact_ai.reviews',
  description:
    'The log of the AI’s looks at customers’ tags and details, newest first: what it put on, took off and changed, each with its reason, and what it left alone and why. For one customer, one pass, or everyone.',
  input: ContactAiReviewsInput,
  output: ContactAiReviewsOutput,
  permission: 'records.read',
  scope: inWorkspace,
  async handler(ctx, input) {
    const found = await rows<ReviewRow>(
      ctx.tx,
      sql`select r.id, r.person_id, p.first_name, p.last_name, r.trigger, r.sweep_id, r.outcome, r.applied, r.note,
            r.created_at
          from app.contact_ai_reviews r join app.people p on p.id = r.person_id
          where r.workspace_id = ${input.workspaceId}
            ${input.personId ? sql`and r.person_id = ${input.personId}` : sql``}
            ${input.sweepId ? sql`and r.sweep_id = ${input.sweepId}` : sql``}
            ${input.changedOnly ? sql`and r.outcome = 'changed'` : sql``}
            ${input.before ? sql`and r.created_at < ${input.before}::timestamptz` : sql``}
          order by r.created_at desc, r.id desc
          limit ${input.limit + 1}`,
    );
    const more = found.length > input.limit;
    const items = found.slice(0, input.limit).map(reviewOut);
    return { items, nextBefore: more ? (items[items.length - 1]?.createdAt ?? null) : null };
  },
});

export const contactAiPreview = defineQuery({
  name: 'contact_ai.preview',
  description:
    'Before a pass over the list: how many customers it would look at, the tags it may use, and the workflows that start when a customer’s tags change.',
  input: ContactAiPreviewInput,
  output: ContactAiPreviewOutput,
  permission: 'records.read',
  scope: inWorkspace,
  async handler(ctx, input) {
    const ws = input.workspaceId;
    const [count] = await rows<{ n: number }>(
      ctx.tx,
      sql`select count(*)::int as n from app.people p
          where p.workspace_id = ${ws} and p.archived_at is null
          ${
            input.onlyTagId
              ? sql`and exists (select 1 from app.record_tags rt where rt.workspace_id = p.workspace_id
                  and rt.record_type = 'person' and rt.record_id = p.id and rt.tag_id = ${input.onlyTagId})`
              : sql``
          }`,
    );
    const tags = await rows<{ id: string; name: string; color: string }>(
      ctx.tx,
      sql`select id, name::text as name, color from app.tags where workspace_id = ${ws} order by name`,
    );
    const tagWorkflows = await rows<{ id: string; name: string }>(
      ctx.tx,
      sql`select id, name from app.workflows
          where workspace_id = ${ws} and status = 'active' and trigger_event = 'record.tags_changed'
          order by name limit 10`,
    );
    return { customers: count?.n ?? 0, tags, tagWorkflows };
  },
});

export const contactAiQueries = [contactAiStatus, contactAiReviews, contactAiPreview];
