/**
 * AI Social Media Content Creator setting itself up, as the server and the worker read and keep it (decisions 28 to
 * 33; docs/socialcontent.md, "Setting up on its own"): how setup stands, the creators it weighs, what the AI said about
 * how close each is, the ones it picks and swaps out, and the steps it took. The choosing is ../picking.ts.
 * Server-only.
 */
import { rows, sql, type Db, type Tx } from '@hfos/db/client';
import { z } from 'zod';
import { defineAddonCommand } from '../../server';
import { listsFilled, listsOf, OFFER_LISTS } from '../../../main-offer/lists';
import { socialcontentAddon } from '../manifest';
import { CONTENT_NETWORK_INFO, isContentNetwork, type ContentNetwork } from '../networks';
import {
  PICKING,
  RecentPost,
  SetupMarks,
  type PickCandidate,
  type SetupFacts,
  type SwapCandidate,
} from '../picking';
import {
  CreatorsMatchedInput,
  CreatorsPickInput,
  CreatorsPickOutput,
  SetupMarkInput,
} from '../shapes';
import { inWorkspace, queueWork, readSince } from './common';

/** The networks a business studies, as its settings say: only ones the extension reads. */
const studied = (raw: string[] | null): ContentNetwork[] =>
  (raw ?? ['instagram']).filter(
    (n): n is ContentNetwork => isContentNetwork(n) && CONTENT_NETWORK_INFO[n].ready,
  );

/** How setting up stands (decisions 28 to 32), for `setupSteps` and for the worker's next step. */
export async function setupFactsOf(tx: Tx | Db, workspaceId: string): Promise<SetupFacts> {
  const [s] = await rows<{
    networks: string[] | null;
    reader_user_id: string | null;
    auto_pick: boolean | null;
    auto_fill: boolean | null;
    setup: unknown;
    filled_at: Date | string | null;
  }>(
    tx,
    sql`select networks, reader_user_id, auto_pick, auto_fill, setup, filled_at
        from addon_socialcontent.settings where workspace_id = ${workspaceId}::uuid`,
  );
  const networks = studied(s?.networks ?? null);
  const [c] = await rows<{
    niches_picked: number;
    finds_left: number;
    reads_left: number;
    noted: number;
    playbook_at: Date | string | null;
    offer_live: boolean;
    lists: unknown;
  }>(
    tx,
    sql`select
          (select count(*)::int from addon_socialcontent.niches
            where workspace_id = ${workspaceId}::uuid and state = 'picked') as niches_picked,
          (select count(*)::int from addon_socialcontent.work
            where workspace_id = ${workspaceId}::uuid and kind = 'find' and state in ('waiting', 'taken')) as finds_left,
          (select count(*)::int from addon_socialcontent.work
            where workspace_id = ${workspaceId}::uuid and kind = 'profile' and state in ('waiting', 'taken')) as reads_left,
          (select count(*)::int from addon_socialcontent.posts
            where workspace_id = ${workspaceId}::uuid and notes is not null) as noted,
          (select written_at from addon_socialcontent.playbook where workspace_id = ${workspaceId}::uuid) as playbook_at,
          coalesce((select live_version is not null from app.main_offers where workspace_id = ${workspaceId}::uuid), false) as offer_live,
          (select lists from app.main_offers where workspace_id = ${workspaceId}::uuid) as lists`,
  );
  const per = await rows<{ network: string; studying: number; by_ai: number; pickable: number }>(
    tx,
    sql`select network,
               count(*) filter (where state = 'studying')::int as studying,
               count(*) filter (where state = 'studying' and picked_by = 'ai')::int as by_ai,
               count(*) filter (where state = 'suggested' and (match is null or (match >= ${PICKING.matchLeast}
                 and coalesce(followers, 0) >= 5000 and last_post_at > now() - interval '30 days')))::int as pickable
        from addon_socialcontent.creators where workspace_id = ${workspaceId}::uuid
        group by network`,
  );
  const at = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);
  return {
    autoPick: s?.auto_pick ?? true,
    autoFill: s?.auto_fill ?? true,
    marks: SetupMarks.parse(s?.setup ?? {}),
    readerSet: !!s?.reader_user_id,
    nichesPicked: c?.niches_picked ?? 0,
    findsLeft: c?.finds_left ?? 0,
    readsLeft: c?.reads_left ?? 0,
    networks: networks.map((network) => {
      const p = per.find((x) => x.network === network);
      return {
        network,
        studying: p?.studying ?? 0,
        byAi: p?.by_ai ?? 0,
        pickable: p?.pickable ?? 0,
      };
    }),
    noted: c?.noted ?? 0,
    playbookAt: at(c?.playbook_at ?? null),
    filledAt: at(s?.filled_at ?? null),
    offerLive: c?.offer_live ?? false,
    listsFilled: listsFilled(listsOf(c?.lists)),
    listsAll: OFFER_LISTS.length,
  };
}

