/**
 * Drafts for Today (docs/outreach.md; `outreach.today.draft`): a first message to a new friend that asks about the
 * main offer (decision 65), a message to a friend who fits to reconnect with (decision 46), the video and the link
 * (decision 66), a follow-up or a monthly check-in (decision 67), a reply, or a comment on a group post, written by the
 * AI in the playbook's tone from the main offer's words (the version they were first pitched with), what's known
 * about the person (what the AI made of them when it checked them too), the chat or post so far, what the extension
 * looked up on their profile and business page just before (decision 21), and what the person said of that part of
 * their messages in Your messages, with the ones they wrote themselves (decision 87). Core holds what the model is
 * asked and checks what it answers (packages/core/src/addons/outreach/today.ts).
 *
 * For a reply, the AI also reads their answer to the person's last step (yes, a question, not now, no), which is kept
 * for their conversation (`outreach.answer.note`); a yes is drafted as the next step instead, Send the video or Send
 * the link, and said so (`kind`). It also says whether a reply is simple (decision 27), never for someone who needs the
 * person (`replyNeedsYou`). Nothing else is saved or sent here: the person copies the one they like, or the extension
 * hands it to `outreach.send.queue`.
 */
import {
  messageNotesOf,
  MessageSamples,
  ownWordsFor,
  stepAfterYes,
  type ConversationStep,
} from '@hfos/core/addons/outreach/conversation';
import { FOR_CUSTOMERS } from '@hfos/core/addons/outreach/ops/common';
import { demoLink, demoRef } from '@hfos/core/addons/outreach/demos';
import { bestFit } from '@hfos/core/addons/outreach/fit';
import type { DownloadMessage } from '@hfos/core/addons/outreach/download';
import {
  nextOpener,
  openerKey,
  openersOf,
  ownOpenerFits,
  ownOpenerText,
  type Opener,
  type OpenerKind,
} from '@hfos/core/addons/outreach/openers';
import { voiceFor } from '@hfos/core/addons/outreach/ops/automation';
import { answerNote } from '@hfos/core/addons/outreach/ops/conversation';
import {
  paceOf,
  PlaybookDetails,
  runsOn,
  upgradePlaybookDetails,
} from '@hfos/core/addons/outreach/playbooks';
import { replyNeedsYou } from '@hfos/core/addons/outreach/sends';
import {
  answerOf,
  checkedDrafts,
  draftOfferOf,
  DRAFTS_FOR,
  fitsRequests,
  isPartnerKind,
  TODAY_DRAFT_SCHEMA,
  todayDraftSystem,
  TodayDraftAnswer,
  TodayDraftInput,
  todayDraftPrompt,
  type CustomerDraftKind,
  type DraftOffer,
  type TodayDraftOutput,
} from '@hfos/core/addons/outreach/today';
import { executeCommand, HfosError, MainOfferParts } from '@hfos/core/server';
import { NETWORKS, type Platform } from '@hfos/core/addons/outreach/networks';
import { asWorker, rows, sql } from '@hfos/db/client';
import {
  AI_BUDGET_MESSAGE,
  AI_BUSY_MESSAGE,
  AI_UNAVAILABLE_MESSAGE,
  AiAskError,
  askStructured,
} from '../../ai/ask';
import type { AddonWorkerAction } from '../types';
import { partnerDraft } from './partner-drafts';

export const TODAY_DRAFT_ACTION = 'outreach.today.draft';

