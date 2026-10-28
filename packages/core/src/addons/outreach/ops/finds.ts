/**
 * People found by topic on Instagram, LinkedIn and Alignable (../finds.ts, docs/outreach.md decision 92), server side:
 * which good posts' likers and commenters the person's computer reads next, what it read of them, of a search and of a
 * group's members, who it checks next, and the day's searches of Alignable's businesses. Each person's own; nobody goes
 * in Contacts, and never in `engagements`.
 *
 * - **Only from good posts** (`outreach.posts.people_next`): the person's own, the AI called good, seen in the last
 *   week; those asking for what the business offers first, then the busiest, then the newest. A good post's writer is
 *   found by the AI's check of the post itself (`findWriter`, from ./posts.ts).
 * - **Nobody known or reached already is kept** (`keepFind`): the person, a post's writer among its people, a friend or
 *   anyone asked either way, a customer or client, anyone left alone or running a group, anyone who says a playbook's
 *   skip word, and anyone the country setting skips by where they are.
 * - **Nobody new is read while 3 days of checks wait** (`findsWaitingMost`): saves stop there, and no posts or searches
 *   are given out.
 * - **Each is checked by the AI from their own page** (`outreach.finds.next`, then `outreach.check.look` as for anyone):
 *   the network's found checks a day (`perDayFor`), and none while the good fits waiting for their like are 2 days of
 *   the network's likes or more (`likesBehind`).
 */
import { eq, sql } from 'drizzle-orm';
import { rows } from '@hfos/db/client';
import { HfosError } from '../../../errors';
import { requireHuman } from '../../../kernel/actor';
import { changeMoment } from '../../../kernel/moment';
import type { CommandContext } from '../../../kernel/types';
import { defineAddonCommand, defineAddonQuery } from '../../server';
import { countryOfPlace, linesCountry, type CountryRule } from '../countries';
import {
  eachSearchOnce,
  FIND_HOW_KEYS,
  FindsNextInput,
  FindsNextOutput,
  FindsSaveInput,
  FindsSaveOutput,
  FindsSearchesInput,
  FindsSearchesOutput,
  findsWaitingMost,
  PostsPeopleNextInput,
  PostsPeopleNextOutput,
  skipWordIn,
  type FindHow,
} from '../finds';
import { outreachAddon } from '../manifest';
import { NETWORKS, type Platform } from '../networks';
import {
  FIND_WORDS_PARTS,
  FIND_WORDS_PER_DAY,
  ownWordsOn,
  type FindWordsPart,
  type PlaybookDetails,
  type WordsPlatform,
} from '../playbooks';
import { dayNumber, inTurn, POST_FRESH_DAYS } from '../posts';
import { posts, profiles } from '../tables';
import { keepGroup } from './activity';
import {
  findsWaiting,
  findToCheck,
  likesBehind,
  myOwnProfile,
  perDayFor,
  stillToReach,
} from './checks';
import {
  countryFateSql,
  countryRuleOf,
  inWorkspace,
  keepCountry,
  keptProfile,
  once,
  type Ctx,
} from './common';
import { playbooksInUse } from './friends';
import { findsByTopic } from './live';
import { startOfToday } from './tidy';

const DAY = 86_400_000;
const ago = (now: number, days: number) => new Date(now - days * DAY).toISOString();

/**
 * A post whose people are read: one the AI called good, or an account like the business's own whatever it called it
 * (decision 110).
 */
const peopleReadOf = (alias: string) =>
  sql.raw(`(${alias}.check_state = 'good' or ${alias}.found = 'account')`);

/** How someone was found, strongest first, as the database orders them. */
const HOW_ORDER = `{${FIND_HOW_KEYS.join(',')}}`;

/** What became of someone found: kept new to check, found again, or left out. */
export type FindKept = 'added' | 'again' | 'left';

/** A find as it's kept (decision 92). */
interface FindRow {
  readonly me: string;
  readonly profileId: string;
  readonly platform: Platform;
  readonly how: FindHow;
  readonly postId: string | null;
  readonly groupId: string | null;
  readonly words: string | null;
  readonly place: string | null;
  readonly said: string | null;
  readonly at: Date;
}

