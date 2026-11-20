/**
 * In your hands on Social Outreach (../in-hands.ts, docs/outreach.md decision 182): who's held, putting someone there
 * and giving them back, the ask on Needs you, and the list. A profile is held by its own row here, or by its customer
 * in core's app.people_in_hands; putting one in hands here puts its customer in the same person's hands in core
 * (`person.note_by_hand`, `person.take_over`), and giving one back gives the customer back (`person.hand_back`), each
 * as far as the person may: someone who can't answer the Inbox still holds them here.
 */
import { and, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { rows } from '@hfos/db/client';
import { personHandBack, personNoteByHand, personTakeOver } from '../../../commands/person-hands';
import { HfosError } from '../../../errors';
import { requireHuman, userIdOf } from '../../../kernel/actor';
import { executeCommandWithin } from '../../../kernel/execute';
import { changeMoment } from '../../../kernel/moment';
import type { CommandContext, QueryContext } from '../../../kernel/types';
import { defineAddonCommand, defineAddonQuery } from '../../server';
import { MESSAGE_KINDS, type WorkingHours } from '../automation';
import { clipLine } from '../live';
import {
  HANDS_ASK_AFTER_MS,
  HANDS_LOOK_BACK_DAYS,
  HANDS_OUTREACH_WORDS,
  HandsAskedInput,
  HandsAskedOutput,
  HandsGiveBackInput,
  HandsGiveBackOutput,
  HandsInput,
  HandsKeepInput,
  HandsKeepOutput,
  HandsOutput,
  HandsReleaseInput,
  HandsReleaseOutput,
  HandsTakeInput,
  HandsTakeOutput,
  handsPushWords,
  workingAfter,
  type ByHandClues,
  type HandsAsk,
  type HandsAskWhy,
  type HandsPerson,
  type HandsOutput as HandsShown,
} from '../in-hands';
import { outreachAddon } from '../manifest';
import type { Platform } from '../networks';
import { hands, profiles } from '../tables';
import { workspaceTimezone } from '../../../crm/records';
import { automationOf } from './automation';
import { inWorkspace } from './common';

type Ctx = CommandContext | QueryContext;
const DAY = 86_400_000;

/** The message kinds, as SQL: what someone held never gets. */
const messageKindsSql = sql.join(
  MESSAGE_KINDS.map((k) => sql`${k}`),
  sql`, `,
);

/** Whether a profile is in someone's hands: its own row, or its customer in core's. `p` is its alias. */
export const heldSql = (p: string): SQL =>
  sql`(exists (select 1 from addon_outreach.hands hh where hh.profile_id = ${sql.raw(p)}.id and hh.back_at is null)
    or (${sql.raw(p)}.person_id is not null
      and exists (select 1 from app.people_in_hands ph where ph.person_id = ${sql.raw(p)}.person_id)))`;

/** A send that may still go: a comment or a reply in a group, or a message to someone nobody has in their hands. */
export const sendNotHeld = (s: string): SQL =>
  sql`(${sql.raw(s)}.kind not in (${messageKindsSql}) or not exists (
    select 1 from addon_outreach.profiles hp where hp.id = ${sql.raw(s)}.profile_id and ${heldSql('hp')}))`;

/** Which of these profiles someone has in their hands. */
export async function heldAmong(ctx: Ctx, profileIds: readonly string[]): Promise<Set<string>> {
  const ids = [...new Set(profileIds)];
  if (!ids.length) return new Set();
  const found = await rows<{ id: string }>(
    ctx.tx,
    sql`select p.id from addon_outreach.profiles p
        where p.workspace_id = ${ctx.scope.workspaceId!} and p.id = any (${`{${ids.join(',')}}`}::uuid[])
          and ${heldSql('p')}`,
  );
  return new Set(found.map((r) => r.id));
}

/** Whether a message kind is one someone held never gets. */
export const heldOffKind = (kind: string): boolean =>
  (MESSAGE_KINDS as readonly string[]).includes(kind);

/** The refusal for a message to someone in someone's hands. */
export function heldRefusal(name: string): HfosError {
  return HfosError.rule(
    'outreach_in_your_hands',
    409,
    `${name} is in someone’s hands, so the AI doesn’t message them. To let it, press Give back to the AI in the menu on their name, or in Social Outreach → People → In your hands.`,
  );
}

/**
 * The AI's messages to them that wait for an OK, or are OK'd and not sent: each skipped, everyone's, so nothing goes to
 * someone in a person's hands. A comment and a reply in a group stay. Returns how many.
 */
export async function skipHeldSends(
  ctx: CommandContext,
  profileIds: readonly string[],
  at: Date,
): Promise<number> {
  if (!profileIds.length) return 0;
  const done = await rows<{ id: string }>(
    ctx.tx,
    sql`update addon_outreach.sends s set state = 'skipped', done_at = ${at.toISOString()}::timestamptz,
            updated_at = ${at.toISOString()}::timestamptz
          where s.workspace_id = ${ctx.scope.workspaceId!} and s.state in ('waiting', 'approved')
            and s.kind in (${messageKindsSql})
            and s.profile_id = any (${`{${[...new Set(profileIds)].join(',')}}`}::uuid[])
          returning s.id`,
  );
  return done.length;
}

/** Runs a core command for the same person as far as they may: a refusal (they can't answer the Inbox) leaves it. */
async function inCore<T>(run: () => Promise<T>): Promise<T | null> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof HfosError) return null;
    throw e;
  }
}

