/**
 * Reading ideas, the roadmap and What's new (0100). The board, one idea with its story, "is it one of these?",
 * the roadmap's three columns and What's new are the person's own reads (`account` scope): the database shows
 * them what anybody who takes part may see, and shows somebody who takes no part nothing. The team's two reads
 * — the triage list and who is behind an idea — are `platform` scope, like the support desk's.
 *
 * Other businesses are never named here. People go by a short name ("Dale R."), the team by the name they chose,
 * and who voted for what is the team's to know alone.
 */
import { rows, sql, type Tx } from '@hfos/db/client';
import { HfosError } from '../errors';
import {
  IDEA_STATUSES,
  OPEN_IDEA_STATUSES,
  ideaExcerpt,
  ideaSearchWords,
  type IdeaSort,
  type IdeaStatus,
  type WhatsNewKind,
} from '../ideas/words';
import { requireHuman } from '../kernel/actor';
import { defineQuery } from '../kernel/define';
import {
  IdeaAreasInput,
  IdeaAreasOutput,
  IdeaGetInput,
  IdeaGetOutput,
  IdeaListInput,
  IdeaListOutput,
  IdeaSimilarInput,
  IdeaSimilarOutput,
  IdeaTeamViewInput,
  IdeaTeamViewOutput,
  IdeaTriageInput,
  IdeaTriageOutput,
  RoadmapInput,
  RoadmapOutput,
  WhatsNewListInput,
  WhatsNewListOutput,
  WhatsNewUnseenInput,
  WhatsNewUnseenOutput,
} from '../schemas/ideas';

const onAccount = () => ({ kind: 'account' as const });
const onPlatform = () => ({ kind: 'platform' as const });

const iso = (d: Date | string | null): string | null => (d ? new Date(d).toISOString() : null);
const isoOf = (d: Date | string): string => new Date(d).toISOString();

/** A week, in seconds: how long a vote takes to count half as much toward "trending". */
const TREND_HALF_LIFE_SECONDS = 7 * 86400;
/** Somebody who has never opened What's new is shown the last month's entries as new, not all of history. */
const WHATS_NEW_FIRST_LOOK_DAYS = 30;

/** Paging is by position: a list sorted by what is trending has no steady key to page on. */
function offsetOf(cursor: string | undefined): number {
  if (!cursor) return 0;
  if (!/^\d{1,6}$/.test(cursor))
    throw HfosError.validation([{ path: 'cursor', message: 'Invalid cursor.' }]);
  return Number(cursor);
}

const uuidArray = (ids: readonly string[]) =>
  ids.length
    ? sql`array[${sql.join(
        ids.map((id) => sql`${id}::uuid`),
        sql`, `,
      )}]`
    : sql`array[]::uuid[]`;

const textArray = (values: readonly string[]) =>
  values.length
    ? sql`array[${sql.join(
        values.map((v) => sql`${v}`),
        sql`, `,
      )}]::text[]`
    : sql`array[]::text[]`;

/** The names to show beside ideas, comments and updates, by user id (0100's private.idea_people). */
async function namesOf(tx: Tx, ids: readonly (string | null)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (!wanted.length) return new Map();
  const found = await rows<{ user_id: string; name: string }>(
    tx,
    sql`select user_id, name from private.idea_people(${uuidArray(wanted)})`,
  );
  return new Map(found.map((r) => [r.user_id, r.name]));
}

async function isModerator(tx: Tx): Promise<boolean> {
  const [row] = await rows<{ ok: boolean }>(
    tx,
    sql`select private.staff_can('platform.ideas.moderate') as ok`,
  );
  return row?.ok === true;
}