/**
 * Keeps someone found by topic as the person's own find (decision 92), unless they're left out: the person, a friend or
 * anyone asked either way, in Contacts or a client, left alone (Don't pitch, Never contact, a partner, not a fit),
 * running a group, or skipped by the country setting by where they are. Found again, `found_at` moves on, and how they
 * were found (with its post, group, words and place) changes only to a way as strong or stronger; what a commenter
 * said is the latest, kept with when (`said_at`, which the daily sweep goes by, so being found again never keeps it
 * longer). Once the AI's check of them has answered, nothing reads it any more, so it isn't kept at all. Someone new is
 * kept only while `mayAdd`: the finds waiting for a check are under the cap.
 */
export async function keepFind(
  ctx: CommandContext,
  find: FindRow,
  rule: CountryRule,
  mayAdd: boolean,
): Promise<FindKept> {
  const ws = ctx.scope.workspaceId!;
  const [seen] = await rows<{ out: boolean; had: boolean; answered: boolean }>(
    ctx.tx,
    sql`select (not ${stillToReach(find.me)} or ${countryFateSql(rule, 'p')} = 'skip') as out,
          exists (select 1 from addon_outreach.finds f
            where f.workspace_id = p.workspace_id and f.user_id = ${find.me} and f.profile_id = p.id) as had,
          exists (select 1 from addon_outreach.checks ch
            where ch.profile_id = p.id and ch.user_id = ${find.me}
              and ch.verdict in ('good', 'maybe', 'not')) as answered
        from addon_outreach.profiles p where p.workspace_id = ${ws} and p.id = ${find.profileId}`,
  );
  if (!seen || seen.out || (!seen.had && !mayAdd)) return 'left';
  const at = find.at.toISOString();
  const said = seen.answered ? null : find.said;
  // As strong as the way kept, or stronger: it takes the post, group, words and place it came with.
  const stronger = sql`array_position(${HOW_ORDER}::text[], excluded.how)
    <= array_position(${HOW_ORDER}::text[], finds.how)`;
  const [kept] = await rows<{ added: boolean }>(
    ctx.tx,
    sql`insert into addon_outreach.finds
          (workspace_id, user_id, profile_id, platform, how, post_id, group_id, words, place, said, said_at,
            found_at)
        values (${ws}, ${find.me}, ${find.profileId}, ${find.platform}, ${find.how}, ${find.postId},
          ${find.groupId}, ${find.words}, ${find.place}, ${said},
          ${said === null ? null : at}::timestamptz, ${at}::timestamptz)
        on conflict (workspace_id, user_id, profile_id) do update set
          how = case when ${stronger} then excluded.how else finds.how end,
          post_id = case when ${stronger} then excluded.post_id else finds.post_id end,
          group_id = case when ${stronger} then excluded.group_id else finds.group_id end,
          words = case when ${stronger} then excluded.words else finds.words end,
          place = case when ${stronger} then excluded.place else finds.place end,
          said = case when ${seen.answered}::boolean then null else coalesce(excluded.said, finds.said) end,
          said_at = case when ${seen.answered}::boolean then null
            when excluded.said is not null then excluded.said_at else finds.said_at end,
          found_at = greatest(finds.found_at, excluded.found_at),
          updated_at = excluded.found_at
        returning (xmax = 0) as added`,
  );
  return kept?.added ? 'added' : 'again';
}

/**
 * The writer of a post the AI just called good, found on a network that checks people found (decision 92): kept as
 * the post's own find (`posted`, with its hashtag or phrase and its group), with the same leave-outs as anyone found.
 * The best of the finds, so the cap on finds waiting never holds a writer back. Null on a network that weighs people
 * by the words they show (Facebook's), and for someone whose computer runs an older build (`findsByTopic`): it never
 * checks them, so they stay the old search pick's, as decision 92's 18 keeps it.
 */
