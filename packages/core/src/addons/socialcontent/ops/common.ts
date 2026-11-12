/**
 * What AI Social Media Content Creator's operations share (docs/socialcontent.md): the business's settings, how its
 * rows are read out, and queueing work for the reading computer. Server-only.
 */
import { rows, sql } from '@hfos/db/client';
import { mainOffers } from '@hfos/db/schema';
import { eq } from 'drizzle-orm';
import { HfosError } from '../../../errors';
import {
  FACEBOOK_WHERE,
  planOf,
  type FacebookWhere,
  type NetworkPlan,
  type PostingNetwork,
} from '../calendar';
import type { CommandContext, QueryContext } from '../../../kernel/types';
import {
  CONTENT_NETWORK_INFO,
  handleShown,
  isContentNetwork,
  networkName,
  READY_NETWORKS,
  type ContentNetwork,
} from '../networks';
import {
  PostNotes,
  PostWatched,
  Searches,
  WorkProgress,
  type Creator,
  type Niche,
  type Post,
  type Work,
  type WorkAskedFor,
  type WorkKind,
} from '../shapes';
import { SetupMarks } from '../picking';
import { settings, type creators, type niches, type posts } from '../tables';

export const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

export type Ctx = CommandContext | QueryContext;

/** How far back a creator's posts are read the first time (decision 8). */
export const READ_BACK_DAYS = 365;
/** A weekly read takes the numbers of posts from this long before the last read again: they still grow. */
export const REREAD_DAYS = 60;
/** Work a computer took and never finished goes back to waiting after this long (Chrome closed mid-way). */
export const TAKEN_FOR_MS = 2 * 60 * 60 * 1000;

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

/**
 * Whether the business's main offer is live (the owner's pick 7b, 11 Nov 2026): until it is, the AI writes no posts
 * and no ideas, as Social Outreach writes no messages.
 */
export async function offerLiveOf(ctx: Ctx): Promise<boolean> {
  const [o] = await ctx.tx
    .select({ live: mainOffers.liveVersion })
    .from(mainOffers)
    .where(eq(mainOffers.workspaceId, ctx.scope.workspaceId!));
  return o?.live != null;
}

/** The business's settings: the networks it studies (only the ones read yet), and whose computer reads. */
export async function settingsOf(ctx: Ctx): Promise<{
  networks: ContentNetwork[];
  readerUserId: string | null;
  watchVideos: boolean;
  readerSeenAt: string | null;
  readerVersion: string | null;
  plan: Record<PostingNetwork, NetworkPlan>;
  facebookPage: string | null;
  facebookWhere: FacebookWhere[];
  filledAt: string | null;
  autoFill: boolean;
  autoPick: boolean;
  setup: SetupMarks;
}> {
  const [s] = await ctx.tx
    .select()
    .from(settings)
    .where(eq(settings.workspaceId, ctx.scope.workspaceId!));
  const networks = (s?.networks ?? ['instagram']).filter(
    (n): n is ContentNetwork => isContentNetwork(n) && CONTENT_NETWORK_INFO[n].ready,
  );
  return {
    networks,
    readerUserId: s?.readerUserId ?? null,
    watchVideos: s?.watchVideos ?? false,
    readerSeenAt: s?.readerSeenAt ? s.readerSeenAt.toISOString() : null,
    readerVersion: s?.readerVersion ?? null,
    plan: planOf(s?.plan),
    facebookPage: s?.facebookPage ?? null,
    facebookWhere: (s?.facebookWhere ?? ['profile']).filter((w): w is FacebookWhere =>
      (FACEBOOK_WHERE as readonly string[]).includes(w),
    ),
    filledAt: s?.filledAt ? s.filledAt.toISOString() : null,
    autoFill: s?.autoFill ?? true,
    autoPick: s?.autoPick ?? true,
    setup: SetupMarks.parse(s?.setup ?? {}),
  };
}

