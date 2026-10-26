/**
 * Your messages, written by the AI (Get ready, docs/outreach.md decisions 65 to 67;
 * packages/core/src/addons/outreach/conversation.ts): sample messages for the person's playbook, as their messages will
 * read in their voice, to a made-up person in its niche (`outreach.messages.samples`). The first messages, the video
 * and the link, the follow-ups in turn and a check-in, from the business's live main offer. Kept on the person's setup
 * row (`outreach.messages.samples_save`) so the sheet opens without asking again; they OK the style there. It counts
 * against the business's daily AI limit like any other use.
 *
 * The person's own say (decision 87): what they told the AI of each part is followed, and the ones they wrote
 * themselves stay as they are. Not quite right? on one (`outreach.messages.rewrite`) writes that one again with their
 * note, which is kept for its part (`outreach.messages.rewrite_save`).
 */
import {
  checkedRewrite,
  checkedSamples,
  isMine,
  MESSAGE_REWRITE_SCHEMA,
  MESSAGE_REWRITE_SYSTEM,
  MESSAGE_SAMPLES_SCHEMA,
  MESSAGE_SAMPLES_SYSTEM,
  messageNotesOf,
  MessageRewriteAnswer,
  MessageRewriteInput,
  messageRewritePrompt,
  MessageSamples,
  MessageSamplesAnswer,
  messageSamplesPrompt,
  noSample,
  sampleAt,
  slotKey,
  slotsOf,
  withNote,
  type MessageNotes,
  type SamplesFacts,
} from '@hfos/core/addons/outreach/conversation';
import { voiceFor } from '@hfos/core/addons/outreach/ops/automation';
import { FOR_CUSTOMERS } from '@hfos/core/addons/outreach/ops/common';
import { messageRewriteSave, messageSamplesSave } from '@hfos/core/addons/outreach/ops/readiness';
import {
  paceOf,
  PlaybookDetails,
  upgradePlaybookDetails,
} from '@hfos/core/addons/outreach/playbooks';
import { noteOf } from '@hfos/core/addons/outreach/profile-parts';
import type { ReadinessOutput } from '@hfos/core/addons/outreach/readiness';
import { draftOfferOf } from '@hfos/core/addons/outreach/today';
import { voiceLines } from '@hfos/core/addons/outreach/voice';
import { executeCommand, HfosError, MainOfferParts } from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import { z } from 'zod';
import { askStructured } from '../../ai/ask';
import type { AddonWorkerAction } from '../types';
import { aiFailure } from './assist';

export const MESSAGE_SAMPLES_ACTION = 'outreach.messages.samples';
export const MESSAGE_REWRITE_ACTION = 'outreach.messages.rewrite';

type Ctx = Parameters<AddonWorkerAction['run']>[0];

const SamplesInput = z.object({
  /** The playbook to write for: by default the first in use with a niche, by name. */
  playbookId: z.uuid().nullable().default(null),
});

/**
 * What the samples are written from: the business, the live main offer, the playbook (the one asked for, else the
 * first in use with a niche; for one sample written again, the samples' own while it's in use), the person's voice,
 * and their own say so far (their samples and notes, decision 87).
 */
async function samplesFrom(ctx: Ctx, asked: { playbookId: string | null } | 'samples') {
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
    const [said] = await rows<{ message_samples: unknown; message_notes: unknown }>(
      tx,
      sql`select message_samples, message_notes from addon_outreach.setup
          where workspace_id = ${ws} and user_id = ${ctx.userId}`,
    );
    return { business, offer, playbooks, said, voice: await voiceFor(tx, ws, ctx.userId) };
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
  const samples = MessageSamples.safeParse(found.said?.message_samples ?? null).data ?? null;
  const first = playbooks.find((p) => p.details.niche) ?? playbooks[0];
  const playbook =
    asked === 'samples'
      ? (playbooks.find((p) => p.id === samples?.playbookId) ?? first)
      : asked.playbookId
        ? playbooks.find((p) => p.id === asked.playbookId)
        : first;
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
  const notes: MessageNotes = messageNotesOf(found.said?.message_notes);
  const facts: SamplesFacts = {
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
    notes,
  };
  return { version: found.offer.version, playbook, hasVideo, followUpGaps, samples, notes, facts };
}

