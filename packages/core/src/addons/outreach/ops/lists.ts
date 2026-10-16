/**
 * When the person's own lists were last saved to their end, before their day (../lists.ts, docs/outreach.md "Lists
 * first"): read by the extension, which saves them, and shown under Start my day on the web and the phone. Each
 * person's own.
 */
import { and, eq, sql } from 'drizzle-orm';
import { requireHuman } from '../../../kernel/actor';
import { changeMoment } from '../../../kernel/moment';
import { defineAddonCommand, defineAddonQuery } from '../../server';
import {
  atKey,
  ListSavedInput,
  ListSavedOutput,
  ListsInput,
  ListsOutput,
  NO_LISTS,
  type ListsSaved,
} from '../lists';
import { outreachAddon } from '../manifest';
import type { Platform } from '../networks';
import { listSaves } from '../tables';
import { inWorkspace, type Ctx } from './common';

const iso = (at: Date | null) => at?.toISOString() ?? null;

/**
 * The person's lists on a network as kept: never saved when there's no row. Facebook's are the row's columns; any
 * other network's are under its name in `network_saves`.
 */
export async function listsOf(
  ctx: Ctx,
  userId: string,
  platform: Platform = 'facebook',
): Promise<ListsSaved> {
  const [row] = await ctx.tx
    .select()
    .from(listSaves)
    .where(and(eq(listSaves.workspaceId, ctx.scope.workspaceId!), eq(listSaves.userId, userId)));
  if (!row) return NO_LISTS;
  if (platform !== 'facebook') {
    const kept = row.networkSaves[platform] ?? {};
    return Object.fromEntries(
      Object.keys(NO_LISTS).map((key) => [key, kept[key] ?? null]),
    ) as ListsSaved;
  }
  return {
    friendsAt: iso(row.friendsAt),
    requestsAt: iso(row.requestsAt),
    sentAt: iso(row.sentAt),
    groupsAt: iso(row.groupsAt),
    groupChecksAt: iso(row.groupChecksAt),
    tidyAt: iso(row.tidyAt),
    checksAt: iso(row.checksAt),
  };
}

export const lists = defineAddonQuery(outreachAddon, {
  name: 'outreach.lists',
  description:
    'When the person’s own friends list, the friend requests they’ve got, the ones they’ve sent and their groups were last saved to their end, and when the first check of their groups, Tidy up and good-fits check after that were done.',
  input: ListsInput,
  output: ListsOutput,
  permission: 'outreach.use',
  scope: inWorkspace,
  handler: (ctx, input) => listsOf(ctx, requireHuman(ctx).userId, input.platform),
});

export const listSaved = defineAddonCommand(outreachAddon, {
  name: 'outreach.lists.saved',
  description:
    'Note that the extension saved one of the person’s own lists to its end (friends, friend requests got or sent, groups), checked their groups, worked out their Tidy up suggestions, or checked their friends for good fits, the first time. The first time, their day starts once all four lists are saved.',
  risk: 0,
  input: ListSavedInput,
  output: ListSavedOutput,
  permission: 'outreach.use',
  scope: inWorkspace,
  emits: ['outreach.lists.saved'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const at = changeMoment(ctx.meta);
    const column = atKey(input.list);
    const { platform } = input;
    // Facebook's in its columns; any other network's under its name, beside them.
    const set =
      platform === 'facebook'
        ? { [column]: at }
        : {
            networkSaves: sql`jsonb_set(
              case when ${listSaves.networkSaves} ? ${platform} then ${listSaves.networkSaves}
                else ${listSaves.networkSaves} || jsonb_build_object(${platform}::text, '{}'::jsonb) end,
              array[${platform}::text, ${column}::text], to_jsonb(${at.toISOString()}::text))`,
          };
    const [row] = await ctx.tx
      .insert(listSaves)
      .values({
        workspaceId: ctx.scope.workspaceId!,
        userId: me,
        ...(platform === 'facebook'
          ? { [column]: at }
          : { networkSaves: { [platform]: { [column]: at.toISOString() } } }),
      })
      .onConflictDoUpdate({
        target: [listSaves.workspaceId, listSaves.userId],
        set: { ...set, updatedAt: at },
      })
      .returning({ id: listSaves.id });
    await ctx.emit({
      type: 'outreach.lists.saved',
      entityType: 'outreach_list_saves',
      entityId: row!.id,
      payload: { userId: me, list: input.list, platform },
    });
    return listsOf(ctx, me, platform);
  },
});

export const listCommands = [listSaved] as const;
export const listQueries = [lists] as const;
