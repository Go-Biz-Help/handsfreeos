/**
 * Instagram accounts like yours (../like-yours.ts, docs/outreach.md decision 110), server side: the business's list in
 * Settings → Instagram, with Add and Remove for owners and admins; what the person's computer does next for them (a
 * search for more, or the one to read today); the accounts a search showed, kept for the AI to look at; the AI's
 * picks (the worker's); and an account read. The business's own, shared by its team. Server-only.
 */
import { and, asc, eq, sql } from 'drizzle-orm';
import { rows } from '@hfos/db/client';
import { HfosError } from '../../../errors';
import { requireHuman } from '../../../kernel/actor';
import { scopeCan } from '../../../kernel/execute';
import { changeMoment } from '../../../kernel/moment';
import type { CommandContext, QueryContext } from '../../../kernel/types';
import type { Permission } from '../../../permissions';
import { defineAddonCommand, defineAddonQuery } from '../../server';
import {
  instagramAccountUrl,
  LIKE_YOURS_MOST,
  LIKE_YOURS_SEARCH_DAYS,
  LIKE_YOURS_WORDS,
  LikeYoursAddInput,
  LikeYoursChangeOutput,
  likeYoursSearches,
  LikeYoursFoundInput,
  LikeYoursFoundOutput,
  LikeYoursListInput,
  LikeYoursListOutput,
  LikeYoursNextInput,
  LikeYoursNextOutput,
  LikeYoursPickInput,
  LikeYoursPickOutput,
  LikeYoursReadInput,
  LikeYoursReadOutput,
  LikeYoursRemoveInput,
  usernameOf,
  type LikeYoursAccount,
} from '../like-yours';
import { outreachAddon } from '../manifest';
import { likeYours } from '../tables';
import { inWorkspace } from './common';
import { playbooksInUse } from './friends';

const DAY = 86_400_000;
type Ctx = CommandContext | QueryContext;

const shown = (r: typeof likeYours.$inferSelect): LikeYoursAccount => ({
  id: r.id,
  username: r.username,
  url: instagramAccountUrl(r.username),
  name: r.name,
  why: r.why,
  addedBy: r.addedByUserId ? 'person' : 'ai',
  readAt: r.readAt ? new Date(r.readAt).toISOString() : null,
});

/** The business's kept accounts like yours, the first added first. */
async function keptAccounts(ctx: Ctx): Promise<(typeof likeYours.$inferSelect)[]> {
  return ctx.tx
    .select()
    .from(likeYours)
    .where(
      and(
        eq(likeYours.workspaceId, ctx.scope.workspaceId!),
        eq(likeYours.platform, 'instagram'),
        eq(likeYours.state, 'kept'),
      ),
    )
    .orderBy(asc(likeYours.createdAt), asc(likeYours.id));
}

const listed = async (ctx: Ctx) => ({ accounts: (await keptAccounts(ctx)).map(shown) });

async function changed(ctx: CommandContext, id: string, state: string): Promise<void> {
  await ctx.emit({
    type: 'outreach.like_yours.changed',
    entityType: 'workspace',
    entityId: ctx.scope.workspaceId!,
    payload: { id, state },
  });
}

export const likeYoursList = defineAddonQuery(outreachAddon, {
  name: 'outreach.like_yours.list',
  description:
    'The business’s Instagram accounts like yours (up to 5): accounts whose followers are its kind of customer, like the chamber of commerce, a venue or a business with the same customers, each with who added it (the AI or the team), why, and when the person’s computer last read it. Each day one is read: who commented on its latest posts and some of its followers, each checked by the AI before anything is done.',
  input: LikeYoursListInput,
  output: LikeYoursListOutput,
  permission: 'outreach.use',
  ai: {
    tool: 'outreach_list_accounts_like_yours',
    keywords: [
      'accounts like yours',
      'instagram accounts like mine',
      'chamber of commerce account',
    ],
  },
  scope: inWorkspace,
  async handler(ctx) {
    return {
      ...(await listed(ctx)),
      most: LIKE_YOURS_MOST,
      canManage: scopeCan(ctx.scope, 'outreach.manage' as Permission),
    };
  },
});

