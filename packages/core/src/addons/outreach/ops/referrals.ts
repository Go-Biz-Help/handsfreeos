/**
 * Referring people the person talked with on posts asking for a recommendation (../referrals.ts, docs/outreach.md
 * decisions 174 and 185): each person's own. The worker finds someone to refer on a post and the AI writes the comment
 * and the heads-up (`outreach.referral.save`); Today shows them (`outreach.referrals`), waiting for the person, who does
 * both by hand and says so (`outreach.referral.done`), lets their computer do it (`outreach.referral.approve`), or puts
 * it aside (`outreach.referral.skip`). Under Autopilot on Facebook one is saved approved. Their computer takes the
 * approved ones (`outreach.referrals.due`) and says how each went (`outreach.referral.posted`).
 *
 * The ask after two (decision 185): the worker writes it once the chat is quiet (`outreach.refer_ask.save`), and it goes
 * the same way (`outreach.refer_ask.answer`, `outreach.refer_ask.sent`).
 */
import { and, eq, sql } from 'drizzle-orm';
import { rows } from '@hfos/db/client';
import { HfosError } from '../../../errors';
import { requireHuman } from '../../../kernel/actor';
import { changeMoment } from '../../../kernel/moment';
import { defineAddonCommand, defineAddonQuery } from '../../server';
import { autopilotOn } from '../automation';
import { outreachAddon } from '../manifest';
import type { Platform } from '../networks';
import {
  askForYou,
  DueAsk,
  DueReferral,
  REFER_POST_DAYS,
  ReferAskAnswerInput,
  ReferAskChangeOutput,
  ReferAskSaveInput,
  ReferAskSaveOutput,
  ReferAskSentInput,
  referForYou,
  ReferralApproveInput,
  ReferralChangeOutput,
  ReferralDoneInput,
  ReferralPostedInput,
  ReferralSaveInput,
  ReferralSaveOutput,
  ReferralSkipInput,
  ReferralsDueInput,
  ReferralsDueOutput,
  ReferralsInput,
  ReferralsOutput,
  type ReferralState,
} from '../referrals';
import { postParts, SEND_POST_MOST } from '../sends';
import { posts, profiles, referAsks, referrals } from '../tables';
import { automationOf, limitsFor } from './automation';
import { inWorkspace, type Ctx } from './common';
import { heldAmong, heldRefusal, heldSql } from './in-hands';
import { slowsNow, startOfToday, warningOf } from './tidy';
import { dayCounts } from './today';

/** The most Today shows at once. */
const SHOWN_MOST = 20;

async function mine(ctx: Ctx, me: string, referralId: string) {
  const [row] = await ctx.tx
    .select()
    .from(referrals)
    .where(
      and(
        eq(referrals.workspaceId, ctx.scope.workspaceId!),
        eq(referrals.id, referralId),
        eq(referrals.userId, me),
      ),
    )
    .for('update');
  if (!row) throw HfosError.notFound('That referral isn’t kept anymore. Reload the page.');
  return row;
}

async function myAsk(ctx: Ctx, me: string, askId: string) {
  const [row] = await ctx.tx
    .select()
    .from(referAsks)
    .where(
      and(
        eq(referAsks.workspaceId, ctx.scope.workspaceId!),
        eq(referAsks.id, askId),
        eq(referAsks.userId, me),
      ),
    )
    .for('update');
  if (!row) throw HfosError.notFound('That note isn’t kept anymore. Reload the page.');
  return row;
}

/** A profile's name and network. */
async function whoIs(ctx: Ctx, profileId: string) {
  const [p] = await ctx.tx
    .select({ name: profiles.name, platform: profiles.platform })
    .from(profiles)
    .where(and(eq(profiles.workspaceId, ctx.scope.workspaceId!), eq(profiles.id, profileId)));
  return p ? { name: p.name, platform: p.platform as Platform } : null;
}

/**
 * Whether the person's computer does it for them now, with no OK (decision 185): Autopilot on Facebook, sending on,
 * where it can do it, and to someone nobody has in their hands when a message goes too (decision 182).
 */
