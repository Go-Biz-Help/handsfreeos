/**
 * The fits among the person's friends and chats (../checks.ts, docs/outreach.md decision 46): who the extension checks
 * next, what their pages said as it read them, and what the AI made of it. Each person's own, like their chats; nobody
 * goes in Contacts. The Friends tab lists them (./friends.ts), and Today has the good fits to reconnect with
 * (./today.ts).
 */
import { and, eq, isNull, ne, or, sql } from 'drizzle-orm';
import { rows } from '@hfos/db/client';
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
import { checkedCountry, countryFromLines } from '../countries';
import { limitNow } from '../limits';
import { NETWORKS, type Platform } from '../networks';
import { outreachAddon } from '../manifest';
import { checks, profiles } from '../tables';
import { inWorkspace, pitchable, type Ctx } from './common';
import { slowsNow, startOfToday, warningOf } from './tidy';

const DAY = 86_400_000;

/**
 * The people there are to check: the person's friends, and anyone they've chatted with that's kept as a profile;
 * never on Don't pitch or tagged Friend or family, and never themselves. `p` is the profile.
 */
const knownToMe = (me: string) => sql`p.friendship <> 'self' and ${pitchable('p')} and (
  exists (select 1 from addon_outreach.friends f
    where f.profile_id = p.id and f.user_id = ${me} and f.state = 'friends')
  or exists (select 1 from addon_outreach.file_chats c where c.profile_id = p.id and c.user_id = ${me}))`;

/**
 * The profiles the person's computer read today on a network for the AI: for its checks of who fits, and of who could
 * partner (./partners.ts). Both count toward the network's profiles read a day.
 */
export async function readToday(
  ctx: Ctx,
  me: string,
  platform: Platform,
  todayStart: Date,
): Promise<{ checks: number; partners: number }> {
  const ws = ctx.scope.workspaceId!;
  const since = todayStart.toISOString();
  const [done] = await rows<{ checks: number; partners: number }>(
    ctx.tx,
    sql`select
          (select count(*)::int from addon_outreach.checks ch
            join addon_outreach.profiles p on p.id = ch.profile_id
            where ch.workspace_id = ${ws} and ch.user_id = ${me} and p.platform = ${platform}
              and ch.looked_at >= ${since}::timestamptz) as checks,
          (select count(*)::int from addon_outreach.partners pa
            join addon_outreach.profiles p on p.id = pa.profile_id
            where pa.workspace_id = ${ws} and pa.user_id = ${me} and p.platform = ${platform}
              and pa.looked_at >= ${since}::timestamptz) as partners`,
  );
  return { checks: done?.checks ?? 0, partners: done?.partners ?? 0 };
}

/** The network's profiles read a day (`checksPerDay`), halved for a week after a warning there. */
export const readsPerDay = (platform: Platform, slower: boolean) =>
  limitNow(Math.min(CHECKS_PER_DAY, NETWORKS[platform].checksPerDay), slower);

/**
 * How many a day the person's computer checks now on a network: its own profiles read a day (`checksPerDay`), halved
 * for a week after a warning there, where the checks read profiles; today's partner reads count too. Another network's
 * checks and warnings never count.
 */
export async function perDayFor(
  ctx: Ctx,
  me: string,
  now: number,
  platform: Platform = 'facebook',
) {
  const todayStart = await startOfToday(ctx, now);
  const warning = await warningOf(ctx, me, platform, todayStart, now);
  const read = await readToday(ctx, me, platform, todayStart);
  return {
    today: read.checks + read.partners,
    perDay: readsPerDay(platform, slowsNow(warning, now)),
  };
}

/** How far the person's checks have come, for the Friends tab. */
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
  return {
    people: counted?.people ?? 0,
    checked: counted?.checked ?? 0,
    good: counted?.good ?? 0,
    maybe: counted?.maybe ?? 0,
    waiting: counted?.waiting ?? 0,
    again: counted?.again ?? 0,
    ...(await perDayFor(ctx, me, now)),
  };
}