type Held = Pick<typeof profiles.$inferSelect, 'id' | 'personId' | 'platform'>;

/**
 * Puts someone in a person's hands (`me`, null for nobody known), or notes their latest message by hand when they're
 * held already (whoever wrote last has them; Take over never moves them from one person to another). A message written
 * before someone gave them back never takes them again. Their customer goes in the same hands in core. Returns whether
 * they've just come into someone's hands, and how many of the AI's messages to them were skipped.
 */
export async function takeHands(
  ctx: CommandContext,
  me: string | null,
  profile: Held,
  o: { readonly how: 'wrote' | 'took_over'; readonly at: Date },
): Promise<{ fresh: boolean; taken: boolean; skipped: number }> {
  const ws = ctx.scope.workspaceId!;
  const place = o.how === 'wrote' ? profile.platform : null;
  const [had] = await ctx.tx
    .select()
    .from(hands)
    .where(and(eq(hands.workspaceId, ws), eq(hands.profileId, profile.id)))
    .for('update');
  let fresh = false;
  if (had && had.backAt === null) {
    if (o.how === 'wrote')
      await ctx.tx
        .update(hands)
        .set({
          userId: me,
          how: 'wrote',
          place,
          lastAt: sql`greatest(${hands.lastAt}, ${o.at.toISOString()}::timestamptz)`,
        })
        .where(eq(hands.profileId, profile.id));
  } else if (had) {
    if (o.how === 'wrote' && o.at.getTime() <= had.backAt!.getTime())
      return { fresh: false, taken: false, skipped: 0 };
    await ctx.tx
      .update(hands)
      .set({
        userId: me,
        how: o.how,
        place,
        since: o.at,
        lastAt: o.at,
        keptAt: null,
        askedAt: null,
        backAt: null,
        backBy: null,
      })
      .where(eq(hands.profileId, profile.id));
    fresh = true;
  } else {
    await ctx.tx.insert(hands).values({
      profileId: profile.id,
      workspaceId: ws,
      userId: me,
      how: o.how,
      place,
      since: o.at,
      lastAt: o.at,
    });
    fresh = true;
  }
  const skipped = fresh ? await skipHeldSends(ctx, [profile.id], o.at) : 0;
  if (profile.personId) {
    const personId = profile.personId;
    if (o.how === 'wrote')
      await inCore(() =>
        executeCommandWithin(ctx, personNoteByHand, {
          workspaceId: ws,
          personId,
          place: profile.platform,
          at: o.at.toISOString(),
        }),
      );
    else
      await inCore(() => executeCommandWithin(ctx, personTakeOver, { workspaceId: ws, personId }));
  }
  if (fresh)
    await ctx.emit({
      type: 'outreach.hands.taken',
      entityType: 'outreach_profile',
      entityId: profile.id,
      payload: { profileId: profile.id, userId: me, how: o.how, at: o.at.toISOString() },
    });
  return { fresh, taken: true, skipped };
}

/**
 * Gives people back to the AI: each profile, and every other profile on the same customer, out of anyone's hands here,
 * and their customers out of anyone's hands in core. Returns how many profiles were held and now aren't.
 */
