/**
 * Referring people the person talked with on posts asking for a recommendation (../referrals.ts, docs/outreach.md
 * decision 174): each person's own. The worker finds someone to refer on a post and the AI writes the comment and the
 * heads-up (`outreach.referral.save`); Today shows them, waiting for the person (`outreach.referrals`), who does both by
 * hand and says so (`outreach.referral.done`), or puts it aside (`outreach.referral.skip`).
 */
import { and, eq, sql } from 'drizzle-orm';
import { rows } from '@hfos/db/client';
import { HfosError } from '../../../errors';
import { requireHuman } from '../../../kernel/actor';
import { changeMoment } from '../../../kernel/moment';
import { defineAddonCommand, defineAddonQuery } from '../../server';
import { outreachAddon } from '../manifest';
import type { Platform } from '../networks';
import {
  REFER_POST_DAYS,
  ReferralChangeOutput,
  ReferralDoneInput,
  ReferralSaveInput,
  ReferralSaveOutput,
  ReferralSkipInput,
  ReferralsInput,
  ReferralsOutput,
  type ReferralState,
} from '../referrals';
import { postParts, SEND_POST_MOST } from '../sends';
import { posts, referrals } from '../tables';
import { inWorkspace, type Ctx } from './common';

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

export const referralSave = defineAddonCommand(outreachAddon, {
  name: 'outreach.referral.save',
  description:
    'Worker: someone the person talked with to refer under a post asking for a recommendation of what they do, with why, the comment naming them and the heads-up to them, as the AI wrote them. It waits on Today for the person. One a post.',
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
      .select({ id: posts.id, userId: posts.userId, skippedAt: posts.skippedAt })
      .from(posts)
      .where(and(eq(posts.workspaceId, ws), eq(posts.id, input.postId)));
    // Gone, or put aside since the worker looked: nothing to refer on.
    if (!post || post.skippedAt) return { referralId: null };
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
      })
      .onConflictDoNothing()
      .returning({ id: referrals.id });
    if (!made) return { referralId: null };
    await ctx.emit({
      type: 'outreach.referral.found',
      entityType: 'workspace',
      entityId: ws,
      payload: { referralId: made.id, postId: post.id, userId: post.userId },
    });
    return { referralId: made.id };
  },
});

export const referralDone = defineAddonCommand(outreachAddon, {
  name: 'outreach.referral.done',
  description:
    'The person commented on the post naming someone they talked with, and sent that person the heads-up: the referral is noted as done, with the words they sent when they changed them.',
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
    if (row.state !== 'waiting') return { referralId: row.id, state: row.state };
    await ctx.tx
      .update(referrals)
      .set({
        state: 'done',
        doneAt: at,
        updatedAt: at,
        ...(input.comment ? { comment: input.comment } : {}),
        ...(input.note ? { note: input.note } : {}),
      })
      .where(eq(referrals.id, row.id));
    await ctx.emit({
      type: 'outreach.referral.done',
      entityType: 'workspace',
      entityId: ctx.scope.workspaceId!,
      payload: { referralId: row.id, profileId: row.profileId },
    });
    return { referralId: row.id, state: 'done' as const };
  },
});

export const referralSkip = defineAddonCommand(outreachAddon, {
  name: 'outreach.referral.skip',
  description: 'Put a referral aside: nothing is commented or sent, and it doesn’t come back.',
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
    if (row.state !== 'waiting') return { referralId: row.id, state: row.state };
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

export const referralList = defineAddonQuery(outreachAddon, {
  name: 'outreach.referrals',
  description:
    'The person’s referrals waiting for them (Refer someone on Today): posts from the last week asking for a recommendation of what someone they talked with does, each with who, why, the comment naming them and the heads-up to them. Nothing is posted or sent: the person does both, then outreach_referral_done notes it.',
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
      why: string | null;
      comment: string;
      note: string;
      state: ReferralState;
      created_at: Date | string;
    }>(
      ctx.tx,
      sql`select r.id, wp.platform, r.post_id, po.url as post_url, po.body, po.asks, wp.name as writer,
            r.profile_id, pr.name, pr.url as profile_url, r.why, r.comment, r.note, r.state, r.created_at
          from addon_outreach.referrals r
          join addon_outreach.posts po on po.id = r.post_id
          join addon_outreach.profiles wp on wp.id = po.profile_id
          join addon_outreach.profiles pr on pr.id = r.profile_id
          where r.workspace_id = ${ws} and r.user_id = ${me} and r.state = 'waiting'
            and po.skipped_at is null
            and po.seen_at >= now() - make_interval(days => ${REFER_POST_DAYS}::int)
            and not pr.dont_pitch and not pr.never_contact
            ${input.platform ? sql`and wp.platform = ${input.platform}` : sql``}
          order by r.created_at desc
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
          createdAt: new Date(r.created_at).toISOString(),
        };
      }),
    };
  },
});

export const referralCommands = [referralSave, referralDone, referralSkip] as const;
export const referralQueries = [referralList] as const;