export const likeYoursAdd = defineAddonCommand(outreachAddon, {
  name: 'outreach.like_yours.add',
  description:
    'Add an Instagram account like yours, by its username or address: one whose followers are the business’s kind of customer (its chamber of commerce, a venue, a business with the same customers). Up to 5; one removed before comes back. Owners and admins.',
  risk: 1,
  input: LikeYoursAddInput,
  output: LikeYoursChangeOutput,
  permission: 'outreach.manage',
  ai: {
    tool: 'outreach_add_account_like_yours',
    keywords: ['add account like yours', 'add instagram account to read'],
  },
  scope: inWorkspace,
  emits: ['outreach.like_yours.changed'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const at = changeMoment(ctx.meta);
    const username = usernameOf(input.account);
    if (!username)
      throw HfosError.rule(
        'outreach_like_yours_username',
        422,
        `“${input.account.slice(0, 60)}” isn’t an Instagram username. Type it as Instagram shows it, like @austinchamber, or paste the account’s address.`,
      );
    const kept = await keptAccounts(ctx);
    if (kept.some((a) => a.username === username)) return listed(ctx);
    if (kept.length >= LIKE_YOURS_MOST)
      throw HfosError.rule('outreach_like_yours_full', 409, LIKE_YOURS_WORDS.full);
    const [row] = await rows<{ id: string }>(
      ctx.tx,
      sql`insert into addon_outreach.like_yours
            (workspace_id, platform, username, state, added_by_user_id, found_at)
          values (${ws}, 'instagram', ${username}, 'kept', ${me}, ${at.toISOString()}::timestamptz)
          on conflict (workspace_id, platform, username) do update set
            state = 'kept', added_by_user_id = excluded.added_by_user_id, why = null,
            updated_at = excluded.found_at
          returning id`,
    );
    await changed(ctx, row!.id, 'kept');
    return listed(ctx);
  },
});

export const likeYoursRemove = defineAddonCommand(outreachAddon, {
  name: 'outreach.like_yours.remove',
  description:
    'Remove an Instagram account like yours from the list, so it isn’t read any more and the AI never picks it again. The people already found from it stay. Owners and admins.',
  risk: 1,
  input: LikeYoursRemoveInput,
  output: LikeYoursChangeOutput,
  permission: 'outreach.manage',
  ai: {
    tool: 'outreach_remove_account_like_yours',
    keywords: ['remove account like yours', 'stop reading instagram account'],
  },
  scope: inWorkspace,
  emits: ['outreach.like_yours.changed'],
  async handler(ctx, input) {
    const [row] = await ctx.tx
      .update(likeYours)
      .set({ state: 'removed', updatedAt: changeMoment(ctx.meta) })
      .where(
        and(
          eq(likeYours.workspaceId, ctx.scope.workspaceId!),
          eq(likeYours.id, input.id),
          eq(likeYours.state, 'kept'),
        ),
      )
      .returning({ id: likeYours.id });
    if (!row)
      throw HfosError.notFound(
        'That account isn’t on your accounts like yours any more. Refresh Settings → Instagram to see the list.',
      );
    await changed(ctx, row.id, 'removed');
    return listed(ctx);
  },
});

export const likeYoursNext = defineAddonQuery(outreachAddon, {
  name: 'outreach.like_yours.next',
  description:
    'What the person’s computer does next for the business’s Instagram accounts like yours: the words to search Instagram’s accounts with (from the playbooks’ area, niche and kinds of business), while fewer than 5 are kept and none were looked for this week; and the kept account to read today, the one read longest ago first.',
  input: LikeYoursNextInput,
  output: LikeYoursNextOutput,
  permission: 'outreach.use',
  scope: inWorkspace,
  async handler(ctx) {
    const ws = ctx.scope.workspaceId!;
    const kept = await keptAccounts(ctx);
    const next = [...kept].sort(
      (a, b) =>
        (a.readAt ? new Date(a.readAt).getTime() : 0) -
          (b.readAt ? new Date(b.readAt).getTime() : 0) ||
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    )[0];
    let searches: string[] = [];
    if (kept.length < LIKE_YOURS_MOST) {
      // The last search's accounts (none a person added) say when it was: about once a week.
      const [last] = await rows<{ at: Date | string | null; waiting: number }>(
        ctx.tx,
        sql`select max(found_at) filter (where added_by_user_id is null) as at,
              count(*) filter (where state = 'candidate')::int as waiting
            from addon_outreach.like_yours where workspace_id = ${ws} and platform = 'instagram'`,
      );
      const since = last?.at ? Date.now() - new Date(last.at).getTime() : Infinity;
      if (!last?.waiting && since >= LIKE_YOURS_SEARCH_DAYS * DAY)
        searches = likeYoursSearches(await playbooksInUse(ctx, 'instagram'));
    }
    return {
      searches,
      account: next
        ? { id: next.id, username: next.username, url: instagramAccountUrl(next.username) }
        : null,
    };
  },
});

