/**
 * The AI's read of a chat brought in from Facebook's download (docs/outreach.md, decision 3), saved by the worker
 * (apps/worker/src/addons/outreach/chats.ts). The chat keeps its summary, tags, whether they look like a prospect and
 * a next step. Who goes in Contacts is the business's setting (../chat-read.ts): someone already there is linked and
 * tagged whatever it says; someone new is added only when the setting takes them, never from the Don't pitch list
 * unless it takes everyone.
 */
import { and, eq, sql } from 'drizzle-orm';
import { tags as tagTable } from '@hfos/db/schema';
import { rows } from '@hfos/db/client';
import { personCreate } from '../../../commands/person.create';
import { recordSetTags } from '../../../commands/record.set_tags';
import { tagCreate } from '../../../commands/tag.create';
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
  type ChatView,
  type ContactsFromChats,
} from '../chat-read';
import { outreachAddon } from '../manifest';
import { PLATFORMS } from '../playbooks';
import { fileChats, profiles } from '../tables';
import { inWorkspace, sourceFor } from './common';

/** Who from the chats goes in Contacts, as the business has it set. */
async function contactsSetting(ctx: CommandContext | QueryContext): Promise<ContactsFromChats> {
  const [installed] = await rows<{ settings: unknown }>(
    ctx.tx,
    sql`select settings from app.addon_installations
        where workspace_id = ${ctx.scope.workspaceId!} and addon_id = ${outreachAddon.id}`,
  );
  return outreachSettings(installed?.settings).contactsFromChats;
}

/** The business's tags by these names, made where they're missing. */
async function tagIdsFor(ctx: CommandContext, names: readonly string[]): Promise<string[]> {
  if (!names.length) return [];
  const ws = ctx.scope.workspaceId!;
  const had = await ctx.tx
    .select({ id: tagTable.id, name: tagTable.name })
    .from(tagTable)
    .where(
      and(
        eq(tagTable.workspaceId, ws),
        // The name is citext, whose own = isn't on the search path here: compared without capitals instead.
        sql`lower(${tagTable.name}::text) in (${sql.join(
          names.map((n) => sql`${n.toLowerCase()}`),
          sql`, `,
        )})`,
      ),
    );
  const byKey = new Map(had.map((t) => [String(t.name).toLowerCase(), t.id]));
  const ids: string[] = [];
  for (const name of names) {
    const id =
      byKey.get(name.toLowerCase()) ??
      (await executeCommandWithin(ctx, tagCreate, { workspaceId: ws, name })).output.tagId;
    byKey.set(name.toLowerCase(), id);
    ids.push(id);
  }
  return [...new Set(ids)];
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
    const takes = profile?.dontPitch ? setting === 'everyone' : goesInContacts(setting, read);
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
        readAt: at,
        personId,
      })
      .where(eq(fileChats.id, chat.id));

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
    'The person’s own chats brought in from their Facebook download, with the AI’s summary, tags, whether they look like a prospect and a next step: the likely prospects, the tagged, all read, or the ones not read yet. The latest first.',
  input: ChatsInput,
  output: ChatsOutput,
  permission: 'outreach.use',
  scope: inWorkspace,
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const mine = sql`c.workspace_id = ${ws} and c.user_id = ${me}`;
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
      person_id: string | null;
      last_at: Date | string;
      last_from_me: boolean;
      messages: number;
      read_state: ChatsOutput['chats'][number]['readState'];
      summary: string | null;
      tags: string[];
      prospect: boolean | null;
      next_step: string | null;
    }>(
      ctx.tx,
      sql`select c.id, coalesce(nullif(btrim(pp.first_name || ' ' || pp.last_name), ''), c.name) as name,
            c.person_id, c.last_at, c.last_from_me, c.messages, c.read_state, c.summary, c.tags, c.prospect,
            c.next_step
          from addon_outreach.file_chats c left join app.people pp on pp.id = c.person_id
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
        personId: c.person_id,
        lastAt: new Date(c.last_at).toISOString(),
        lastFromMe: c.last_from_me,
        messages: c.messages,
        readState: c.read_state,
        summary: c.summary,
        tags: c.tags,
        prospect: c.prospect,
        nextStep: c.next_step,
      })),
      page,
      pages,
      total,
    };
  },
});

export const chatCommands = [chatRead] as const;
export const chatQueries = [chatsList] as const;
