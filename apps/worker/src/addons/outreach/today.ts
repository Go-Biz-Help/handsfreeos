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
 * A reply, a follow-up or a check-in to someone who said no, or not now, before (their answer kept, their chat read as
 * not interested, or marked not a fit) carries nothing that pitches, and the AI reads the whole chat, never only their
 * last message: a chat that has come to a close gets a short sign-off at most (decision 134).
 *
 * For a reply, the AI also reads their answer to the person's last step (yes, a question, not now, no), which is kept
 * for their conversation (`outreach.answer.note`); a yes is drafted as the next step instead, Send the video or Send
 * the link, and said so (`kind`), but never for a client in Contacts (decision 91), whose drafts carry no link. It also says whether a reply is simple (decision 27), never for someone who needs the
 * person (`replyNeedsYou`). Nothing else is saved or sent here: the person copies the one they like, or the extension
 * hands it to `outreach.send.queue`.
 *
 * After a demo booked through the person's link (decision 106): a short reminder the day before, with its day and time
 * on the business's calendar, and after a no-show a kind message offering another time, with the link to book again.
 * A birthday or a new job read on the person's computer (decision 108): a short, warm note with nothing about the
 * business and no link, the new job in the page's words.
 *
 * When the playbook's link is one of the business's own booking pages (decision 149, ./times.ts): Send the link, the
 * follow-up after it, Offer another time and a reply offer three of its open times, with the link for any other, and a
 * reply where they picked one and gave an email or a mobile number confirms it. What they offer and book is kept with
 * the drafts, checked again, and booked, before the message queued from one of them goes (./times-check.ts).
 */
