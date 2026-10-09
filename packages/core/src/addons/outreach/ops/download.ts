/**
 * Facebook's download file (docs/outreach.md, decisions 2 and 15): what the person's browser read out of it, saved a
 * part at a time. With the last part, each name is linked to the one profile saved here by that name, and what the
 * file says is put in place in the person's own friends: since when they've been friends, when each request was sent
 * or got, and the friends they removed and the requests they deleted. None of it adds anyone to Contacts, and no
 * message's words come here.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { rows } from '@hfos/db/client';
import { HfosError } from '../../../errors';
import { requireHuman } from '../../../kernel/actor';
import { changeMoment } from '../../../kernel/moment';
import type { CommandContext } from '../../../kernel/types';
import { defineAddonCommand } from '../../server';
import {
  DOWNLOAD_LIST_KEYS,
  DownloadSaveInput,
  DownloadSaveOutput,
  nameKey,
  type DownloadCounts,
  type DownloadList,
} from '../download';
import type { FriendState } from '../limits';
import { outreachAddon } from '../manifest';
import type { Platform } from '../playbooks';
import { fileChats, filePeople, friends, imports } from '../tables';
import { inWorkspace, once } from './common';

const DAY = 86_400_000;
/** Facebook's own start: nothing in a download is older. */
const FIRST_DAY = Date.UTC(2004, 0, 1);

/** The most rows one statement writes, well under Postgres's limit on a statement's values. */
const WRITE_MOST = 1000;

const inChunks = <T>(list: readonly T[]): T[][] =>
  Array.from({ length: Math.ceil(list.length / WRITE_MOST) }, (_, i) =>
    list.slice(i * WRITE_MOST, (i + 1) * WRITE_MOST),
  );

/** A uuid[] in one parameter; null stays null. */
const uuids = (ids: readonly (string | null)[]) =>
  sql`${`{${ids.map((id) => id ?? 'NULL').join(',')}}`}::uuid[]`;

/** What each list says about where the person's Facebook stands with someone. Followers and following say nothing. */
const LIST_STATE: Partial<Record<DownloadList, FriendState>> = {
  friends: 'friends',
  request_received: 'request_received',
  request_sent: 'request_sent',
  removed: 'not_friends',
  declined: 'declined',
};
/** Where things stand now, as the file was made, the strongest first; the rest are what happened before. */
const NOW_LISTS: readonly DownloadList[] = ['friends', 'request_received', 'request_sent'];

/** The bringing-in a later part belongs to: the person's own, and not finished. */
async function openImport(
  ctx: CommandContext,
  importId: string,
  me: string,
  platform: Platform,
): Promise<typeof imports.$inferSelect> {
  const [had] = await ctx.tx
    .select()
    .from(imports)
    .where(
      and(
        eq(imports.workspaceId, ctx.scope.workspaceId!),
        eq(imports.id, importId),
        eq(imports.userId, me),
        eq(imports.platform, platform),
      ),
    );
  if (!had)
    throw HfosError.notFound(
      'That file isn’t being brought in anymore. Pick the file again to start over.',
    );
  if (had.finishedAt)
    throw HfosError.rule(
      'outreach_download_finished',
      409,
      'That file is in already. To bring it in again, pick the file again.',
    );
  return had;
}

/** Every moment in a part is after Facebook began, and none after the file was made. */
function checkDates(
  input: Pick<DownloadSaveInput, 'people' | 'chats'>,
  madeAt: Date,
  now: Date,
): void {
  const fine = (at: string | null | undefined, latest: number) =>
    at === null || at === undefined || (Date.parse(at) >= FIRST_DAY && Date.parse(at) <= latest);
  const made = madeAt.getTime();
  if (
    !fine(madeAt.toISOString(), now.getTime() + DAY) ||
    !(input.people ?? []).every((p) => fine(p.at, made + DAY)) ||
    !(input.chats ?? []).every(
      (c) =>
        fine(c.firstAt, made + DAY) &&
        fine(c.lastAt, made + DAY) &&
        Date.parse(c.firstAt) <= Date.parse(c.lastAt),
    )
  )
    throw HfosError.rule(
      'outreach_download_dates',
      400,
      'Some dates in that file come after it was made, so it can’t be brought in. Download your information from Facebook again and pick the new file.',
    );
}

