/**
 * Drafts for Today (docs/outreach.md; `outreach.today.draft`): a first message to a new friend, a message to a friend
 * who fits to reconnect with (decision 46), a pitch with their demo link (decision 47), a follow-up, a reply, or a
 * comment on a group post, written by the AI in the playbook's tone from what's known about the person (what the AI
 * made of them when it checked them too), the chat or post so far, and what the extension looked up on their profile
 * and business page just before (decision 21). Core holds what the model is asked and checks what it answers
 * (packages/core/src/addons/outreach/today.ts). Nothing is saved or sent here: the person copies the one they like, or
 * the extension hands it to `outreach.send.queue`. For a reply, the AI also says whether it's simple (decision 27),
 * never for someone who needs the person (`replyNeedsYou`).
 */
import { demoLink, demoRef } from '@hfos/core/addons/outreach/demos';
import { bestFit } from '@hfos/core/addons/outreach/fit';
import type { DownloadMessage } from '@hfos/core/addons/outreach/download';
import {
  nextOpener,
  openerKey,
  openersOf,
  ownOpenerText,
  type Opener,
  type OpenerKind,
} from '@hfos/core/addons/outreach/openers';
import { voiceFor } from '@hfos/core/addons/outreach/ops/automation';
import { PlaybookDetails, upgradePlaybookDetails } from '@hfos/core/addons/outreach/playbooks';
import { replyNeedsYou } from '@hfos/core/addons/outreach/sends';
import {
  checkedDrafts,
  DRAFTS_FOR,
  TODAY_DRAFT_SCHEMA,
  TODAY_DRAFT_SYSTEM,
  TodayDraftAnswer,
  TodayDraftInput,
  todayDraftPrompt,
  type TodayDraftOutput,
} from '@hfos/core/addons/outreach/today';
import { HfosError } from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import {
  AI_BUDGET_MESSAGE,
  AI_BUSY_MESSAGE,
  AI_UNAVAILABLE_MESSAGE,
  AiAskError,
  askStructured,
} from '../../ai/ask';
import type { AddonWorkerAction } from '../types';

export const TODAY_DRAFT_ACTION = 'outreach.today.draft';

export const todayDraft: AddonWorkerAction<TodayDraftInput> = {
  permission: 'outreach.use',
  input: TodayDraftInput,
  async run(ctx, raw): Promise<TodayDraftOutput> {
    const input = TodayDraftInput.parse(raw);
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
                  join addon_outreach.groups g on g.id = h.group_id
                  where e.workspace_id = ${ws} and e.user_id = ${ctx.userId} and e.profile_id = ${profileId}
                    and e.kind = 'comment' and e.comment is not null
                  order by e.seen_at desc limit 1`,
            )
          : [];
      const [profile] = profileId
        ? await rows<{
            name: string;
            intro: string[];
            mutual_friends: number | null;
            group: string | null;
          }>(
            tx,
            sql`select p.name, p.intro, p.mutual_friends, g.name as group
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
            where workspace_id = ${ws} and archived_at is null`,
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
    const playbooks = found.playbooks.flatMap((p) => {
      const read = PlaybookDetails.safeParse(upgradePlaybookDetails(p.details));
      return read.success ? [{ id: p.id, name: p.name, details: read.data }] : [];
    });
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
    const drafted = opener && playbook ? { playbookId: playbook.id, ...opener } : null;
    // One of the business's own openers goes as written, with their first name in: no AI.
    if (opener?.kind === 'own')
      return { drafts: [ownOpenerText(opener.text, name)], opener: drafted, simple: false };
    // The playbook's link, as the person's demo link for them (decision 24).
    const profileId = input.profileId ?? found.chat?.profile_id ?? found.post?.profile_id ?? null;
    const link =
      playbook && profileId
        ? demoLink(playbook.details.link, demoRef(ctx.userId, profileId))
        : (playbook?.details.link ?? null);
    try {
      const { value } = await askStructured(ctx, ctx.scope, {
        system: TODAY_DRAFT_SYSTEM,
        messages: [
          {
            role: 'user',
            content: todayDraftPrompt({
              kind: input.kind,
              business: found.business?.name ?? 'the business',
              name,
              facts,
              recent: found.chat?.recent ?? [],
              playbook: playbook ? { name: playbook.name, ...playbook.details, link } : null,
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
            }),
          },
        ],
        schema: TODAY_DRAFT_SCHEMA,
        zod: TodayDraftAnswer,
        maxTokens: 800,
        usage: { source: 'addon', addonId: ctx.manifest.id },
      });
      const theirs = [...(found.chat?.recent ?? [])].reverse().find((m) => !m.fromMe)?.text ?? null;
      const drafts = checkedDrafts(
        value,
        playbook?.details.avoid ?? [],
        DRAFTS_FOR[input.kind],
        found.voice.split && input.kind !== 'comment' && input.kind !== 'warm_lead',
      );
      return {
        // A pitch always carries their demo link (decision 47): one the AI left out goes on the end.
        drafts:
          input.kind === 'pitch' && link
            ? drafts.map((d) => (d.includes(link) ? d : `${d}\n\n${link}`))
            : drafts,
        opener: drafted,
        simple: input.kind === 'reply' && value.simple && theirs !== null && !replyNeedsYou(theirs),
      };
    } catch (e) {
      if (!(e instanceof AiAskError)) throw e;
      if (e.code === 'budget_reached' || e.code === 'wallet_empty')
        throw HfosError.rule('budget_reached', 429, e.message || AI_BUDGET_MESSAGE);
      if (e.code === 'ai_unavailable')
        throw HfosError.rule('ai_not_configured', 503, AI_UNAVAILABLE_MESSAGE);
      if (e.retryable) throw HfosError.rule('ai_busy', 503, AI_BUSY_MESSAGE);
      throw HfosError.rule(
        'ai_failed',
        502,
        'The AI couldn’t write that just now. Try again, or write it yourself.',
      );
    }
  },
};