/** A creator as the AI and picking read them. */
export type CreatorToWeigh = PickCandidate & {
  readonly shown: string;
  readonly name: string | null;
  readonly bio: string | null;
  readonly recent: RecentPost[] | null;
};

/**
 * The suggested creators on the networks studied, for the AI to score and picking to weigh; not those whose profile
 * wouldn't read lately.
 */
export async function creatorsToWeigh(
  tx: Tx | Db,
  workspaceId: string,
  networks: readonly ContentNetwork[],
): Promise<CreatorToWeigh[]> {
  if (!networks.length) return [];
  const found = await rows<{
    id: string;
    network: ContentNetwork;
    handle: string;
    name: string | null;
    bio: string | null;
    followers: number | null;
    last_post_at: Date | string | null;
    profile_read_at: Date | string | null;
    match: number | null;
    engagement: number | string | null;
    recent: unknown;
  }>(
    tx,
    sql`select id, network, handle, name, bio, followers, last_post_at, profile_read_at, match, engagement, recent
        from addon_socialcontent.creators c
        where workspace_id = ${workspaceId}::uuid and state = 'suggested'
          and network = any(${`{${networks.join(',')}}`}::text[])
          -- A profile that wouldn't read lately, or whose read someone stopped, isn't asked for again and again.
          and not exists (
            select 1 from addon_socialcontent.work w
            where w.workspace_id = c.workspace_id and w.creator_id = c.id and w.kind = 'profile'
              and w.state in ('failed', 'stopped')
              and w.finished_at > now() - make_interval(days => ${PICKING.freshDays}))
        order by followers desc nulls last, created_at`,
  );
  return found.map((f) => {
    const recent = Array.isArray(f.recent)
      ? f.recent.flatMap((p) => {
          const r = RecentPost.safeParse(p);
          return r.success ? [r.data] : [];
        })
      : null;
    return {
      id: f.id,
      network: f.network,
      state: 'suggested' as const,
      shown: `@${f.handle}`,
      name: f.name,
      bio: f.bio,
      followers: f.followers,
      lastPostAt: f.last_post_at,
      profileReadAt: f.profile_read_at,
      match: f.match,
      engagement: f.engagement === null ? null : Number(f.engagement),
      recentRead: recent !== null,
      recent,
    };
  });
}

/** How many are studied on each network. */
export async function studyingOn(
  tx: Tx | Db,
  workspaceId: string,
): Promise<Partial<Record<ContentNetwork, number>>> {
  const found = await rows<{ network: ContentNetwork; n: number }>(
    tx,
    sql`select network, count(*)::int as n from addon_socialcontent.creators
        where workspace_id = ${workspaceId}::uuid and state = 'studying' group by network`,
  );
  return Object.fromEntries(found.map((f) => [f.network, f.n]));
}

/** The creators the AI picked and still studies, for the monthly swap (decision 31). */
export async function aiPicked(tx: Tx | Db, workspaceId: string): Promise<SwapCandidate[]> {
  const found = await rows<{
    id: string;
    last_post_at: Date | string | null;
    posts_read_at: Date | string | null;
    posts_count: number;
    standouts_count: number;
  }>(
    tx,
    sql`select id, last_post_at, posts_read_at, posts_count, standouts_count from addon_socialcontent.creators
        where workspace_id = ${workspaceId}::uuid and state = 'studying' and picked_by = 'ai'`,
  );
  return found.map((f) => ({
    id: f.id,
    lastPostAt: f.last_post_at,
    postsReadAt: f.posts_read_at,
    postsCount: f.posts_count,
    standoutsCount: f.standouts_count,
  }));
}

export const creatorsMatched = defineAddonCommand(socialcontentAddon, {
  name: 'socialcontent.creators.matched',
  description:
    'Worker: how close the AI found suggested creators to what the business does, 0 to 10, with why (decision 30), from their bio and latest posts.',
  risk: 0,
  input: CreatorsMatchedInput,
  output: z.object({ kept: z.number().int() }),
  permission: 'socialcontent.use',
  actors: ['system'],
  scope: inWorkspace,
  emits: [],
  async handler(ctx, input) {
    let kept = 0;
    for (const m of input.matches) {
      const done = await rows<{ id: string }>(
        ctx.tx,
        sql`update addon_socialcontent.creators
            set match = ${m.match}, match_why = ${m.why}, matched_at = now()
            where id = ${m.creatorId}::uuid and workspace_id = ${ctx.scope.workspaceId!}::uuid
            returning id`,
      );
      kept += done.length;
    }
    return { kept };
  },
});

