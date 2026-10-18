/**
 * The AI's check of group posts worth a look (docs/outreach.md, decisions 18 and 19): whether each is someone the
 * business could help, with why. Core holds what the model is asked and what it may answer
 * (packages/core/src/addons/outreach/posts.ts), and `outreach.post.check` saves it.
 *
 * - Posts kept as worth a look (`outreach.posts.saved`) queue one check per business, so a feed read in a few
 *   scrolls is checked once.
 * - Each check takes a batch, the newest first. At the day's AI limit the rest wait a few hours; an answer it can't
 *   use marks that post as failed rather than trying it forever.
 * - A post the AI calls strong, its writer asking now for what the business offers (`outreach.post.checked`, decision
 *   49), pushes to the person who found it at once when it's fresh: "Dana Reyes is asking for what you offer". Once a
 *   post, on their add-ons switch, opening Today, where it's first.
 */
import { PlaybookDetails, upgradePlaybookDetails } from '@hfos/core/addons/outreach/playbooks';
import { FOR_CUSTOMERS } from '@hfos/core/addons/outreach/ops/common';
import { postCheck } from '@hfos/core/addons/outreach/ops/posts';
import {
  checkedPostWhy,
  freshPost,
  type PostFound,
  POST_CHECK_SCHEMA,
  postCheckSystem,
  PostCheckAnswer,
  postCheckPrompt,
  type PostCheckPlaybook,
  strongPostPushWords,
} from '@hfos/core/addons/outreach/posts';
import { executeCommand } from '@hfos/core/server';
import type { Platform } from '@hfos/core/addons/outreach/networks';
import { asWorker, rows, sql } from '@hfos/db/client';
import type { JobResult } from '../../jobs';
import { AiAskError, askStructured } from '../../ai/ask';
import { pushAddonNotice } from '../alerts';
import { scheduleAddonJob } from '../queue';
import type { AddonEventContext, AddonJobContext } from '../types';

export const CHECK_POSTS_JOB = 'outreach.check_posts';
const TODAY_HREF = '/a/outreach?view=today';
/** How many posts one check takes. */
export const CHECK_POSTS_BATCH = 20;
const HOUR = 3_600_000;

/** `outreach.posts.saved`: the posts waiting are checked now. */
export async function postsSaved(ctx: AddonEventContext): Promise<void> {
  await asWorker(ctx.db, ctx.scope, (tx) =>
    scheduleAddonJob(
      tx,
      { id: ctx.manifest.id, generation: ctx.generation },
      {
        kind: CHECK_POSTS_JOB,
        dedupeKey: `${CHECK_POSTS_JOB}:${ctx.scope.workspaceId}`,
        runAt: new Date(),
        payload: {},
        workspaceId: ctx.scope.workspaceId,
        organizationId: ctx.scope.organizationId,
      },
      { pullEarlier: true },
    ),
  );
}