async function onItsOwn(
  ctx: Ctx,
  userId: string,
  forYou: boolean,
  messageTo: string | null,
): Promise<boolean> {
  if (!forYou) return false;
  const { settings, choices } = await automationOf(ctx, userId, Date.now(), 'facebook');
  if (!autopilotOn(settings, 'facebook') || choices.sending === 'off') return false;
  return messageTo === null || !(await heldAmong(ctx, [messageTo])).has(messageTo);
}

/** The refusal for Do it for me where the person's computer can't. */
const byHand = (name: string, what: string) =>
  HfosError.rule(
    'outreach_refer_by_hand',
    409,
    `Your computer can do this only on Facebook, and ${name} ${what}. Do it yourself from Today, then press the button that says you did.`,
  );

export const referralSave = defineAddonCommand(outreachAddon, {
  name: 'outreach.referral.save',
  description:
    'Worker: someone the person talked with to refer under a post asking for a recommendation of what they do, with why, the comment naming them and the heads-up to them (none when they had one this week), as the AI wrote them. It waits on Today for the person, or under Autopilot on Facebook their computer does it. One a post.',
  risk: 0,
  input: ReferralSaveInput,
  output: ReferralSaveOutput,
  permission: 'outreach.use',
  actors: ['system'],
  scope: inWorkspace,
  emits: ['outreach.referral.found'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const [post] = await ctx.tx
      .select({
        id: posts.id,
        userId: posts.userId,
        skippedAt: posts.skippedAt,
        platform: profiles.platform,
      })
      .from(posts)
      .innerJoin(profiles, eq(profiles.id, posts.profileId))
      .where(and(eq(posts.workspaceId, ws), eq(posts.id, input.postId)));
    // Gone, or put aside since the worker looked: nothing to refer on.
    if (!post || post.skippedAt) return { referralId: null };
    const person = await whoIs(ctx, input.profileId);
    if (!person) return { referralId: null };
    const forYou = referForYou(post.platform as Platform, person.platform);
    const own = await onItsOwn(ctx, post.userId, forYou, input.note ? input.profileId : null);
    const [made] = await ctx.tx
      .insert(referrals)
      .values({
        workspaceId: ws,
        userId: post.userId,
        postId: post.id,
        profileId: input.profileId,
        why: input.why,
        comment: input.comment,
        note: input.note,
        state: own ? 'approved' : 'waiting',
      })
      .onConflictDoNothing()
      .returning({ id: referrals.id });
    if (!made) return { referralId: null };
    await ctx.emit({
      type: 'outreach.referral.found',
      entityType: 'workspace',
      entityId: ws,
      payload: { referralId: made.id, postId: post.id, userId: post.userId, approved: own },
    });
    return { referralId: made.id };
  },
});

export const referralApprove = defineAddonCommand(outreachAddon, {
  name: 'outreach.referral.approve',
  description:
    'Do it for me on a referral waiting on Today: the person’s computer posts the comment naming someone they talked with under the post (tagging them, or their name as plain words where Facebook won’t list them) and sends them the heads-up, as it stands or as changed. Only on Facebook, where the post and the person both are, and never a heads-up to someone in a person’s hands.',
  risk: 1,
  input: ReferralApproveInput,
  output: ReferralChangeOutput,
  permission: 'outreach.use',
  ai: { tool: 'outreach_refer_for_me', keywords: ['do it for me', 'post the referral'] },
  scope: inWorkspace,
  emits: ['outreach.referral.approved'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const at = changeMoment(ctx.meta);
    const row = await mine(ctx, me, input.referralId);
    if (row.state !== 'waiting') return { referralId: row.id, state: row.state };
    const [post] = await ctx.tx
      .select({ platform: profiles.platform })
      .from(posts)
      .innerJoin(profiles, eq(profiles.id, posts.profileId))
      .where(eq(posts.id, row.postId));
    const person = await whoIs(ctx, row.profileId);
    if (!post || !person)
      throw HfosError.notFound('That post isn’t kept anymore. Reload the page.');
    if (!referForYou(post.platform as Platform, person.platform))
      throw byHand(
        person.name,
        post.platform !== 'facebook' ? 'the post aren’t both there' : 'isn’t there',
      );
    const note = input.note ?? row.note;
    if (note && !row.notedAt && (await heldAmong(ctx, [row.profileId])).has(row.profileId))
      throw heldRefusal(person.name);
    await ctx.tx
      .update(referrals)
      .set({
        state: 'approved',
        needs: null,
        updatedAt: at,
        ...(input.comment ? { comment: input.comment } : {}),
        ...(input.note ? { note: input.note } : {}),
      })
      .where(eq(referrals.id, row.id));
    await ctx.emit({
      type: 'outreach.referral.approved',
      entityType: 'workspace',
      entityId: ctx.scope.workspaceId!,
      payload: { referralId: row.id },
    });
    return { referralId: row.id, state: 'approved' as const };
  },
});

