/**
 * Your messages, written by the AI (Get ready, docs/outreach.md decisions 65 to 67;
 * packages/core/src/addons/outreach/conversation.ts): sample messages for the person's playbook, as their messages will
 * read in their voice, to a made-up person in its niche (`outreach.messages.samples`). The first messages, the video
 * and the link, the follow-ups in turn and a check-in, from the business's live main offer. Kept on the person's setup
 * row (`outreach.messages.samples_save`) so the sheet opens without asking again; they OK the style there. It counts
 * against the business's daily AI limit like any other use.
 */
import {
  checkedSamples,
  MESSAGE_SAMPLES_SCHEMA,
  MESSAGE_SAMPLES_SYSTEM,
  MessageSamplesAnswer,
  messageSamplesPrompt,
  type MessageSamples,
} from '@hfos/core/addons/outreach/conversation';
import { voiceFor } from '@hfos/core/addons/outreach/ops/automation';
import { FOR_CUSTOMERS } from '@hfos/core/addons/outreach/ops/common';
import { messageSamplesSave } from '@hfos/core/addons/outreach/ops/readiness';
import {
  paceOf,
  PlaybookDetails,
  upgradePlaybookDetails,
} from '@hfos/core/addons/outreach/playbooks';
import { draftOfferOf } from '@hfos/core/addons/outreach/today';
import { voiceLines } from '@hfos/core/addons/outreach/voice';
import { executeCommand, HfosError, MainOfferParts } from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import { z } from 'zod';
import { askStructured } from '../../ai/ask';
import type { AddonWorkerAction } from '../types';
import { aiFailure } from './assist';

export const MESSAGE_SAMPLES_ACTION = 'outreach.messages.samples';

const SamplesInput = z.object({
  /** The playbook to write for: by default the first in use with a niche, by name. */
  playbookId: z.uuid().nullable().default(null),
});

export const messageSamples: AddonWorkerAction<z.input<typeof SamplesInput>> = {
  permission: 'outreach.use',
  input: SamplesInput,
  async run(ctx, raw): Promise<MessageSamples> {
    const input = SamplesInput.parse(raw);
    const ws = ctx.scope.workspaceId!;
    const found = await asWorker(ctx.db, ctx.scope, async (tx) => {
      const [business] = await rows<{ name: string }>(
        tx,
        sql`select name from app.workspaces where id = ${ws}`,
      );
      const [offer] = await rows<{ version: number; parts: unknown }>(
        tx,
        sql`select v.version, v.parts from app.main_offers o
            join app.main_offer_versions v on v.workspace_id = o.workspace_id and v.version = o.live_version
            where o.workspace_id = ${ws}`,
      );
      const playbooks = await rows<{ id: string; name: string; details: unknown }>(
        tx,
        sql`select id, name, details from addon_outreach.playbooks
            where workspace_id = ${ws} and archived_at is null and ${FOR_CUSTOMERS} order by name`,
      );
      return { business, offer, playbooks, voice: await voiceFor(tx, ws, ctx.userId) };
    });
    if (!found.offer)
      throw HfosError.rule(
        'outreach_messages_no_offer',
        422,
        'Your business’s main offer isn’t live yet, so there are no messages to write. Ask an owner of this business to finish it under Settings → Main offer.',
      );
    const playbooks = found.playbooks.flatMap((p) => {
      const read = PlaybookDetails.safeParse(upgradePlaybookDetails(p.details));
      return read.success ? [{ id: p.id, name: p.name, details: read.data }] : [];
    });
    const playbook = input.playbookId
      ? playbooks.find((p) => p.id === input.playbookId)
      : (playbooks.find((p) => p.details.niche) ?? playbooks[0]);
    if (!playbook)
      throw HfosError.notFound(
        'There’s no playbook to write messages for yet. Write one on the Playbooks tab first.',
      );
    const parts = MainOfferParts.safeParse(found.offer.parts);
    const offer = draftOfferOf(
      found.offer.version,
      parts.success ? parts.data : MainOfferParts.parse({}),
    );
    const d = playbook.details;
    const hasVideo = Boolean(
      d.videoLink ?? playbooks.find((p) => p.details.videoLink)?.details.videoLink,
    );
    const { followUps, followUpGaps } = paceOf(d.pace);
    let samples: MessageSamples | null;
    try {
      const { value } = await askStructured(ctx, ctx.scope, {
        system: MESSAGE_SAMPLES_SYSTEM,
        messages: [
          {
            role: 'user',
            content: messageSamplesPrompt({
              business: found.business?.name ?? 'the business',
              playbook: {
                name: playbook.name,
                niche: d.niche ?? null,
                problem: d.problem ?? null,
                tone: d.tone,
                samples: d.samples,
                avoid: d.avoid,
                disclaimer: d.disclaimer,
                usefulWhat: d.usefulWhat ?? null,
                hasVideo,
              },
              offer,
              followUps,
              voice: voiceLines(found.voice, true),
            }),
          },
        ],
        schema: MESSAGE_SAMPLES_SCHEMA,
        zod: MessageSamplesAnswer,
        maxTokens: 1500,
        usage: { source: 'addon', addonId: ctx.manifest.id },
      });
      samples = checkedSamples(value, {
        playbook: { id: playbook.id, name: playbook.name, hasVideo },
        avoid: d.avoid,
        followUps,
        followUpGaps,
        at: new Date(),
        version: found.offer.version,
      });
    } catch (e) {
      throw aiFailure(e);
    }
    if (!samples)
      throw HfosError.rule(
        'ai_failed',
        502,
        'The AI couldn’t write your samples just now. Try again in a minute.',
      );
    await executeCommand(
      ctx.db,
      messageSamplesSave,
      { workspaceId: ws, userId: ctx.userId, samples },
      ctx.actor,
      ctx.meta,
    );
    return samples;
  },
};
