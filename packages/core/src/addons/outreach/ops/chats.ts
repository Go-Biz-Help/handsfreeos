/**
 * The AI's read of a chat brought in from Facebook's download (docs/outreach.md, decision 3), saved by the worker
 * (apps/worker/src/addons/outreach/chats.ts). The chat keeps its summary, tags, whether they look like a prospect and
 * a next step. Who goes in Contacts is the business's setting (../chat-read.ts): someone already there is linked and
 * tagged whatever it says; someone new is added only when the setting takes them, never from the Don't pitch list
 * unless it takes everyone.
 */
import { and, eq, sql } from 'drizzle-orm';
import { rows } from '@hfos/db/client';
import { personCreate } from '../../../commands/person.create';
import { recordSetTags } from '../../../commands/record.set_tags';
import { HfosError } from '../../../errors';
import { requireHuman } from '../../../kernel/actor';
import { splitName } from '../../../inbox/contact';
import { executeCommandWithin } from '../../../kernel/execute';
import { changeMoment } from '../../../kernel/moment';
import type { CommandContext, QueryContext } from '../../../kernel/types';
import { addonTimelineLine, defineAddonCommand, defineAddonQuery } from '../../server';
import {
  CHATS_PAGE,
  ChatReadInput,
  ChatReadOutput,
  ChatsInput,
  ChatsOutput,
  goesInContacts,
  outreachSettings,
  worthReading,
  type ChatView,
  type ContactsFromChats,
} from '../chat-read';
import { ChatsCollectInput, ChatsCollectOutput, mergeRecent } from '../chat-collect';
import { nameKey } from '../download';
import { outreachAddon } from '../manifest';
import { PLATFORMS, type Platform } from '../playbooks';
import { fileChats, profiles } from '../tables';
import { inWorkspace, keptProfile, once, sourceFor, tagIdsFor } from './common';
import { noteAnswer } from './conversation';
import { noteChatRead } from './stages';

const DAY = 86_400_000;
/** Facebook's own start: no message is older. */
const FIRST_DAY = Date.UTC(2004, 0, 1);

/** Who from the chats goes in Contacts, as the business has it set. */
async function contactsSetting(ctx: CommandContext | QueryContext): Promise<ContactsFromChats> {
  const [installed] = await rows<{ settings: unknown }>(
    ctx.tx,
    sql`select settings from app.addon_installations
        where workspace_id = ${ctx.scope.workspaceId!} and addon_id = ${outreachAddon.id}`,
  );
  return outreachSettings(installed?.settings).contactsFromChats;
}