export const referralDone = defineAddonCommand(outreachAddon, {
  name: 'outreach.referral.done',
  description:
    'The person commented on the post naming someone they talked with, and sent that person the heads-up when there was one: the referral is noted as done, with the words they sent when they changed them.',
  risk: 1,
  input: ReferralDoneInput,
  output: ReferralChangeOutput,
  permission: 'outreach.use',
  ai: { tool: 'outreach_referral_done', keywords: ['referred', 'I did both', 'referral done'] },
  scope: inWorkspace,
  emits: ['outreach.referral.done'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const at = changeMoment(ctx.meta);
    const row = await mine(ctx, me, input.referralId);
    if (row.state !== 'waiting' && row.state !== 'approved')
      return { referralId: row.id, state: row.state };
    const note = input.note ?? row.note;
    await ctx.tx
      .update(referrals)
      .set({
        state: 'done',
        doneAt: at,
        updatedAt: at,
        needs: null,
        ...(note && !row.notedAt ? { notedAt: at } : {}),
        ...(input.comment ? { comment: input.comment } : {}),
        ...(input.note ? { note: input.note } : {}),
      })
      .where(eq(referrals.id, row.id));
    await ctx.emit({
      type: 'outreach.referral.done',
      entityType: 'workspace',
      entityId: ctx.scope.workspaceId!,
      payload: { referralId: row.id, profileId: row.profileId, userId: me },
    });
    return { referralId: row.id, state: 'done' as const };
  },
});

export const referralSkip = defineAddonCommand(outreachAddon, {
  name: 'outreach.referral.skip',
  description:
    'Put a referral aside, waiting or about to be done for the person: nothing more is commented or sent, and it doesn’t come back.',
  risk: 0,
  input: ReferralSkipInput,
  output: ReferralChangeOutput,
  permission: 'outreach.use',
  ai: { tool: 'outreach_skip_referral', keywords: ['skip referral', 'not this one'] },
  scope: inWorkspace,
  emits: ['outreach.referral.skipped'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const at = changeMoment(ctx.meta);
    const row = await mine(ctx, me, input.referralId);
    if (row.state !== 'waiting' && row.state !== 'approved')
      return { referralId: row.id, state: row.state };
    await ctx.tx
      .update(referrals)
      .set({ state: 'skipped', skippedAt: at, updatedAt: at })
      .where(eq(referrals.id, row.id));
    await ctx.emit({
      type: 'outreach.referral.skipped',
      entityType: 'workspace',
      entityId: ctx.scope.workspaceId!,
      payload: { referralId: row.id },
    });
    return { referralId: row.id, state: 'skipped' as const };
  },
});

