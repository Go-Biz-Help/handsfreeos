/**
 * What the browser extension saves (docs/outreach.md): a person's profile, and a chat with them, as the page showed
 * them. Each save finds or adds the customer, so saving the same page twice changes nothing but what's new on it; and
 * a look-up tells the extension which of the people and chats on a page are saved already.
 */
import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { rows } from '@hfos/db/client';
import { people } from '@hfos/db/schema';
import { fmtMonthDay, fmtTime, localDayOf } from '../../../calendar/when';
import { personCreate } from '../../../commands/person.create';
import { fullName, requirePerson, userRef, workspaceTimezone } from '../../../crm/records';
import { HfosError } from '../../../errors';
import { splitName } from '../../../inbox/contact';
import { requireHuman, userIdOf } from '../../../kernel/actor';
import { executeCommandWithin } from '../../../kernel/execute';
import { changeMoment } from '../../../kernel/moment';
import { addonTimelineLine, defineAddonCommand, defineAddonQuery } from '../../server';
import { DONT_PITCH_TAG, type FriendState } from '../limits';
import { outreachAddon } from '../manifest';
import { PLATFORMS, PLATFORM_KEYS } from '../playbooks';
import {
  ChatKeepInput,
  ChatSaveInput,
  ChatSaveOutput,
  joinMessages,
  OutreachLookupInput,
  OutreachLookupOutput,
  ProfileSaveInput,
  ProfileSaveOutput,
  type SavedMessage,
} from '../saves';
import { fileChats, profiles, threads } from '../tables';
import { inWorkspace, keepFriendStates, neverTwins, once, saveProfile, sourceFor } from './common';

const clip = (text: string, most: number) =>
  text.length > most ? `${text.slice(0, most - 1)}…` : text;

export const profileSave = defineAddonCommand(outreachAddon, {
  name: 'outreach.profile.save',
  description:
    'Save someone’s social profile as the extension read it: finds the customer it’s saved to, or the one picked, or adds them, and keeps their intro and where the two of you stand.',
  risk: 1,
  input: ProfileSaveInput,
  output: ProfileSaveOutput,
  permission: 'outreach.use',
  scope: inWorkspace,
  emits: ['outreach.profile.saved'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const saved = await once(async () => {
      const done = await saveProfile(ctx, {
        platform: input.platform,
        profile: input.profile,
        name: input.name,
        facts: {
          intro: input.intro,
          friendship: input.friendship,
          mutualFriends: input.mutualFriends,
        },
        ...(input.personId ? { personId: input.personId } : {}),
      });
      // The profile shows where the person's own Facebook stands with them.
      if (input.friendship !== 'unknown')
        await keepFriendStates(
          ctx,
          me,
          [{ profileId: done.profileId, state: input.friendship }],
          changeMoment(ctx.meta),
        );
      return done;
    });
    await ctx.emit({
      type: 'outreach.profile.saved',
      entityType: 'person',
      entityId: saved.personId,
      payload: {
        platform: input.platform,
        profileId: saved.profileId,
        addedPerson: saved.addedPerson,
      },
    });
    return saved;
  },
});

