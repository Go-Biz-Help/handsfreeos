/**
 * A partner's messages for Today (docs/outreach.md, decision 81; `outreach.today.draft` with a partner's kind): the ask,
 * a follow-up, the details after a yes, and replies. Written by the AI in the person's voice from what the partner
 * check said of them (their kind, audience and why), the partner playbook's words, who the business helps, the chat so
 * far and what the extension looked up on their profile just before. Core holds what the model is asked
 * (packages/core/src/addons/outreach/partners.ts `partnerDraftPrompt`) and checks what it answers.
 *
 * For a reply, the AI also reads their answer to the ask (yes, a question, not now, no), which moves them along the
 * Partners list (`outreach.partner.answer`); a yes is drafted as the details instead, and said so (`kind`). Every one
 * waits for the person's OK, one at a time (packages/core/src/addons/outreach/sends.ts `goesAsItIs`).
 */
import { demoLink, partnerRef } from '@hfos/core/addons/outreach/demos';
import type { DownloadMessage } from '@hfos/core/addons/outreach/download';
import type { Platform } from '@hfos/core/addons/outreach/networks';
import { voiceFor } from '@hfos/core/addons/outreach/ops/automation';
import { partnerAnswer } from '@hfos/core/addons/outreach/ops/partners';
import {
  partnerAnswerOf,
  partnerDraftPrompt,
  type PartnerKind,
} from '@hfos/core/addons/outreach/partners';
import {
  forPartners,
  PlaybookDetails,
  upgradePlaybookDetails,
} from '@hfos/core/addons/outreach/playbooks';
import {
  checkedDrafts,
  DRAFTS_FOR,
  TODAY_DRAFT_SCHEMA,
  TodayDraftAnswer,
  todayDraftSystem,
  type PartnerMessageKind,
  type TodayDraftInput,
  type TodayDraftOutput,
} from '@hfos/core/addons/outreach/today';
import { executeCommand, HfosError, MainOfferParts } from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import { askStructured } from '../../ai/ask';
import type { AddonScopeContext } from '../types';