export const referralPosted = defineAddonCommand(outreachAddon, {
  name: 'outreach.referral.posted',
  description:
    'The person’s computer says how a referral it did went: the comment up (tagged or not) and the heads-up sent, and it’s done; or what couldn’t go and why, and it waits on Today for the person to finish by hand; or nothing to do there, and it’s put aside.',
  risk: 0,
  input: ReferralPostedInput,
  output: ReferralChangeOutput,
  permission: 'outreach.use',
  scope: inWorkspace,
  emits: ['outreach.referral.done', 'outreach.referral.skipped'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const at = changeMoment(ctx.meta);
    const row = await mine(ctx, me, input.referralId);
    // Put aside or done by hand meanwhile: nothing more to note.
    if (row.state !== 'approved') return { referralId: row.id, state: row.state };
    const ws = ctx.scope.workspaceId!;
    const commented = row.postedAt !== null || input.commented;
    const posted = row.postedAt ?? (input.commented ? at : null);
    const tagged = row.postedAt ? row.tagged : input.commented ? input.tagged : null;
    if (input.more && commented && row.note && !row.notedAt) {
      await ctx.tx
        .update(referrals)
        .set({ postedAt: posted, tagged, updatedAt: at })
        .where(eq(referrals.id, row.id));
      return { referralId: row.id, state: 'approved' as const };
    }
    if (input.skip && !commented) {
      await ctx.tx
        .update(referrals)
        .set({ state: 'skipped', skippedAt: at, updatedAt: at, needs: input.why })
        .where(eq(referrals.id, row.id));
      await ctx.emit({
        type: 'outreach.referral.skipped',
        entityType: 'workspace',
        entityId: ws,
        payload: { referralId: row.id, auto: true },
      });
      return { referralId: row.id, state: 'skipped' as const };
    }
    const noted = row.notedAt !== null || !row.note || input.noted;
    if (commented && noted) {
      await ctx.tx
        .update(referrals)
        .set({
          state: 'done',
          doneAt: at,
          updatedAt: at,
          postedAt: posted,
          tagged,
          needs: null,
          ...(row.note && !row.notedAt ? { notedAt: at } : {}),
        })
        .where(eq(referrals.id, row.id));
      await ctx.emit({
        type: 'outreach.referral.done',
        entityType: 'workspace',
        entityId: ws,
        payload: { referralId: row.id, profileId: row.profileId, userId: me, auto: true },
      });
      return { referralId: row.id, state: 'done' as const };
    }
    // What's left goes back to the person, with why.
    await ctx.tx
      .update(referrals)
      .set({
        state: 'waiting',
        updatedAt: at,
        postedAt: posted,
        tagged,
        needs: input.why ?? (commented ? 'the heads-up couldn’t go' : 'the comment couldn’t go'),
      })
      .where(eq(referrals.id, row.id));
    return { referralId: row.id, state: 'waiting' as const };
  },
});