/** How each sort orders the board; the idea table is aliased `i`. */
function orderFor(sort: IdeaSort) {
  switch (sort) {
    case 'trending':
      return sql`i.trend_score * power(0.5::float8,
          extract(epoch from (now() - i.trend_at))::float8 / ${TREND_HALF_LIFE_SECONDS}::float8) desc,
        i.vote_count desc, i.created_at desc, i.id`;
    case 'top':
      return sql`i.vote_count desc, i.created_at desc, i.id`;
    case 'new':
      return sql`i.created_at desc, i.id`;
  }
}

/** Its words (stemmed, English), or a title that looks like it, typos and all. */
function matches(search: string) {
  return sql`(i.search @@ websearch_to_tsquery('english'::regconfig, ${search})
    or i.title operator(extensions.%) ${search})`;
}

function statusFilter(status: 'open' | 'all' | IdeaStatus) {
  if (status === 'all') return sql``;
  const wanted = status === 'open' ? OPEN_IDEA_STATUSES : [status];
  return sql`and i.status::text = any(${textArray(wanted)})`;
}

type SummaryRow = {
  id: string;
  number: string | number;
  title: string;
  body: string;
  area_id: string;
  status: IdeaStatus;
  vote_count: number;
  comment_count: number;
  author_user_id: string | null;
  created_at: Date | string;
  status_changed_at: Date | string | null;
  voted: boolean;
};

const summaryColumns = (me: string) => sql`i.id, i.number, i.title, i.body, i.area_id,
  i.status::text as status, i.vote_count, i.comment_count, i.author_user_id, i.created_at,
  i.status_changed_at,
  exists (select 1 from platform.idea_votes v where v.idea_id = i.id and v.user_id = ${me}) as voted`;

function summarize(r: SummaryRow, me: string, names: Map<string, string>) {
  return {
    id: r.id,
    number: Number(r.number),
    title: r.title,
    excerpt: ideaExcerpt(r.body),
    areaId: r.area_id,
    status: r.status,
    voteCount: r.vote_count,
    commentCount: r.comment_count,
    author: {
      name: r.author_user_id ? (names.get(r.author_user_id) ?? '') : '',
      you: r.author_user_id === me,
    },
    voted: r.voted,
    createdAt: isoOf(r.created_at),
    statusChangedAt: iso(r.status_changed_at),
  };
}

export const ideaList = defineQuery({
  name: 'idea.list',
  description:
    'The ideas board: trending, most voted or newest, by status and area, with a search. Your votes marked.',
  input: IdeaListInput,
  output: IdeaListOutput,
  permission: null,
  scope: onAccount,
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const offset = offsetOf(input.cursor);
    const mine =
      input.mine === 'shared'
        ? sql`and i.author_user_id = ${me}`
        : input.mine === 'voted'
          ? sql`and exists (select 1 from platform.idea_votes v where v.idea_id = i.id and v.user_id = ${me})`
          : input.mine === 'following'
            ? sql`and exists (select 1 from platform.idea_followers f
                where f.idea_id = i.id and f.user_id = ${me} and f.following)`
            : sql``;
    const list = await rows<SummaryRow>(
      ctx.tx,
      sql`select ${summaryColumns(me)}
          from platform.ideas i
          where i.hidden_at is null and i.merged_into is null
            ${statusFilter(input.status)}
            ${input.areaId ? sql`and i.area_id = ${input.areaId}` : sql``}
            ${input.search ? sql`and ${matches(input.search)}` : sql``}
            ${mine}
          order by ${orderFor(input.sort)}
          limit ${input.limit + 1} offset ${offset}`,
    );
    const page = list.slice(0, input.limit);
    const names = await namesOf(
      ctx.tx,
      page.map((r) => r.author_user_id),
    );
    return {
      ideas: page.map((r) => summarize(r, me, names)),
      nextCursor: list.length > input.limit ? String(offset + input.limit) : null,
    };
  },
});

