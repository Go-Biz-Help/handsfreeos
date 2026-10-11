/**
 * Helpful posts in the groups (docs/outreach.md, decision 50): when the person asks for the day's
 * (`outreach.helpful.asked`), the AI writes one for the group picked, from the playbook and what people there asked
 * lately (the posts kept from it), after reading the group's About tab and rules; or says the rules don't allow one.
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
  HELPFUL_SCHEMA,
  HELPFUL_SYSTEM,
  HelpfulAnswer,
  type HelpfulDraftInput,
  helpfulPrompt,
} from '@hfos/core/addons/outreach/helpful';
import { helpfulDraft } from '@hfos/core/addons/outreach/ops/helpful';
import { PlaybookDetails, upgradePlaybookDetails } from '@hfos/core/addons/outreach/playbooks';
import { executeCommand } from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import type { JobResult } from '../../jobs';
import { AiAskError, askStructured } from '../../ai/ask';
import { scheduleAddonJob } from '../queue';
import type { AddonEventContext, AddonJobContext } from '../types';

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
      group_id: string;
      group_name: string | null;
      about: string[];
      rules: string[];
      playbook_name: string | null;
      details: unknown;
    }>(
      tx,
      sql`select h.id, h.group_id, g.name as group_name, g.about, g.rules, pb.name as playbook_name, pb.details
          from addon_outreach.helpful h
          join addon_outreach.groups g on g.id = h.group_id
          left join addon_outreach.playbooks pb on pb.id = h.playbook_id
          where h.workspace_id = ${ws} and h.state = 'drafting'
          order by h.asked_at limit ${DRAFT_BATCH + 1}`,
    );
    const asked = new Map<string, string[]>();
    for (const groupId of new Set(waiting.map((w) => w.group_id)))
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
    return { business: business?.name ?? 'the business', waiting, asked };
  });
  for (const h of found.waiting.slice(0, DRAFT_BATCH)) {
    const read = h.details ? PlaybookDetails.safeParse(upgradePlaybookDetails(h.details)) : null;
    let draft: HelpfulDraftInput['draft'];
    try {
      const { value } = await askStructured(ctx, ctx.scope, {
        system: HELPFUL_SYSTEM,
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
              group: { name: h.group_name, about: h.about, rules: h.rules },
              asked: found.asked.get(h.group_id) ?? [],
            }),
          },
        ],
        schema: HELPFUL_SCHEMA,
        zod: HelpfulAnswer,
        maxTokens: 700,
        usage: { source: 'addon', addonId: ctx.manifest.id },
      });
      draft = checkedHelpful(value);
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