export const referralList = defineAddonQuery(outreachAddon, {
  name: 'outreach.referrals',
  description:
    'The person’s referrals waiting for them or about to be done for them (Refer someone on Today): posts from the last week asking for a recommendation of what someone they talked with does, each with who, why, the comment naming them and the heads-up to them (null when they had one this week), whether their computer can do it for them (forYou: outreach_refer_for_me), whether the comment is up already (posted) and why one came back to them (needs). And the notes asking someone referred twice to send people their way too (asks: outreach_answer_refer_ask). By hand, the person does both, then outreach_referral_done notes it.',
  input: ReferralsInput,
  output: ReferralsOutput,
  permission: 'outreach.use',
  ai: {
    tool: 'outreach_referrals',
    keywords: ['refer', 'referral', 'recommend someone', 'who to refer'],
  },
  scope: inWorkspace,
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const found = await rows<{
      id: string;
      platform: Platform;
      post_id: string;
      post_url: string;
      body: string;
      asks: string | null;
      writer: string;
      profile_id: string;
      name: string;
      profile_url: string;
      person_on: Platform;
      why: string | null;
      comment: string;
      note: string | null;
      state: ReferralState;
      posted_at: Date | string | null;
      needs: string | null;
      created_at: Date | string;
    }>(
      ctx.tx,
      sql`select r.id, wp.platform, r.post_id, po.url as post_url, po.body, po.asks, wp.name as writer,
            r.profile_id, pr.name, pr.url as profile_url, pr.platform as person_on, r.why, r.comment, r.note, r.state,
            r.posted_at, r.needs, r.created_at
          from addon_outreach.referrals r
          join addon_outreach.posts po on po.id = r.post_id
          join addon_outreach.profiles wp on wp.id = po.profile_id
          join addon_outreach.profiles pr on pr.id = r.profile_id
          where r.workspace_id = ${ws} and r.user_id = ${me} and r.state in ('waiting', 'approved')
            and po.skipped_at is null
            and (r.posted_at is not null
              or po.seen_at >= now() - make_interval(days => ${REFER_POST_DAYS}::int))
            and not pr.dont_pitch and not pr.never_contact
            ${input.platform ? sql`and wp.platform = ${input.platform}` : sql``}
          order by r.created_at desc
          limit ${SHOWN_MOST}`,
    );
    const asks = await rows<{
      id: string;
      platform: Platform;
      profile_id: string;
      name: string;
      url: string;
      text: string;
      state: ReferralState;
      needs: string | null;
      referred: number;
      created_at: Date | string;
    }>(
      ctx.tx,
      sql`select a.id, pr.platform, a.profile_id, pr.name, pr.url, a.text, a.state, a.needs, a.created_at,
            (select count(*)::int from addon_outreach.referrals r
              where r.workspace_id = a.workspace_id and r.user_id = a.user_id and r.profile_id = a.profile_id
                and r.state = 'done') as referred
          from addon_outreach.refer_asks a
          join addon_outreach.profiles pr on pr.id = a.profile_id
          where a.workspace_id = ${ws} and a.user_id = ${me} and a.state in ('waiting', 'approved')
            and not pr.dont_pitch and not pr.never_contact
            ${input.platform ? sql`and pr.platform = ${input.platform}` : sql``}
          order by a.created_at desc
          limit ${SHOWN_MOST}`,
    );
    return {
      referrals: found.map((r) => {
        const { post, postWhole } = postParts(r.body, SEND_POST_MOST);
        return {
          referralId: r.id,
          platform: r.platform,
          postId: r.post_id,
          postUrl: r.post_url,
          post,
          postWhole,
          asks: r.asks,
          writer: r.writer,
          profileId: r.profile_id,
          name: r.name,
          profileUrl: r.profile_url,
          why: r.why,
          comment: r.comment,
          note: r.note,
          state: r.state,
          forYou: referForYou(r.platform, r.person_on),
          posted: r.posted_at !== null,
          needs: r.needs,
          createdAt: new Date(r.created_at).toISOString(),
        };
      }),
      asks: asks.map((a) => ({
        askId: a.id,
        platform: a.platform,
        profileId: a.profile_id,
        name: a.name,
        profileUrl: a.url,
        referred: a.referred,
        text: a.text,
        state: a.state,
        forYou: askForYou(a.platform),
        needs: a.needs,
        createdAt: new Date(a.created_at).toISOString(),
      })),
    };
  },
});