export const ideaGet = defineQuery({
  name: 'idea.get',
  description:
    'One idea: its details, your vote, whether you follow it, its comments and its story.',
  input: IdeaGetInput,
  output: IdeaGetOutput,
  permission: null,
  scope: onAccount,
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const [idea] = await rows<
      SummaryRow & {
        merged_into: string | null;
        hidden: boolean;
        following: boolean;
        merged_number: string | number | null;
        merged_title: string | null;
      }
    >(
      ctx.tx,
      sql`select ${summaryColumns(me)}, i.merged_into, i.hidden_at is not null as hidden,
            coalesce((select f.following from platform.idea_followers f
              where f.idea_id = i.id and f.user_id = ${me}), false) as following,
            m.number as merged_number, m.title as merged_title
          from platform.ideas i
          left join platform.ideas m on m.id = i.merged_into
          where i.id = ${input.ideaId}`,
    );
    if (!idea) throw HfosError.notFound('No idea with that id.');
    const moderator = await isModerator(ctx.tx);
    const [comments, updates, shipped] = await Promise.all([
      rows<{
        id: string;
        body: string;
        author_user_id: string | null;
        from_team: boolean;
        hidden: boolean;
        created_at: Date | string;
      }>(
        ctx.tx,
        sql`select c.id, c.body, c.author_user_id, c.from_team, c.hidden_at is not null as hidden, c.created_at
            from platform.idea_comments c
            where c.idea_id = ${idea.id} ${moderator ? sql`` : sql`and c.hidden_at is null`}
            order by c.created_at, c.id`,
      ),
      rows<{
        id: string;
        kind: 'status' | 'merged' | 'merged_in';
        from_status: IdeaStatus | null;
        to_status: IdeaStatus | null;
        note: string;
        other_id: string | null;
        other_number: string | number | null;
        other_title: string | null;
        whats_new_id: string | null;
        whats_new_title: string | null;
        actor_user_id: string | null;
        created_at: Date | string;
      }>(
        ctx.tx,
        sql`select u.id, u.kind::text as kind, u.from_status::text as from_status,
              u.to_status::text as to_status, u.note, o.id as other_id, o.number as other_number,
              o.title as other_title, w.id as whats_new_id, w.title as whats_new_title,
              u.actor_user_id, u.created_at
            from platform.idea_updates u
            left join platform.ideas o on o.id = u.other_idea_id
            left join platform.whats_new w on w.id = u.whats_new_id
            where u.idea_id = ${idea.id}
            order by u.created_at, u.id`,
      ),
      rows<{ id: string; title: string; published_at: Date | string }>(
        ctx.tx,
        sql`select w.id, w.title, w.published_at
            from platform.whats_new_ideas wi join platform.whats_new w on w.id = wi.whats_new_id
            where wi.idea_id = ${idea.id} and w.published_at is not null
            order by w.published_at desc`,
      ),
    ]);
    const names = await namesOf(ctx.tx, [
      idea.author_user_id,
      ...comments.map((c) => c.author_user_id),
      ...updates.map((u) => u.actor_user_id),
    ]);
    const merged =
      idea.merged_into && idea.merged_number !== null
        ? {
            id: idea.merged_into,
            number: Number(idea.merged_number),
            title: idea.merged_title ?? '',
          }
        : null;
    const open = OPEN_IDEA_STATUSES.includes(idea.status) && !merged && !idea.hidden;
    return {
      idea: {
        ...summarize(idea, me, names),
        body: idea.body,
        following: idea.following,
        canEdit:
          idea.author_user_id === me && idea.status === 'under_review' && !merged && !idea.hidden,
        votingOpen: open,
        mergedInto: merged,
        hidden: idea.hidden,
      },
      comments: comments.map((c) => ({
        id: c.id,
        body: c.body,
        author: {
          name: c.author_user_id ? (names.get(c.author_user_id) ?? '') : '',
          you: c.author_user_id === me,
          team: c.from_team,
        },
        hidden: c.hidden,
        createdAt: isoOf(c.created_at),
      })),
      updates: updates.map((u) => ({
        id: u.id,
        kind: u.kind,
        fromStatus: u.from_status,
        toStatus: u.to_status,
        note: u.note,
        other:
          u.other_id && u.other_number !== null
            ? { id: u.other_id, number: Number(u.other_number), title: u.other_title ?? '' }
            : null,
        whatsNew:
          u.whats_new_id && u.whats_new_title !== null
            ? { id: u.whats_new_id, title: u.whats_new_title }
            : null,
        by: (u.actor_user_id && names.get(u.actor_user_id)) || 'The HandsFreeOS team',
        createdAt: isoOf(u.created_at),
      })),
      shipped: shipped.map((s) => ({
        id: s.id,
        title: s.title,
        publishedAt: isoOf(s.published_at),
      })),
    };
  },
});