export const chatSave = defineAddonCommand(outreachAddon, {
  name: 'outreach.chat.save',
  description:
    'Save a chat as the extension read it: finds or adds the customer it’s with from the profile it links to, and adds the messages it hadn’t saved before, keeping the most recent.',
  risk: 1,
  input: ChatSaveInput,
  output: ChatSaveOutput,
  permission: 'outreach.use',
  scope: inWorkspace,
  emits: ['outreach.chat.saved', 'outreach.profile.saved'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const at = changeMoment(ctx.meta);
    const network = PLATFORMS[input.platform];
    return once(async () => {
      const [had] = await ctx.tx
        .select()
        .from(threads)
        .where(
          and(
            eq(threads.workspaceId, ws),
            eq(threads.platform, input.platform),
            eq(threads.threadKey, input.thread.id),
            eq(threads.ownerUserId, me),
          ),
        );
      let person: { personId: string; personName: string; addedPerson: boolean };
      if (input.profile) {
        const saved = await saveProfile(ctx, {
          platform: input.platform,
          profile: input.profile,
          name: input.name,
          facts: null,
          ...(input.personId ? { personId: input.personId } : {}),
        });
        person = saved;
        if (saved.addedPerson)
          await ctx.emit({
            type: 'outreach.profile.saved',
            entityType: 'person',
            entityId: saved.personId,
            payload: {
              platform: input.platform,
              profileId: saved.profileId,
              addedPerson: true,
            },
          });
      } else if (input.personId || had) {
        // The one picked, or the one this chat was saved with before: the page doesn't always link the profile.
        const p = await requirePerson(ctx.tx, ws, input.personId ?? had!.personId);
        person = {
          personId: p.id,
          personName: fullName(p.firstName, p.lastName),
          addedPerson: false,
        };
      } else
        throw HfosError.rule(
          'outreach_chat_without_profile',
          422,
          `This chat doesn’t link to anyone’s ${network} profile, so it can’t tell who it’s with. Group chats can’t be saved yet.`,
        );

      const joined = joinMessages(had?.messages ?? [], input.messages, at.toISOString());
      const facts = {
        personId: person.personId,
        encrypted: input.thread.encrypted,
        url: input.thread.url,
        name: input.name,
        messages: joined.messages,
        lastSavedBy: me,
        lastSavedAt: at,
      };
      let threadId: string;
      if (had) {
        await ctx.tx
          .update(threads)
          .set({ ...facts, savedMessages: sql`${threads.savedMessages} + ${joined.added}` })
          .where(eq(threads.id, had.id));
        threadId = had.id;
      } else {
        const [row] = await ctx.tx
          .insert(threads)
          .values({
            ...facts,
            workspaceId: ws,
            platform: input.platform,
            threadKey: input.thread.id,
            ownerUserId: me,
            savedMessages: joined.added,
          })
          .returning({ id: threads.id });
        threadId = row!.id;
      }

      if (joined.added > 0) {
        const newest = joined.messages.at(-1)!;
        await addonTimelineLine(ctx, outreachAddon, {
          personId: person.personId,
          words: `saved ${joined.added} ${network} ${joined.added === 1 ? 'message' : 'messages'}`,
          body: `${await whoSent(ctx, newest, person.personName)}: ${clip(newest.text, 280)}`,
        });
      }
      await ctx.emit({
        type: 'outreach.chat.saved',
        entityType: 'person',
        entityId: person.personId,
        payload: { platform: input.platform, threadId, added: joined.added },
      });
      return {
        ...person,
        threadId,
        added: joined.added,
        kept: joined.messages.length,
      };
    });
  },
});

/** A chat brought in, on a card: its number from its link, or one of its own while it has none (download only). */
const keptKey = (chat: { id: string; threadKey: string | null }) =>
  chat.threadKey ?? `file.${chat.id}`;

/** When a message was sent, on the business's clock, as a card shows it: "Oct 9, 2026, 2:10 PM". */
function sentWords(iso: string, timeZone: string): string | null {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return null;
  const day = localDayOf(at, timeZone);
  return `${fmtMonthDay(day)}, ${day.slice(0, 4)}, ${fmtTime(at, timeZone)}`;
}