export const messageSamples: AddonWorkerAction<z.input<typeof SamplesInput>> = {
  permission: 'outreach.use',
  ai: {
    tool: 'outreach_write_sample_messages',
    description:
      "The AI writes the person's sample messages for one playbook, in their voice, from the live main offer: the first message, the video, the link, the follow-ups and a check-in. They're kept for Get ready's Your messages, replacing the samples there (the ones they wrote themselves stay), and the person OKs the style with outreach_ok_message_samples. Nothing is sent.",
    autonomy: 'auto',
    keywords: ['sample messages', 'write my messages', 'how my messages read'],
  },
  input: SamplesInput,
  async run(ctx, raw): Promise<MessageSamples> {
    const input = SamplesInput.parse(raw);
    const {
      version,
      playbook,
      hasVideo,
      followUpGaps,
      samples: before,
      facts,
    } = await samplesFrom(ctx, { playbookId: input.playbookId });
    // The ones the person wrote themselves, for the same playbook: the rest are written in line with them.
    const mine =
      before && before.playbookId === playbook.id
        ? slotsOf(before)
            .filter((slot) => isMine(before, slot))
            .map((slot) => ({ slot, text: sampleAt(before, slot)! }))
        : [];
    let samples: MessageSamples | null;
    try {
      const { value } = await askStructured(ctx, ctx.scope, {
        system: MESSAGE_SAMPLES_SYSTEM,
        messages: [{ role: 'user', content: messageSamplesPrompt({ ...facts, mine }) }],
        schema: MESSAGE_SAMPLES_SCHEMA,
        zod: MessageSamplesAnswer,
        maxTokens: 1500,
        usage: { source: 'addon', addonId: ctx.manifest.id },
      });
      samples = checkedSamples(value, {
        playbook: { id: playbook.id, name: playbook.name, hasVideo },
        avoid: playbook.details.avoid,
        followUps: facts.followUps,
        followUpGaps,
        at: new Date(),
        version,
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
    // Kept with the person's own put back where they wrote them (the command's `withMineKept`).
    const { output } = await executeCommand(
      ctx.db,
      messageSamplesSave,
      { workspaceId: ctx.scope.workspaceId!, userId: ctx.userId, samples },
      ctx.actor,
      ctx.meta,
    );
    return output.messages.samples ?? samples;
  },
};

/**
 * Not quite right? (decision 87): one sample written again, unlike it and the rest, following what the person said of
 * its part (the chips they tapped and their own words, kept as one note) and what they said before. Refused for
 * samples of an earlier main offer, which are written again whole first.
 */
export const messageRewrite: AddonWorkerAction<MessageRewriteInput> = {
  permission: 'outreach.use',
  ai: {
    tool: 'outreach_rewrite_sample_message',
    description:
      "The AI writes one of the person's sample messages again (part and, for a follow-up, its index) with their note on what they want, and keeps the note for that part so their real messages follow it too. Nothing is sent.",
    autonomy: 'auto',
    keywords: ['not quite right', 'rewrite message', 'change a sample'],
  },
  input: MessageRewriteInput,
  async run(ctx, raw): Promise<ReadinessOutput> {
    const input = MessageRewriteInput.parse(raw);
    const slot = { part: input.part, index: input.index };
    const { version, playbook, hasVideo, samples, notes, facts } = await samplesFrom(
      ctx,
      'samples',
    );
    if (!samples)
      throw HfosError.rule(
        'outreach_messages_unseen',
        422,
        'There are no sample messages to change yet. Press Write samples under Your messages first.',
      );
    const before = sampleAt(samples, slot);
    if (before === null) {
      const why = noSample(samples, slot, {
        has: hasVideo,
        playbook: playbook.id === samples.playbookId ? playbook.name : null,
      });
      throw HfosError.rule(why.rule, 409, why.message);
    }
    if (samples.version !== version)
      throw HfosError.rule(
        'outreach_messages_older',
        409,
        'These samples were written for an earlier version of your main offer. Write them all again first, then change one.',
      );
    const note = noteOf(input.chips, input.note);
    const others = slotsOf(samples)
      .filter((s) => slotKey(s) !== slotKey(slot))
      .map((s) => ({ slot: s, text: sampleAt(samples, s)! }));
    let text: string | null;
    try {
      const { value } = await askStructured(ctx, ctx.scope, {
        system: MESSAGE_REWRITE_SYSTEM,
        messages: [
          {
            role: 'user',
            content: messageRewritePrompt({
              ...facts,
              notes: withNote(notes, slot.part, note),
              slot,
              before,
              others,
            }),
          },
        ],
        schema: MESSAGE_REWRITE_SCHEMA,
        zod: MessageRewriteAnswer,
        maxTokens: 600,
        usage: { source: 'addon', addonId: ctx.manifest.id },
      });
      text = checkedRewrite(value.message, {
        avoid: facts.playbook.avoid,
        before,
        others: others.map((o) => o.text),
      });
    } catch (e) {
      throw aiFailure(e);
    }
    if (!text)
      throw HfosError.rule(
        'ai_failed',
        502,
        'The AI couldn’t write it again just now. Try again in a minute, or change it yourself.',
      );
    const { output } = await executeCommand(
      ctx.db,
      messageRewriteSave,
      { workspaceId: ctx.scope.workspaceId!, userId: ctx.userId, ...slot, text, note },
      ctx.actor,
      ctx.meta,
    );
    return output;
  },
};