/** `outreach.check_posts`: checks a batch of the business's waiting posts, and comes back for the rest. */
export async function checkPostsJob(ctx: AddonJobContext): Promise<JobResult> {
  const found = await asWorker(ctx.db, ctx.scope, async (tx) => ({
    business: (
      await rows<{ name: string }>(
        tx,
        sql`select name from app.workspaces where id = ${ctx.scope.workspaceId}`,
      )
    )[0],
    posts: await rows<{ id: string; body: string; group: string | null; platform: Platform }>(
      tx,
      sql`select po.id, po.body, g.name as group, pr.platform from addon_outreach.posts po
          join addon_outreach.profiles pr on pr.id = po.profile_id
          left join addon_outreach.groups g on g.id = po.group_id
          where po.workspace_id = ${ctx.scope.workspaceId} and po.check_state = 'waiting'
          order by po.seen_at desc limit ${CHECK_POSTS_BATCH + 1}`,
    ),
    playbooks: await rows<{ name: string; details: unknown }>(
      tx,
      sql`select name, details from addon_outreach.playbooks
          where workspace_id = ${ctx.scope.workspaceId} and archived_at is null and ${FOR_CUSTOMERS}
          order by created_at`,
    ),
  }));
  if (!found.posts.length) return;
  const playbooks: PostCheckPlaybook[] = found.playbooks.flatMap((p) => {
    const read = PlaybookDetails.safeParse(upgradePlaybookDetails(p.details));
    return read.success
      ? [
          {
            name: p.name,
            offer: read.data.offer,
            audience: read.data.audience,
            signs: read.data.signs,
            skip: read.data.skip,
          },
        ]
      : [];
  });

  for (const post of found.posts.slice(0, CHECK_POSTS_BATCH)) {
    let check: { good: boolean; strong: boolean; why: string | null } | null;
    try {
      const { value } = await askStructured(ctx, ctx.scope, {
        system: postCheckSystem(post.platform),
        messages: [
          {
            role: 'user',
            content: postCheckPrompt({
              business: found.business?.name ?? 'the business',
              group: post.group,
              text: post.body,
              playbooks,
            }),
          },
        ],
        schema: POST_CHECK_SCHEMA,
        zod: PostCheckAnswer,
        maxTokens: 200,
        usage: { source: 'addon', addonId: ctx.manifest.id },
      });
      check = { good: value.good, strong: value.strong, why: checkedPostWhy(value.why) };
    } catch (e) {
      if (!(e instanceof AiAskError)) throw e;
      // The day's limit or an empty balance: the rest wait a few hours. Not set up: they wait for the next save.
      if (e.code === 'budget_reached' || e.code === 'wallet_empty')
        return { rescheduleAt: new Date(ctx.now + 6 * HOUR) };
      if (e.code === 'ai_unavailable') return;
      // A busy model is worth another try; one still busy waits an hour.
      if (e.retryable) {
        if (ctx.attempt < 3) throw e;
        return { rescheduleAt: new Date(ctx.now + HOUR) };
      }
      check = null;
    }
    await executeCommand(
      ctx.db,
      postCheck,
      { workspaceId: ctx.scope.workspaceId, postId: post.id, check },
      ctx.actor,
      ctx.meta,
    );
  }
  if (found.posts.length > CHECK_POSTS_BATCH) return { rescheduleAt: new Date(ctx.now) };
}

/** `outreach.post.checked`: a strong post that's fresh pushes to the person who found it, once. */
export async function postChecked(ctx: AddonEventContext): Promise<void> {
  const p = (ctx.event.payload ?? {}) as { postId?: string; check?: string; strong?: boolean };
  if (p.check !== 'good' || !p.strong || !p.postId) return;
  const postId = p.postId;
  await asWorker(ctx.db, ctx.scope, async (tx) => {
    const [post] = await rows<{
      user_id: string;
      posted: string | null;
      found: PostFound;
      check_why: string | null;
      name: string;
      person_id: string | null;
      group: string | null;
      skipped: boolean;
    }>(
      tx,
      sql`select po.user_id, po.posted, po.found, po.check_why, pr.name, pr.person_id, g.name as group,
            po.skipped_at is not null as skipped
          from addon_outreach.posts po
          join addon_outreach.profiles pr on pr.id = po.profile_id
          left join addon_outreach.groups g on g.id = po.group_id
          where po.workspace_id = ${ctx.scope.workspaceId} and po.id = ${postId}`,
    );
    // Put aside already, or days old by the time anyone looked: Today has it, without a buzz.
    if (!post || post.skipped || !freshPost(post)) return;
    await pushAddonNotice(ctx, tx, {
      key: `post:${postId}`,
      userIds: [post.user_id],
      permission: 'outreach.use',
      ...strongPostPushWords(post.name, post.group, post.check_why),
      href: TODAY_HREF,
      collapseKey: `post-${postId}`,
      personId: post.person_id,
    });
  });
}