export const chatRead = defineAddonCommand(outreachAddon, {
  name: 'outreach.chat.read',
  description:
    'Worker: the AI’s read of a chat brought in from Facebook’s download (a short summary, the playbooks’ tags that fit, whether they look like a prospect, a next step), or that it couldn’t read it. Puts them in Contacts when the business’s setting says to, and tags them there.',
  risk: 0,
  input: ChatReadInput,
  output: ChatReadOutput,
  permission: 'outreach.use',
  actors: ['system'],
  scope: inWorkspace,
  emits: ['outreach.chat.read'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const at = changeMoment(ctx.meta);
    const [chat] = await ctx.tx
      .select()
      .from(fileChats)
      .where(and(eq(fileChats.workspaceId, ws), eq(fileChats.id, input.chatId)))
      .for('update');
    if (!chat) throw HfosError.notFound('That chat isn’t here anymore.');
    const skipped = { saved: false, personId: chat.personId, addedPerson: false };
    // Read already, or newer messages came in since: those wait for their own read.
    if (chat.readState !== 'waiting' || chat.lastAt.getTime() !== Date.parse(input.lastAt))
      return skipped;

    if (!input.read) {
      await ctx.tx
        .update(fileChats)
        .set({ readState: 'failed', readAt: at })
        .where(eq(fileChats.id, chat.id));
      return skipped;
    }
    const read = input.read;

    const [profile] = chat.profileId
      ? await ctx.tx.select().from(profiles).where(eq(profiles.id, chat.profileId))
      : [];
    const setting = await contactsSetting(ctx);

    let personId = profile?.personId ?? chat.personId ?? null;
    let addedPerson = false;
    // Never contact keeps them out of Contacts whatever the setting; Don't pitch only lets everyone in.
    const takes = profile?.neverContact
      ? false
      : profile?.dontPitch
        ? setting === 'everyone'
        : goesInContacts(setting, read);
    if (!personId && takes) {
      const { firstName, lastName } = splitName(chat.name);
      personId = (
        await executeCommandWithin(ctx, personCreate, {
          workspaceId: ws,
          firstName: firstName.slice(0, 80),
          lastName: lastName.slice(0, 80),
          source: sourceFor(chat.platform),
          ignoreDuplicates: true,
        })
      ).output.personId;
      addedPerson = true;
      if (profile && !profile.personId)
        await ctx.tx.update(profiles).set({ personId }).where(eq(profiles.id, profile.id));
    }

    await ctx.tx
      .update(fileChats)
      .set({
        readState: 'read',
        summary: read.summary,
        tags: read.tags,
        prospect: read.prospect,
        nextStep: read.nextStep,
        pitch: read.pitch,
        pitchWhy: read.pitchWhy,
        reply: read.reply,
        readAt: at,
        personId,
      })
      .where(eq(fileChats.id, chat.id));
    // Whether it's time to offer, for their stage (decision 47): a no marks them not a fit.
    if (chat.profileId)
      await noteChatRead(ctx, chat.userId, chat.profileId, read.pitch, read.pitchWhy, at);
    // What their last message answers to the person's last step (decisions 65 to 67): a yes is a positive reply.
    if (chat.profileId && read.reply && !chat.lastFromMe)
      await noteAnswer(ctx, chat.userId, {
        profileId: chat.profileId,
        answer: read.reply,
        at,
        writtenAt: chat.lastAt,
      });

    if (personId) {
      const tagIds = await tagIdsFor(ctx, read.tags);
      if (tagIds.length)
        await executeCommandWithin(ctx, recordSetTags, {
          workspaceId: ws,
          recordType: 'person',
          recordId: personId,
          tagIds,
          mode: 'add',
        });
      await addonTimelineLine(ctx, outreachAddon, {
        personId,
        words: addedPerson
          ? `added them from their ${PLATFORMS[chat.platform]} chat`
          : `read their ${PLATFORMS[chat.platform]} chat`,
        body: [read.summary, read.nextStep ? `Next: ${read.nextStep}` : null]
          .filter(Boolean)
          .join('\n'),
      });
    }

    await ctx.emit({
      type: 'outreach.chat.read',
      entityType: 'workspace',
      entityId: ws,
      payload: {
        chatId: chat.id,
        personId,
        addedPerson,
        prospect: read.prospect,
        tags: read.tags.length,
      },
    });
    return { saved: true, personId, addedPerson };
  },
});

const VIEW_WHERE: Record<ChatView, ReturnType<typeof sql>> = {
  prospects: sql`c.read_state = 'read' and c.prospect`,
  tagged: sql`c.read_state = 'read' and cardinality(c.tags) > 0`,
  read: sql`c.read_state = 'read'`,
  waiting: sql`c.read_state in ('waiting', 'failed')`,
};