export const ideaSimilar = defineQuery({
  name: 'idea.similar',
  description:
    'Ideas already on the board that look like what someone is typing, so they can vote instead of repeating it.',
  input: IdeaSimilarInput,
  output: IdeaSimilarOutput,
  permission: null,
  scope: onAccount,
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const words = ideaSearchWords(input.text);
    if (!words.length) return { ideas: [] };
    // Any of the words, not all of them: somebody half way through a title has not said everything yet.
    const list = await rows<{
      id: string;
      number: string | number;
      title: string;
      status: IdeaStatus;
      vote_count: number;
      voted: boolean;
    }>(
      ctx.tx,
      sql`with q as (
            select websearch_to_tsquery('english'::regconfig, ${words.join(' or ')}) as tsq,
              ${input.text}::text as raw
          )
          select i.id, i.number, i.title, i.status::text as status, i.vote_count,
            exists (select 1 from platform.idea_votes v where v.idea_id = i.id and v.user_id = ${me}) as voted
          from platform.ideas i cross join q
          where i.hidden_at is null and i.merged_into is null
            ${input.excludeIdeaId ? sql`and i.id <> ${input.excludeIdeaId}` : sql``}
            and (i.search @@ q.tsq or i.title operator(extensions.%) q.raw)
          order by (ts_rank_cd(i.search, q.tsq, 32)
            + 0.5::float8 * extensions.similarity(i.title, q.raw)) desc, i.vote_count desc, i.id
          limit 5`,
    );
    return {
      ideas: list.map((r) => ({
        id: r.id,
        number: Number(r.number),
        title: r.title,
        status: r.status,
        voteCount: r.vote_count,
        voted: r.voted,
      })),
    };
  },
});

/** How much each column of the roadmap shows. Done is the last ninety days. */
const ROADMAP_LIMIT = 100;
const ROADMAP_DONE_DAYS = 90;

export const ideaRoadmap = defineQuery({
  name: 'idea.roadmap',
  description: 'The roadmap: what is planned, what is being built, and what shipped lately.',
  input: RoadmapInput,
  output: RoadmapOutput,
  permission: null,
  scope: onAccount,
  async handler(ctx) {
    const me = requireHuman(ctx).userId;
    const list = await rows<{
      id: string;
      number: string | number;
      title: string;
      area_id: string;
      status: IdeaStatus;
      vote_count: number;
      status_changed_at: Date | string | null;
      voted: boolean;
    }>(
      ctx.tx,
      sql`select * from (
            select i.id, i.number, i.title, i.area_id, i.status::text as status, i.vote_count,
              i.status_changed_at,
              exists (select 1 from platform.idea_votes v where v.idea_id = i.id and v.user_id = ${me}) as voted,
              row_number() over (partition by i.status order by
                case when i.status = 'done' then extract(epoch from coalesce(i.status_changed_at, i.updated_at)) end
                  desc nulls last,
                i.vote_count desc, i.created_at desc) as place
            from platform.ideas i
            where i.hidden_at is null and i.merged_into is null
              and (i.status in ('planned', 'in_progress')
                or (i.status = 'done' and coalesce(i.status_changed_at, i.updated_at)
                  > now() - make_interval(days => ${ROADMAP_DONE_DAYS})))
          ) ranked
          where place <= ${ROADMAP_LIMIT}
          order by place`,
    );
    const card = (r: (typeof list)[number]) => ({
      id: r.id,
      number: Number(r.number),
      title: r.title,
      areaId: r.area_id,
      voteCount: r.vote_count,
      voted: r.voted,
      statusChangedAt: iso(r.status_changed_at),
    });
    return {
      planned: list.filter((r) => r.status === 'planned').map(card),
      inProgress: list.filter((r) => r.status === 'in_progress').map(card),
      done: list.filter((r) => r.status === 'done').map(card),
    };
  },
});