/** The business's time zone: the calendar's days and times are its. */
export async function timeZoneOf(ctx: Ctx): Promise<string> {
  const [w] = await rows<{ timezone: string | null }>(
    ctx.tx,
    sql`select timezone from app.workspaces where id = ${ctx.scope.workspaceId!}`,
  );
  return w?.timezone || 'America/Chicago';
}

/** A person's name as the team sees it. */
export async function nameOf(ctx: Ctx, userId: string | null): Promise<string | null> {
  if (!userId) return null;
  const [who] = await rows<{ name: string }>(
    ctx.tx,
    sql`select coalesce(nullif(btrim(full_name), ''), email::text) as name from app.users where id = ${userId}::uuid`,
  );
  return who?.name ?? null;
}

/** Whether the person asking may change the settings. */
export function mayManage(ctx: Ctx): boolean {
  return (
    ctx.scope.workspaceRole === 'owner' ||
    (ctx.scope.workspacePermissions ?? []).includes('socialcontent.manage')
  );
}

export const nicheOut = (n: typeof niches.$inferSelect): Niche => ({
  id: n.id,
  name: n.name,
  own: n.own,
  state: n.state,
  why: n.why,
  searches: Searches.catch({}).parse(n.searches),
  addedBy: n.addedBy ? 'person' : 'ai',
  createdAt: n.createdAt.toISOString(),
});

export function creatorOut(
  c: typeof creators.$inferSelect,
  more: { nicheName: string | null; reading: boolean },
): Creator {
  return {
    id: c.id,
    network: c.network,
    handle: c.handle,
    shown: handleShown(c.network, c.handle),
    name: c.name,
    link: c.link,
    bio: c.bio,
    followers: c.followers,
    lastPostAt: iso(c.lastPostAt),
    nicheId: c.nicheId,
    nicheName: more.nicheName,
    state: c.state,
    foundBy: c.foundBy,
    why: c.why,
    profileReadAt: iso(c.profileReadAt),
    postsReadAt: iso(c.postsReadAt),
    postsCount: c.postsCount,
    standoutsCount: c.standoutsCount,
    reading: more.reading,
    createdAt: c.createdAt.toISOString(),
    pickedBy: c.pickedBy,
    match: c.match,
    matchWhy: c.matchWhy,
    engagement: c.engagement === null ? null : Number(c.engagement),
  };
}

export function postOut(
  p: typeof posts.$inferSelect,
  c: Pick<typeof creators.$inferSelect, 'name' | 'network' | 'handle'>,
  watching = false,
): Post {
  return {
    id: p.id,
    creatorId: p.creatorId,
    creatorName: c.name,
    creatorShown: handleShown(c.network, c.handle),
    network: c.network,
    postKey: p.postKey,
    link: p.link,
    postedAt: p.postedAt.toISOString(),
    kind: p.kind,
    caption: p.caption,
    views: p.views,
    likes: p.likes,
    comments: p.comments,
    shares: p.shares,
    seconds: p.seconds,
    pinned: p.pinned,
    viewsTimes: p.viewsTimes === null ? null : Number(p.viewsTimes),
    engagementTimes: p.engagementTimes === null ? null : Number(p.engagementTimes),
    standout: p.standout,
    standoutOn: p.standoutOn,
    waiting: p.waiting,
    // Kept as the AI wrote them; one that no longer fits the shape shows as none.
    notes: p.notes ? (PostNotes.safeParse(p.notes).data ?? null) : null,
    watched: p.watched ? (PostWatched.safeParse(p.watched).data ?? null) : null,
    watching,
  };
}

export type WorkRow = {
  id: string;
  kind: WorkKind;
  network: ContentNetwork;
  niche_id: string | null;
  niche_name: string | null;
  creator_id: string | null;
  creator_handle: string | null;
  creator_network: ContentNetwork | null;
  post_id: string | null;
  state: Work['state'];
  asked_for: WorkAskedFor;
  failure: string | null;
  done_count: number | null;
  progress: unknown;
  created_at: Date | string;
  taken_at: Date | string | null;
  finished_at: Date | string | null;
};