export async function giveBackHands(
  ctx: CommandContext,
  me: string | null,
  profileIds: readonly string[],
  at: Date,
): Promise<number> {
  const ws = ctx.scope.workspaceId!;
  if (!profileIds.length) return 0;
  const ids = `{${[...new Set(profileIds)].join(',')}}`;
  // The customers they're on, and every profile on those.
  const reach = await rows<{ id: string; person_id: string | null; held: boolean }>(
    ctx.tx,
    sql`select o.id, o.person_id, ${heldSql('o')} as held from addon_outreach.profiles o
        where o.workspace_id = ${ws}
          and (o.id = any (${ids}::uuid[])
            or o.person_id in (select p.person_id from addon_outreach.profiles p
              where p.workspace_id = ${ws} and p.id = any (${ids}::uuid[]) and p.person_id is not null))`,
  );
  const wereHeld = reach.filter((r) => r.held).map((r) => r.id);
  if (!wereHeld.length) return 0;
  await ctx.tx
    .update(hands)
    .set({ backAt: at, backBy: me })
    .where(
      and(eq(hands.workspaceId, ws), inArray(hands.profileId, wereHeld), isNull(hands.backAt)),
    );
  const personIds = [
    ...new Set(reach.map((r) => r.person_id).filter((p): p is string => p !== null)),
  ];
  if (personIds.length && me)
    await inCore(() =>
      executeCommandWithin(ctx, personHandBack, {
        workspaceId: ws,
        personIds,
        all: false,
        mine: false,
      }),
    );
  await ctx.emit({
    type: 'outreach.hands.given_back',
    entityType: 'workspace',
    entityId: ws,
    payload: { profileIds: wereHeld, by: me },
  });
  return wereHeld.length;
}

// ------------------------------------------------------------------------------------------------- what the chat says

/**
 * What tells a message of the person's in someone's chat apart from the AI's (../in-hands.ts `byHandAt`): HandsFreeOS's
 * drafts for them, when the extension sent them anything, when the person last copied a draft for them, and when
 * someone last gave them back.
 */
export async function byHandCluesOf(
  ctx: CommandContext,
  profileId: string,
  name: string,
  now: Date,
): Promise<ByHandClues> {
  const since = new Date(now.getTime() - (HANDS_LOOK_BACK_DAYS + 15) * DAY).toISOString();
  const [drafts, sent, kept] = await Promise.all([
    rows<{ text: string; drafted: string }>(
      ctx.tx,
      sql`select s.text, s.drafted from addon_outreach.sends s
          where s.workspace_id = ${ctx.scope.workspaceId!} and s.profile_id = ${profileId}
            and s.created_at >= ${since}::timestamptz and s.post_id is null`,
    ),
    rows<{ at: Date | string }>(
      ctx.tx,
      sql`select t.at from addon_outreach.touches t
          where t.workspace_id = ${ctx.scope.workspaceId!} and t.profile_id = ${profileId}
            and t.kind = 'message' and t.auto and t.at >= ${since}::timestamptz
          union all
          select s.done_at from addon_outreach.sends s
          where s.workspace_id = ${ctx.scope.workspaceId!} and s.profile_id = ${profileId}
            and s.state = 'sent' and s.post_id is null and s.done_at >= ${since}::timestamptz`,
    ),
    rows<{ copied_at: Date | string | null; back_at: Date | string | null }>(
      ctx.tx,
      sql`select p.copied_at, h.back_at from addon_outreach.profiles p
          left join addon_outreach.hands h on h.profile_id = p.id
          where p.workspace_id = ${ctx.scope.workspaceId!} and p.id = ${profileId}`,
    ),
  ]);
  const ms = (v: Date | string | null | undefined) => (v ? new Date(v).getTime() : null);
  return {
    name,
    drafts: drafts.flatMap((d) => (d.drafted === d.text ? [d.text] : [d.text, d.drafted])),
    sentAt: sent.map((s) => new Date(s.at).getTime()),
    copiedAt: ms(kept[0]?.copied_at),
    backAt: ms(kept[0]?.back_at),
    now: now.getTime(),
  };
}

// ------------------------------------------------------------------------------------------------- the ask