export async function findWriter(
  ctx: CommandContext,
  post: typeof posts.$inferSelect,
  at: Date,
): Promise<FindKept | null> {
  // An account like the business's (decision 110) is read for its people, never found itself.
  if (post.found === 'account') return null;
  const [author] = await ctx.tx.select().from(profiles).where(eq(profiles.id, post.profileId));
  if (!author || NETWORKS[author.platform].foundChecksPerDay === null) return null;
  if (!(await findsByTopic(ctx, post.userId))) return null;
  if (skipWordIn(await playbooksInUse(ctx, author.platform), author.intro)) return 'left';
  return keepFind(
    ctx,
    {
      me: post.userId,
      profileId: author.id,
      platform: author.platform,
      how: 'posted',
      postId: post.id,
      groupId: post.groupId,
      words: post.words,
      place: null,
      said: null,
      at,
    },
    await countryRuleOf(ctx),
    true,
  );
}

/** Whether the finds waiting for the AI's check on a network are at the cap: 3 days of its found checks. */
async function findsFull(ctx: Ctx, me: string, platform: Platform, now: number): Promise<boolean> {
  const most = findsWaitingMost(NETWORKS[platform].foundChecksPerDay ?? 0);
  return (await findsWaiting(ctx, me, platform, now)) >= most;
}

export const findsSave = defineAddonCommand(outreachAddon, {
  name: 'outreach.finds.save',
  description:
    'People found by topic on Instagram, LinkedIn or Alignable, as the person’s computer read them: who liked or commented on a good post its search found, or on an Instagram account like yours’s post (that post’s people are then read), the businesses a search of Alignable showed, a group’s members, the hosts and guests of an Alignable event near them, or an account like yours’s followers. Each one new is kept, the person’s own, for the AI to check from their own page; nobody goes in Contacts. Leaves out the person, the post’s writer, friends and anyone asked either way, customers and clients, anyone on Don’t pitch or Never contact or running a group, anyone who says a playbook’s skip word, and anyone the country setting skips by where they are; and stops once 3 days of checks wait.',
  risk: 1,
  input: FindsSaveInput,
  output: FindsSaveOutput,
  permission: 'outreach.use',
  scope: inWorkspace,
  emits: ['outreach.finds.saved'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const at = changeMoment(ctx.meta);
    const kit = NETWORKS[input.platform];
    const perDay = kit.foundChecksPerDay;
    if (perDay === null)
      throw HfosError.rule(
        'outreach_finds_off',
        409,
        `${kit.name} doesn’t check people found by topic: the people in its groups are weighed by what they show. Update the extension, then start your day again.`,
      );
    return once(async () => {
      // The good post whose people these are: the person's own on this network, kept in the last week.
      const post = input.postId
        ? (
            await rows<{
              id: string;
              profile_id: string;
              group_id: string | null;
              words: string | null;
            }>(
              ctx.tx,
              sql`select po.id, po.profile_id, po.group_id, po.words from addon_outreach.posts po
                  join addon_outreach.profiles a on a.id = po.profile_id
                  where po.workspace_id = ${ws} and po.id = ${input.postId} and po.user_id = ${me}
                    and a.platform = ${input.platform} and ${peopleReadOf('po')} and po.skipped_at is null
                    and po.seen_at >= ${ago(at.getTime(), POST_FRESH_DAYS)}::timestamptz
                  for update of po`,
            )
          )[0]
        : null;
      if (input.postId && !post)
        throw HfosError.rule(
          'outreach_find_post',
          404,
          'That post isn’t one HandsFreeOS kept for you any more. It reads a post’s people only from good posts its search found in the last week.',
        );
      // Its people are read now, found or not: each good post's are read once.
      if (post) await ctx.tx.update(posts).set({ peopleReadAt: at }).where(eq(posts.id, post.id));
      const groupId = input.group
        ? await keepGroup(ctx, input.platform, input.group)
        : (post?.group_id ?? null);
      const words = post ? post.words : input.words;
      const playbooks = await playbooksInUse(ctx, input.platform);
      const rule = await countryRuleOf(ctx);
      // Up to 3 days of checks may wait: past it, nobody new is kept.
      let room = Math.max(
        0,
        findsWaitingMost(perDay) - (await findsWaiting(ctx, me, input.platform, at.getTime())),
      );
      const seen = new Set<string>();
      let added = 0;
      let skipped = 0;
      for (const person of input.people) {
        const key = person.profile.id ?? person.profile.username ?? person.profile.url;
        if (seen.has(key)) continue;
        seen.add(key);
        const lines = [...person.lines];
        if (person.place && !lines.includes(person.place)) lines.push(person.place);
        const profile = await keptProfile(
          ctx,
          { platform: input.platform, profile: person.profile, name: person.name },
          me,
          at,
          { intro: lines },
          // What a list shows of someone kept already only fills in what their profile hasn't said.
          (had) => (had.intro.length ? {} : { intro: lines }),
        );
        if (profile.id === post?.profile_id || skipWordIn(playbooks, lines)) {
          skipped++;
          continue;
        }
        // Where a search's result or a member says they are (decision 61): an address names their country, and one
        // outside the business's is skipped. Anyone with no place is looked at by their check.
        const where = person.place ? countryOfPlace(person.place) : null;
        const lined = where ? { country: where, how: 'seen' as const } : linesCountry(lines);
        if (lined) await keepCountry(ctx, profile.id, lined);
        const kept = await keepFind(
          ctx,
          {
            me,
            profileId: profile.id,
            platform: input.platform,
            how: input.how,
            postId: post?.id ?? null,
            groupId,
            words,
            place: input.place,
            said: input.how === 'commented' ? person.said : null,
            at,
          },
          rule,
          room > 0,
        );
        if (kept === 'added') {
          added++;
          room--;
        } else if (kept === 'left') skipped++;
      }
      if (added)
        await ctx.emit({
          type: 'outreach.finds.saved',
          entityType: 'workspace',
          entityId: ws,
          payload: { platform: input.platform, how: input.how, added },
        });
      return { added, skipped };
    });
  },
});

