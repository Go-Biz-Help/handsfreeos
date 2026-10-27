/**
 * The fits among the person's friends and chats (../checks.ts, docs/outreach.md decision 46): who the extension checks
 * next, what their pages said as it read them, and what the AI made of it. Each person's own, like their chats; nobody
 * goes in Contacts. The Friends tab lists them (./friends.ts), and Today has the good fits to reconnect with
 * (./today.ts).
 *
 * The same checks read people found by topic on Instagram, LinkedIn and Alignable (decision 92, ./finds.ts): each look
 * says whether it was of someone known or found (`via`), for the day's counts; the readers about people the person
 * knows decide by who they know now (`knownCheck`), so someone found who becomes a friend shows there at once.
 */
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { rows, type Tx } from '@hfos/db/client';
import { HfosError } from '../../../errors';
import { requireHuman } from '../../../kernel/actor';
import { changeMoment } from '../../../kernel/moment';
import { defineAddonCommand, defineAddonQuery } from '../../server';
import {
  CHECK_AGAIN_DAYS,
  CHECK_RETRY_DAYS,
  CHECKS_PER_DAY,
  ChecksAgainInput,
  ChecksAgainOutput,
  CheckLookInput,
  CheckLookOutput,
  CheckSaveInput,
  CheckSaveOutput,
  ChecksNextInput,
  ChecksNextOutput,
  type CheckReason,
  type ChecksSummary,
  type CheckVerdict,
} from '../checks';
import { ASK_KEEP_DAYS } from '../asks';
import {
  countryRuleOn,
  linesCountry,
  lookedCountry,
  type CountryRule,
  type MutualCountries,
} from '../countries';
import { FIND_FRESH_DAYS, type CheckVia } from '../finds';
import { limitNow } from '../limits';
import { NETWORKS, type Platform } from '../networks';
import { outreachAddon } from '../manifest';
import { partnerReadsPerDay } from '../partners';
import { checks, finds, profiles } from '../tables';
import { automationOf } from './automation';
import {
  countryFateSql,
  countryRuleOf,
  inPlay,
  inWorkspace,
  keepCountry,
  pitchable,
  runsAGroup,
  waitsForLook,
  type Ctx,
} from './common';
import { slowsNow, startOfToday, warningOf } from './tidy';

const DAY = 86_400_000;

/** Someone the person knows: a friend of theirs, or someone they've chatted with that's kept as a profile. `p` is its alias. */
export const knowsThem = (
  me: string,
  p = 'p',
) => sql`(exists (select 1 from addon_outreach.friends f
    where f.profile_id = ${sql.raw(p)}.id and f.user_id = ${me} and f.state = 'friends')
  or exists (select 1 from addon_outreach.file_chats c where c.profile_id = ${sql.raw(p)}.id and c.user_id = ${me}))`;

/**
 * The people there are to check: the person's friends, and anyone they've chatted with that's kept as a profile;
 * never on Don't pitch or tagged Friend or family, and never themselves. `p` is the profile.
 */
export const knownToMe = (me: string) =>
  sql`p.friendship <> 'self' and ${pitchable('p')} and ${knowsThem(me)}`;

/**
 * A check of someone the person knows, decided now (decision 92), for the readers about them: Reconnect, the Friends
 * tab, Check everyone again and how far the checks have come. Either the look was of someone known (a Research press
 * counts), or the person found by topic has since become a friend or chatted, and shows there at once. A check of
 * someone found and not known yet is theirs alone: Today's found people. `ch` is the check, `p` its profile.
 */
export const knownCheck = (me: string) => sql`(ch.via = 'known' or ${knowsThem(me)})`;

/** Someone the person found by topic (decision 92) and doesn't know: a find of theirs, and no friend or chat. `p` is the profile. */
export const foundNotKnown = (me: string) => sql`(exists (select 1 from addon_outreach.finds fd
    where fd.profile_id = p.id and fd.user_id = ${me}) and not ${knowsThem(me)})`;

/**
 * Someone found by topic who's still someone to reach (decision 92): not the person, a friend or anyone asked either
 * way, in Contacts or a client, left alone (Don't pitch, Never contact, a partner, not a fit) or running a group. `p` is
 * the profile.
 */