export const referralsDue = defineAddonQuery(outreachAddon, {
  name: 'outreach.referrals.due',
  description:
    'The referrals and asks after two the person’s computer does now on Facebook (decision 185): OK’d or under Autopilot, oldest first, as many referrals as the day’s comments leave room for (a referral’s comment counts as one), each with the post, whom it names and their chat. None with Sending off or after a warning today.',
  input: ReferralsDueInput,
  output: ReferralsDueOutput,
  permission: 'outreach.use',
  scope: inWorkspace,
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const now = Date.now();
    const none = { referrals: [], asks: [] };
    const { choices } = await automationOf(ctx, me, now, input.platform);
    if (choices.sending === 'off') return none;
    const todayStart = await startOfToday(ctx, now);
    const warning = await warningOf(ctx, me, input.platform, todayStart, now);
    if (warning?.today) return none;
    const [done, limits] = await Promise.all([
      dayCounts(ctx, [me], input.platform, todayStart).then((d) => d.get(me)!),
      limitsFor(ctx, me, slowsNow(warning, now), now, input.platform),
    ]);
    const room = Math.max(0, limits.comment - done.comment);
    const chatOf = (alias: string) =>
      sql`(select c.thread_key from addon_outreach.file_chats c
            where c.workspace_id = ${ws} and c.user_id = ${me} and c.profile_id = ${sql.raw(alias)}.id
              and c.thread_key is not null
            order by c.last_at desc limit 1)`;
    // Those whose comment is up already only have the heads-up left: they take no room.
    const found = await rows<{
      id: string;
      post_id: string;
      post_url: string;
      writer: string;
      writer_url: string;
      profile_id: string;
      name: string;
      url: string;
      platform_id: string | null;
      thread_key: string | null;
      comment: string;
      note: string | null;
      posted: boolean;
    }>(
      ctx.tx,
      sql`select r.id, r.post_id, po.url as post_url, wp.name as writer, wp.url as writer_url, r.profile_id,
            pr.name, pr.url, pr.platform_id, ${chatOf('pr')} as thread_key, r.comment,
            case when r.noted_at is null then r.note end as note, r.posted_at is not null as posted
          from addon_outreach.referrals r
          join addon_outreach.posts po on po.id = r.post_id
          join addon_outreach.profiles wp on wp.id = po.profile_id
          join addon_outreach.profiles pr on pr.id = r.profile_id
          where r.workspace_id = ${ws} and r.user_id = ${me} and r.state = 'approved'
            and wp.platform = ${input.platform} and pr.platform = ${input.platform}
            and po.skipped_at is null and not pr.dont_pitch and not pr.never_contact
            and (r.posted_at is not null
              or po.seen_at >= now() - make_interval(days => ${REFER_POST_DAYS}::int))
            and not ${heldSql('pr')}
          order by r.posted_at is null, r.updated_at
          limit 20`,
    );
    let left = room;
    const due = found.filter((r) => r.posted || left-- > 0);
    const asks = await rows<{
      id: string;
      profile_id: string;
      name: string;
      url: string;
      platform_id: string | null;
      thread_key: string | null;
      text: string;
    }>(
      ctx.tx,
      sql`select a.id, a.profile_id, pr.name, pr.url, pr.platform_id, ${chatOf('pr')} as thread_key, a.text
          from addon_outreach.refer_asks a
          join addon_outreach.profiles pr on pr.id = a.profile_id
          where a.workspace_id = ${ws} and a.user_id = ${me} and a.state = 'approved'
            and pr.platform = ${input.platform} and not pr.dont_pitch and not pr.never_contact
            and not ${heldSql('pr')}
          order by a.updated_at
          limit 20`,
    );
    return {
      referrals: due.map((r) =>
        DueReferral.parse({
          referralId: r.id,
          postId: r.post_id,
          postUrl: r.post_url,
          writer: r.writer,
          writerUrl: r.writer_url,
          profileId: r.profile_id,
          name: r.name,
          profileUrl: r.url,
          platformId: r.platform_id,
          threadKey: r.thread_key,
          comment: r.comment,
          note: r.note,
          posted: r.posted,
        }),
      ),
      asks: asks.map((a) =>
        DueAsk.parse({
          askId: a.id,
          profileId: a.profile_id,
          name: a.name,
          profileUrl: a.url,
          platformId: a.platform_id,
          threadKey: a.thread_key,
          text: a.text,
        }),
      ),
    };
  },
});

// ---- The ask after two (decision 185) ----

export const referAskSave = defineAddonCommand(outreachAddon, {
  name: 'outreach.refer_ask.save',
  description:
    'Worker: the note to someone the person referred twice, asking if they’d send people their way too or have a quick call, as the AI wrote it once the chat was quiet. It waits on Today, or under Autopilot on Facebook their computer sends it. Once a person, ever.',
  risk: 0,
  input: ReferAskSaveInput,
  output: ReferAskSaveOutput,
  permission: 'outreach.use',
  actors: ['system'],
  scope: inWorkspace,
  emits: ['outreach.refer_ask.found'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const person = await whoIs(ctx, input.profileId);
    if (!person) return { askId: null };
    const own = await onItsOwn(ctx, input.userId, askForYou(person.platform), input.profileId);
    const [made] = await ctx.tx
      .insert(referAsks)
      .values({
        workspaceId: ws,
        userId: input.userId,
        profileId: input.profileId,
        text: input.text,
        state: own ? 'approved' : 'waiting',
      })
      .onConflictDoNothing()
      .returning({ id: referAsks.id });
    if (!made) return { askId: null };
    await ctx.emit({
      type: 'outreach.refer_ask.found',
      entityType: 'workspace',
      entityId: ws,
      payload: { askId: made.id, userId: input.userId, profileId: input.profileId, approved: own },
    });
    return { askId: made.id };
  },
});

