/**
 * Drafts for Today (docs/outreach.md; `outreach.today.draft`): a first message to a new friend, a follow-up, a reply,
 * or a comment on a group post, written by the AI in the playbook's tone from what's known about the person, the chat
 * or post so far, and what the extension looked up on their profile and business page just before (decision 21). Core holds
 * what the model is asked and checks what it answers (packages/core/src/addons/outreach/today.ts). Nothing is saved
 * or sent: the person copies the one they like, changes it as they like, and sends it on Facebook themselves.
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
import { PlaybookDetails, upgradePlaybookDetails } from '@hfos/core/addons/outreach/playbooks';
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
      return { business, chat, post, profile, lines: lines[0]?.lines ?? [], playbooks };
    });
    const name = found.profile?.name ?? found.chat?.name;
    if (input.kind === 'comment' && !found.post)
      throw HfosError.notFound('That post isn’t on your list anymore. Reload Today.');
    if (!name) throw HfosError.notFound('That person isn’t on your list anymore. Reload Today.');
    const facts = [
      ...found.lines,
      ...(found.profile?.intro ?? []),
      ...(found.profile?.group ? [`Found in the group ${found.profile.group}`] : []),
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
      return { drafts: [ownOpenerText(opener.text, name)], opener: drafted };
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
              post: found.post ? { text: found.post.body, group: found.post.group } : null,
              lookup: input.lookup,
              opener,
            }),
          },
        ],
        schema: TODAY_DRAFT_SCHEMA,
        zod: TodayDraftAnswer,
        maxTokens: 800,
        usage: { source: 'addon', addonId: ctx.manifest.id },
      });
      return {
        drafts: checkedDrafts(value, playbook?.details.avoid ?? [], DRAFTS_FOR[input.kind]),
        opener: drafted,
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