/** The people in a part, each once by their list, name and moment, ready to write. */
function peopleRows(
  input: DownloadSaveInput & { readonly platform: Platform },
  ws: string,
  me: string,
  importId: string,
) {
  const seen = new Set<string>();
  return (input.people ?? []).flatMap((p) => {
    const key = nameKey(p.name);
    const once = `${p.list}\n${key}\n${p.at ?? ''}`;
    if (seen.has(once)) return [];
    seen.add(once);
    return [
      {
        workspaceId: ws,
        userId: me,
        platform: input.platform,
        list: p.list,
        name: p.name,
        nameKey: key,
        at: p.at ? new Date(p.at) : null,
        importId,
      },
    ];
  });
}

/** The chats in a part, each person's once: the same name written two ways is one chat. */
function chatRows(
  input: DownloadSaveInput & { readonly platform: Platform },
  ws: string,
  me: string,
  importId: string,
) {
  const byKey = new Map<string, typeof fileChats.$inferInsert>();
  for (const c of input.chats ?? []) {
    const key = nameKey(c.name);
    const firstAt = new Date(c.firstAt);
    const lastAt = new Date(c.lastAt);
    const had = byKey.get(key);
    byKey.set(
      key,
      had
        ? {
            ...had,
            firstAt: firstAt < had.firstAt ? firstAt : had.firstAt,
            lastAt: lastAt > had.lastAt ? lastAt : had.lastAt,
            lastFromMe: lastAt > had.lastAt ? c.lastFromMe : had.lastFromMe,
            messages: had.messages + c.messages,
          }
        : {
            workspaceId: ws,
            userId: me,
            platform: input.platform,
            name: c.name,
            nameKey: key,
            firstAt,
            lastAt,
            messages: c.messages,
            lastFromMe: c.lastFromMe,
            importId,
          },
    );
  }
  return [...byKey.values()];
}

/**
 * The profile each name in the file is: the one saved here by that name, or among several, the one the person's own
 * Facebook has a say on. A name twice in one of the file's lists is two people, and neither is matched.
 */
async function matchNames(
  ctx: CommandContext,
  me: string,
  platform: Platform,
  people: readonly { readonly list: DownloadList; readonly nameKey: string }[],
): Promise<Map<string, string>> {
  const ws = ctx.scope.workspaceId!;
  const twice = new Set<string>();
  const inList = new Set<string>();
  for (const p of people) {
    const key = `${p.list}\n${p.nameKey}`;
    if (inList.has(key)) twice.add(p.nameKey);
    inList.add(key);
  }
  const saved = await rows<{ id: string; name: string; mine: boolean }>(
    ctx.tx,
    sql`select p.id, p.name, exists (select 1 from addon_outreach.friends f
          where f.profile_id = p.id and f.user_id = ${me}) as mine
        from addon_outreach.profiles p where p.workspace_id = ${ws} and p.platform = ${platform}`,
  );
  const byName = new Map<string, { id: string; mine: boolean }[]>();
  for (const p of saved) {
    const key = nameKey(p.name);
    byName.set(key, [...(byName.get(key) ?? []), { id: p.id, mine: p.mine }]);
  }
  const matched = new Map<string, string>();
  for (const [key, found] of byName) {
    if (twice.has(key)) continue;
    const mine = found.filter((p) => p.mine);
    const one = mine.length ? mine : found;
    if (one.length === 1) matched.set(key, one[0]!.id);
  }
  return matched;
}

