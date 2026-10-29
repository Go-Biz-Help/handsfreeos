/**
 * Helpful posts in the groups (docs/outreach.md, decision 50): when the person asks for the day's
 * (`outreach.helpful.asked`), the AI writes one for the group picked, from the playbook and what people there asked
 * lately (the posts kept from it), after reading the group's About tab and rules; or says the rules don't allow one.
 * Off Facebook it goes on the person's own feed; on Instagram it's the week's caption and the picture to take for it
 * (decision 109).
 * It writes from what the business knows too: its profile and Knowledge (decision 122, ./knows.ts).
 * Core holds what the model is asked and what it may answer (packages/core/src/addons/outreach/helpful.ts), and
 * `outreach.helpful.draft` keeps it.
 *
 * - One job per business takes every post being written, the oldest first.
 * - At the day's AI limit they wait a few hours; an answer it can't use, or a link in it, marks that one as couldn't
 *   be written, which frees the day's slot for another try.
 */
import {
  checkedHelpful,
  HELPFUL_ASKED_MOST,
  helpfulSchemaOn,
  helpfulSystem,
  HelpfulAnswer,
  type HelpfulDraftInput,
  helpfulPrompt,
} from '@hfos/core/addons/outreach/helpful';
import { helpfulDraft } from '@hfos/core/addons/outreach/ops/helpful';
import { PlaybookDetails, upgradePlaybookDetails } from '@hfos/core/addons/outreach/playbooks';
import { executeCommand } from '@hfos/core/server';
import type { Platform } from '@hfos/core/addons/outreach/networks';
import { asWorker, rows, sql } from '@hfos/db/client';
import type { JobResult } from '../../jobs';
import { AiAskError, askStructured } from '../../ai/ask';
import { scheduleAddonJob } from '../queue';
import type { AddonEventContext, AddonJobContext } from '../types';
import { businessKnows } from './knows';

export const DRAFT_HELPFUL_JOB = 'outreach.draft_helpful';
/** How many one job writes before it comes back for the rest. */
const DRAFT_BATCH = 10;
const HOUR = 3_600_000;

/** `outreach.helpful.asked`: the AI writes it now. */
export async function helpfulAsked(ctx: AddonEventContext): Promise<void> {
  await asWorker(ctx.db, ctx.scope, (tx) =>
    scheduleAddonJob(
      tx,
      { id: ctx.manifest.id, generation: ctx.generation },
      {
        kind: DRAFT_HELPFUL_JOB,
        dedupeKey: `${DRAFT_HELPFUL_JOB}:${ctx.scope.workspaceId}`,
        runAt: new Date(),
        payload: {},
        workspaceId: ctx.scope.workspaceId,
        organizationId: ctx.scope.organizationId,
      },
      { pullEarlier: true },
    ),
  );
}

/** `outreach.draft_helpful`: writes the business's helpful posts being written, and comes back for the rest. */
export async function draftHelpfulJob(ctx: AddonJobContext): Promise<JobResult> {
  const ws = ctx.scope.workspaceId;
  const found = await asWorker(ctx.db, ctx.scope, async (tx) => {
    const [business] = await rows<{ name: string }>(
      tx,
      sql`select name from app.workspaces where id = ${ws}`,
    );
    const waiting = await rows<{
      id: string;
      user_id: string;
      platform: Platform;
      group_id: string | null;
      group_name: string | null;
      about: string[] | null;
      rules: string[] | null;
      playbook_name: string | null;
      details: unknown;
      emoji: boolean | null;
    }>(
      tx,
      // Each post in its own person's voice (voice.ts): an emoji or none.
      sql`select h.id, h.user_id, h.platform, h.group_id, g.name as group_name, g.about, g.rules,
            pb.name as playbook_name, pb.details, au.voice_emoji as emoji
          from addon_outreach.helpful h
          left join addon_outreach.groups g on g.id = h.group_id
          left join addon_outreach.playbooks pb on pb.id = h.playbook_id
          left join addon_outreach.automation au on au.workspace_id = h.workspace_id and au.user_id = h.user_id
          where h.workspace_id = ${ws} and h.state = 'drafting'
          order by h.asked_at limit ${DRAFT_BATCH + 1}`,
    );
    const asked = new Map<string, string[]>();
    for (const groupId of new Set(waiting.flatMap((w) => (w.group_id ? [w.group_id] : []))))
      asked.set(
        groupId,
        (
          await rows<{ body: string }>(
            tx,
            sql`select body from addon_outreach.posts where group_id = ${groupId}
                order by seen_at desc limit ${HELPFUL_ASKED_MOST}`,
          )
        ).map((p) => p.body),
      );
    // Off Facebook it goes on the person's own feed: what people there asked is in the posts their search found.
    for (const w of waiting)
      if (!w.group_id)
        asked.set(
          `${w.user_id}:${w.platform}`,
          (
            await rows<{ body: string }>(
              tx,
              sql`select po.body from addon_outreach.posts po
                  join addon_outreach.profiles pr on pr.id = po.profile_id
                  where po.workspace_id = ${ws} and po.user_id = ${w.user_id} and pr.platform = ${w.platform}
                  order by po.seen_at desc limit ${HELPFUL_ASKED_MOST}`,
            )
          ).map((p) => p.body),
        );
    return { business: business?.name ?? 'the business', waiting, asked };
  });
  // What the business knows (decision 122): its profile and Knowledge, read once for every post in the batch.
  const knows = found.waiting.length ? await businessKnows(ctx) : null;
  for (const h of found.waiting.slice(0, DRAFT_BATCH)) {
    const read = h.details ? PlaybookDetails.safeParse(upgradePlaybookDetails(h.details)) : null;
    let draft: HelpfulDraftInput['draft'];
    try {
      const { value } = await askStructured(ctx, ctx.scope, {
        system: helpfulSystem(h.platform),
        messages: [
          {
            role: 'user',
            content: helpfulPrompt({
              business: found.business,
              playbook:
                read?.success && h.playbook_name
                  ? {
                      name: h.playbook_name,
                      offer: read.data.offer,
                      audience: read.data.audience,
                      tone: read.data.tone,
                    }
                  : null,
              group: h.group_id
                ? { name: h.group_name, about: h.about ?? [], rules: h.rules ?? [] }
                : null,
              platform: h.platform,
              asked: found.asked.get(h.group_id ?? `${h.user_id}:${h.platform}`) ?? [],
              emoji: h.emoji ?? false,
              // On Instagram a few of the playbook's own hashtags may close it (decision 109).
              hashtags:
                h.platform === 'instagram' && read?.success ? (read.data.hashtags ?? []) : [],
              knows,
            }),
          },
        ],
        schema: helpfulSchemaOn(h.platform),
        zod: HelpfulAnswer,
        maxTokens: 700,
        usage: { source: 'addon', addonId: ctx.manifest.id },
      });
      draft = checkedHelpful(value, h.platform);
    } catch (e) {
      if (!(e instanceof AiAskError)) throw e;
      if (e.code === 'budget_reached' || e.code === 'wallet_empty')
        return { rescheduleAt: new Date(ctx.now + 6 * HOUR) };
      if (e.retryable) {
        if (ctx.attempt < 3) throw e;
        return { rescheduleAt: new Date(ctx.now + HOUR) };
      }
      draft = null;
    }
    await executeCommand(
      ctx.db,
      helpfulDraft,
      { workspaceId: ws, helpfulId: h.id, draft },
      ctx.actor,
      ctx.meta,
    );
  }
  if (found.waiting.length > DRAFT_BATCH) return { rescheduleAt: new Date(ctx.now) };
}