/** A partner's message: the drafts, and for a reply what they answered, a yes drafted as the details. */
export async function partnerDraft(
  ctx: AddonScopeContext & { readonly userId: string },
  input: TodayDraftInput & { readonly kind: PartnerMessageKind },
): Promise<TodayDraftOutput> {
  const ws = ctx.scope.workspaceId!;
  const profileId = input.profileId;
  if (!profileId)
    throw HfosError.notFound('That partner isn’t on your list anymore. Reload Today.');
  const found = await asWorker(ctx.db, ctx.scope, async (tx) => {
    const [business] = await rows<{ name: string }>(
      tx,
      sql`select name from app.workspaces where id = ${ws}`,
    );
    // The person's own row: each person's Partners list is their own.
    const [partner] = await rows<{
      name: string;
      platform: Platform;
      intro: string[];
      kind: PartnerKind;
      audience: string | null;
      why: string[];
      follow_ups: number;
      playbook_id: string | null;
    }>(
      tx,
      sql`select p.name, p.platform, p.intro, pa.kind, pa.audience, pa.why, pa.follow_ups, pa.playbook_id
          from addon_outreach.partners pa join addon_outreach.profiles p on p.id = pa.profile_id
          where pa.workspace_id = ${ws} and pa.user_id = ${ctx.userId} and pa.profile_id = ${profileId}
            and pa.stage is not null`,
    );
    const [chat] = await rows<{ recent: DownloadMessage[] }>(
      tx,
      sql`select recent from addon_outreach.file_chats
          where workspace_id = ${ws} and profile_id = ${profileId} and user_id = ${ctx.userId}
          order by last_at desc limit 1`,
    );
    const [last] = await rows<{ at: Date | string | null }>(
      tx,
      sql`select greatest(
            (select max(c.last_at) from addon_outreach.file_chats c
              where c.profile_id = ${profileId} and c.user_id = ${ctx.userId}),
            (select max(t.at) from addon_outreach.touches t
              where t.profile_id = ${profileId} and t.user_id = ${ctx.userId} and t.kind = 'message')) as at`,
    );
    const playbooks = await rows<{ id: string; name: string; details: unknown }>(
      tx,
      sql`select id, name, details from addon_outreach.playbooks
          where workspace_id = ${ws} and archived_at is null order by name`,
    );
    const [offer] = await rows<{ parts: unknown }>(
      tx,
      sql`select v.parts from app.main_offers o
          join app.main_offer_versions v on v.workspace_id = o.workspace_id and v.version = o.live_version
          where o.workspace_id = ${ws}`,
    );
    return {
      business,
      partner,
      recent: chat?.recent ?? [],
      lastAt: last?.at ?? null,
      playbooks,
      offer,
      voice: await voiceFor(tx, ws, ctx.userId),
    };
  });
  const partner = found.partner;
  if (!partner) throw HfosError.notFound('That partner isn’t on your list anymore. Reload Today.');
  // The partner playbook they fit, else the first in use.
  const books = found.playbooks.flatMap((p) => {
    const read = PlaybookDetails.safeParse(upgradePlaybookDetails(p.details));
    return read.success && forPartners(read.data) ? [{ id: p.id, name: p.name, ...read.data }] : [];
  });
  const book = books.find((b) => b.id === partner.playbook_id) ?? books[0] ?? null;
  // The partner link (decision 81): a call booked through it is theirs, never a demo.
  const link = book ? demoLink(book.link, partnerRef(ctx.userId, profileId)) : null;
  const parts = found.offer ? MainOfferParts.safeParse(found.offer.parts) : null;
  const helps = parts?.success ? parts.data.line?.trim() || null : null;
  const draft = async (kind: PartnerMessageKind) => {
    const { value } = await askStructured(ctx, ctx.scope, {
      system: todayDraftSystem(partner.platform),
      messages: [
        {
          role: 'user',
          content: partnerDraftPrompt({
            kind,
            business: found.business?.name ?? 'the business',
            name: partner.name,
            helps,
            partner: { kind: partner.kind, audience: partner.audience, why: partner.why },
            facts: partner.intro,
            recent: found.recent,
            playbook: book
              ? {
                  name: book.name,
                  offer: book.offer,
                  audience: book.audience,
                  tone: book.tone,
                  samples: book.samples,
                  avoid: book.avoid,
                  disclaimer: book.disclaimer,
                  link,
                }
              : null,
            followUps: partner.follow_ups,
            lookup: input.lookup,
            voice: found.voice,
            lastAt: found.lastAt,
            platform: partner.platform,
          }),
        },
      ],
      schema: TODAY_DRAFT_SCHEMA,
      zod: TodayDraftAnswer,
      maxTokens: 800,
      usage: { source: 'addon', addonId: ctx.manifest.id },
    });
    const drafts = checkedDrafts(value, book?.avoid ?? [], DRAFTS_FOR[kind], found.voice.split);
    // The details always carry the partner link: one the AI left out goes on the end.
    return {
      value,
      drafts:
        kind === 'partner_details' && link
          ? drafts.map((d) => (d.includes(link) ? d : `${d}\n\n${link}`))
          : drafts,
    };
  };
  let kind: PartnerMessageKind = input.kind;
  let made = await draft(kind);
  // A reply: what they answered moves them along the list, and a yes gets the details instead.
  const answer = partnerAnswerOf(kind, made.value, found.recent);
  if (answer) {
    const moved = await executeCommand(
      ctx.db,
      partnerAnswer,
      { workspaceId: ws, userId: ctx.userId, profileId, answer },
      ctx.actor,
      ctx.meta,
    );
    if (answer === 'yes' && moved.output.stage === 'interested') {
      kind = 'partner_details';
      made = await draft(kind);
    }
  }
  return { kind, answer, drafts: made.drafts, opener: null, simple: false };
}