const when = (d: Date | string | null) =>
  d === null ? null : (d instanceof Date ? d : new Date(d)).toISOString();

export const workOut = (w: WorkRow): Work => ({
  id: w.id,
  kind: w.kind,
  network: w.network,
  nicheId: w.niche_id,
  nicheName: w.niche_name,
  creatorId: w.creator_id,
  creatorShown:
    w.creator_handle && w.creator_network ? handleShown(w.creator_network, w.creator_handle) : null,
  postId: w.post_id,
  state: w.state,
  askedFor: w.asked_for,
  failure: w.failure,
  doneCount: w.done_count,
  progress: w.progress ? (WorkProgress.safeParse(w.progress).data ?? null) : null,
  createdAt: when(w.created_at)!,
  takenAt: when(w.taken_at),
  finishedAt: when(w.finished_at),
});

/** The work's rows with the niche and creator they're about. */
export const WORK_SELECT = sql`
  select w.id, w.kind, w.network, w.niche_id, n.name as niche_name, w.creator_id, c.handle as creator_handle,
         c.network as creator_network, w.post_id, w.state, w.asked_for, w.failure, w.done_count, w.progress, w.created_at, w.taken_at,
         w.finished_at
  from addon_socialcontent.work w
  left join addon_socialcontent.niches n on n.id = w.niche_id
  left join addon_socialcontent.creators c on c.id = w.creator_id`;

export interface WorkAsk {
  readonly kind: WorkKind;
  readonly network: ContentNetwork;
  readonly nicheId?: string | null;
  readonly creatorId?: string | null;
  readonly postId?: string | null;
  readonly since?: Date | null;
}

/**
 * Asks the reading computer for each, unless the same is already open (one of a kind about the same thing at a time).
 * How many were new.
 */
export async function queueWork(
  ctx: CommandContext,
  asks: readonly WorkAsk[],
  askedFor: WorkAskedFor,
  askedBy: string | null,
): Promise<number> {
  let asked = 0;
  for (const a of asks) {
    const made = await rows<{ id: string }>(
      ctx.tx,
      sql`insert into addon_socialcontent.work
            (workspace_id, kind, network, niche_id, creator_id, post_id, since, asked_for, asked_by)
          values (${ctx.scope.workspaceId!}, ${a.kind}, ${a.network}, ${a.nicheId ?? null}, ${a.creatorId ?? null},
                  ${a.postId ?? null}, ${a.since ? a.since.toISOString() : null}::timestamptz, ${askedFor}, ${askedBy})
          on conflict do nothing
          returning id`,
    );
    asked += made.length;
  }
  if (asked)
    await ctx.emit({
      type: 'socialcontent.work.asked',
      entityType: 'socialcontent_work',
      payload: { asked, askedFor, kinds: [...new Set(asks.map((a) => a.kind))] },
    });
  return asked;
}

/** Where a creator's posts are read back to: 12 months the first time, else 60 days before the last read. */
export function readSince(postsReadAt: Date | null, now: Date): Date {
  const back = new Date(now.getTime() - READ_BACK_DAYS * 86_400_000);
  if (!postsReadAt) return back;
  const again = new Date(postsReadAt.getTime() - REREAD_DAYS * 86_400_000);
  return again > back ? again : back;
}

/** Refuses a network the extension doesn't read yet. */
export function needReady(network: ContentNetwork): void {
  if (!CONTENT_NETWORK_INFO[network].ready)
    throw HfosError.rule(
      'socialcontent_network_not_ready',
      409,
      `HandsFreeOS can’t read ${networkName(network)} yet. It comes in a later update, after ${READY_NETWORKS.map(networkName).join(', ')}.`,
    );
}
