/**
 * Knowledge reads (everyone in the workspace): the profile, items (search, kind, tags, status; keyset
 * pages), ranked search with snippets, the website scan's progress and suggestions. Packs are the agency's.
 */
import { and, asc, eq, isNull } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { knowledgePacks, knowledgeProfiles } from '@hfos/db/schema';
import { userNames } from '../calendar/load';
import { HfosError } from '../errors';
import { defineQuery } from '../kernel/define';
import { decodeTimeCursor, page } from '../kernel/pagination';
import { KnowledgePackItem } from '../schemas/knowledge';
import {
  KnowledgeItemGetInput,
  KnowledgeItemGetOutput,
  KnowledgeItemListInput,
  KnowledgeItemListOutput,
  KnowledgePackListInput,
  KnowledgePackListOutput,
  KnowledgeProfileGetInput,
  KnowledgeProfileOutput,
  KnowledgeScanGetInput,
  KnowledgeScanGetOutput,
  KnowledgeSearchInput,
  KnowledgeSearchOutput,
  KnowledgeSuggestionListInput,
  KnowledgeSuggestionListOutput,
  type KnowledgeItemOut,
} from '../schemas/knowledge';
import type { KnowledgeKind, KnowledgeSource, KnowledgeStatus } from '../knowledge/items';
import { emptyKnowledgeProfile, KnowledgeProfile, profileCompleteness } from '../knowledge/profile';
import { knowledgeMatches, knowledgeRetriever } from '../knowledge/search';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});
const inOrganization = (i: { organizationId: string }) => ({
  kind: 'organization' as const,
  organizationId: i.organizationId,
});
const iso = (v: Date | string | null | undefined) => (v ? new Date(v).toISOString() : null);
const SORT_KEY = (column: ReturnType<typeof sql>) =>
  sql`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const textArray = (values: readonly string[]) =>
  sql`array[${sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  )}]::text[]`;
const userRef = (id: string | null, names: ReadonlyMap<string, string>) =>
  id ? { id, fullName: names.get(id) ?? 'Someone' } : null;

export const knowledgeProfileGet = defineQuery({
  name: 'knowledge.profile',
  description:
    'The business profile the AI writes from, how complete it is, and who changed it last.',
  input: KnowledgeProfileGetInput,
  output: KnowledgeProfileOutput,
  permission: 'workspace.read',
  scope: inWorkspace,
  async handler(ctx, input) {
    const [row] = await ctx.tx
      .select()
      .from(knowledgeProfiles)
      .where(eq(knowledgeProfiles.workspaceId, input.workspaceId));
    const parsed = row ? KnowledgeProfile.safeParse(row.profile) : null;
    const profile: KnowledgeProfile = {
      ...(parsed?.success ? parsed.data : emptyKnowledgeProfile()),
      allowPrices: row?.allowPrices ?? false,
    };
    const names = await userNames(ctx.tx, row?.updatedBy ? [row.updatedBy] : []);
    return {
      profile,
      completeness: profileCompleteness(profile),
      updatedBy: userRef(row?.updatedBy ?? null, names),
      updatedAt: iso(row?.updatedAt),
    };
  },
});

type ItemRow = {
  id: string;
  kind: KnowledgeKind;
  title: string;
  body: string;
  tags: string[];
  status: KnowledgeStatus;
  source: KnowledgeSource;
  source_url: string | null;
  file_id: string | null;
  use_count: number;
  last_used_at: Date | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: Date;
  updated_at: Date;
  sort_key: string;
};

const itemColumns = sql`i.id, i.kind::text as kind, i.title, i.body, i.tags, i.status::text as status,
  i.source::text as source, i.source_url, i.file_id, i.use_count, i.last_used_at, i.created_by, i.updated_by,
  i.created_at, i.updated_at, ${SORT_KEY(sql`i.updated_at`)} as sort_key`;

async function itemsOut(
  ctx: { tx: Parameters<typeof userNames>[0] },
  list: readonly ItemRow[],
): Promise<KnowledgeItemOut[]> {
  const names = await userNames(
    ctx.tx,
    list.flatMap((r) => [r.created_by, r.updated_by]).filter((u): u is string => !!u),
  );
  return list.map((r) => ({
    id: r.id,
    kind: r.kind,
    title: r.title,
    body: r.body,
    tags: r.tags ?? [],
    status: r.status,
    source: r.source,
    sourceUrl: r.source_url,
    fileId: r.file_id,
    useCount: r.use_count,
    lastUsedAt: iso(r.last_used_at),
    createdBy: userRef(r.created_by, names),
    updatedBy: userRef(r.updated_by, names),
    createdAt: iso(r.created_at)!,
    updatedAt: iso(r.updated_at)!,
  }));
}

export const knowledgeItemList = defineQuery({
  name: 'knowledge_item.list',
  description:
    'Knowledge items, newest change first: filter by words (typos forgiven in titles), kind, tags and status (draft and published unless asked). Pages with a cursor.',
  input: KnowledgeItemListInput,
  output: KnowledgeItemListOutput,
  permission: 'workspace.read',
  scope: inWorkspace,
  async handler(ctx, input) {
    const ws = input.workspaceId;
    const cursor = decodeTimeCursor(input.cursor);
    const statuses = input.status?.length ? input.status : ['draft', 'published'];
    const list = await rows<ItemRow>(
      ctx.tx,
      sql`select ${itemColumns} from app.knowledge_items i
          where i.workspace_id = ${ws}
            and i.status::text = any(${textArray(statuses)})
            ${input.kind?.length ? sql`and i.kind::text = any(${textArray(input.kind)})` : sql``}
            ${input.tags?.length ? sql`and i.tags @> ${textArray(input.tags)}` : sql``}
            ${input.search ? sql`and ${knowledgeMatches(input.search)}` : sql``}
            ${cursor ? sql`and (i.updated_at, i.id) < (${cursor.sort}::timestamptz, ${cursor.id}::uuid)` : sql``}
          order by i.updated_at desc, i.id desc
          limit ${input.limit + 1}`,
    );
    const result = page(list, input.limit, (r) => ({ sort: r.sort_key, id: r.id }));
    const counts = await rows<{ status: KnowledgeStatus; n: number }>(
      ctx.tx,
      sql`select status::text as status, count(*)::int as n from app.knowledge_items
          where workspace_id = ${ws} group by status`,
    );
    const count = (s: KnowledgeStatus) => counts.find((c) => c.status === s)?.n ?? 0;
    return {
      items: await itemsOut(ctx, result.items),
      nextCursor: result.nextCursor,
      counts: { draft: count('draft'), published: count('published'), archived: count('archived') },
    };
  },
});

export const knowledgeItemGet = defineQuery({
  name: 'knowledge_item.get',
  description: 'One knowledge item with its text, where it came from, and when it was last used.',
  input: KnowledgeItemGetInput,
  output: KnowledgeItemGetOutput,
  permission: 'workspace.read',
  scope: inWorkspace,
  async handler(ctx, input) {
    const [row] = await rows<ItemRow & { file_name: string | null }>(
      ctx.tx,
      sql`select ${itemColumns}, f.name as file_name from app.knowledge_items i
          left join app.files f on f.id = i.file_id
          where i.workspace_id = ${input.workspaceId} and i.id = ${input.itemId}`,
    );
    if (!row) throw HfosError.notFound('Item not found.');
    const [item] = await itemsOut(ctx, [row]);
    return {
      item: {
        ...item!,
        file: row.file_id && row.file_name ? { id: row.file_id, name: row.file_name } : null,
      },
    };
  },
});

export const knowledgeSearch = defineQuery({
  name: 'knowledge.search',
  description:
    'Search the knowledge base the way AI steps do: ranked matches with snippets, published items only unless drafts are asked for.',
  input: KnowledgeSearchInput,
  output: KnowledgeSearchOutput,
  permission: 'workspace.read',
  scope: inWorkspace,
  async handler(ctx, input) {
    return {
      matches: await knowledgeRetriever().search(ctx.tx, input.workspaceId, input.query, {
        limit: input.limit,
        kinds: input.kinds,
        includeDrafts: input.includeDrafts,
      }),
    };
  },
});

export const knowledgeScanGet = defineQuery({
  name: 'knowledge_scan.get',
  description:
    'The website and a scan of it (the newest unless one is named): progress, pages read, errors and suggestions waiting.',
  input: KnowledgeScanGetInput,
  output: KnowledgeScanGetOutput,
  permission: 'workspace.read',
  scope: inWorkspace,
  async handler(ctx, input) {
    const ws = input.workspaceId;
    const [source] = await rows<{ id: string; url: string; updated_at: Date }>(
      ctx.tx,
      sql`select id, url, updated_at from app.knowledge_sources where workspace_id = ${ws}`,
    );
    const [scan] = await rows<{
      id: string;
      status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
      pages: Record<string, unknown>[];
      suggestion_count: number;
      errors: unknown[];
      started_by: string | null;
      started_at: Date | null;
      finished_at: Date | null;
      created_at: Date;
      pending: number;
    }>(
      ctx.tx,
      sql`select s.id, s.status::text as status, s.pages, s.suggestion_count, s.errors, s.started_by,
            s.started_at, s.finished_at, s.created_at,
            (select count(*)::int from app.knowledge_suggestions g
              where g.scan_id = s.id and g.status = 'pending') as pending
          from app.knowledge_scans s
          where s.workspace_id = ${ws} ${input.scanId ? sql`and s.id = ${input.scanId}` : sql``}
          order by s.created_at desc limit 1`,
    );
    if (input.scanId && !scan) throw HfosError.notFound('Scan not found.');
    const names = await userNames(ctx.tx, scan?.started_by ? [scan.started_by] : []);
    return {
      source: source
        ? { id: source.id, url: source.url, updatedAt: iso(source.updated_at)! }
        : null,
      scan: scan
        ? {
            id: scan.id,
            status: scan.status,
            pages: scan.pages ?? [],
            suggestionCount: scan.suggestion_count,
            pendingSuggestions: scan.pending,
            errors: scan.errors ?? [],
            startedBy: userRef(scan.started_by, names),
            startedAt: iso(scan.started_at),
            finishedAt: iso(scan.finished_at),
            createdAt: iso(scan.created_at)!,
          }
        : null,
    };
  },
});

export const knowledgeSuggestionList = defineQuery({
  name: 'knowledge_suggestion.list',
  description:
    'Suggestions to accept, edit or reject (pending unless asked): from website scans, questions the AI couldn’t answer, and agency packs.',
  input: KnowledgeSuggestionListInput,
  output: KnowledgeSuggestionListOutput,
  permission: 'workspace.read',
  scope: inWorkspace,
  async handler(ctx, input) {
    const cursor = decodeTimeCursor(input.cursor);
    const list = await rows<{
      id: string;
      kind: KnowledgeKind;
      reason: 'scan' | 'gap' | 'pack';
      status: 'pending' | 'accepted' | 'rejected';
      proposed: { title?: unknown; body?: unknown; tags?: unknown };
      source: Record<string, unknown>;
      scan_id: string | null;
      item_id: string | null;
      similar_count: number;
      decided_by: string | null;
      decided_at: Date | null;
      created_at: Date;
      sort_key: string;
    }>(
      ctx.tx,
      sql`select s.id, s.kind::text as kind, s.reason::text as reason, s.status::text as status, s.proposed,
            s.source, s.scan_id, s.item_id, s.similar_count, s.decided_by, s.decided_at, s.created_at,
            ${SORT_KEY(sql`s.created_at`)} as sort_key
          from app.knowledge_suggestions s
          where s.workspace_id = ${input.workspaceId} and s.status::text = ${input.status}
            ${input.reason ? sql`and s.reason::text = ${input.reason}` : sql``}
            ${input.scanId ? sql`and s.scan_id = ${input.scanId}` : sql``}
            ${cursor ? sql`and (s.created_at, s.id) < (${cursor.sort}::timestamptz, ${cursor.id}::uuid)` : sql``}
          order by s.created_at desc, s.id desc
          limit ${input.limit + 1}`,
    );
    const result = page(list, input.limit, (r) => ({ sort: r.sort_key, id: r.id }));
    const names = await userNames(
      ctx.tx,
      result.items.map((r) => r.decided_by).filter((u): u is string => !!u),
    );
    return {
      items: result.items.map((r) => ({
        id: r.id,
        kind: r.kind,
        reason: r.reason,
        status: r.status,
        proposed: {
          title: typeof r.proposed?.title === 'string' ? r.proposed.title : '',
          body: typeof r.proposed?.body === 'string' ? r.proposed.body : '',
          tags: Array.isArray(r.proposed?.tags)
            ? r.proposed.tags.filter((t): t is string => typeof t === 'string')
            : [],
        },
        source: r.source ?? {},
        scanId: r.scan_id,
        itemId: r.item_id,
        similarCount: r.similar_count,
        decidedBy: userRef(r.decided_by, names),
        decidedAt: iso(r.decided_at),
        createdAt: iso(r.created_at)!,
      })),
      nextCursor: result.nextCursor,
    };
  },
});

export const knowledgePackList = defineQuery({
  name: 'knowledge_pack.list',
  description:
    'The agency’s knowledge starter packs, with their items and versions, and how each business is getting on with them: its suggestions from the pack accepted, rejected and still waiting.',
  input: KnowledgePackListInput,
  output: KnowledgePackListOutput,
  permission: 'org.templates.manage',
  scope: inOrganization,
  async handler(ctx, input) {
    const list = await ctx.tx
      .select()
      .from(knowledgePacks)
      .where(
        and(
          eq(knowledgePacks.organizationId, input.organizationId),
          input.includeArchived ? undefined : isNull(knowledgePacks.archivedAt),
        ),
      )
      .orderBy(asc(knowledgePacks.name), asc(knowledgePacks.id));
    const names = await userNames(
      ctx.tx,
      list.map((p) => p.createdBy).filter((u): u is string => !!u),
    );
    // Each business's pack suggestions, any version. The organization's owners and admins can read every
    // one of its businesses' suggestions (RLS: accessible_workspace_ids covers the organization's).
    const progress = list.length
      ? await rows<{
          pack_id: string;
          workspace_id: string;
          name: string;
          pending: number;
          accepted: number;
          rejected: number;
        }>(
          ctx.tx,
          sql`select s.source ->> 'packId' as pack_id, s.workspace_id, w.name,
                count(*) filter (where s.status = 'pending')::int as pending,
                count(*) filter (where s.status = 'accepted')::int as accepted,
                count(*) filter (where s.status = 'rejected')::int as rejected
              from app.knowledge_suggestions s join app.workspaces w on w.id = s.workspace_id
              where w.organization_id = ${input.organizationId} and s.reason = 'pack'
                and s.source ->> 'packId' = any(${textArray(list.map((p) => p.id))})
              group by s.source ->> 'packId', s.workspace_id, w.name
              order by lower(w.name), s.workspace_id`,
        )
      : [];
    return {
      items: list.map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        items: p.items.flatMap((raw) => {
          const item = KnowledgePackItem.safeParse(raw);
          return item.success ? [item.data] : [];
        }),
        version: p.version,
        archivedAt: iso(p.archivedAt),
        createdBy: userRef(p.createdBy, names),
        updatedAt: iso(p.updatedAt)!,
        businesses: progress
          .filter((r) => r.pack_id === p.id)
          .map((r) => ({
            workspaceId: r.workspace_id,
            name: r.name,
            pending: r.pending,
            accepted: r.accepted,
            rejected: r.rejected,
          })),
      })),
    };
  },
});