export const stillToReach = (
  me: string,
) => sql`(p.friendship not in ('self', 'friends', 'request_sent', 'request_received')
  and p.person_id is null and ${pitchable('p')} and ${inPlay(me, 'p')} and not ${runsAGroup('p')}
  and not exists (select 1 from addon_outreach.friends fr where fr.profile_id = p.id and fr.user_id = ${me}
    and fr.state in ('friends', 'request_sent', 'request_received'))
  and not exists (select 1 from addon_outreach.touches t where t.profile_id = p.id and t.user_id = ${me}
    and t.kind = 'friend_request'))`;

/**
 * A find of the person's on a network waiting for the AI's check (decision 92): found in the last 14 days, not checked
 * by them yet (or a look that couldn't read them a week ago), still someone to reach, and not skipped by the business's
 * country setting: someone with no place is looked at, and the check's look says where. `f` is the find, `p` its
 * profile and `ch` the person's check of them, left joined.
 */
export function findToCheck(me: string, platform: Platform, rule: CountryRule, now: number) {
  const ago = (days: number) => new Date(now - days * DAY).toISOString();
  return sql`(f.user_id = ${me} and f.platform = ${platform}
    and f.found_at >= ${ago(FIND_FRESH_DAYS)}::timestamptz
    and (ch.id is null or (ch.verdict = 'failed' and ch.looked_at < ${ago(CHECK_RETRY_DAYS)}::timestamptz))
    and ${stillToReach(me)} and ${countryFateSql(rule, 'p')} <> 'skip')`;
}

/** How many of the person's finds on a network wait for the AI's check (`findToCheck`). */
export async function findsWaiting(
  ctx: Ctx,
  me: string,
  platform: Platform,
  now: number,
): Promise<number> {
  const [n] = await rows<{ n: number }>(
    ctx.tx,
    sql`select count(*)::int as n from addon_outreach.finds f
        join addon_outreach.profiles p on p.id = f.profile_id
        left join addon_outreach.checks ch on ch.profile_id = p.id and ch.user_id = ${me}
        where f.workspace_id = ${ctx.scope.workspaceId!}
          and ${findToCheck(me, platform, await countryRuleOf(ctx), now)}`,
  );
  return n?.n ?? 0;
}

/**
 * The profiles the person's computer read today on a network for the AI: for its checks of who fits, of someone found
 * by topic (decision 92, counted by the look's `via`), and of who could partner (./partners.ts). All count toward the
 * network's profiles read a day; found people's only where they share them (`foundShareReads`).
 */
export async function readToday(
  ctx: Ctx,
  me: string,
  platform: Platform,
  todayStart: Date,
): Promise<{ checks: number; partners: number; found: number }> {
  const ws = ctx.scope.workspaceId!;
  const since = todayStart.toISOString();
  const [done] = await rows<{ checks: number; partners: number; found: number }>(
    ctx.tx,
    sql`select
          (select count(*) filter (where ch.via = 'known')::int from addon_outreach.checks ch
            join addon_outreach.profiles p on p.id = ch.profile_id
            where ch.workspace_id = ${ws} and ch.user_id = ${me} and p.platform = ${platform}
              and ch.looked_at >= ${since}::timestamptz) as checks,
          (select count(*)::int from addon_outreach.checks ch
            join addon_outreach.profiles p on p.id = ch.profile_id
            where ch.workspace_id = ${ws} and ch.user_id = ${me} and ch.via = 'found'
              and p.platform = ${platform} and ch.looked_at >= ${since}::timestamptz) as found,
          (select count(*)::int from addon_outreach.partners pa
            join addon_outreach.profiles p on p.id = pa.profile_id
            where pa.workspace_id = ${ws} and pa.user_id = ${me} and p.platform = ${platform}
              and pa.looked_at >= ${since}::timestamptz) as partners`,
  );
  return { checks: done?.checks ?? 0, partners: done?.partners ?? 0, found: done?.found ?? 0 };
}

/** The network's profiles read a day (`checksPerDay`), halved for a week after a warning there. */
export const readsPerDay = (platform: Platform, slower: boolean) =>
  limitNow(Math.min(CHECKS_PER_DAY, NETWORKS[platform].checksPerDay), slower);

/** A day's reads of one kind on a network: how many today, how many a day now, and how many more today has room for. */
export interface DayReads {
  readonly today: number;
  readonly perDay: number;
  readonly room: number;
}