export const ideaAreas = defineQuery({
  name: 'idea.areas',
  description: 'The parts of HandsFreeOS an idea can be about, with how many open ideas each has.',
  input: IdeaAreasInput,
  output: IdeaAreasOutput,
  permission: null,
  scope: onAccount,
  async handler(ctx) {
    const list = await rows<{
      id: string;
      name: string;
      description: string;
      sort: number;
      archived: boolean;
      open_count: number;
    }>(
      ctx.tx,
      sql`select a.id, a.name, a.description, a.sort, a.archived_at is not null as archived,
            (select count(*) from platform.ideas i
              where i.area_id = a.id and i.hidden_at is null and i.merged_into is null
                and i.status::text = any(${textArray(OPEN_IDEA_STATUSES)}))::int as open_count
          from platform.idea_areas a
          order by a.sort, a.name`,
    );
    return {
      areas: list.map((a) => ({
        id: a.id,
        name: a.name,
        description: a.description,
        sort: a.sort,
        archived: a.archived,
        openCount: a.open_count,
      })),
    };
  },
});

// ---------- What's new ----------

/** When the reader last looked at What's new, or a month ago for somebody who never has. */
const seenLine = (me: string) => sql`coalesce(
  (select r.seen_at from platform.whats_new_reads r where r.user_id = ${me}),
  now() - make_interval(days => ${WHATS_NEW_FIRST_LOOK_DAYS}))`;

export const whatsNewList = defineQuery({
  name: 'whats_new.list',
  description: 'What’s new in HandsFreeOS, newest first, with the ideas each entry delivers.',
  input: WhatsNewListInput,
  output: WhatsNewListOutput,
  permission: null,
  scope: onAccount,
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const offset = offsetOf(input.cursor);
    // Drafts exist only for the team (0100's policy); asking for them is how the team's page shows them first.
    const list = await rows<{
      id: string;
      title: string;
      body: string;
      kind: WhatsNewKind;
      area_id: string | null;
      published_at: Date | string | null;
      updated_at: Date | string;
      unseen: boolean;
    }>(
      ctx.tx,
      sql`select w.id, w.title, w.body, w.kind::text as kind, w.area_id, w.published_at, w.updated_at,
            coalesce(w.published_at > ${seenLine(me)}, false) as unseen
          from platform.whats_new w
          where ${input.includeDrafts ? sql`true` : sql`w.published_at is not null`}
          order by w.published_at desc nulls first, w.updated_at desc, w.id
          limit ${input.limit + 1} offset ${offset}`,
    );
    const page = list.slice(0, input.limit);
    const delivered = page.length
      ? await rows<{
          whats_new_id: string;
          id: string;
          number: string | number;
          title: string;
          vote_count: number;
          status: IdeaStatus;
        }>(
          ctx.tx,
          sql`select wi.whats_new_id, i.id, i.number, i.title, i.vote_count, i.status::text as status
              from platform.whats_new_ideas wi join platform.ideas i on i.id = wi.idea_id
              where wi.whats_new_id = any(${uuidArray(page.map((e) => e.id))})
              order by i.vote_count desc, i.number`,
        )
      : [];
    return {
      entries: page.map((e) => ({
        id: e.id,
        title: e.title,
        body: e.body,
        kind: e.kind,
        areaId: e.area_id,
        publishedAt: iso(e.published_at),
        ideas: delivered
          .filter((d) => d.whats_new_id === e.id)
          .map((d) => ({
            id: d.id,
            number: Number(d.number),
            title: d.title,
            voteCount: d.vote_count,
            status: d.status,
          })),
        unseen: e.unseen,
        updatedAt: isoOf(e.updated_at),
      })),
      nextCursor: list.length > input.limit ? String(offset + input.limit) : null,
    };
  },
});

