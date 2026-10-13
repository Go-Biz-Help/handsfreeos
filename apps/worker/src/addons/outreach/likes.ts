/**
 * Which of someone's posts to like before their friend request (`outreach.like.pick`; docs/outreach.md, decision 33):
 * the extension sends the few latest posts on their profile that are theirs, and the AI picks one to do with the
 * business, else one about them, never one about grief, illness, trouble, politics or religion. Without the AI (its
 * limit for the day, not set up, or busy) the words alone pick: a like is a small step, and shouldn't wait on it.
 * Nothing is saved here: the extension likes the one picked and notes it with why.
 *
 * Core holds what the model is asked and checks what it answers (packages/core/src/addons/outreach/like-pick.ts).
 */
import {
  checkedLikePick,
  fallbackLikePick,
  LIKE_PICK_SCHEMA,
  LIKE_PICK_SYSTEM,
  LikePickAnswer,
  LikePickInput,
  likePickPrompt,
  type LikePickOutput,
} from '@hfos/core/addons/outreach/like-pick';
import { asWorker, rows, sql } from '@hfos/db/client';
import { AiAskError, askStructured } from '../../ai/ask';
import type { AddonWorkerAction } from '../types';
import { playbooksOf } from './groups';

export const LIKE_PICK_ACTION = 'outreach.like.pick';

export const likePick: AddonWorkerAction<LikePickInput> = {
  permission: 'outreach.use',
  input: LikePickInput,
  async run(ctx, raw): Promise<LikePickOutput> {
    const input = LikePickInput.parse(raw);
    const ws = ctx.scope.workspaceId!;
    const found = await asWorker(ctx.db, ctx.scope, async (tx) => ({
      business: (
        await rows<{ name: string }>(tx, sql`select name from app.workspaces where id = ${ws}`)
      )[0],
      profile: (
        await rows<{ name: string | null }>(
          tx,
          sql`select name from addon_outreach.profiles
              where workspace_id = ${ws} and id = ${input.profileId}`,
        )
      )[0],
      playbooks: await playbooksOf(tx, ws),
    }));
    try {
      const { value } = await askStructured(ctx, ctx.scope, {
        system: LIKE_PICK_SYSTEM,
        messages: [
          {
            role: 'user',
            content: likePickPrompt({
              business: found.business?.name ?? 'the business',
              playbooks: found.playbooks.map((p) => ({
                offer: p.details.offer,
                audience: p.details.audience,
                area: p.details.area,
              })),
              name: found.profile?.name ?? null,
              posts: input.posts,
            }),
          },
        ],
        schema: LIKE_PICK_SCHEMA,
        zod: LikePickAnswer,
        maxTokens: 200,
        usage: { source: 'addon', addonId: ctx.manifest.id },
      });
      return checkedLikePick(value, input.posts);
    } catch (e) {
      if (!(e instanceof AiAskError)) throw e;
      return fallbackLikePick(input.posts);
    }
  },
};