/** What the file says about each profile: where things stood when it was made, or else the latest thing that happened. */
function verdicts(
  people: readonly {
    readonly list: DownloadList;
    readonly at: Date | null;
    readonly profileId: string | null;
  }[],
): Map<string, { state: FriendState; at: Date | null }> {
  const byProfile = new Map<string, typeof people>();
  for (const p of people)
    if (p.profileId && LIST_STATE[p.list])
      byProfile.set(p.profileId, [...(byProfile.get(p.profileId) ?? []), p]);
  const out = new Map<string, { state: FriendState; at: Date | null }>();
  const latest = (list: typeof people) =>
    list.reduce<Date | null>((a, p) => (p.at && (!a || p.at > a) ? p.at : a), null);
  for (const [profileId, said] of byProfile) {
    const now = NOW_LISTS.find((l) => said.some((p) => p.list === l));
    if (now) {
      out.set(profileId, {
        state: LIST_STATE[now]!,
        at: latest(said.filter((p) => p.list === now)),
      });
      continue;
    }
    // Removed and deleted both: the later one, and a deleted request when they're as late.
    const removed = latest(said.filter((p) => p.list === 'removed'));
    const declined = latest(said.filter((p) => p.list === 'declined'));
    const hadDeclined = said.some((p) => p.list === 'declined');
    out.set(
      profileId,
      hadDeclined && (!removed || (declined !== null && declined >= removed))
        ? { state: 'declined', at: declined }
        : { state: 'not_friends', at: removed },
    );
  }
  return out;
}

/**
 * Puts what the file says in place in the person's own friends, as of when it was made. Newer news wins: something
 * seen since only moves its start earlier when it's the same; "not friends" never replaces a request they deleted;
 * Keep stays. How many changed.
 */
async function putInPlace(
  ctx: CommandContext,
  me: string,
  said: Map<string, { state: FriendState; at: Date | null }>,
  madeAt: Date,
): Promise<number> {
  if (!said.size) return 0;
  const ws = ctx.scope.workspaceId!;
  const had = new Map<string, typeof friends.$inferSelect>();
  for (const chunk of inChunks([...said.keys()]))
    for (const f of await ctx.tx
      .select()
      .from(friends)
      .where(
        and(eq(friends.workspaceId, ws), eq(friends.userId, me), inArray(friends.profileId, chunk)),
      ))
      had.set(f.profileId, f);

  const write: { profileId: string; state: FriendState; since: Date; seenAt: Date }[] = [];
  for (const [profileId, { state: fileState, at }] of said) {
    const was = had.get(profileId);
    if (!was) {
      write.push({ profileId, state: fileState, since: at ?? madeAt, seenAt: madeAt });
      continue;
    }
    if (was.seenAt > madeAt) {
      // Seen since the file was made: only a start the file knows was earlier.
      if (was.state === fileState && at && at < was.since)
        write.push({ profileId, state: was.state, since: at, seenAt: was.seenAt });
      continue;
    }
    // A request they deleted says more than not being friends.
    if (was.state === 'declined' && fileState === 'not_friends') continue;
    if (fileState !== was.state) {
      write.push({ profileId, state: fileState, since: at ?? madeAt, seenAt: madeAt });
      continue;
    }
    const earlier = at !== null && at < was.since;
    if (earlier || madeAt > was.seenAt)
      write.push({ profileId, state: fileState, since: earlier ? at : was.since, seenAt: madeAt });
  }
  for (const chunk of inChunks(write))
    await ctx.tx
      .insert(friends)
      .values(chunk.map((w) => ({ workspaceId: ws, userId: me, ...w })))
      .onConflictDoUpdate({
        target: [friends.workspaceId, friends.userId, friends.profileId],
        set: {
          state: sql`excluded.state`,
          since: sql`excluded.since`,
          seenAt: sql`excluded.seen_at`,
        },
      });
  return write.filter((w) => {
    const was = had.get(w.profileId);
    return !was || was.state !== w.state || was.since.getTime() !== w.since.getTime();
  }).length;
}