export const postsPeopleNext = defineAddonQuery(outreachAddon, {
  name: 'outreach.posts.people_next',
  description:
    'Which good posts the person’s computer reads next for who liked and commented on them, on a network that reads them (Instagram’s and LinkedIn’s): their own, the AI called good or by an Instagram account like yours, seen in the last week, not put aside, not read yet and not showing none; those asking for what the business offers first, then the busiest, then the newest; no more than the day’s, and none while 3 days of checks of people found wait.',
  input: PostsPeopleNextInput,
  output: PostsPeopleNextOutput,
  permission: 'outreach.use',
  scope: inWorkspace,
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const now = Date.now();
    const perDay = NETWORKS[input.platform].postPeoplePerDay ?? 0;
    if (!perDay) return { posts: [], today: 0, perDay: 0 };
    const todayStart = await startOfToday(ctx, now);
    const [done] = await rows<{ n: number }>(
      ctx.tx,
      sql`select count(*)::int as n from addon_outreach.posts po
          join addon_outreach.profiles a on a.id = po.profile_id
          where po.workspace_id = ${ws} and po.user_id = ${me} and a.platform = ${input.platform}
            and po.people_read_at >= ${todayStart.toISOString()}::timestamptz`,
    );
    const today = done?.n ?? 0;
    const room = Math.max(0, perDay - today);
    if (!room || (await findsFull(ctx, me, input.platform, now)))
      return { posts: [], today, perDay };
    const found = await rows<{
      id: string;
      url: string;
      name: string;
      profile_url: string;
      words: string | null;
      strong: boolean;
      comments: number | null;
      reactions: number | null;
    }>(
      ctx.tx,
      sql`select po.id, po.url, a.name, a.url as profile_url, po.words, po.strong, po.comments, po.reactions
          from addon_outreach.posts po
          join addon_outreach.profiles a on a.id = po.profile_id
          where po.workspace_id = ${ws} and po.user_id = ${me} and a.platform = ${input.platform}
            and ${peopleReadOf('po')} and po.people_read_at is null and po.skipped_at is null
            and po.seen_at >= ${ago(now, POST_FRESH_DAYS)}::timestamptz and not ${myOwnProfile(me, 'a')}
            -- A post that shows no comments and no likes has nobody to read; one whose counts weren't read may.
            and (coalesce(po.comments, 1) > 0 or coalesce(po.reactions, 1) > 0)
          order by po.strong desc, coalesce(po.comments, 0) + coalesce(po.reactions, 0) desc,
            po.seen_at desc, po.id
          limit ${room}`,
    );
    return {
      posts: found.map((p) => ({
        postId: p.id,
        url: p.url,
        name: p.name,
        profileUrl: p.profile_url,
        words: p.words,
        strong: p.strong,
        comments: p.comments,
        reactions: p.reactions,
      })),
      today,
      perDay,
    };
  },
});

