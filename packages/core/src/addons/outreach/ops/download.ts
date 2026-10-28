/**
 * Facebook's download file (docs/outreach.md, decisions 2 and 15): what the person's browser read out of it, saved a
 * part at a time. With the last part, each name is linked to the one profile saved here by that name, and what the
 * file says is put in place in the person's own friends: since when they've been friends, when each request was sent
 * or got, and the friends they removed and the requests they deleted. Of what was said, only each chat's latest few
 * messages come, for the AI to read (../chat-read.ts, apps/worker/src/addons/outreach/chats.ts); it's the reading
 * that may put someone in Contacts, under the business's setting, never the file itself.
 */
import { and, eq, sql } from 'drizzle-orm';
import { HfosError } from '../../../errors';
import { requireHuman } from '../../../kernel/actor';
import { changeMoment } from '../../../kernel/moment';
import type { CommandContext } from '../../../kernel/types';
import { defineAddonCommand } from '../../server';
import { worthReading, type ChatReadState } from '../chat-read';
import {
  DOWNLOAD_LIST_KEYS,
  DownloadSaveInput,
  DownloadSaveOutput,
  nameKey,
  type DownloadCounts,
  type DownloadList,
  type DownloadMessage,
} from '../download';
import { RECENT_MESSAGES } from '../limits';
import { outreachAddon } from '../manifest';
import type { Platform } from '../playbooks';
import { fileChats, filePeople, imports } from '../tables';
import { inWorkspace, once } from './common';
import { inChunks, matchNames, putInPlace, uuids, verdicts } from './file-match';

const DAY = 86_400_000;
/** Facebook's own start: nothing in a download is older. */
const FIRST_DAY = Date.UTC(2004, 0, 1);

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

/** Whether a chat's latest messages are for the AI: nothing to read, theirs to read, or only the person's own. */
const readStateOf = (recent: readonly DownloadMessage[]): ChatReadState =>
  !recent.length ? 'none' : worthReading(recent) ? 'waiting' : 'skipped';

/** The latest few of two lists of messages, oldest first. */
const latest = (a: readonly DownloadMessage[], b: readonly DownloadMessage[]) =>
  [...a, ...b].sort((x, y) => x.at.localeCompare(y.at)).slice(-RECENT_MESSAGES);

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
            recent: latest(had.recent ?? [], c.recent ?? []),
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
            recent: latest([], c.recent ?? []),
            importId,
          },
    );
  }
  return [...byKey.values()].map((c) => ({ ...c, readState: readStateOf(c.recent ?? []) }));
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
    .select({
      id: fileChats.id,
      nameKey: fileChats.nameKey,
      profileId: fileChats.profileId,
      threadKey: fileChats.threadKey,
    })
    .from(fileChats)
    .where(eq(fileChats.importId, done.id));

  const matched = await matchNames(ctx, me, done.platform, people);
  const link = async (
    table: 'file_people' | 'file_chats',
    list: readonly { id: string; nameKey: string; profileId: string | null }[],
  ) => {
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
  // A chat read in the person's browser keeps the profile its own link named: a name in the file can't tell two
  // people with the same name apart (decision 93).
  await link(
    'file_chats',
    chats.filter((c) => !(c.threadKey && c.profileId)),
  );

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

/** In the upsert: whether what's sent has newer messages to read than what's kept. */
const newerWords = sql`(jsonb_array_length(excluded.recent) > 0 and (excluded.last_at > ${fileChats.lastAt}
  or jsonb_array_length(${fileChats.recent}) = 0))`;

export const downloadSave = defineAddonCommand(outreachAddon, {
  name: 'outreach.download.save',
  description:
    'Bring in a part of the person’s Facebook download file as their browser read it: the names in their friends, requests, removed friends, deleted requests, followers and following, with when, and when they last messaged each person with their latest few messages, which the AI reads later. The last part matches the names to the profiles saved here and puts it in place in their own friends. Adds nobody to Contacts itself.',
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
      // A chat brought in before keeps its first message and gains the later ones. Its latest messages are read
      // again only when there are newer ones (or none were kept before): the same file twice reads nothing twice.
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
              recent: sql`case when ${newerWords} then excluded.recent else ${fileChats.recent} end`,
              readState: sql`case when ${newerWords} then excluded.read_state else ${fileChats.readState} end`,
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