export const chatKeep = defineAddonCommand(outreachAddon, {
  name: 'outreach.chat.keep',
  description:
    'Save to their card: copy a chat brought in from Messenger or Facebook’s file onto the customer’s Social card, adding the messages it hadn’t saved before. Finds the customer from the chat or its profile, or takes the one picked, or adds them when asked.',
  risk: 1,
  input: ChatKeepInput,
  output: ChatSaveOutput,
  permission: 'outreach.use',
  ai: {
    tool: 'outreach_save_chat_to_card',
    autonomy: 'confirm',
    keywords: ['save chat to customer', 'social card'],
  },
  scope: inWorkspace,
  emits: ['outreach.chat.saved', 'outreach.profile.saved'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const at = changeMoment(ctx.meta);
    return once(async () => {
      // Each person's chats are their own: only theirs can go on a card.
      const [chat] = await ctx.tx
        .select()
        .from(fileChats)
        .where(
          and(
            eq(fileChats.workspaceId, ws),
            eq(fileChats.id, input.chatId),
            eq(fileChats.userId, me),
          ),
        )
        .for('update');
      if (!chat)
        throw HfosError.notFound(
          'That chat isn’t on your Chats tab anymore. Refresh the page and try again.',
        );
      const network = PLATFORMS[chat.platform];
      if (!chat.recent.length)
        throw HfosError.rule(
          'outreach_chat_nothing_to_keep',
          422,
          `There are no messages from your chat with ${chat.name} here yet. Press Read my chats on the Chats tab, then save it again.`,
        );
      const [profile] = chat.profileId
        ? await ctx.tx.select().from(profiles).where(eq(profiles.id, chat.profileId))
        : [];
      // Saved before: by its number, or by its own key while it had none.
      const keys = [...new Set([keptKey(chat), `file.${chat.id}`])];
      const [had] = await ctx.tx
        .select()
        .from(threads)
        .where(
          and(
            eq(threads.workspaceId, ws),
            eq(threads.platform, chat.platform),
            eq(threads.ownerUserId, me),
            or(...keys.map((k) => eq(threads.threadKey, k))),
          ),
        )
        .orderBy(desc(threads.lastSavedAt))
        .limit(1);

      const known = input.personId ?? chat.personId ?? profile?.personId ?? had?.personId ?? null;
      if (!known && !input.add)
        throw HfosError.rule(
          'outreach_chat_who',
          409,
          `${chat.name} isn’t in Contacts yet. Pick who they are, or add them as someone new.`,
        );
      let person: { personId: string; personName: string; addedPerson: boolean };
      if (profile) {
        const saved = await saveProfile(ctx, {
          platform: chat.platform,
          profile: { id: profile.platformId, username: profile.username, url: profile.url },
          name: profile.name,
          facts: null,
          ...(known ? { personId: known } : {}),
        });
        person = saved;
        if (saved.addedPerson)
          await ctx.emit({
            type: 'outreach.profile.saved',
            entityType: 'person',
            entityId: saved.personId,
            payload: { platform: chat.platform, profileId: saved.profileId, addedPerson: true },
          });
      } else if (known) {
        const p = await requirePerson(ctx.tx, ws, known);
        person = {
          personId: p.id,
          personName: fullName(p.firstName, p.lastName),
          addedPerson: false,
        };
      } else {
        const { firstName, lastName } = splitName(chat.name);
        const added = await executeCommandWithin(ctx, personCreate, {
          workspaceId: ws,
          firstName: firstName.slice(0, 80),
          lastName: lastName.slice(0, 80),
          source: sourceFor(chat.platform),
          ignoreDuplicates: true,
        });
        person = { personId: added.output.personId, personName: chat.name, addedPerson: true };
      }

      // Each message keeps when it was sent, so the activity counts a reply on its own day.
      const timeZone = await workspaceTimezone(ctx.tx, ws);
      const read = chat.recent.map((m) => ({
        from: m.fromMe ? ('me' as const) : ('them' as const),
        sender: null,
        text: m.text,
        when: sentWords(m.at, timeZone),
      }));
      const joined = joinMessages(had?.messages ?? [], read, (i) => chat.recent[i]!.at);
      const facts = {
        personId: person.personId,
        threadKey: keptKey(chat),
        url: chat.threadKey
          ? `https://www.facebook.com/messages/t/${encodeURIComponent(chat.threadKey)}`
          : (profile?.url ?? 'https://www.facebook.com/messages/'),
        name: chat.name,
        messages: joined.messages,
        lastSavedBy: me,
        lastSavedAt: at,
      };
      let threadId: string;
      if (had) {
        await ctx.tx
          .update(threads)
          .set({ ...facts, savedMessages: sql`${threads.savedMessages} + ${joined.added}` })
          .where(eq(threads.id, had.id));
        threadId = had.id;
      } else {
        const [row] = await ctx.tx
          .insert(threads)
          .values({
            ...facts,
            workspaceId: ws,
            platform: chat.platform,
            ownerUserId: me,
            savedMessages: joined.added,
          })
          .returning({ id: threads.id });
        threadId = row!.id;
      }
      // The Chats tab shows them in Contacts now.
      if (chat.personId !== person.personId)
        await ctx.tx
          .update(fileChats)
          .set({ personId: person.personId })
          .where(eq(fileChats.id, chat.id));

      if (joined.added > 0) {
        const newest = joined.messages.at(-1)!;
        await addonTimelineLine(ctx, outreachAddon, {
          personId: person.personId,
          words: `saved ${joined.added} ${network} ${joined.added === 1 ? 'message' : 'messages'}`,
          body: `${await whoSent(ctx, newest, person.personName)}: ${clip(newest.text, 280)}`,
        });
      }
      await ctx.emit({
        type: 'outreach.chat.saved',
        entityType: 'person',
        entityId: person.personId,
        payload: { platform: chat.platform, threadId, added: joined.added },
      });
      return { ...person, threadId, added: joined.added, kept: joined.messages.length };
    });
  },
});