export const likeYoursFound = defineAddonCommand(outreachAddon, {
  name: 'outreach.like_yours.found',
  description:
    'The accounts the person’s computer found with Instagram’s search for accounts like yours: each new one waits for the AI to pick the best, up to 5 kept. Never the person’s own account, and never one kept, passed over or removed already.',
  risk: 0,
  input: LikeYoursFoundInput,
  output: LikeYoursFoundOutput,
  permission: 'outreach.use',
  scope: inWorkspace,
  emits: ['outreach.like_yours.found'],
  async handler(ctx, input) {
    requireHuman(ctx);
    const ws = ctx.scope.workspaceId!;
    const at = changeMoment(ctx.meta).toISOString();
    // The person's own Instagram, as their profile check read it, is never an account like theirs.
    const own = new Set(
      (
        await rows<{ username: string | null }>(
          ctx.tx,
          sql`select lower(s.network_profiles -> 'instagram' -> 'check' -> 'seen' ->> 'username') as username
              from addon_outreach.setup s where s.workspace_id = ${ws}`,
        )
      ).flatMap((r) => (r.username ? [r.username] : [])),
    );
    let candidates = 0;
    const seen = new Set<string>();
    for (const a of input.accounts) {
      if (own.has(a.username) || seen.has(a.username)) continue;
      seen.add(a.username);
      const [row] = await rows<{ added: boolean }>(
        ctx.tx,
        sql`insert into addon_outreach.like_yours (workspace_id, platform, username, name, why, state, found_at)
            values (${ws}, 'instagram', ${a.username}, ${a.name}, ${a.words}, 'candidate', ${at}::timestamptz)
            on conflict (workspace_id, platform, username) do update set
              found_at = greatest(like_yours.found_at, excluded.found_at),
              name = coalesce(excluded.name, like_yours.name), updated_at = excluded.found_at
            returning (xmax = 0) as added`,
      );
      if (row?.added) candidates++;
    }
    const [waiting] = await rows<{ n: number }>(
      ctx.tx,
      sql`select count(*)::int as n from addon_outreach.like_yours
          where workspace_id = ${ws} and platform = 'instagram' and state = 'candidate'`,
    );
    if (waiting?.n)
      await ctx.emit({
        type: 'outreach.like_yours.found',
        entityType: 'workspace',
        entityId: ws,
        payload: { candidates: waiting.n },
      });
    return { candidates };
  },
});

export const likeYoursPick = defineAddonCommand(outreachAddon, {
  name: 'outreach.like_yours.pick',
  description:
    'Worker: the AI’s picks among the accounts an Instagram search found for accounts like yours, each with why, kept up to 5 in all; the rest it looked at are passed over and never offered again.',
  risk: 0,
  input: LikeYoursPickInput,
  output: LikeYoursPickOutput,
  permission: 'outreach.use',
  actors: ['system'],
  scope: inWorkspace,
  emits: ['outreach.like_yours.changed'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const at = changeMoment(ctx.meta);
    let room = LIKE_YOURS_MOST - (await keptAccounts(ctx)).length;
    let kept = 0;
    for (const pick of input.picks) {
      if (room <= 0) break;
      const [row] = await ctx.tx
        .update(likeYours)
        .set({ state: 'kept', why: pick.why, updatedAt: at })
        .where(
          and(
            eq(likeYours.workspaceId, ws),
            eq(likeYours.id, pick.id),
            eq(likeYours.state, 'candidate'),
          ),
        )
        .returning({ id: likeYours.id });
      if (!row) continue;
      room--;
      kept++;
      await changed(ctx, row.id, 'kept');
    }
    const picked = new Set(input.picks.map((p) => p.id));
    const passed = input.looked.filter((id) => !picked.has(id));
    if (passed.length)
      await ctx.tx.execute(
        sql`update addon_outreach.like_yours set state = 'passed', updated_at = ${at.toISOString()}::timestamptz
            where workspace_id = ${ws} and state = 'candidate'
              and id in (${sql.join(
                passed.map((id) => sql`${id}::uuid`),
                sql`, `,
              )})`,
      );
    return { kept };
  },
});

export const likeYoursRead = defineAddonCommand(outreachAddon, {
  name: 'outreach.like_yours.read',
  description:
    'The person’s computer read an Instagram account like yours today: its latest posts and a screen of its followers. The next one is read tomorrow.',
  risk: 0,
  input: LikeYoursReadInput,
  output: LikeYoursReadOutput,
  permission: 'outreach.use',
  scope: inWorkspace,
  emits: [],
  async handler(ctx, input) {
    requireHuman(ctx);
    const [row] = await ctx.tx
      .update(likeYours)
      .set({ readAt: changeMoment(ctx.meta) })
      .where(
        and(
          eq(likeYours.workspaceId, ctx.scope.workspaceId!),
          eq(likeYours.id, input.id),
          eq(likeYours.state, 'kept'),
        ),
      )
      .returning({ id: likeYours.id });
    if (!row)
      throw HfosError.notFound(
        'That account isn’t on your accounts like yours any more: someone removed it. The next one is read tomorrow.',
      );
    return { id: row.id };
  },
});

export const likeYoursCommands = [
  likeYoursAdd,
  likeYoursRemove,
  likeYoursFound,
  likeYoursPick,
  likeYoursRead,
] as const;
export const likeYoursQueries = [likeYoursList, likeYoursNext] as const;