import {
  ANSWERS,
  messageNotesOf,
  MessageSamples,
  ownWordsFor,
  samplesNow,
  stepAfterYes,
  type Answer,
  type ConversationStep,
  type OwnWords,
} from '@hfos/core/addons/outreach/conversation';
import { outreachSettings } from '@hfos/core/addons/outreach/chat-read';
import {
  fitsVideos,
  libraryOf,
  sentLinks,
  videoFits,
  type DraftVideos,
} from '@hfos/core/addons/outreach/video-library';
import { FOR_CUSTOMERS, isClient } from '@hfos/core/addons/outreach/ops/common';
import { demoLink, demoRef } from '@hfos/core/addons/outreach/demos';
import { bestFit } from '@hfos/core/addons/outreach/fit';
import type { DownloadMessage } from '@hfos/core/addons/outreach/download';
import type { PitchRead } from '@hfos/core/addons/outreach/stages';
import {
  nextOpener,
  openerKey,
  openersOf,
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
import { underAPost } from '@hfos/core/addons/outreach/automation';
import { replyNeedsYou } from '@hfos/core/addons/outreach/sends';
import {
  answerOf,
  checkedDrafts,
  draftOfferOf,
  demoWhen,
  DRAFTS_FOR,
  firstStepFact,
  fitsComment,
  fitsGroupReply,
  fitsOccasion,
  fitsRequests,
  isOccasionKind,
  isPartnerKind,
  knowsFor,
  TODAY_DRAFT_SCHEMA,
  todayDraftSystem,
  WARM_COMMENTS_SAID,
  TodayDraftAnswer,
  TodayDraftInput,
  todayDraftPrompt,
  unansweredOf,
  withoutStockPraise,
  type CustomerDraftKind,
  type DraftOffer,
  type TodayDraftOutput,
} from '@hfos/core/addons/outreach/today';
import { contactIn, isTimeKind, openTimeOf } from '@hfos/core/addons/outreach/meeting-times';
import { executeCommand, HfosError, listsOf, MainOfferParts } from '@hfos/core/server';
import { NETWORKS, type Platform } from '@hfos/core/addons/outreach/networks';
import { asWorker, rows, sql } from '@hfos/db/client';
import {
  AI_BUDGET_MESSAGE,
  AI_BUSY_MESSAGE,
  AI_UNAVAILABLE_MESSAGE,
  AiAskError,
  askedTwice,
  askStructured,
} from '../../ai/ask';
import type { AddonScopeContext, AddonWorkerAction } from '../types';
import { VOICE_DEFAULTS } from '@hfos/core/addons/outreach/voice';
import { groupNamesIn, namesAGroup, withoutGroupLines } from '@hfos/core/addons/outreach/no-groups';
import { businessKnows } from './knows';
import { partnerDraft } from './partner-drafts';
import {
  bookingOf,
  draftTimes,
  keepTimes,
  meetingFor,
  offeredWords,
  type Meeting,
} from './times';

export const TODAY_DRAFT_ACTION = 'outreach.today.draft';

/** A chat a draft reads: who, its latest messages, and the AI's read of whether it's time to offer, with why. */
type ChatRow = {
  name: string;
  profile_id: string | null;
  recent: DownloadMessage[];
  pitch: PitchRead | null;
  pitch_why: string | null;
};

export const todayDraft: AddonWorkerAction<TodayDraftInput> = {
  permission: 'outreach.use',
  ai: {
    tool: 'outreach_draft_message',
    description:
      "Draft a message for someone the person reached, as Draft a message on Today does: up to three drafts from the AI in the playbook's tone, for a first message, a reconnect, a pitch, a follow-up, a reply (with the chat), a demo's reminder, another time after a missed demo, a birthday or new-job note, a comment (with the post), or a reply to a question asked in one of the person’s Facebook groups (with the post). Nothing is sent: the person copies one and sends it, then outreach_note_sent notes it.",
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
      const [business] = await rows<{ name: string; timezone: string | null }>(
        tx,
        sql`select name, timezone from app.workspaces where id = ${ws}`,
      );
      const [chat] = input.chatId
        ? await rows<ChatRow>(
            tx,
            // The person's own chats only: nobody else sees them.
            sql`select name, profile_id, recent, pitch, pitch_why from addon_outreach.file_chats
                where workspace_id = ${ws} and id = ${input.chatId} and user_id = ${ctx.userId}`,
          )
        : input.profileId && !underAPost(input.kind) && input.kind !== 'warm_lead'
          ? // No chat named: their latest with the person, as the extension just brought it in for a reply.
            await rows<ChatRow>(
              tx,
              sql`select name, profile_id, recent, pitch, pitch_why from addon_outreach.file_chats
                  where workspace_id = ${ws} and profile_id = ${input.profileId} and user_id = ${ctx.userId}
                  order by last_at desc limit 1`,
            )
          : [];
      const [post] = input.postId
        ? await rows<{
            profile_id: string;
            body: string;
            group: string | null;
            warm_up: boolean;
            strong: boolean;
          }>(
            tx,
            // The person's own posts only, like their chats.
            sql`select po.profile_id, po.body, g.name as group, po.warm_up, po.strong from addon_outreach.posts po
                left join addon_outreach.groups g on g.id = po.group_id
                where po.workspace_id = ${ws} and po.id = ${input.postId} and po.user_id = ${ctx.userId}`,
          )
        : [];
      // A warm-up's comment (decision 161) never says what the owner's latest comments said.
      const commentedLately =
        post?.warm_up && input.kind === 'comment'
          ? (
              await rows<{ comment_text: string }>(
                tx,
                sql`select t.comment_text from addon_outreach.touches t
                    where t.workspace_id = ${ws} and t.user_id = ${ctx.userId} and t.kind = 'comment'
                      and t.comment_text is not null
                    order by t.at desc limit ${WARM_COMMENTS_SAID}`,
              )
            ).map((r) => r.comment_text)
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
            client: boolean;
            country: string | null;
          }>(
            tx,
            // A client in Contacts (decision 91) gets replies only: no link, no video, and a yes isn't a pitch.
            sql`select p.name, p.platform, p.intro, p.mutual_friends, g.name as group, ${isClient('p')} as client,
                  p.country
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
        ? await rows<{
            step: ConversationStep;
            sent: number;
            offer_version: number | null;
            answer: Answer | null;
          }>(
            tx,
            sql`select step, sent, offer_version, answer from addon_outreach.follow_ups
                where workspace_id = ${ws} and user_id = ${ctx.userId} and profile_id = ${profileId}`,
          )
        : [];
      // Marked not a fit (decision 47): by the AI when they said no in a chat, or by the person, with why.
      const [lost] = profileId
        ? await rows<{ why: string | null }>(
            tx,
            sql`select why from addon_outreach.stages
                where workspace_id = ${ws} and user_id = ${ctx.userId} and profile_id = ${profileId}
                  and mark = 'lost'`,
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
      // The offer's lists for content (docs/main-offer.md, "For your content"): what a reply answers from, beside the
      // offer (decision 164). They aren't versioned: the lists as they are now.
      const [content] = await rows<{ lists: unknown }>(
        tx,
        sql`select lists from app.main_offers where workspace_id = ${ws}`,
      );
      // A demo's reminder, or another time after a no-show (decision 106): when their latest booked through the link
      // is, or was.
      const [demo] =
        profileId && (input.kind === 'demo_reminder' || input.kind === 'rebook')
          ? await rows<{ starts_at: Date | string }>(
              tx,
              sql`select a.starts_at from addon_outreach.demos d join app.appointments a on a.id = d.appointment_id
                  where d.workspace_id = ${ws} and d.user_id = ${ctx.userId} and d.profile_id = ${profileId}
                    and d.how = 'link' and d.undone_at is null
                  order by d.at desc limit 1`,
            )
          : [];
      // A new job (decision 108): what LinkedIn's Catch up said of it, the latest seen.
      const [occasion] =
        profileId && input.kind === 'new_job'
          ? await rows<{ detail: string | null }>(
              tx,
              sql`select o.detail from addon_outreach.occasions o
                  where o.workspace_id = ${ws} and o.user_id = ${ctx.userId} and o.profile_id = ${profileId}
                    and o.kind = 'new_job' and o.detail is not null
                  order by o.seen_at desc limit 1`,
            )
          : [];
      // The business's video library (decision 154), kept with its Social Outreach settings, and what the person sent
      // them, read for the videos they've had: one never goes twice.
      const [installed] = videoFits(input.kind, conversation?.step, {
        declined: false,
        requests: false,
      })
        ? await rows<{ settings: unknown }>(
            tx,
            sql`select settings from app.addon_installations
                where workspace_id = ${ws} and addon_id = 'outreach'`,
          )
        : [];
      const sentTexts =
        installed && profileId
          ? await rows<{ text: string }>(
              tx,
              sql`select text from addon_outreach.sends
                  where workspace_id = ${ws} and user_id = ${ctx.userId} and profile_id = ${profileId}
                    and state = 'sent'`,
            )
          : [];
      // The groups they're known to be in, and the person's own (decision 157): none is ever named to them.
      const groups = await rows<{ name: string }>(
        tx,
        sql`select distinct g.name from addon_outreach.groups g
            where g.workspace_id = ${ws} and g.name is not null
              and (${
                profileId
                  ? sql`g.id = (select p.group_id from addon_outreach.profiles p where p.id = ${profileId})
                or exists (select 1 from addon_outreach.group_people gp
                  where gp.group_id = g.id and gp.profile_id = ${profileId}) or`
                  : sql``
              }
                exists (select 1 from addon_outreach.my_groups m
                  where m.group_id = g.id and m.user_id = ${ctx.userId} and m.joined))`,
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
        commentedLately,
        engaged,
        profile,
        lines: lines[0]?.lines ?? [],
        playbooks,
        check,
        voice: await voiceFor(tx, ws, ctx.userId),
        lastAt: last?.at ?? null,
        conversation: conversation ?? null,
        lost: lost ?? null,
        offer: offer ?? null,
        lists: listsOf(content?.lists),
        friendState: friend?.state ?? null,
        demoAt: demo?.starts_at ?? null,
        occasion: occasion?.detail ?? null,
        samples: samplesNow(MessageSamples.safeParse(said?.message_samples ?? null).data),
        notes: messageNotesOf(said?.message_notes),
        library: installed ? outreachSettings(installed.settings).videos : undefined,
        sentTexts: sentTexts.map((t) => t.text),
        groups: groups.map((g) => g.name),
      };
    });
    const name = found.profile?.name ?? found.chat?.name;
    if (underAPost(input.kind) && !found.post)
      throw HfosError.notFound('That post isn’t on your list anymore. Reload Today.');
    if (input.kind === 'warm_lead' && !found.engaged)
      throw HfosError.notFound('Their comment isn’t on your list anymore. Reload Today.');
    if (!name) throw HfosError.notFound('That person isn’t on your list anymore. Reload Today.');
    // Their groups, and the post's, never named to them (decision 157).
    const groupNames = [
      ...new Set(
        [...found.groups, found.profile?.group, found.post?.group, found.engaged?.group].filter(
          (g): g is string => !!g,
        ),
      ),
    ];
    const facts = [
      ...found.lines,
      ...(found.profile?.intro ?? []),
      ...(found.check?.about ? [found.check.about] : []),
      ...(found.check?.why ?? []),
      // Only for Reconnect's catch-up (decision 164): never a first message, a follow-up or a reply.
      ...[firstStepFact(input.kind, found.check?.next_step)].filter((f): f is string => f !== null),
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
    // A first message takes the next of the playbook's versions in turn (decisions 23 and 164).
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
    // Requests: one short text, with no link and no video (core's `requestsTask`).
    const toRequests =
      input.kind === 'opener' &&
      found.profile !== undefined &&
      NETWORKS[found.profile.platform].follows &&
      found.friendState !== 'friends';
    // The AI keeps close to the version's words, fitted to them (decision 164, the owner's 1a): none goes out word for
    // word, so no two people get the very same text.
    const drafted = opener && playbook ? { playbookId: playbook.id, ...opener } : null;
    // A client in Contacts (decision 91): written to as a client, never pitched.
    const client = found.profile?.client ?? false;
    // The playbook's link, as the person's demo link for them (decision 24).
    const profileId = input.profileId ?? found.chat?.profile_id ?? found.post?.profile_id ?? null;
    const link = client
      ? null
      : playbook && profileId
        ? demoLink(playbook.details.link, demoRef(ctx.userId, profileId))
        : (playbook?.details.link ?? null);
    // The short video (decision 66): this playbook's, else the first in use with one, as Today picks it.
    const videoLink = client
      ? null
      : (playbook?.details.videoLink ??
        [...playbooks].sort((a, b) => a.name.localeCompare(b.name)).find((p) => p.details.videoLink)
          ?.details.videoLink ??
        null);
    const recent = found.chat?.recent ?? [];
    // The business's videos (decision 154): its library, or the playbooks' short videos until it's saved, with the
    // ones they've had (in a message sent them, or the chat), never to a client.
    const library = found.library === undefined || client ? [] : libraryOf(found.library, kept);
    const videos: DraftVideos | null = library.length
      ? {
          videos: library,
          sent: sentLinks(library, [
            ...found.sentTexts,
            ...recent.filter((m) => m.fromMe).map((m) => m.text),
          ]),
        }
      : null;
    // They told the person no, or not now, before (decision 134): their answer kept for the conversation, their chat
    // read as not interested, or marked not a fit. A chat read since as ready for the offer says they came round.
    const said = found.conversation?.answer;
    const declined =
      found.chat?.pitch !== 'ready' &&
      (found.lost !== null ||
        said === 'no' ||
        said === 'later' ||
        found.chat?.pitch === 'not_interested')
        ? {
            why:
              found.lost?.why ??
              found.chat?.pitch_why ??
              (said === 'no' || said === 'later' ? ANSWERS[said] : null),
          }
        : null;
    const conversation = found.conversation
      ? {
          step: found.conversation.step,
          sent: found.conversation.sent,
          followUps: paceOf(playbook?.details.pace ?? null).followUps,
        }
      : null;
    // The network the message goes on: the profile's.
    const platform = found.profile?.platform ?? 'facebook';
    // Times to meet on the playbook's booking page (decision 149, ./times.ts): for Send the link, the follow-up after
    // it, another time after a no-show and a reply (which may become Send the link), never to a client, someone who
    // said no, or their Requests. The email or number they wrote is who a reply books.
    const theirWords = recent.filter((m) => !m.fromMe).map((m) => m.text);
    const contact = contactIn(theirWords);
    const meeting =
      profileId &&
      !client &&
      !declined &&
      !toRequests &&
      isTimeKind(input.kind) &&
      (input.kind !== 'follow_up' || found.conversation?.step === 'link')
        ? await meetingFor(ctx, {
            link: playbook?.details.link,
            userId: ctx.userId,
            lines: [...found.lines, ...(found.profile?.intro ?? []), ...input.lookup],
            country: found.profile?.country ?? null,
          }).catch((e: unknown) => {
            // No times is no reason to stop the draft: its link goes as before.
            ctx.log.warn({ err: e }, 'outreach: open times for a draft failed');
            return null;
          })
        : null;
    // What the business knows (decision 122): its profile and Knowledge, with what matches their latest words, their
    // post or their comment first. Read once, for the reply and the step after a yes alike.
    const knows = knowsFor(input.kind)
      ? await businessKnows(ctx, [
          ...recent
            .filter((m) => !m.fromMe)
            .slice(-2)
            .map((m) => m.text),
          found.engaged?.comment,
          found.post?.body,
        ])
      : undefined;
    // What the AI is told of them: nothing that names one of their groups or says they're in one (decision 157).
    const toldFacts = withoutGroupLines(facts, groupNames);
    const toldLookup = withoutGroupLines(input.lookup, groupNames);
    // Everything a draft for them is written from: the same for the kind asked and the step after a yes.
    const base: DraftBase = {
      platform,
      told: {
        business: found.business?.name ?? 'the business',
        name,
        facts: toldFacts,
        recent,
        playbook: playbook ? { name: playbook.name, ...playbook.details, link, videoLink } : null,
        offer,
        lists: found.lists,
        conversation,
        post: found.engaged
          ? {
              text: `Your post: ${found.engaged.body ?? ''}\n\nTheir comment: ${found.engaged.comment}`,
              group: found.engaged.group,
            }
          : found.post
            ? {
                text: found.post.body,
                group: found.post.group,
                warm: found.post.warm_up,
                said: found.commentedLately,
                // The post check's word on whether they ask for what the business offers (decision 163).
                asking: found.post.strong,
              }
            : null,
        lookup: toldLookup,
        opener,
        voice: found.voice,
        lastAt: found.lastAt,
        requests: toRequests,
        demoWhen: found.demoAt
          ? demoWhen(found.demoAt, found.business?.timezone ?? 'America/Chicago')
          : null,
        occasion: found.occasion,
        knows,
        declined,
        videos,
      },
      avoid: [...(playbook?.details.avoid ?? []), ...(knows?.avoid ?? [])],
      groupNames,
      meeting,
      contact,
      link,
      videoLink,
      own: (kind) =>
        ownWordsFor(kind, found.samples, found.notes, found.conversation, playbook?.id ?? null),
    };
    const draft = (kind: CustomerDraftKind) => writeDrafts(ctx, base, kind);
    try {
      let kind: CustomerDraftKind = input.kind;
      let made = await draft(kind);
      // A reply: what they answered to the person's last step is kept, and a yes gets the next step instead.
      const answer = answerOf(kind, made.value, recent);
      // A reply where they took one of the open times (decision 149): the booking is the next step, not the link.
      const picked =
        meeting && kind === 'reply'
          ? openTimeOf(made.value.time, meeting.open, meeting.zone)
          : null;
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
        // A client's yes is kept, and answered as a reply: no video or link follows it.
        const next =
          answer === 'yes' && found.conversation && !client && !picked
            ? stepAfterYes(found.conversation.step)
            : null;
        if (next) {
          kind = next;
          made = await draft(kind);
        }
      }
      const theirs = [...recent].reverse().find((m) => !m.fromMe)?.text ?? null;
      // Something they asked that nothing given answers (decision 122): the reply says the owner will check, and waits.
      const unanswered = unansweredOf(kind, made.value, recent);
      // The times the drafts offer, and the time a reply books (decision 149): kept for the message queued from one of
      // them, and checked again before it goes. A reply that books waits for the person unless every reply goes.
      const booking =
        meeting && kind === 'reply' ? bookingOf(meeting, picked, name, contact) : null;
      // A time the AI says they took that isn't open: the person reads it before it goes.
      const missed = meeting !== null && kind === 'reply' && !!made.value.time?.trim() && !picked;
      const offerId =
        meeting && profileId && isTimeKind(kind) && made.drafts.length
          ? await keepTimes(ctx, {
              userId: ctx.userId,
              profileId,
              meeting,
              drafts: made.drafts,
              booking,
            })
          : null;
      return {
        kind,
        answer,
        drafts: made.drafts,
        opener: drafted,
        simple:
          kind === 'reply' &&
          made.value.simple &&
          theirs !== null &&
          !replyNeedsYou(theirs) &&
          unanswered === null &&
          !booking &&
          !missed,
        unanswered,
        meeting:
          meeting && offerId
            ? {
                offerId,
                offered: booking ? [] : offeredWords(meeting),
                books: booking?.says ?? null,
              }
            : null,
      };
    } catch (e) {
      throw draftRefusal(e);
    }
  },
};

/**
 * Everything a draft for one person is written from, whatever its kind: what core's prompt is told, and what its
 * answer is checked against. Today's drafts build it from what's kept of the person; a playbook's Test console
 * (./playbook-test.ts) from someone made up, so what it shows is what would go out.
 */
export interface DraftBase {
  readonly platform: Platform;
  /** What the prompt is told (core's `todayDraftPrompt`), less what changes with the kind. */
  readonly told: Omit<
    Parameters<typeof todayDraftPrompt>[0],
    'kind' | 'platform' | 'times' | 'own' | 'again'
  >;
  /** The playbook's words to avoid, and the business's. */
  readonly avoid: readonly string[];
  /** Their groups, and the post's, never named to them (decision 157). */
  readonly groupNames: readonly string[];
  /** The playbook's booking page and its open times (decision 149); null with none. */
  readonly meeting: Meeting | null;
  /** The email or number they wrote, for a reply that books. */
  readonly contact: { readonly email: string | null; readonly phone: string | null };
  /** The link that always goes with Send the link and another time after a no-show; the video's with the video. */
  readonly link: string | null;
  readonly videoLink: string | null;
  /** What the person said and wrote of this kind's part in Your messages (decision 87). */
  readonly own: (kind: CustomerDraftKind) => OwnWords | null;
}

/**
 * The AI's drafts of one kind for them, checked: no words to avoid, no group named (written again once when every one
 * names one, decision 157), and what the kind and the network never carry left out.
 */
export async function writeDrafts(
  ctx: AddonScopeContext,
  base: DraftBase,
  kind: CustomerDraftKind,
  again: readonly string[] | null = null,
): Promise<{ value: TodayDraftAnswer; drafts: string[] }> {
  const { platform, told, meeting } = base;
  const warm = told.post?.warm === true && kind === 'comment';
  const toRequests = told.requests === true;
  const videos = told.videos ?? null;
  const voice = told.voice ?? VOICE_DEFAULTS;
  const { value } = await askedTwice((last) =>
    askStructured(ctx, ctx.scope, {
      system: todayDraftSystem(platform, { warm }),
      messages: [
        {
          role: 'user',
          content: todayDraftPrompt({
            ...told,
            kind,
            platform,
            times: meeting && isTimeKind(kind) ? draftTimes(meeting, kind, base.contact) : null,
            own: base.own(kind),
            again,
          }),
        },
      ],
      schema: TODAY_DRAFT_SCHEMA,
      zod: TodayDraftAnswer,
      maxTokens: 800,
      usage: { source: 'addon', addonId: ctx.manifest.id },
      backupWhenDeclined: last,
    }),
  );
  // A first message is one text (decision 137), as a comment is.
  const checked = checkedDrafts(
    value,
    base.avoid,
    DRAFTS_FOR[kind],
    voice.split && !underAPost(kind) && kind !== 'warm_lead' && kind !== 'opener',
  );
  // Never a group (decision 157): a draft that mentions one goes, and when every one did, the AI writes again once,
  // told which of their groups' names to leave out.
  const quiet = checked.filter((d) => !namesAGroup(d, base.groupNames));
  if (checked.length && !quiet.length && !again)
    return writeDrafts(ctx, base, kind, [
      ...new Set(checked.flatMap((d) => groupNamesIn(d, base.groupNames))),
    ]);
  // To their Requests: only one short text with no link goes. A comment opens with no stock praise (decision 141:
  // a "Great post!" before its point goes), and one that waits to be posted (Instagram's and Alignable's, decision
  // 92) never carries a link, and on Instagram no hashtag, within its 30 words; nor does a birthday or new-job note
  // (decision 108), nor a reply in a group (decision 114).
  const drafts =
    toRequests && kind === 'opener'
      ? quiet.filter(fitsRequests)
      : kind === 'comment'
        ? quiet.flatMap((d) => {
            const said = withoutStockPraise(d);
            return said && fitsComment(said, platform) ? [said] : [];
          })
        : kind === 'group_reply'
          ? quiet.filter(fitsGroupReply)
          : isOccasionKind(kind)
            ? quiet.filter(fitsOccasion)
            : // At most one of the business's videos, and never one they've had (decision 154).
              quiet.filter((d) => fitsVideos(d, videos));
  // The link always goes with the link and the video with the video (decisions 47 and 66), and the link with
  // another time after a no-show (decision 106): one the AI left out goes on the end.
  const must =
    kind === 'pitch' || kind === 'rebook' ? base.link : kind === 'video' ? base.videoLink : null;
  return {
    value,
    drafts: must ? drafts.map((d) => (d.includes(must) ? d : `${d}\n\n${must}`)) : drafts,
  };
}

/** What the person reads when the AI couldn't write a draft, and what to do. */
export function draftRefusal(e: unknown): unknown {
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