/** Who sent a message, for its line on the timeline: the person saving it, or the customer. */
async function whoSent(
  ctx: Parameters<typeof addonTimelineLine>[0],
  message: SavedMessage,
  personName: string,
): Promise<string> {
  if (message.from === 'them') return message.sender ?? personName;
  const me = userIdOf(ctx.actor);
  const user = message.from === 'me' && me ? await userRef(ctx.tx, me) : null;
  return user?.fullName ?? 'Someone';
}

export const lookup = defineAddonQuery(outreachAddon, {
  name: 'outreach.lookup',
  description:
    'Which of the profiles and chats on a social page are saved here, and to whom; and which customers have a name, for someone not saved yet.',
  input: OutreachLookupInput,
  output: OutreachLookupOutput,
  permission: 'outreach.use',
  scope: inWorkspace,
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const ids = input.profiles.flatMap((p) => (p.id ? [p.id] : []));
    const usernames = input.profiles.flatMap((p) => (p.username ? [p.username.toLowerCase()] : []));
    const name = sql<string>`btrim(${people.firstName} || ' ' || ${people.lastName})`;

    const saved =
      ids.length || usernames.length
        ? await ctx.tx
            .select({
              profileId: profiles.id,
              id: profiles.platformId,
              username: profiles.username,
              // The customer it's saved to: a profile noted from a step alone has none, and the join leaves it out.
              personId: people.id,
              name,
            })
            .from(profiles)
            .innerJoin(people, eq(people.id, profiles.personId))
            .where(
              and(
                eq(profiles.workspaceId, ws),
                eq(profiles.platform, input.platform),
                sql`(${ids.length ? inArray(profiles.platformId, ids) : sql`false`} or ${
                  usernames.length
                    ? inArray(sql`lower(${profiles.username})`, usernames)
                    : sql`false`
                })`,
              ),
            )
        : [];

    // Every profile on the page kept here, with a customer or not, and what the Friends tab and fit need of each.
    const marked =
      ids.length || usernames.length
        ? await rows<{
            profile_id: string;
            id: string | null;
            username: string | null;
            person_id: string | null;
            state: FriendState | null;
            keep: boolean | null;
            dont_pitch: boolean;
            dont_pitch_by: string | null;
            dont_pitch_at: Date | string | null;
            tagged: boolean;
            twin_dont_pitch: boolean | null;
            twin_by: string | null;
            twin_at: Date | string | null;
            demo: 'link' | 'marked' | null;
            intro: string[];
            mutual_friends: number | null;
            group_name: string | null;
          }>(
            ctx.tx,
            sql`select p.id as profile_id, p.platform_id as id, p.username, p.person_id, f.state, f.keep,
                  p.dont_pitch, coalesce(nullif(u.full_name, ''), u.email::text) as dont_pitch_by, p.dont_pitch_at,
                  exists (select 1 from app.record_tags rt join app.tags t on t.id = rt.tag_id
                          where rt.workspace_id = p.workspace_id and rt.record_type = 'person'
                            and rt.record_id = p.person_id and lower(t.name::text) = lower(${DONT_PITCH_TAG})) as tagged,
                  tw.dont_pitch as twin_dont_pitch, coalesce(nullif(tu.full_name, ''), tu.email::text) as twin_by,
                  tw.dont_pitch_at as twin_at,
                  (select d.how from addon_outreach.demos d
                    where d.workspace_id = p.workspace_id and d.user_id = ${me} and d.profile_id = p.id
                      and d.undone_at is null
                    order by d.how = 'link' desc limit 1) as demo,
                  p.intro, p.mutual_friends, g.name as group_name
                from addon_outreach.profiles p
                left join addon_outreach.friends f on f.profile_id = p.id and f.user_id = ${me}
                left join app.users u on u.id = p.dont_pitch_by
                left join lateral (${neverTwins('p')} order by twin.dont_pitch desc limit 1) tw on true
                left join app.users tu on tu.id = tw.dont_pitch_by
                left join addon_outreach.groups g on g.id = p.group_id
                where p.workspace_id = ${ws} and p.platform = ${input.platform}
                  and (${ids.length ? sql`p.platform_id in ${ids}` : sql`false`}
                    or ${usernames.length ? sql`lower(p.username) in ${usernames}` : sql`false`})`,
          )
        : [];

    const chats = input.threads.length
      ? await ctx.tx
          .select({
            threadId: threads.id,
            key: threads.threadKey,
            personId: threads.personId,
            name,
            kept: sql<number>`jsonb_array_length(${threads.messages})`.mapWith(Number),
            lastSavedAt: threads.lastSavedAt,
          })
          .from(threads)
          .innerJoin(people, eq(people.id, threads.personId))
          .where(
            and(
              eq(threads.workspaceId, ws),
              eq(threads.platform, input.platform),
              eq(threads.ownerUserId, me),
              inArray(threads.threadKey, input.threads),
            ),
          )
      : [];

    const sameName = [];
    for (const wanted of [...new Set(input.names.map((n) => n.replace(/\s+/g, ' ')))]) {
      const found = await ctx.tx
        .select({
          personId: people.id,
          name,
          email: people.email,
          phone: people.phone,
          source: people.source,
          createdAt: people.createdAt,
          // Spelled out: a column in a one-table query is written without its table, which the inner one would take.
          hasProfile: sql<boolean>`exists (select 1 from addon_outreach.profiles p
            where p.person_id = people.id and p.platform = ${input.platform})`,
        })
        .from(people)
        .where(
          and(
            eq(people.workspaceId, ws),
            isNull(people.archivedAt),
            sql`lower(${name}) = lower(${wanted})`,
          ),
        )
        .orderBy(desc(people.createdAt))
        .limit(3);
      sameName.push({
        name: wanted,
        people: found.map((p) => ({ ...p, createdAt: p.createdAt.toISOString() })),
      });
    }

    return {
      profiles: saved,
      marks: marked.map((m) => ({
        profileId: m.profile_id,
        id: m.id,
        username: m.username,
        state: m.state,
        keep: m.keep ?? false,
        // Their own mark, else their twin's, kept under the same name (`neverTwins`).
        dontPitch:
          m.dont_pitch || m.tagged
            ? {
                by: m.dont_pitch ? m.dont_pitch_by : null,
                at:
                  m.dont_pitch && m.dont_pitch_at ? new Date(m.dont_pitch_at).toISOString() : null,
                tagged: m.tagged,
              }
            : m.twin_dont_pitch !== null
              ? {
                  by: m.twin_dont_pitch ? m.twin_by : null,
                  at: m.twin_dont_pitch && m.twin_at ? new Date(m.twin_at).toISOString() : null,
                  tagged: !m.twin_dont_pitch,
                }
              : null,
        demo: m.demo,
        intro: m.intro,
        mutualFriends: m.mutual_friends,
        groupName: m.group_name,
      })),
      threads: chats.map((t) => ({ ...t, lastSavedAt: t.lastSavedAt.toISOString() })),
      sameName,
    };
  },
});