/**
 * How many profiles the person's computer reads a day on a network now, and how many more today, for each kind of
 * read. Another network's reads and warnings never count.
 *
 * - **Checks** of people they know: the network's profiles read a day (`checksPerDay`), halved for a week after a
 *   warning there; today's partner reads count too.
 * - **Partners**: at most half of those (`partnerReadsPerDay`), inside what the checks leave (./partners.ts).
 * - **Found** people (decision 92): the network's own a day (`foundChecksPerDay`), halved on training wheels there too
 *   and for a week after a warning, never below 1, beside the profiles read. Where they share them instead
 *   (`foundShareReads`, LinkedIn's settled 40), found people go first: up to their day's, inside the profiles read, the
 *   found checks still to come today hold their part (as many as wait), and the checks and partner reads take what's
 *   left. The network's limit never grows.
 */
export async function perDayFor(
  ctx: Ctx,
  me: string,
  now: number,
  platform: Platform = 'facebook',
): Promise<{ checks: DayReads; partners: DayReads; found: DayReads }> {
  const todayStart = await startOfToday(ctx, now);
  const warned = slowsNow(await warningOf(ctx, me, platform, todayStart, now), now);
  const read = await readToday(ctx, me, platform, todayStart);
  const reads = readsPerDay(platform, warned);
  const kit = NETWORKS[platform];
  const shared = kit.foundShareReads;
  const used = read.checks + read.partners + (shared ? read.found : 0);
  const left = Math.max(0, reads - used);
  let found: DayReads = { today: read.found, perDay: 0, room: 0 };
  let held = 0;
  if (kit.foundChecksPerDay !== null) {
    const slower = warned || (await automationOf(ctx, me, now, platform)).wheels.on;
    const most = limitNow(kit.foundChecksPerDay, slower);
    const perDay = shared ? Math.min(most, reads) : most;
    const room = Math.max(0, perDay - read.found);
    found = { today: read.found, perDay, room: shared ? Math.min(room, left) : room };
    if (shared && found.room)
      held = Math.min(found.room, await findsWaiting(ctx, me, platform, now));
  }
  const free = left - held;
  const partners = partnerReadsPerDay(reads);
  return {
    checks: { today: used, perDay: reads, room: free },
    partners: {
      today: read.partners,
      perDay: partners,
      room: Math.min(Math.max(0, partners - read.partners), free),
    },
    found,
  };
}

/** How far the person's checks of the people they know have come, for the Friends tab. */
export async function checksSummary(
  ctx: Ctx,
  me: string,
  now = Date.now(),
): Promise<ChecksSummary> {
  const ws = ctx.scope.workspaceId!;
  const [counted] = await rows<{
    people: number;
    checked: number;
    good: number;
    maybe: number;
    waiting: number;
    again: number;
  }>(
    ctx.tx,
    sql`select count(*)::int as people,
          count(*) filter (where ch.verdict in ('good', 'maybe', 'not'))::int as checked,
          count(*) filter (where ch.verdict = 'good')::int as good,
          count(*) filter (where ch.verdict = 'maybe')::int as maybe,
          count(*) filter (where ch.verdict = 'waiting')::int as waiting,
          count(*) filter (where ch.again)::int as again
        from addon_outreach.profiles p
        left join addon_outreach.checks ch on ch.profile_id = p.id and ch.user_id = ${me}
        where p.workspace_id = ${ws} and ${knownToMe(me)}`,
  );
  const { checks: day } = await perDayFor(ctx, me, now);
  return {
    people: counted?.people ?? 0,
    checked: counted?.checked ?? 0,
    good: counted?.good ?? 0,
    maybe: counted?.maybe ?? 0,
    waiting: counted?.waiting ?? 0,
    again: counted?.again ?? 0,
    today: day.today,
    perDay: day.perDay,
  };
}