export const creatorsPick = defineAddonCommand(socialcontentAddon, {
  name: 'socialcontent.creators.pick',
  description:
    'Worker: setting up on its own and the monthly swap (decisions 30 and 31). The suggested creators the AI picked are studied (their posts read back 12 months); the ones it picked before that stopped posting or rarely stand out are swapped out, with why; and the profiles it reads first, for their latest likes and comments, are asked for. Never one a person ticked, added or skipped.',
  risk: 0,
  input: CreatorsPickInput,
  output: CreatorsPickOutput,
  permission: 'socialcontent.use',
  actors: ['system'],
  scope: inWorkspace,
  emits: ['socialcontent.creators.picked', 'socialcontent.work.asked'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const now = new Date();
    const swapped: string[] = [];
    for (const s of input.swap) {
      const done = await rows<{ id: string }>(
        ctx.tx,
        sql`update addon_socialcontent.creators
            set state = 'skipped', why = ${s.why}, updated_at = now()
            where id = ${s.creatorId}::uuid and workspace_id = ${ws}::uuid
              and state = 'studying' and picked_by = 'ai'
            returning id`,
      );
      swapped.push(...done.map((d) => d.id));
    }
    if (swapped.length)
      await rows(
        ctx.tx,
        sql`update addon_socialcontent.work set state = 'stopped', finished_at = now()
            where workspace_id = ${ws}::uuid and state = 'waiting'
              and creator_id = any(${`{${swapped.join(',')}}`}::uuid[])`,
      );
    const picked = input.pick.length
      ? await rows<{
          id: string;
          network: ContentNetwork;
          profile_read_at: Date | null;
          posts_read_at: Date | null;
        }>(
          ctx.tx,
          sql`update addon_socialcontent.creators
              set state = 'studying', picked_by = 'ai', decided_by = null, updated_at = now()
              where workspace_id = ${ws}::uuid and state = 'suggested'
                and id = any(${`{${input.pick.join(',')}}`}::uuid[])
              returning id, network, profile_read_at, posts_read_at`,
        )
      : [];
    let asked = await queueWork(
      ctx,
      picked
        .filter((c) => CONTENT_NETWORK_INFO[c.network].ready)
        .flatMap((c) => [
          ...(c.profile_read_at
            ? []
            : [{ kind: 'profile' as const, network: c.network, creatorId: c.id }]),
          {
            kind: 'posts' as const,
            network: c.network,
            creatorId: c.id,
            since: readSince(c.posts_read_at ? new Date(c.posts_read_at) : null, now),
          },
        ]),
      'studying',
      null,
    );
    const toRead = input.read.length
      ? await rows<{ id: string; network: ContentNetwork }>(
          ctx.tx,
          sql`select id, network from addon_socialcontent.creators
              where workspace_id = ${ws}::uuid and state = 'suggested'
                and id = any(${`{${input.read.join(',')}}`}::uuid[])`,
        )
      : [];
    asked += await queueWork(
      ctx,
      toRead
        .filter((c) => CONTENT_NETWORK_INFO[c.network].ready)
        .map((c) => ({ kind: 'profile' as const, network: c.network, creatorId: c.id })),
      'person',
      null,
    );
    if (picked.length || swapped.length)
      await ctx.emit({
        type: 'socialcontent.creators.picked',
        entityType: 'socialcontent_creator',
        payload: { picked: picked.length, swapped: swapped.length },
      });
    return { picked: picked.length, swapped: swapped.length, asked };
  },
});

export const setupMark = defineAddonCommand(socialcontentAddon, {
  name: 'socialcontent.setup.mark',
  description:
    'Worker: the steps of setting up on its own it just took (started, niches ticked, creators searched for, writing started); one taken before keeps its first time.',
  risk: 0,
  input: SetupMarkInput,
  output: z.object({ marks: SetupMarks }),
  permission: 'socialcontent.use',
  actors: ['system'],
  scope: inWorkspace,
  emits: [],
  async handler(ctx, input) {
    const [s] = await rows<{ setup: unknown }>(
      ctx.tx,
      sql`insert into addon_socialcontent.settings (workspace_id, setup)
          values (${ctx.scope.workspaceId!}::uuid, ${JSON.stringify(input.marks)}::jsonb)
          on conflict (workspace_id) do update
            set setup = excluded.setup || addon_socialcontent.settings.setup
          returning setup`,
    );
    return { marks: SetupMarks.parse(s?.setup ?? {}) };
  },
});

export const setupCommands = [creatorsMatched, creatorsPick, setupMark] as const;