/** The last part: names matched to profiles, what the file says put in place, and what it held counted. */
async function finish(
  ctx: CommandContext,
  me: string,
  done: typeof imports.$inferSelect,
): Promise<{ counts: DownloadCounts; changed: number }> {
  const people = await ctx.tx
    .select({
      id: filePeople.id,
      list: filePeople.list,
      nameKey: filePeople.nameKey,
      at: filePeople.at,
      profileId: filePeople.profileId,
    })
    .from(filePeople)
    .where(eq(filePeople.importId, done.id));
  const chats = await ctx.tx
    .select({ id: fileChats.id, nameKey: fileChats.nameKey, profileId: fileChats.profileId })
    .from(fileChats)
    .where(eq(fileChats.importId, done.id));

  const matched = await matchNames(ctx, me, done.platform, people);
  const link = async (table: 'file_people' | 'file_chats', list: typeof chats) => {
    const moved = list.filter((r) => (matched.get(r.nameKey) ?? null) !== r.profileId);
    for (const chunk of inChunks(moved))
      await ctx.tx.execute(
        sql`update ${sql.raw(`addon_outreach.${table}`)} t set profile_id = v.profile_id
            from unnest(${uuids(chunk.map((r) => r.id))}, ${uuids(chunk.map((r) => matched.get(r.nameKey) ?? null))})
              as v(id, profile_id)
            where t.id = v.id`,
      );
  };
  await link('file_people', people);
  await link('file_chats', chats);

  const changed = await putInPlace(
    ctx,
    me,
    verdicts(people.map((p) => ({ ...p, profileId: matched.get(p.nameKey) ?? null }))),
    done.madeAt,
  );
  const linked =
    people.filter((p) => matched.has(p.nameKey)).length +
    chats.filter((c) => matched.has(c.nameKey)).length;
  const byList = Object.fromEntries(
    DOWNLOAD_LIST_KEYS.map((l) => [l, people.filter((p) => p.list === l).length]),
  ) as Record<DownloadList, number>;
  const counts: DownloadCounts = {
    ...byList,
    chats: chats.length,
    linked,
    notLinked: people.length + chats.length - linked,
  };
  await ctx.tx
    .update(imports)
    .set({ counts, finishedAt: changeMoment(ctx.meta) })
    .where(eq(imports.id, done.id));
  return { counts, changed };
}

export const downloadSave = defineAddonCommand(outreachAddon, {
  name: 'outreach.download.save',
  description:
    'Bring in a part of the person’s Facebook download file as their browser read it: the names in their friends, requests, removed friends, deleted requests, followers and following, with when, and when they last messaged each person, never what was said. The last part matches the names to the profiles saved here and puts it in place in their own friends. Adds nobody to Contacts.',
  risk: 1,
  input: DownloadSaveInput,
  output: DownloadSaveOutput,
  permission: 'outreach.use',
  scope: inWorkspace,
  emits: ['outreach.download.saved'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const now = changeMoment(ctx.meta);
    return once(async () => {
      const started = input.importId
        ? await openImport(ctx, input.importId, me, input.platform)
        : (
            await ctx.tx
              .insert(imports)
              .values({
                workspaceId: ws,
                userId: me,
                platform: input.platform,
                madeAt: new Date(input.madeAt),
              })
              .returning()
          )[0]!;
      checkDates(input, started.madeAt, now);

      for (const chunk of inChunks(peopleRows(input, ws, me, started.id)))
        await ctx.tx
          .insert(filePeople)
          .values(chunk)
          .onConflictDoUpdate({
            target: [
              filePeople.userId,
              filePeople.workspaceId,
              filePeople.platform,
              filePeople.list,
              filePeople.nameKey,
              filePeople.at,
            ],
            set: { name: sql`excluded.name`, importId: sql`excluded.import_id` },
          });
      // A chat brought in before keeps its first message and gains the later ones.
      for (const chunk of inChunks(chatRows(input, ws, me, started.id)))
        await ctx.tx
          .insert(fileChats)
          .values(chunk)
          .onConflictDoUpdate({
            target: [
              fileChats.userId,
              fileChats.workspaceId,
              fileChats.platform,
              fileChats.nameKey,
            ],
            set: {
              name: sql`excluded.name`,
              firstAt: sql`least(${fileChats.firstAt}, excluded.first_at)`,
              lastAt: sql`greatest(${fileChats.lastAt}, excluded.last_at)`,
              lastFromMe: sql`case when excluded.last_at >= ${fileChats.lastAt}
                then excluded.last_from_me else ${fileChats.lastFromMe} end`,
              messages: sql`greatest(${fileChats.messages}, excluded.messages)`,
              importId: sql`excluded.import_id`,
            },
          });

      if (!input.last) return { importId: started.id, counts: null, changed: 0 };
      const { counts, changed } = await finish(ctx, me, started);
      await ctx.emit({
        type: 'outreach.download.saved',
        entityType: 'workspace',
        entityId: ws,
        payload: { platform: input.platform, importId: started.id, ...counts, changed },
      });
      return { importId: started.id, counts, changed };
    });
  },
});

export const downloadCommands = [downloadSave] as const;