export const chatsList = defineAddonQuery(outreachAddon, {
  name: 'outreach.chats',
  description:
    'The person’s own chats brought in from their download files or read as they opened them, on every network or one, with the AI’s summary, tags, whether they look like a prospect and a next step: the likely prospects, the tagged, all read, or the ones not read yet. The latest first.',
  input: ChatsInput,
  output: ChatsOutput,
  permission: 'outreach.use',
  ai: {
    tool: 'outreach_chats',
    keywords: ['messenger chats', 'likely prospects', 'chat tags'],
  },
  scope: inWorkspace,
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    // One network's chats, counts and tags too, when asked: every network's otherwise.
    const mine = sql`c.workspace_id = ${ws} and c.user_id = ${me}
      and ${input.platform ? sql`c.platform = ${input.platform}` : sql`true`}`;
    const [counts] = await rows<{
      prospects: number;
      tagged: number;
      read: number;
      waiting: number;
    }>(
      ctx.tx,
      sql`select count(*) filter (where ${VIEW_WHERE.prospects})::int as prospects,
            count(*) filter (where ${VIEW_WHERE.tagged})::int as tagged,
            count(*) filter (where ${VIEW_WHERE.read})::int as read,
            count(*) filter (where ${VIEW_WHERE.waiting})::int as waiting
          from addon_outreach.file_chats c where ${mine}`,
    );
    const tags = await rows<{ name: string; count: number }>(
      ctx.tx,
      sql`select t as name, count(*)::int as count
          from addon_outreach.file_chats c, unnest(c.tags) t
          where ${mine} and c.read_state = 'read'
          group by t order by count(*) desc, t limit 50`,
    );
    const shown = sql`${mine} and ${VIEW_WHERE[input.view]}
      and ${input.tag ? sql`exists (select 1 from unnest(c.tags) t where lower(t) = lower(${input.tag}))` : sql`true`}
      and ${input.search ? sql`position(${input.search.toLowerCase()} in lower(c.name)) > 0` : sql`true`}`;
    const [counted] = await rows<{ total: number }>(
      ctx.tx,
      sql`select count(*)::int as total from addon_outreach.file_chats c where ${shown}`,
    );
    const total = counted?.total ?? 0;
    const pages = Math.max(1, Math.ceil(total / CHATS_PAGE));
    const page = Math.min(input.page, pages);
    const listed = await rows<{
      id: string;
      name: string;
      platform: Platform;
      person_id: string | null;
      last_at: Date | string;
      last_from_me: boolean;
      messages: number;
      read_state: ChatsOutput['chats'][number]['readState'];
      summary: string | null;
      tags: string[];
      prospect: boolean | null;
      next_step: string | null;
      thread_key: string | null;
      profile_id: string | null;
      dont_pitch: boolean;
      never_contact: boolean;
      on_card: boolean;
    }>(
      ctx.tx,
      sql`select c.id, coalesce(nullif(btrim(pp.first_name || ' ' || pp.last_name), ''), c.name) as name,
            c.platform, c.person_id, c.last_at, c.last_from_me, c.messages, c.read_state, c.summary, c.tags, c.prospect,
            c.next_step, c.thread_key, c.profile_id,
            coalesce(pr.dont_pitch, false) as dont_pitch, coalesce(pr.never_contact, false) as never_contact,
            -- Saved to their card (outreach.chat.keep): by its number, or its own key while it had none.
            exists (select 1 from addon_outreach.threads t
                    where t.workspace_id = c.workspace_id and t.platform = c.platform
                      and t.owner_user_id = c.user_id
                      and t.thread_key in (coalesce(c.thread_key, 'file.' || c.id), 'file.' || c.id)) as on_card
          from addon_outreach.file_chats c left join app.people pp on pp.id = c.person_id
          left join addon_outreach.profiles pr on pr.id = c.profile_id
          where ${shown} order by c.last_at desc, c.id
          limit ${CHATS_PAGE} offset ${(page - 1) * CHATS_PAGE}`,
    );
    return {
      contactsFromChats: await contactsSetting(ctx),
      counts: counts ?? { prospects: 0, tagged: 0, read: 0, waiting: 0 },
      tags,
      chats: listed.map((c) => ({
        chatId: c.id,
        name: c.name,
        platform: c.platform,
        personId: c.person_id,
        lastAt: new Date(c.last_at).toISOString(),
        lastFromMe: c.last_from_me,
        messages: c.messages,
        readState: c.read_state,
        summary: c.summary,
        tags: c.tags,
        prospect: c.prospect,
        nextStep: c.next_step,
        threadKey: c.thread_key,
        profileId: c.profile_id,
        dontPitch: c.dont_pitch,
        neverContact: c.never_contact,
        onCard: c.on_card,
      })),
      page,
      pages,
      total,
    };
  },
});