export const findsNext = defineAddonQuery(outreachAddon, {
  name: 'outreach.finds.next',
  description:
    'Who of the people found by topic on a network the person’s computer checks next for whether they fit a playbook, in order and no more than today has room for: those who wrote a good post first, then who commented on one, liked one, are in a group and a search showed; a post asking for what the business offers first, then the newest. Only people found in the last two weeks, not checked yet (or not read a week ago), and still to reach; none while the good fits waiting for their like are 2 days of likes or more.',
  input: FindsNextInput,
  output: FindsNextOutput,
  permission: 'outreach.use',
  scope: inWorkspace,
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const now = Date.now();
    const { found: day } = await perDayFor(ctx, me, now, input.platform);
    const { today, perDay } = day;
    const room = Math.min(input.most, day.room);
    if (!room || (await likesBehind(ctx, me, input.platform, now)))
      return { people: [], today, perDay };
    const found = await rows<{
      id: string;
      name: string;
      url: string;
      how: FindHow;
      words: string | null;
      post_url: string | null;
    }>(
      ctx.tx,
      sql`select p.id, p.name, p.url, f.how, f.words, po.url as post_url
          from addon_outreach.finds f
          join addon_outreach.profiles p on p.id = f.profile_id
          left join addon_outreach.checks ch on ch.profile_id = p.id and ch.user_id = ${me}
          left join addon_outreach.posts po on po.id = f.post_id
          where f.workspace_id = ${ws}
            and ${findToCheck(me, input.platform, await countryRuleOf(ctx), now)}
          order by array_position(${HOW_ORDER}::text[], f.how), coalesce(po.strong, false) desc,
            f.found_at desc, f.id
          limit ${room}`,
    );
    return {
      people: found.map((p) => ({
        profileId: p.id,
        name: p.name,
        url: p.url,
        how: p.how,
        words: p.words,
        postUrl: p.post_url,
      })),
      today,
      perDay,
    };
  },
});

/**
 * The searches of a network's businesses (Alignable's) its playbooks give, before the day's turn: each kind of business
 * with whether its own playbook works with clients online, so it searches anywhere rather than the person's town. A
 * kind a local playbook and an online one share is searched both ways (`eachSearchOnce`).
 */
export function kindSearches(
  playbooks: readonly {
    readonly details: Partial<
      Pick<PlaybookDetails, FindWordsPart | 'wordsWritten' | 'worksOnline'>
    >;
  }[],
  platform: Platform,
): { words: string; anywhere: boolean }[] {
  return eachSearchOnce(
    playbooks.flatMap((p) =>
      (ownWordsOn(p.details, platform, 'businessKinds') ?? []).flatMap((kind) => {
        const words = kind.replace(/\s+/g, ' ').trim();
        return words ? [{ words, anywhere: p.details.worksOnline === true }] : [];
      }),
    ),
  );
}

export const findsSearches = defineAddonQuery(outreachAddon, {
  name: 'outreach.finds.searches',
  description:
    'The searches of a network’s businesses (Alignable’s) the person’s computer does today to find people by topic: the kinds of business the customers’ playbooks there say their clients run, 3 a day in turn, each with whether its playbook works with clients online, so it searches anywhere rather than the person’s own town. None until a playbook has kinds of business, nor while 3 days of checks of people found wait.',
  input: FindsSearchesInput,
  output: FindsSearchesOutput,
  permission: 'outreach.use',
  scope: inWorkspace,
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const now = Date.now();
    const part = (FIND_WORDS_PARTS as Partial<Record<Platform, FindWordsPart>>)[input.platform];
    if (part !== 'businessKinds' || NETWORKS[input.platform].foundChecksPerDay === null)
      return { searches: [] };
    if (await findsFull(ctx, me, input.platform, now)) return { searches: [] };
    const pool = kindSearches(await playbooksInUse(ctx, input.platform), input.platform);
    const perDay = FIND_WORDS_PER_DAY[input.platform as WordsPlatform];
    return { searches: inTurn(pool, perDay, dayNumber(now)) };
  },
});

export const findCommands = [findsSave] as const;
export const findQueries = [postsPeopleNext, findsNext, findsSearches] as const;