export const checksNext = defineAddonQuery(outreachAddon, {
  name: 'outreach.checks.next',
  description:
    'Who the person’s computer checks next for whether they fit a playbook, in order and no more than today has room for: anyone they pressed Research on, anyone waiting for a look at where they live (those asking to be friends first), friends whose chat looks like a prospect, then friends with any chat, others they’ve chatted with, friends from the groups, then the rest. Never anyone on Don’t pitch, nor anyone checked lately unless the person asked to check everyone again or they wait for a look.',
  input: ChecksNextInput,
  output: ChecksNextOutput,
  permission: 'outreach.use',
  ai: {
    tool: 'outreach_checks_next',
    keywords: ['who gets checked next', 'fit checks'],
  },
  scope: inWorkspace,
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const now = Date.now();
    const { checks: day } = await perDayFor(ctx, me, now, input.platform);
    const { today, perDay } = day;
    const room = Math.max(0, Math.min(input.most, day.room));
    if (!room) return { people: [], today, perDay };
    const ago = (days: number) => new Date(now - days * DAY).toISOString();
    // Pressed Research (decision 46a) since they were last read: they go first, whoever they are to the person.
    const asked = sql`exists (select 1 from addon_outreach.asks a
      where a.workspace_id = p.workspace_id and a.user_id = ${me} and a.kind = 'research'
        and a.target = 'profile:' || p.id::text and a.state <> 'cancelled'
        and a.asked_at > ${ago(ASK_KEEP_DAYS)}::timestamptz
        and (ch.id is null or a.asked_at > ch.looked_at))`;
    // Waiting for a look at where they live (decision 86): a From or a guess the country setting would skip. Not
    // someone found by topic the person doesn't know: their own check looks (decision 92, `outreach.finds.next`).
    const rule = await countryRuleOf(ctx);
    const look = sql`(${waitsForLook(rule, 'p')} and not ${foundNotKnown(me)})`;
    const who = input.profileId
      ? sql`p.id = ${input.profileId} and p.friendship <> 'self' and ${pitchable('p')}`
      : sql`(${knownToMe(me)} or (p.friendship <> 'self' and ${pitchable('p')} and (${asked} or ${look})))`;
    const found = await rows<{ id: string; name: string; url: string; reason: CheckReason }>(
      ctx.tx,
      sql`select x.id, x.name, x.url, x.reason from (
            select p.id, p.name, p.url, p.mutual_friends, p.updated_at, p.friendship,
              case
                when ${asked} then 'asked'
                when ${look} then 'country'
                when f.id is not null and c.prospect then 'prospect'
                when f.id is not null and c.id is not null then 'chat'
                when c.id is not null then 'chat_only'
                when p.group_id is not null then 'group'
                else 'friend'
              end as reason
            from addon_outreach.profiles p
            left join addon_outreach.friends f
              on f.profile_id = p.id and f.user_id = ${me} and f.state = 'friends'
            left join lateral (
              select c.id, coalesce(c.prospect, false) as prospect from addon_outreach.file_chats c
              where c.profile_id = p.id and c.user_id = ${me}
              order by c.prospect desc nulls last, c.last_at desc limit 1
            ) c on true
            left join addon_outreach.checks ch on ch.profile_id = p.id and ch.user_id = ${me}
            where p.workspace_id = ${ws} and ${who}
              and p.platform = ${input.platform}
              and (ch.id is null
                or (ch.again and ch.verdict <> 'waiting')
                or (ch.verdict = 'failed' and ${asked})
                or (ch.verdict in ('good', 'maybe', 'not')
                  and ch.checked_at < ${ago(CHECK_AGAIN_DAYS)}::timestamptz)
                or (ch.verdict = 'failed' and ch.looked_at < ${ago(CHECK_RETRY_DAYS)}::timestamptz)
                or (${look} and ch.verdict in ('good', 'maybe', 'not')))
          ) x
          order by array_position(
              array['asked', 'country', 'prospect', 'chat', 'chat_only', 'group', 'friend'], x.reason),
            (x.reason = 'country' and x.friendship = 'request_received') desc,
            x.mutual_friends desc nulls last, x.updated_at desc, x.id
          limit ${room}`,
    );
    // Where their mutual friends live helps say where they do, while the business reaches only some countries.
    const mutual = countryRuleOn(rule) && input.platform === 'facebook';
    return {
      people: found.map((p) => ({
        profileId: p.id,
        name: p.name,
        url: p.url,
        reason: p.reason,
        mutual,
      })),
      today,
      perDay,
    };
  },
});

/**
 * Where someone's mutual friends live, as far as the business knows (decision 86): each country, the most first, with
 * how many were seen on a profile and how many worked out else. Null when the look didn't read them. The worker's check
 * reads it too.
 */
export async function mutualCountries(
  tx: Tx,
  workspaceId: string,
  ids: readonly string[],
  read: number | null,
): Promise<MutualCountries | null> {
  if (read === null) return null;
  const by = ids.length
    ? await rows<{ code: string; seen: number; other: number }>(
        tx,
        sql`select country as code, count(*) filter (where country_how = 'seen')::int as seen,
              count(*) filter (where country_how <> 'seen')::int as other
            from addon_outreach.profiles
            where workspace_id = ${workspaceId} and id = any (${`{${ids.join(',')}}`}::uuid[])
              and country is not null
            group by country order by count(*) desc, country limit 40`,
      )
    : [];
  return { read, by };
}