type AskRow = {
  profile_id: string;
  person_id: string | null;
  name: string;
  platform: Platform;
  url: string;
  thread_key: string | null;
  last_at: Date | string;
  kept_at: Date | string | null;
  asked_at: Date | string | null;
  theirs_at: Date | string | null;
  theirs_text: string | null;
  mine_at: Date | string | null;
  fu_gap_ms: number | null;
};

/**
 * The people in `me`'s hands, or nobody's (a customer someone outside HandsFreeOS wrote to), each with what the ask
 * would go by: their latest message, the person's latest, and the gap the AI's follow-ups were keeping. `profileId`
 * reads one.
 */
async function askRows(ctx: Ctx, me: string, profileId?: string): Promise<AskRow[]> {
  const ws = ctx.scope.workspaceId!;
  return rows<AskRow>(
    ctx.tx,
    sql`with held as (
          select p.id as profile_id, p.person_id, p.name, p.platform, p.url,
                 coalesce(h.last_at, ph.last_at) as last_at, h.kept_at, h.asked_at
            from addon_outreach.profiles p
            left join addon_outreach.hands h on h.profile_id = p.id and h.back_at is null
            left join app.people_in_hands ph on ph.person_id = p.person_id
           where p.workspace_id = ${ws} and (h.profile_id is not null or ph.person_id is not null)
             and coalesce(h.user_id, ph.user_id) = ${me}
             and not p.never_contact
             ${profileId ? sql`and p.id = ${profileId}` : sql``}
        )
        select held.profile_id, held.person_id, held.name, held.platform, held.url, held.last_at, held.kept_at,
               held.asked_at, c.thread_key, c.theirs_at, c.theirs_text, c.mine_at,
               (select extract(epoch from (f.due_at - f.last_at)) * 1000 from addon_outreach.follow_ups f
                 where f.profile_id = held.profile_id and f.user_id = ${me} and f.stopped_at is null
                   and f.due_at is not null and f.due_at > f.last_at
                   and (f.answer is null or f.answer <> 'no')
                 order by f.last_at desc limit 1)::float8 as fu_gap_ms
          from held
          left join lateral (
            select fc.thread_key,
                   case when not fc.last_from_me then fc.last_at end as theirs_at,
                   case when not fc.last_from_me then fc.recent -> -1 ->> 'text' end as theirs_text,
                   case when fc.last_from_me then fc.last_at end as mine_at
              from addon_outreach.file_chats fc
             where fc.workspace_id = ${ws} and fc.user_id = ${me} and fc.profile_id = held.profile_id
             order by fc.last_at desc limit 1
          ) c on true
         order by held.last_at desc
         limit 200`,
  );
}

/** The ask for one of them now, and when it came due; or, when it isn't due yet, when it will be. */
function askOf(
  r: AskRow,
  now: number,
  hours: WorkingHours,
  timeZone: string,
): { readonly why: HandsAskWhy; readonly at: number } | { readonly dueAt: number } | null {
  const ms = (v: Date | string | null) => (v ? new Date(v).getTime() : null);
  const lastAt = ms(r.last_at)!;
  const settled = Math.max(lastAt, ms(r.kept_at) ?? 0);
  const theirs = ms(r.theirs_at);
  // They wrote back after the person, and an hour of the person's working hours went by.
  if (theirs !== null && theirs > settled) {
    const due = workingAfter(hours, timeZone, theirs, HANDS_ASK_AFTER_MS);
    if (due === null) return null;
    return due <= now ? { why: 'reply', at: due } : { dueAt: due };
  }
  // The person's word is the latest, and the AI would have followed up by now, at its own pace from there.
  if (r.fu_gap_ms !== null && (ms(r.mine_at) ?? lastAt) <= settled + 60_000) {
    const due = workingAfter(hours, timeZone, settled + r.fu_gap_ms, 0);
    if (due === null) return null;
    return due <= now ? { why: 'follow_up', at: due } : { dueAt: due };
  }
  return null;
}