export const whatsNewUnseen = defineQuery({
  name: 'whats_new.unseen',
  description: 'How many entries in What’s new were published since you last looked.',
  input: WhatsNewUnseenInput,
  output: WhatsNewUnseenOutput,
  permission: null,
  scope: onAccount,
  async handler(ctx) {
    const me = requireHuman(ctx).userId;
    const [row] = await rows<{ unseen: number }>(
      ctx.tx,
      sql`select count(*)::int as unseen from platform.whats_new w
          where w.published_at is not null and w.published_at > ${seenLine(me)}`,
    );
    return { unseen: row?.unseen ?? 0 };
  },
});

// ---------- the team ----------

type TeamRow = SummaryRow & {
  author_name: string | null;
  author_email: string | null;
  workspace_id: string | null;
  business_name: string | null;
  business_count: number;
  hidden: boolean;
  merged_into: string | null;
  merged_number: string | number | null;
  merged_title: string | null;
};

export const ideaTriage = defineQuery({
  name: 'idea.triage',
  description:
    'The team’s list of ideas: who shared each, from which business, and how many businesses want it.',
  input: IdeaTriageInput,
  output: IdeaTriageOutput,
  permission: 'platform.ideas.moderate',
  scope: onPlatform,
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const offset = offsetOf(input.cursor);
    const show =
      input.show === 'hidden'
        ? sql`i.hidden_at is not null`
        : input.show === 'merged'
          ? sql`i.merged_into is not null`
          : sql`i.hidden_at is null and i.merged_into is null`;
    const list = await rows<TeamRow>(
      ctx.tx,
      sql`select ${summaryColumns(me)}, u.full_name as author_name, u.email::text as author_email,
            i.workspace_id, w.name as business_name,
            (select count(distinct v.workspace_id) from platform.idea_votes v
              where v.idea_id = i.id and v.workspace_id is not null)::int as business_count,
            i.hidden_at is not null as hidden, i.merged_into, m.number as merged_number, m.title as merged_title
          from platform.ideas i
          left join app.users u on u.id = i.author_user_id
          left join app.workspaces w on w.id = i.workspace_id
          left join platform.ideas m on m.id = i.merged_into
          where ${show}
            ${input.show === 'board' ? statusFilter(input.status) : sql``}
            ${input.areaId ? sql`and i.area_id = ${input.areaId}` : sql``}
            ${input.search ? sql`and ${matches(input.search)}` : sql``}
          order by ${orderFor(input.sort)}
          limit ${input.limit + 1} offset ${offset}`,
    );
    const [counts] = await rows<Record<IdeaStatus | 'hidden', number>>(
      ctx.tx,
      sql`select
            ${sql.join(
              IDEA_STATUSES.map(
                (s) =>
                  sql`count(*) filter (where i.status = ${s}::platform.idea_status
                    and i.hidden_at is null and i.merged_into is null)::int as ${sql.raw(s)}`,
              ),
              sql`, `,
            )},
            count(*) filter (where i.hidden_at is not null)::int as hidden
          from platform.ideas i`,
    );
    const page = list.slice(0, input.limit);
    return {
      ideas: page.map((r) => {
        const { voted: _voted, ...summary } = summarize(r, me, new Map());
        return {
          ...summary,
          author: r.author_user_id
            ? {
                userId: r.author_user_id,
                name: r.author_name ?? '',
                email: r.author_email ?? '',
              }
            : null,
          business:
            r.workspace_id && r.business_name !== null
              ? { id: r.workspace_id, name: r.business_name }
              : null,
          businessCount: r.business_count,
          hidden: r.hidden,
          mergedInto:
            r.merged_into && r.merged_number !== null
              ? { id: r.merged_into, number: Number(r.merged_number), title: r.merged_title ?? '' }
              : null,
        };
      }),
      nextCursor: list.length > input.limit ? String(offset + input.limit) : null,
      counts: {
        under_review: counts?.under_review ?? 0,
        planned: counts?.planned ?? 0,
        in_progress: counts?.in_progress ?? 0,
        done: counts?.done ?? 0,
        not_planned: counts?.not_planned ?? 0,
        hidden: counts?.hidden ?? 0,
      },
    };
  },
});