export const referAskAnswer = defineAddonCommand(outreachAddon, {
  name: 'outreach.refer_ask.answer',
  description:
    'The person’s answer to a note asking someone they referred twice to send people their way too: approve (Do it for me: their computer sends it on Facebook, as it stands or changed), done (they sent it themselves) or skip (it never comes back). Never sent to someone in a person’s hands.',
  risk: 1,
  input: ReferAskAnswerInput,
  output: ReferAskChangeOutput,
  permission: 'outreach.use',
  ai: {
    tool: 'outreach_answer_refer_ask',
    keywords: ['send people my way', 'ask them back', 'referral ask'],
  },
  scope: inWorkspace,
  emits: ['outreach.refer_ask.answered'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const at = changeMoment(ctx.meta);
    const row = await myAsk(ctx, me, input.askId);
    if (row.state !== 'waiting' && row.state !== 'approved')
      return { askId: row.id, state: row.state };
    const person = await whoIs(ctx, row.profileId);
    if (!person) throw HfosError.notFound('That person isn’t kept anymore. Reload the page.');
    const text = input.text ? { text: input.text } : {};
    let state: ReferralState;
    if (input.answer === 'approve') {
      if (row.state === 'approved') return { askId: row.id, state: row.state };
      if (!askForYou(person.platform)) throw byHand(person.name, 'isn’t there');
      if ((await heldAmong(ctx, [row.profileId])).has(row.profileId))
        throw heldRefusal(person.name);
      state = 'approved';
      await ctx.tx
        .update(referAsks)
        .set({ state, needs: null, updatedAt: at, ...text })
        .where(eq(referAsks.id, row.id));
    } else if (input.answer === 'done') {
      state = 'done';
      await ctx.tx
        .update(referAsks)
        .set({ state, doneAt: at, needs: null, updatedAt: at, ...text })
        .where(eq(referAsks.id, row.id));
    } else {
      state = 'skipped';
      await ctx.tx
        .update(referAsks)
        .set({ state, skippedAt: at, updatedAt: at })
        .where(eq(referAsks.id, row.id));
    }
    await ctx.emit({
      type: 'outreach.refer_ask.answered',
      entityType: 'workspace',
      entityId: ctx.scope.workspaceId!,
      payload: { askId: row.id, answer: input.answer },
    });
    return { askId: row.id, state };
  },
});

export const referAskSent = defineAddonCommand(outreachAddon, {
  name: 'outreach.refer_ask.sent',
  description:
    'The person’s computer says how an ask after two went: sent, and it’s done; or why not, and it waits on Today for the person to send by hand.',
  risk: 0,
  input: ReferAskSentInput,
  output: ReferAskChangeOutput,
  permission: 'outreach.use',
  scope: inWorkspace,
  emits: [],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const at = changeMoment(ctx.meta);
    const row = await myAsk(ctx, me, input.askId);
    if (row.state !== 'approved') return { askId: row.id, state: row.state };
    if (input.sent) {
      await ctx.tx
        .update(referAsks)
        .set({ state: 'done', sentAt: at, doneAt: at, needs: null, updatedAt: at })
        .where(eq(referAsks.id, row.id));
      return { askId: row.id, state: 'done' as const };
    }
    await ctx.tx
      .update(referAsks)
      .set({ state: 'waiting', needs: input.why ?? 'it couldn’t go', updatedAt: at })
      .where(eq(referAsks.id, row.id));
    return { askId: row.id, state: 'waiting' as const };
  },
});

export const referralCommands = [
  referralSave,
  referralApprove,
  referralDone,
  referralSkip,
  referralPosted,
  referAskSave,
  referAskAnswer,
  referAskSent,
] as const;
export const referralQueries = [referralList, referralsDue] as const;