/** What Social Outreach knows about one customer: their profiles and the chats saved with them. */
export const personSocial = defineAddonQuery(outreachAddon, {
  name: 'outreach.person',
  description: 'A customer’s social profiles and the chats saved with them, newest first.',
  input: z.object({ workspaceId: z.uuid(), personId: z.uuid() }),
  output: z.object({
    profiles: z.array(
      z.object({
        id: z.uuid(),
        platform: z.enum(PLATFORM_KEYS),
        url: z.string(),
        name: z.string(),
        intro: z.array(z.string()),
        friendship: z.string(),
        mutualFriends: z.number().int().nullable(),
        lastSeenAt: z.iso.datetime(),
      }),
    ),
    chats: z.array(
      z.object({
        id: z.uuid(),
        platform: z.enum(PLATFORM_KEYS),
        url: z.string(),
        encrypted: z.boolean(),
        ownerName: z.string().nullable(),
        savedMessages: z.number().int(),
        lastSavedAt: z.iso.datetime(),
        messages: z.array(
          z.object({
            from: z.enum(['me', 'them', 'unknown']),
            sender: z.string().nullable(),
            text: z.string(),
            when: z.string().nullable(),
            savedAt: z.string(),
          }),
        ),
      }),
    ),
  }),
  permission: 'outreach.use',
  ai: {
    tool: 'outreach_customer_social',
    keywords: ['facebook profile', 'social card', 'messenger chat with a customer'],
  },
  scope: inWorkspace,
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const found = await ctx.tx
      .select()
      .from(profiles)
      .where(and(eq(profiles.workspaceId, ws), eq(profiles.personId, input.personId)))
      .orderBy(desc(profiles.lastSeenAt));
    const chats = await ctx.tx
      .select()
      .from(threads)
      .where(and(eq(threads.workspaceId, ws), eq(threads.personId, input.personId)))
      .orderBy(desc(threads.lastSavedAt));
    const owners = new Map<string, string | null>();
    for (const id of new Set(chats.flatMap((c) => (c.ownerUserId ? [c.ownerUserId] : []))))
      owners.set(id, (await userRef(ctx.tx, id))?.fullName ?? null);
    return {
      profiles: found.map((p) => ({
        id: p.id,
        platform: p.platform,
        url: p.url,
        name: p.name,
        intro: p.intro,
        friendship: p.friendship,
        mutualFriends: p.mutualFriends,
        lastSeenAt: p.lastSeenAt.toISOString(),
      })),
      chats: chats.map((c) => ({
        id: c.id,
        platform: c.platform,
        url: c.url,
        encrypted: c.encrypted,
        ownerName: c.ownerUserId ? (owners.get(c.ownerUserId) ?? null) : null,
        savedMessages: c.savedMessages,
        lastSavedAt: c.lastSavedAt.toISOString(),
        messages: c.messages,
      })),
    };
  },
});

export const saveCommands = [profileSave, chatSave, chatKeep] as const;
export const saveQueries = [lookup, personSocial] as const;