export const checkLook = defineAddonCommand(outreachAddon, {
  name: 'outreach.check.look',
  description:
    'What someone says on their profile and business page, as the person’s computer just read it, with how many friends they have and their mutual friends with the person, for the AI to see whether they fit a playbook and where they live; or that the network showed someone else. Someone the person knows, or someone found by topic they don’t know yet, whose check counts on its own. Kept only until the AI has read it.',
  risk: 1,
  input: CheckLookInput,
  output: CheckLookOutput,
  permission: 'outreach.use',
  scope: inWorkspace,
  emits: ['outreach.check.looked'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const at = changeMoment(ctx.meta);
    const [profile] = await ctx.tx
      .select({ id: profiles.id, platform: profiles.platform })
      .from(profiles)
      .where(and(eq(profiles.workspaceId, ws), eq(profiles.id, input.profileId)));
    if (!profile)
      throw HfosError.notFound('That person isn’t kept here anymore. Check your friends again.');
    const verdict: CheckVerdict = input.missing ? 'failed' : 'waiting';
    // Of someone found by topic the person doesn't know (decision 92), counted on its own a day; else of someone known,
    // as is anyone they pressed Research on since the last look (decision 46a). Set at each look, so it's kept fresh.
    const [seen] = await rows<{ found: boolean }>(
      ctx.tx,
      sql`select (${foundNotKnown(me)} and not exists (select 1 from addon_outreach.asks a
            where a.workspace_id = p.workspace_id and a.user_id = ${me} and a.kind = 'research'
              and a.target = 'profile:' || p.id::text and a.state <> 'cancelled'
              and a.asked_at > ${new Date(at.getTime() - ASK_KEEP_DAYS * DAY).toISOString()}::timestamptz
              and (ch.id is null or a.asked_at > ch.looked_at))) as found
          from addon_outreach.profiles p
          left join addon_outreach.checks ch on ch.profile_id = p.id and ch.user_id = ${me}
          where p.workspace_id = ${ws} and p.id = ${profile.id}`,
    );
    const via: CheckVia = seen?.found ? 'found' : 'known';
    // Their mutual friends (decision 86), matched to the people the business keeps on the network, for where they live.
    const mutual = input.missing ? null : input.mutual;
    const ids = (mutual ?? []).flatMap((m) => (m.id ? [m.id] : []));
    const usernames = (mutual ?? []).flatMap((m) => (m.username ? [m.username.toLowerCase()] : []));
    const mutualIds = mutual?.length
      ? (
          await rows<{ id: string }>(
            ctx.tx,
            sql`select id from addon_outreach.profiles
                where workspace_id = ${ws} and platform = ${profile.platform} and id <> ${profile.id}
                  and (platform_id = any (${`{${ids.join(',')}}`}::text[])
                    or lower(username) = any (${`{${usernames.join(',')}}`}::text[]))`,
          )
        ).map((r) => r.id)
      : [];
    if (!input.missing && input.friendsCount !== null)
      await ctx.tx
        .update(profiles)
        .set({ friendsCount: input.friendsCount })
        .where(eq(profiles.id, profile.id));
    const why = input.missing
      ? [`${NETWORKS[profile.platform].name} didn’t show their profile`]
      : [];
    const [row] = await ctx.tx
      .insert(checks)
      .values({
        workspaceId: ws,
        userId: me,
        profileId: profile.id,
        lines: input.missing ? [] : input.lines,
        mutualIds,
        mutualRead: mutual ? mutual.length : null,
        verdict,
        why,
        lookedAt: at,
        via,
      })
      .onConflictDoUpdate({
        target: [checks.workspaceId, checks.userId, checks.profileId],
        set: {
          lines: input.missing ? [] : input.lines,
          mutualIds,
          mutualRead: mutual ? mutual.length : null,
          verdict,
          via,
          // A new read keeps the last answer on show until the AI's next one.
          ...(input.missing
            ? { why, about: null, nextStep: null, playbookId: null, checkedAt: null }
            : {}),
          lookedAt: at,
          again: false,
        },
      })
      .returning({ id: checks.id });
    if (verdict === 'waiting')
      await ctx.emit({
        type: 'outreach.check.looked',
        entityType: 'workspace',
        entityId: ws,
        payload: { checkId: row!.id },
      });
    return { checkId: row!.id, verdict };
  },
});