export const chatsCollect = defineAddonCommand(outreachAddon, {
  name: 'outreach.chats.collect',
  description:
    'Bring in one-to-one chats the extension read in Messenger in the person’s browser, each with its latest few messages and when they were sent, for the AI to read later. They join the chats from the person’s Facebook download, one per person. Adds nobody to Contacts itself.',
  risk: 1,
  input: ChatsCollectInput,
  output: ChatsCollectOutput,
  permission: 'outreach.use',
  scope: inWorkspace,
  emits: ['outreach.chats.collected'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const now = changeMoment(ctx.meta);
    const fine = (at: string) =>
      Date.parse(at) >= FIRST_DAY && Date.parse(at) <= now.getTime() + DAY;
    if (!input.chats.every((c) => c.messages.every((m) => fine(m.at))))
      throw HfosError.rule(
        'outreach_chat_dates',
        400,
        'Some messages in that chat say they were sent after today. Check the date and time on your computer, then read the chat again.',
      );
    return once(async () => {
      let saved = 0;
      let waiting = 0;
      for (const c of input.chats) {
        const key = nameKey(c.name);
        const profile = c.profile
          ? await keptProfile(
              ctx,
              { platform: input.platform, profile: c.profile, name: c.name },
              me,
              now,
            )
          : null;
        const [had] = await ctx.tx
          .select()
          .from(fileChats)
          .where(
            and(
              eq(fileChats.workspaceId, ws),
              eq(fileChats.userId, me),
              eq(fileChats.platform, input.platform),
              eq(fileChats.nameKey, key),
            ),
          )
          .for('update');
        const read = mergeRecent([], c.messages);
        const recent = mergeRecent(had?.recent ?? [], read);
        const first = read[0]!;
        const last = recent[recent.length - 1]!;
        // Newer words than the last read are read again; older ones (scrolled up to) only fill in.
        const newer = !had || !had.recent.length || Date.parse(last.at) > had.lastAt.getTime();
        const changed = !had || JSON.stringify(recent) !== JSON.stringify(had.recent);
        const readState = newer ? (worthReading(recent) ? 'waiting' : 'skipped') : had.readState;
        if (!had) {
          await ctx.tx.insert(fileChats).values({
            workspaceId: ws,
            userId: me,
            platform: input.platform,
            name: c.name,
            nameKey: key,
            firstAt: new Date(first.at),
            lastAt: new Date(last.at),
            messages: recent.length,
            lastFromMe: last.fromMe,
            profileId: profile?.id ?? null,
            importId: null,
            recent,
            readState,
            threadKey: c.thread.id,
            collectedAt: now,
          });
        } else {
          const lastAt = new Date(Math.max(had.lastAt.getTime(), Date.parse(last.at)));
          await ctx.tx
            .update(fileChats)
            .set({
              firstAt: new Date(Math.min(had.firstAt.getTime(), Date.parse(first.at))),
              lastAt,
              lastFromMe:
                Date.parse(last.at) >= had.lastAt.getTime() ? last.fromMe : had.lastFromMe,
              messages: Math.max(had.messages, recent.length),
              profileId: profile?.id ?? had.profileId,
              recent,
              readState: changed ? readState : had.readState,
              threadKey: c.thread.id,
              collectedAt: now,
            })
            .where(eq(fileChats.id, had.id));
        }
        if (!changed) continue;
        saved++;
        if (readState === 'waiting') waiting++;
      }
      if (saved)
        await ctx.emit({
          type: 'outreach.chats.collected',
          entityType: 'workspace',
          entityId: ws,
          payload: { platform: input.platform, saved, waiting },
        });
      return { saved, waiting };
    });
  },
});

export const chatCommands = [chatRead, chatsCollect] as const;
export const chatQueries = [chatsList] as const;