export const checksNext = defineAddonQuery(outreachAddon, {
  name: 'outreach.checks.next',
  description:
    'Who the person’s computer checks next for whether they fit a playbook, in order and no more than today has room for: friends whose chat looks like a prospect, then friends with any chat, others they’ve chatted with, friends from the groups, then the rest. Never anyone on Don’t pitch, nor anyone checked lately unless the person asked to check everyone again.',
  input: ChecksNextInput,
  output: ChecksNextOutput,
  permission: 'outreach.use',
  scope: inWorkspace,
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const now = Date.now();
    const { today, perDay } = await perDayFor(ctx, me, now, input.platform);
    const room = Math.max(0, Math.min(input.most, perDay - today));
    if (!room) return { people: [], today, perDay };
    const ago = (days: number) => new Date(now - days * DAY).toISOString();
    // Pressed Research (decision 46a) since they were last read: they go first, whoever they are to the person.
    const asked = sql`exists (select 1 from addon_outreach.asks a
      where a.workspace_id = p.workspace_id and a.user_id = ${me} and a.kind = 'research'
        and a.target = 'profile:' || p.id::text and a.state <> 'cancelled'
        and a.asked_at > ${ago(ASK_KEEP_DAYS)}::timestamptz
        and (ch.id is null or a.asked_at > ch.looked_at))`;
    const who = input.profileId
      ? sql`p.id = ${input.profileId} and p.friendship <> 'self' and ${pitchable('p')}`
      : sql`(${knownToMe(me)} or (p.friendship <> 'self' and ${pitchable('p')} and ${asked}))`;
    const found = await rows<{ id: string; name: string; url: string; reason: CheckReason }>(
      ctx.tx,
      sql`select x.id, x.name, x.url, x.reason from (
            select p.id, p.name, p.url, p.mutual_friends, p.updated_at,
              case
                when ${asked} then 'asked'
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
                or (ch.verdict = 'failed' and ch.looked_at < ${ago(CHECK_RETRY_DAYS)}::timestamptz))
          ) x
          order by array_position(array['asked', 'prospect', 'chat', 'chat_only', 'group', 'friend'], x.reason),
            x.mutual_friends desc nulls last, x.updated_at desc, x.id
          limit ${room}`,
    );
    return {
      people: found.map((p) => ({ profileId: p.id, name: p.name, url: p.url, reason: p.reason })),
      today,
      perDay,
    };
  },
});

export const checkLook = defineAddonCommand(outreachAddon, {
  name: 'outreach.check.look',
  description:
    'What someone the person knows on Facebook says on their profile and business page, as the person’s computer just read it, for the AI to see whether they fit a playbook; or that Facebook showed someone else. Kept only until the AI has read it.',
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
        verdict,
        why,
        lookedAt: at,
      })
      .onConflictDoUpdate({
        target: [checks.workspaceId, checks.userId, checks.profileId],
        set: {
          lines: input.missing ? [] : input.lines,
          verdict,
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
    'Worker: what the AI made of someone the person knows on Facebook: a good fit, might fit or not, for which playbook, why, who they are and a first step; or that it couldn’t read them. What their pages said is let go.',
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
    // Where they live (decision 61): what their pages' lines show, seen, over the AI's word; a guess never replaces a
    // country seen before.
    const lined = countryFromLines(check.lines);
    const said = checkedCountry(a?.country?.code);
    const country = lined
      ? { code: lined, how: 'seen' as const }
      : said
        ? {
            code: said,
            how: a!.country!.seen && check.lines.length ? ('seen' as const) : ('guessed' as const),
          }
        : null;
    if (country)
      await ctx.tx
        .update(profiles)
        .set({ country: country.code, countryHow: country.how, countryAt: at })
        .where(
          and(
            eq(profiles.workspaceId, ws),
            eq(profiles.id, check.profileId),
            ...(country.how === 'guessed'
              ? [or(isNull(profiles.countryHow), ne(profiles.countryHow, 'seen'))]
              : []),
          ),
        );
    await ctx.tx
      .update(checks)
      .set({
        lines: [],
        verdict,
        playbookId: a?.playbookId ?? null,
        why: a?.why ?? ['The AI couldn’t read them'],
        about: a?.about ?? null,
        nextStep: a?.nextStep ?? null,
        checkedAt: at,
      })
      .where(eq(checks.id, check.id));
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
 * Check everyone again: everyone the person's computer has checked is read again, at the day's pace, whenever it last
 * was. For when the AI reads pages better than it did; what it said stays on show until then.
 */
export const checksAgain = defineAddonCommand(outreachAddon, {
  name: 'outreach.checks.again',
  description:
    'Puts everyone the person’s computer has checked back on the list to check, at the day’s pace, so the AI reads them again. What it said about each stays until then.',
  risk: 1,
  input: ChecksAgainInput,
  output: ChecksAgainOutput,
  permission: 'outreach.use',
  scope: inWorkspace,
  emits: ['outreach.checks.again'],
  async handler(ctx) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const marked = await ctx.tx
      .update(checks)
      .set({ again: true })
      .where(
        and(
          eq(checks.workspaceId, ws),
          eq(checks.userId, me),
          eq(checks.again, false),
          ne(checks.verdict, 'waiting'),
        ),
      )
      .returning({ id: checks.id });
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