/** The asks on `me`'s Needs you now, newest first. */
export async function handsAsks(
  ctx: Ctx,
  me: string,
  now: number,
  hours: WorkingHours,
  timeZone: string,
): Promise<HandsAsk[]> {
  const found = await askRows(ctx, me);
  const asks: HandsAsk[] = [];
  for (const r of found) {
    const ask = askOf(r, now, hours, timeZone);
    if (!ask || !('why' in ask)) continue;
    asks.push({
      profileId: r.profile_id,
      personId: r.person_id,
      name: r.name,
      platform: r.platform,
      url: r.url,
      threadKey: r.thread_key,
      why: ask.why,
      at: new Date(ask.at).toISOString(),
      theirs: ask.why === 'reply' && r.theirs_text ? clipLine(r.theirs_text) : null,
    });
  }
  return asks.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

// ------------------------------------------------------------------------------------------------- commands

export const handsTake = defineAddonCommand(outreachAddon, {
  name: 'outreach.hands.take',
  description:
    'Take someone over yourself (Take over, in the menu on their name): the AI sends them no messages, here or as a customer in Contacts, until someone gives them back. Likes and comments still go. Its messages to them waiting for an OK are skipped.',
  risk: 1,
  input: HandsTakeInput,
  output: HandsTakeOutput,
  permission: 'outreach.use',
  ai: {
    tool: 'outreach_take_over',
    keywords: ['take over', 'i will handle them', 'stop the ai messaging', 'manual control'],
  },
  scope: inWorkspace,
  emits: ['outreach.hands.taken'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const at = changeMoment(ctx.meta);
    const [profile] = await ctx.tx
      .select({ id: profiles.id, personId: profiles.personId, platform: profiles.platform })
      .from(profiles)
      .where(and(eq(profiles.workspaceId, input.workspaceId), eq(profiles.id, input.profileId)));
    if (!profile) throw HfosError.notFound('That person isn’t kept here anymore. Reload the page.');
    const held = (await heldAmong(ctx, [profile.id])).has(profile.id);
    if (held) return { profileId: profile.id, already: true, skipped: 0 };
    const { skipped } = await takeHands(ctx, me, profile, { how: 'took_over', at });
    return { profileId: profile.id, already: false, skipped };
  },
});

export const handsGiveBack = defineAddonCommand(outreachAddon, {
  name: 'outreach.hands.give_back',
  description:
    'Give people in someone’s hands back to the AI (Give back to the AI, in the menu on their name, on In your hands, or on the ask on Needs you): it messages them again, starting with anything they’re waiting on, and gives back their customer in Contacts too. Pass profileIds, or all (with mine for only your own).',
  risk: 1,
  input: HandsGiveBackInput,
  output: HandsGiveBackOutput,
  permission: 'outreach.use',
  ai: {
    tool: 'outreach_give_back',
    keywords: ['give back to the ai', 'let the ai take it', 'hand back', 'release'],
  },
  scope: inWorkspace,
  emits: ['outreach.hands.given_back'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const at = changeMoment(ctx.meta);
    if (!input.all && !input.profileIds.length)
      throw HfosError.validation(
        [{ path: 'profileIds', message: 'Pick who to give back, or give them all back.' }],
        'Pick who to give back to the AI, or press Give all back.',
      );
    const ws = input.workspaceId;
    const ids = input.all
      ? (
          await rows<{ id: string }>(
            ctx.tx,
            sql`select p.id from addon_outreach.profiles p
                left join addon_outreach.hands h on h.profile_id = p.id and h.back_at is null
                left join app.people_in_hands ph on ph.person_id = p.person_id
                where p.workspace_id = ${ws} and (h.profile_id is not null or ph.person_id is not null)
                  ${input.mine ? sql`and coalesce(h.user_id, ph.user_id) = ${me}` : sql``}`,
          )
        ).map((r) => r.id)
      : input.profileIds;
    return { handedBack: await giveBackHands(ctx, me, ids, at) };
  },
});

export const handsKeep = defineAddonCommand(outreachAddon, {
  name: 'outreach.hands.keep',
  description:
    'Keep someone in your hands (Keep it mine, on the ask on Needs you): the ask goes until they write again or the AI would follow up again.',
  risk: 0,
  input: HandsKeepInput,
  output: HandsKeepOutput,
  permission: 'outreach.use',
  ai: { tool: 'outreach_keep_it_mine', keywords: ['keep it mine', 'i will answer them'] },
  scope: inWorkspace,
  emits: ['outreach.hands.taken'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const at = changeMoment(ctx.meta);
    const [profile] = await ctx.tx
      .select({ id: profiles.id, personId: profiles.personId, platform: profiles.platform })
      .from(profiles)
      .where(and(eq(profiles.workspaceId, input.workspaceId), eq(profiles.id, input.profileId)));
    if (!profile) throw HfosError.notFound('That person isn’t kept here anymore. Reload the page.');
    if (!(await heldAmong(ctx, [profile.id])).has(profile.id))
      throw HfosError.rule(
        'outreach_not_in_hands',
        409,
        'Nobody has them in their hands now, so the AI is looking after them. To take them on, press Take over in the menu on their name.',
      );
    // Held through their customer alone: a row here keeps the answer, in the same hands.
    const [had] = await ctx.tx
      .select({ profileId: hands.profileId, backAt: hands.backAt })
      .from(hands)
      .where(eq(hands.profileId, profile.id));
    const took =
      !had || had.backAt !== null
        ? await takeHands(ctx, me, profile, { how: 'took_over', at })
        : null;
    await ctx.tx.update(hands).set({ keptAt: at }).where(eq(hands.profileId, profile.id));
    // The ask comes back when the AI would follow up again, so the worker looks again (./in-hands.ts there).
    if (!took?.fresh)
      await ctx.emit({
        type: 'outreach.hands.taken',
        entityType: 'outreach_profile',
        entityId: profile.id,
        payload: { profileId: profile.id, userId: me, how: 'kept', at: at.toISOString() },
      });
    return { profileId: profile.id, keptAt: at.toISOString() };
  },
});

export const handsRelease = defineAddonCommand(outreachAddon, {
  name: 'outreach.hands.release',
  description:
    'Worker: a customer was given back to the AI in Contacts, so every profile of theirs here is out of anyone’s hands too.',
  risk: 0,
  input: HandsReleaseInput,
  output: HandsReleaseOutput,
  permission: 'outreach.use',
  actors: ['system'],
  scope: inWorkspace,
  emits: [],
  async handler(ctx, input) {
    const at = changeMoment(ctx.meta);
    const done = await rows<{ profile_id: string }>(
      ctx.tx,
      sql`update addon_outreach.hands h set back_at = ${at.toISOString()}::timestamptz
          from addon_outreach.profiles p
          where p.id = h.profile_id and h.workspace_id = ${input.workspaceId} and p.person_id = ${input.personId}
            and h.back_at is null
          returning h.profile_id`,
    );
    return { released: done.length };
  },
});

export const handsAsked = defineAddonCommand(outreachAddon, {
  name: 'outreach.hands.asked',
  description:
    'Worker: whether the ask about someone in a person’s hands is due now (they wrote back an hour of working hours ago, or the AI would have followed up), and if it is, notes it as asked so their phone hears it once.',
  risk: 0,
  input: HandsAskedInput,
  output: HandsAskedOutput,
  permission: 'outreach.use',
  actors: ['system'],
  scope: inWorkspace,
  emits: [],
  async handler(ctx, input) {
    const now = changeMoment(ctx.meta).getTime();
    const [r] = await askRows(ctx, input.userId, input.profileId);
    if (!r) return { push: null, again: null };
    const { hours, timeZone } = await hoursOf(ctx, input.userId, now);
    const ask = askOf(r, now, hours, timeZone);
    if (!ask) return { push: null, again: null };
    if (!('why' in ask)) return { push: null, again: new Date(ask.dueAt).toISOString() };
    const asked = r.asked_at ? new Date(r.asked_at).getTime() : null;
    if (asked !== null && asked >= ask.at) return { push: null, again: null };
    await ctx.tx
      .update(hands)
      .set({ askedAt: new Date(now) })
      .where(eq(hands.profileId, r.profile_id));
    return { push: handsPushWords(ask.why, r.name, r.platform), again: null };
  },
});

/** The person's working hours and the business's time zone: the ask and its push follow them. */
async function hoursOf(
  ctx: Ctx,
  userId: string,
  now: number,
): Promise<{ hours: WorkingHours; timeZone: string }> {
  const [auto, timeZone] = await Promise.all([
    automationOf(ctx, userId, now),
    workspaceTimezone(ctx.tx, ctx.scope.workspaceId!),
  ]);
  return { hours: auto.settings.hours, timeZone };
}

export const handsList = defineAddonQuery(outreachAddon, {
  name: 'outreach.hands',
  description:
    'Who’s in someone’s hands (Social Outreach → People → In your hands): people someone on the team wrote to themselves, or took over, whom the AI sends no messages till someone gives them back; whose hands, how, when, and whether an ask waits on Needs you. Newest first.',
  input: HandsInput,
  output: HandsOutput,
  permission: 'outreach.use',
  ai: {
    tool: 'outreach_in_your_hands',
    keywords: ['in your hands', 'who am i handling', 'manual control', 'taken over'],
  },
  scope: inWorkspace,
  async handler(ctx, input) {
    return handsPeople(ctx, userIdOf(ctx.actor), { ...input, asks: true });
  },
});

/**
 * Who's in someone's hands, as In your hands lists them, newest first: everyone, or `me`'s own with `mine`, or one
 * profile; with whether an ask waits for `me` when `asks` (only for someone in their own hands).
 */
export async function handsPeople(
  ctx: Ctx,
  me: string | null,
  input: {
    readonly mine?: boolean;
    readonly profileId?: string;
    readonly limit: number;
    readonly asks?: boolean;
  },
): Promise<HandsShown> {
  const ws = ctx.scope.workspaceId!;
  const where = sql`p.workspace_id = ${ws} and (h.profile_id is not null or ph.person_id is not null)
      ${input.mine && me ? sql`and coalesce(h.user_id, ph.user_id) = ${me}` : sql``}
      ${input.profileId ? sql`and p.id = ${input.profileId}` : sql``}`;
  const from = sql`from addon_outreach.profiles p
      left join addon_outreach.hands h on h.profile_id = p.id and h.back_at is null
      left join app.people_in_hands ph on ph.person_id = p.person_id
      left join app.users u on u.id = coalesce(h.user_id, ph.user_id)`;
  const [counted] = await rows<{ n: number }>(
    ctx.tx,
    sql`select count(*)::int as n ${from} where ${where}`,
  );
  const found = await rows<{
    profile_id: string;
    person_id: string | null;
    name: string;
    platform: Platform;
    url: string;
    thread_key: string | null;
    user_id: string | null;
    user_name: string | null;
    how: HandsPerson['how'];
    place: string | null;
    since: Date | string;
    last_at: Date | string;
    in_contacts: boolean;
  }>(
    ctx.tx,
    sql`select p.id as profile_id, p.person_id, p.name, p.platform, p.url,
              (select fc.thread_key from addon_outreach.file_chats fc
                where fc.profile_id = p.id and fc.thread_key is not null order by fc.last_at desc limit 1) as thread_key,
              coalesce(h.user_id, ph.user_id) as user_id,
              coalesce(nullif(btrim(u.full_name), ''), u.email::text) as user_name,
              coalesce(h.how, ph.how) as how, coalesce(h.place, ph.place) as place,
              coalesce(h.since, ph.since) as since, greatest(h.last_at, ph.last_at) as last_at,
              ph.person_id is not null as in_contacts
            ${from} where ${where}
            order by greatest(h.last_at, ph.last_at) desc, p.id
            limit ${input.limit}`,
  );
  // Whether an ask waits, by the person's own Needs you: only for someone in their own hands.
  let asking = new Map<string, HandsAskWhy>();
  if (me && input.asks) {
    const now = Date.now();
    const { hours, timeZone } = await hoursOf(ctx, me, now);
    const asks = await handsAsks(ctx, me, now, hours, timeZone);
    asking = new Map(asks.map((a) => [a.profileId, a.why]));
  }
  return {
    people: found.map((r) => ({
      profileId: r.profile_id,
      personId: r.person_id,
      name: r.name,
      platform: r.platform,
      url: r.url,
      threadKey: r.thread_key,
      user: r.user_id && r.user_name ? { id: r.user_id, fullName: r.user_name } : null,
      how: r.how,
      place: r.place,
      since: new Date(r.since).toISOString(),
      lastAt: new Date(r.last_at).toISOString(),
      inContacts: r.in_contacts,
      ask: asking.get(r.profile_id) ?? null,
    })),
    total: counted?.n ?? 0,
  };
}

export const handsCommands = [
  handsTake,
  handsGiveBack,
  handsKeep,
  handsRelease,
  handsAsked,
] as const;
export const handsQueries = [handsList] as const;

export { HANDS_OUTREACH_WORDS };