export const checkSave = defineAddonCommand(outreachAddon, {
  name: 'outreach.check.save',
  description:
    'Worker: what the AI made of someone the person knows, or found by topic: a good fit, might fit or not, for which playbook, why, who they are and a first step, and where they live (a Lives in on their profile beats its word); or that it couldn’t read them. What their pages said, their mutual friends and what they said under a post are let go.',
  risk: 0,
  input: CheckSaveInput,
  output: CheckSaveOutput,
  permission: 'outreach.use',
  actors: ['system'],
  scope: inWorkspace,
  emits: ['outreach.check.saved'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const at = changeMoment(ctx.meta);
    const [check] = await ctx.tx
      .select()
      .from(checks)
      .where(and(eq(checks.workspaceId, ws), eq(checks.id, input.checkId)))
      .for('update');
    if (!check) throw HfosError.notFound('That check isn’t kept anymore.');
    // Answered already, or read again since: this answer is for lines that are gone.
    if (
      check.verdict !== 'waiting' ||
      check.lookedAt.getTime() !== new Date(input.lookedAt).getTime()
    )
      return { saved: false, verdict: check.verdict };
    const a = input.answer;
    const verdict: CheckVerdict = a ? a.fit : 'failed';
    // Where they live (decisions 61 and 86): a look weighs their pages' lines, their mutual friends and the AI's word.
    // With no answer, the lines alone count, as the worker's would, and never undo a stronger one.
    if (a?.country) {
      const looked = lookedCountry(check.lines, a.country);
      await ctx.tx
        .update(profiles)
        .set({
          country: looked.country,
          countryHow: looked.how,
          countryAt: at,
          countryFrom: looked.from,
          countryAlt: looked.alt,
          countryWhy: looked.why,
          countryUnsure: looked.unsure,
          countryLookedAt: at,
          countryMutual: await mutualCountries(ctx.tx, ws, check.mutualIds, check.mutualRead),
        })
        .where(and(eq(profiles.workspaceId, ws), eq(profiles.id, check.profileId)));
    } else {
      const lined = linesCountry(check.lines);
      if (lined) await keepCountry(ctx, check.profileId, lined);
    }
    await ctx.tx
      .update(checks)
      .set({
        lines: [],
        mutualIds: [],
        verdict,
        playbookId: a?.playbookId ?? null,
        why: a?.why ?? ['The AI couldn’t read them'],
        about: a?.about ?? null,
        nextStep: a?.nextStep ?? null,
        checkedAt: at,
      })
      .where(eq(checks.id, check.id));
    // What they said under a good post, if they were found commenting on one (decision 92), goes once it's read too.
    await ctx.tx
      .update(finds)
      .set({ said: null, updatedAt: at })
      .where(
        and(
          eq(finds.workspaceId, ws),
          eq(finds.userId, check.userId),
          eq(finds.profileId, check.profileId),
          isNotNull(finds.said),
        ),
      );
    await ctx.emit({
      type: 'outreach.check.saved',
      entityType: 'workspace',
      entityId: ws,
      payload: { checkId: check.id, verdict },
    });
    return { saved: true, verdict };
  },
});

/**
 * Check everyone again: everyone the person's computer has checked among the people they know is read again, at the
 * day's pace, whenever it last was. For when the AI reads pages better than it did; what it said stays on show until
 * then.
 */
export const checksAgain = defineAddonCommand(outreachAddon, {
  name: 'outreach.checks.again',
  description:
    'Puts everyone the person’s computer has checked among the people they know back on the list to check, at the day’s pace, so the AI reads them again. What it said about each stays until then. People found by topic they don’t know yet aren’t among them.',
  risk: 1,
  input: ChecksAgainInput,
  output: ChecksAgainOutput,
  permission: 'outreach.use',
  ai: {
    tool: 'outreach_check_again',
    autonomy: 'confirm',
    keywords: ['check everyone again', 'redo fit checks'],
  },
  scope: inWorkspace,
  emits: ['outreach.checks.again'],
  async handler(ctx) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    // Only checks of people the person knows, decided now (decision 92): someone found who became a friend is one.
    const marked = await rows<{ id: string }>(
      ctx.tx,
      sql`update addon_outreach.checks ch set again = true
          from addon_outreach.profiles p
          where p.id = ch.profile_id and ch.workspace_id = ${ws} and ch.user_id = ${me}
            and not ch.again and ch.verdict <> 'waiting' and ${knownCheck(me)}
          returning ch.id`,
    );
    if (marked.length)
      await ctx.emit({
        type: 'outreach.checks.again',
        entityType: 'workspace',
        entityId: ws,
        payload: { again: marked.length },
      });
    return { again: marked.length };
  },
});

export const checkCommands = [checkLook, checkSave, checksAgain] as const;
export const checkQueries = [checksNext] as const;