/** The most voters the team's page lists at once. */
const VOTERS_SHOWN = 500;

export const ideaTeamView = defineQuery({
  name: 'idea.team_view',
  description:
    'Who is behind one idea, for the team: who shared it and from where, who voted, and how many would be emailed.',
  input: IdeaTeamViewInput,
  output: IdeaTeamViewOutput,
  permission: 'platform.ideas.moderate',
  scope: onPlatform,
  async handler(ctx, input) {
    const [idea] = await rows<{
      author_user_id: string | null;
      author_name: string | null;
      author_email: string | null;
      workspace_id: string | null;
      business_name: string | null;
    }>(
      ctx.tx,
      sql`select i.author_user_id, u.full_name as author_name, u.email::text as author_email,
            i.workspace_id, w.name as business_name
          from platform.ideas i
          left join app.users u on u.id = i.author_user_id
          left join app.workspaces w on w.id = i.workspace_id
          where i.id = ${input.ideaId}`,
    );
    if (!idea) throw HfosError.notFound('No idea with that id.');
    const [voters, [tally]] = await Promise.all([
      rows<{
        user_id: string;
        full_name: string | null;
        email: string | null;
        workspace_id: string | null;
        business_name: string | null;
        created_at: Date | string;
      }>(
        ctx.tx,
        sql`select v.user_id, u.full_name, u.email::text as email, v.workspace_id,
              w.name as business_name, v.created_at
            from platform.idea_votes v
            left join app.users u on u.id = v.user_id
            left join app.workspaces w on w.id = v.workspace_id
            where v.idea_id = ${input.ideaId}
            order by v.created_at desc
            limit ${VOTERS_SHOWN}`,
      ),
      rows<{ business_count: number; follower_count: number }>(
        ctx.tx,
        sql`select
              (select count(distinct v.workspace_id) from platform.idea_votes v
                where v.idea_id = ${input.ideaId} and v.workspace_id is not null)::int as business_count,
              (select count(*) from platform.idea_followers f
                where f.idea_id = ${input.ideaId} and f.following)::int as follower_count`,
      ),
    ]);
    return {
      author: idea.author_user_id
        ? {
            userId: idea.author_user_id,
            name: idea.author_name ?? '',
            email: idea.author_email ?? '',
          }
        : null,
      business:
        idea.workspace_id && idea.business_name !== null
          ? { id: idea.workspace_id, name: idea.business_name }
          : null,
      businessCount: tally?.business_count ?? 0,
      voters: voters.map((v) => ({
        userId: v.user_id,
        name: v.full_name ?? '',
        email: v.email ?? '',
        business:
          v.workspace_id && v.business_name !== null
            ? { id: v.workspace_id, name: v.business_name }
            : null,
        votedAt: isoOf(v.created_at),
      })),
      followerCount: tally?.follower_count ?? 0,
    };
  },
});

export const ideaQueries = [
  ideaList,
  ideaGet,
  ideaSimilar,
  ideaRoadmap,
  ideaAreas,
  whatsNewList,
  whatsNewUnseen,
  ideaTriage,
  ideaTeamView,
] as const;