export const todayDraft: AddonWorkerAction<TodayDraftInput> = {
  permission: 'outreach.use',
  ai: {
    tool: 'outreach_draft_message',
    description:
      "Draft a message for someone the person reached, as Draft a message on Today does: up to three drafts from the AI in the playbook's tone, for a first message, a reconnect, a pitch, a follow-up, a reply (with the chat) or a comment (with the post). Nothing is sent: the person copies one and sends it, then outreach_note_sent notes it.",
    autonomy: 'auto',
    keywords: ['draft a message', 'write a first message', 'draft a reply', 'draft a comment'],
  },
  input: TodayDraftInput,
  async run(ctx, raw): Promise<TodayDraftOutput> {
    const input = TodayDraftInput.parse(raw);
    // A partner's message (decision 81) is written about partnering only (./partner-drafts.ts).
    if (isPartnerKind(input.kind))
      try {
        return await partnerDraft(ctx, { ...input, kind: input.kind });
      } catch (e) {
        throw draftRefusal(e);
      }
    const ws = ctx.scope.workspaceId!;
    const found = await asWorker(ctx.db, ctx.scope, async (tx) => {
      const [business] = await rows<{ name: string }>(
        tx,
        sql`select name from app.workspaces where id = ${ws}`,
      );
      const [chat] = input.chatId
        ? await rows<{ name: string; profile_id: string | null; recent: DownloadMessage[] }>(
            tx,
            // The person's own chats only: nobody else sees them.
            sql`select name, profile_id, recent from addon_outreach.file_chats
                where workspace_id = ${ws} and id = ${input.chatId} and user_id = ${ctx.userId}`,
          )
        : input.profileId && input.kind !== 'comment' && input.kind !== 'warm_lead'
          ? // No chat named: their latest with the person, as the extension just brought it in for a reply.
            await rows<{ name: string; profile_id: string | null; recent: DownloadMessage[] }>(
              tx,
              sql`select name, profile_id, recent from addon_outreach.file_chats
                  where workspace_id = ${ws} and profile_id = ${input.profileId} and user_id = ${ctx.userId}
                  order by last_at desc limit 1`,
            )
          : [];
      const [post] = input.postId
        ? await rows<{ profile_id: string; body: string; group: string | null }>(
            tx,
            // The person's own posts only, like their chats.
            sql`select po.profile_id, po.body, g.name as group from addon_outreach.posts po
                left join addon_outreach.groups g on g.id = po.group_id
                where po.workspace_id = ${ws} and po.id = ${input.postId} and po.user_id = ${ctx.userId}`,
          )
        : [];
      const profileId = input.profileId ?? chat?.profile_id ?? post?.profile_id ?? null;
      // A warm lead (decision 50): their latest comment on one of the person's own helpful posts, and that post.
      const [engaged] =
        input.kind === 'warm_lead' && profileId
          ? await rows<{ comment: string; body: string | null; group: string | null }>(
              tx,
              sql`select e.comment, h.body, g.name as group from addon_outreach.engagements e
                  join addon_outreach.helpful h on h.id = e.helpful_id
                  left join addon_outreach.groups g on g.id = h.group_id
                  where e.workspace_id = ${ws} and e.user_id = ${ctx.userId} and e.profile_id = ${profileId}
                    and e.kind = 'comment' and e.comment is not null
                  order by e.seen_at desc limit 1`,
            )
          : [];
      const [profile] = profileId
        ? await rows<{
            name: string;
            platform: Platform;
            intro: string[];
            mutual_friends: number | null;
            group: string | null;
          }>(
            tx,
            sql`select p.name, p.platform, p.intro, p.mutual_friends, g.name as group
                from addon_outreach.profiles p left join addon_outreach.groups g on g.id = p.group_id
                where p.workspace_id = ${ws} and p.id = ${profileId}`,
          )
        : [];
      const lines = profileId
        ? await rows<{ lines: string[] }>(
            tx,
            sql`select lines from addon_outreach.group_people where profile_id = ${profileId}
                order by seen_at desc limit 1`,
          )
        : [];
      const playbooks = await rows<{ id: string; name: string; details: unknown }>(
        tx,
        sql`select id, name, details from addon_outreach.playbooks
            where workspace_id = ${ws} and archived_at is null and ${FOR_CUSTOMERS}`,
      );
      // What the AI made of them when it checked them (decision 46): the person's own.
      const [check] = profileId
        ? await rows<{ about: string | null; why: string[]; next_step: string | null }>(
            tx,
            sql`select about, why, next_step from addon_outreach.checks
                where workspace_id = ${ws} and profile_id = ${profileId} and user_id = ${ctx.userId}
                  and verdict in ('good', 'maybe')`,
          )
        : [];
      // When they last wrote to each other, either way, for a greeting after a gap: in a chat, or a message noted.
      const [last] = profileId
        ? await rows<{ at: Date | string | null }>(
            tx,
            sql`select greatest(
                  (select max(c.last_at) from addon_outreach.file_chats c
                    where c.profile_id = ${profileId} and c.user_id = ${ctx.userId}),
                  (select max(t.at) from addon_outreach.touches t
                    where t.profile_id = ${profileId} and t.user_id = ${ctx.userId} and t.kind = 'message')) as at`,
          )
        : [];
      // Where their conversation with the person is (decisions 65 to 67), and the main offer's words for it: the
      // version they were first pitched with, else the live one.
      const [conversation] = profileId
        ? await rows<{ step: ConversationStep; sent: number; offer_version: number | null }>(
            tx,
            sql`select step, sent, offer_version from addon_outreach.follow_ups
                where workspace_id = ${ws} and user_id = ${ctx.userId} and profile_id = ${profileId}`,
          )
        : [];
      // Where the person stands with them on their network: on a follow network, someone who hasn't followed back gets
      // their first message in their Requests (core's `TodayItem.requests`).
      const [friend] = profileId
        ? await rows<{ state: string }>(
            tx,
            sql`select state from addon_outreach.friends
                where workspace_id = ${ws} and user_id = ${ctx.userId} and profile_id = ${profileId}`,
          )
        : [];
      const [offer] = await rows<{ version: number; parts: unknown }>(
        tx,
        sql`select v.version, v.parts from app.main_offer_versions v
            where v.workspace_id = ${ws} and v.version = coalesce(${conversation?.offer_version ?? null}::int,
              (select live_version from app.main_offers where workspace_id = ${ws}))`,
      );
      // What the person told the AI of their messages, and the ones they wrote themselves (decision 87).
      const [said] = await rows<{ message_samples: unknown; message_notes: unknown }>(
        tx,
        sql`select message_samples, message_notes from addon_outreach.setup
            where workspace_id = ${ws} and user_id = ${ctx.userId}`,
      );
      return {
        business,
        chat,
        post,
        engaged,
        profile,
        lines: lines[0]?.lines ?? [],
        playbooks,
        check,
        voice: await voiceFor(tx, ws, ctx.userId),
        lastAt: last?.at ?? null,
        conversation: conversation ?? null,
        offer: offer ?? null,
        friendState: friend?.state ?? null,
        samples: MessageSamples.safeParse(said?.message_samples ?? null).data ?? null,
        notes: messageNotesOf(said?.message_notes),
      };
    });
    const name = found.profile?.name ?? found.chat?.name;
    if (input.kind === 'comment' && !found.post)
      throw HfosError.notFound('That post isn’t on your list anymore. Reload Today.');
    if (input.kind === 'warm_lead' && !found.engaged)
      throw HfosError.notFound('Their comment isn’t on your list anymore. Reload Today.');
    if (!name) throw HfosError.notFound('That person isn’t on your list anymore. Reload Today.');
    const facts = [
      ...found.lines,
      ...(found.profile?.intro ?? []),
      ...(found.profile?.group ? [`Found in the group ${found.profile.group}`] : []),
      ...(found.check?.about ? [found.check.about] : []),
      ...(found.check?.why ?? []),
      ...(found.check?.next_step ? [`A good first step: ${found.check.next_step}`] : []),
    ];
    const kept = found.playbooks.flatMap((p) => {
      const read = PlaybookDetails.safeParse(upgradePlaybookDetails(p.details));
      return read.success ? [{ id: p.id, name: p.name, details: read.data }] : [];
    });
    // The playbooks that run on their network (data version 7), or every one when none does: a draft asked for by hand
    // is written all the same.
    const onIt = kept.filter((p) => runsOn(p.details, found.profile?.platform ?? 'facebook'));
    const playbooks = onIt.length ? onIt : kept;
    const fit = bestFit(playbooks, {
      lines: [...facts, ...input.lookup, ...(found.post ? [found.post.body] : [])],
      mutualFriends: found.profile?.mutual_friends ?? null,
      groupName: found.profile?.group ?? null,
    });
    const playbook = playbooks.find((p) => p.id === fit.playbookId) ?? playbooks[0] ?? null;
    // A first message takes the next of the playbook's openers in turn (decision 23).
    let opener: Opener | null = null;
    if (input.kind === 'opener' && playbook) {
      const used = await asWorker(ctx.db, ctx.scope, (tx) =>
        rows<{ kind: OpenerKind; text: string; n: number }>(
          tx,
          sql`select kind, text, count(*)::int as n from addon_outreach.opener_uses
              where workspace_id = ${ws} and user_id = ${ctx.userId} and playbook_id = ${playbook.id}
              group by kind, text`,
        ),
      );
      const counts = new Map<string, number>();
      for (const u of used) counts.set(openerKey(u), (counts.get(openerKey(u)) ?? 0) + u.n);
      opener = nextOpener(openersOf(playbook.details), counts);
    }
    // The main offer's words for the conversation: the version they were first pitched with, or the live one.
    const parts = found.offer ? MainOfferParts.safeParse(found.offer.parts) : null;
    const offer: DraftOffer | null =
      found.offer && parts?.success ? draftOfferOf(found.offer.version, parts.data) : null;
    // A first message on a follow network (Instagram's) to someone who hasn't followed the person back lands in their
    // Requests: one short text, with no link and no video (core's `REQUESTS_TASK`).
    const toRequests =
      input.kind === 'opener' &&
      found.profile !== undefined &&
      NETWORKS[found.profile.platform].requestsMessageAfterDays !== null &&
      found.friendState !== 'friends';
    // One of the business's own openers goes as written, with their first name and the offer's words in: no AI. One
    // that names the offer's words when there are none is written by the AI instead, and so is one too long for their
    // Requests, or with a link.
    if (opener?.kind === 'own' && !ownOpenerFits(opener.text, offer)) opener = null;
    if (
      opener?.kind === 'own' &&
      toRequests &&
      !fitsRequests(ownOpenerText(opener.text, name, offer))
    )
      opener = null;
    const drafted = opener && playbook ? { playbookId: playbook.id, ...opener } : null;
    if (opener?.kind === 'own')
      return {
        kind: input.kind,
        answer: null,
        drafts: [ownOpenerText(opener.text, name, offer)],
        opener: drafted,
        simple: false,
      };
    // The playbook's link, as the person's demo link for them (decision 24).
    const profileId = input.profileId ?? found.chat?.profile_id ?? found.post?.profile_id ?? null;
    const link =
      playbook && profileId
        ? demoLink(playbook.details.link, demoRef(ctx.userId, profileId))
        : (playbook?.details.link ?? null);
    // The short video (decision 66): this playbook's, else the first in use with one, as Today picks it.
    const videoLink =
      playbook?.details.videoLink ??
      [...playbooks].sort((a, b) => a.name.localeCompare(b.name)).find((p) => p.details.videoLink)
        ?.details.videoLink ??
      null;
    const recent = found.chat?.recent ?? [];
    const conversation = found.conversation
      ? {
          step: found.conversation.step,
          sent: found.conversation.sent,
          followUps: paceOf(playbook?.details.pace ?? null).followUps,
        }
      : null;
    // The network the message goes on: the profile's.
    const platform = found.profile?.platform ?? 'facebook';
    const draft = async (kind: CustomerDraftKind) => {
      const { value } = await askStructured(ctx, ctx.scope, {
        system: todayDraftSystem(platform),
        messages: [
          {
            role: 'user',
            content: todayDraftPrompt({
              kind,
              business: found.business?.name ?? 'the business',
              name,
              facts,
              recent,
              playbook: playbook
                ? { name: playbook.name, ...playbook.details, link, videoLink }
                : null,
              offer,
              conversation,
              post: found.engaged
                ? {
                    text: `Your post: ${found.engaged.body ?? ''}\n\nTheir comment: ${found.engaged.comment}`,
                    group: found.engaged.group,
                  }
                : found.post
                  ? { text: found.post.body, group: found.post.group }
                  : null,
              lookup: input.lookup,
              opener,
              voice: found.voice,
              lastAt: found.lastAt,
              platform,
              requests: toRequests,
              own: ownWordsFor(
                kind,
                found.samples,
                found.notes,
                found.conversation,
                playbook?.id ?? null,
              ),
            }),
          },
        ],
        schema: TODAY_DRAFT_SCHEMA,
        zod: TodayDraftAnswer,
        maxTokens: 800,
        usage: { source: 'addon', addonId: ctx.manifest.id },
      });
      const checked = checkedDrafts(
        value,
        playbook?.details.avoid ?? [],
        DRAFTS_FOR[kind],
        found.voice.split && kind !== 'comment' && kind !== 'warm_lead' && !toRequests,
      );
      // To their Requests: only one short text with no link goes.
      const drafts = toRequests && kind === 'opener' ? checked.filter(fitsRequests) : checked;
      // The link always goes with the link and the video with the video (decisions 47 and 66): one the AI left out
      // goes on the end.
      const must = kind === 'pitch' ? link : kind === 'video' ? videoLink : null;
      return {
        value,
        drafts: must ? drafts.map((d) => (d.includes(must) ? d : `${d}\n\n${must}`)) : drafts,
      };
    };
    try {
      let kind: CustomerDraftKind = input.kind;
      let made = await draft(kind);
      // A reply: what they answered to the person's last step is kept, and a yes gets the next step instead.
      const answer = answerOf(kind, made.value, recent);
      if (answer && profileId) {
        await executeCommand(
          ctx.db,
          answerNote,
          {
            workspaceId: ws,
            userId: ctx.userId,
            profileId,
            answer,
            writtenAt: recent.at(-1)?.at ?? null,
          },
          ctx.actor,
          ctx.meta,
        );
        const next =
          answer === 'yes' && found.conversation
            ? stepAfterYes(found.conversation.step, videoLink !== null)
            : null;
        if (next) {
          kind = next;
          made = await draft(kind);
        }
      }
      const theirs = [...recent].reverse().find((m) => !m.fromMe)?.text ?? null;
      return {
        kind,
        answer,
        drafts: made.drafts,
        opener: drafted,
        simple: kind === 'reply' && made.value.simple && theirs !== null && !replyNeedsYou(theirs),
      };
    } catch (e) {
      throw draftRefusal(e);
    }
  },
};

/** What the person reads when the AI couldn't write a draft, and what to do. */
function draftRefusal(e: unknown): unknown {
  if (!(e instanceof AiAskError)) return e;
  if (e.code === 'budget_reached' || e.code === 'wallet_empty')
    return HfosError.rule('budget_reached', 429, e.message || AI_BUDGET_MESSAGE);
  if (e.code === 'ai_unavailable')
    return HfosError.rule('ai_not_configured', 503, AI_UNAVAILABLE_MESSAGE);
  if (e.retryable) return HfosError.rule('ai_busy', 503, AI_BUSY_MESSAGE);
  return HfosError.rule(
    'ai_failed',
    502,
    'The AI couldn’t write that just now. Try again, or write it yourself.',
  );
}
