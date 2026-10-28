/**
 * Matching Facebook's download file to the profiles saved here (docs/outreach.md, decisions 2 and 15): each name in
 * the file is the one profile saved by that name, and what the file says goes in place in the person's own friends.
 * The file's last part does it for every name (./download.ts); a profile saved since does it for its own name, so it
 * needn't wait for a newer file (`matchFileLater`).
 */
import { and, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { rows } from '@hfos/db/client';
import type { CommandContext } from '../../../kernel/types';
import { nameKey, type DownloadList } from '../download';
import type { FriendState } from '../limits';
import type { Platform } from '../playbooks';
import { fileChats, filePeople, friends, imports } from '../tables';

/** The most rows one statement writes, well under Postgres's limit on a statement's values. */
export const WRITE_MOST = 1000;

export const inChunks = <T>(list: readonly T[]): T[][] =>
  Array.from({ length: Math.ceil(list.length / WRITE_MOST) }, (_, i) =>
    list.slice(i * WRITE_MOST, (i + 1) * WRITE_MOST),
  );

/** A uuid[] in one parameter; null stays null. */
export const uuids = (ids: readonly (string | null)[]) =>
  sql`${`{${ids.map((id) => id ?? 'NULL').join(',')}}`}::uuid[]`;

/** What each list says about where the person's Facebook stands with someone. Followers and following say nothing. */
export const LIST_STATE: Partial<Record<DownloadList, FriendState>> = {
  friends: 'friends',
  request_received: 'request_received',
  request_sent: 'request_sent',
  removed: 'not_friends',
  declined: 'declined',
};
/** Where things stand now, as the file was made, the strongest first; the rest are what happened before. */
export const NOW_LISTS: readonly DownloadList[] = ['friends', 'request_received', 'request_sent'];

/**
 * The profile each name in the file is: the one saved here by that name, or among several, the one the person's own
 * Facebook has a say on. A name twice in one of the file's lists is two people, and neither is matched.
 */
export async function matchNames(
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
export function verdicts(
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
export async function putInPlace(
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

/**
 * A profile saved after the person's file came in (fix 28 on the list of 28 Oct 2026), matched to the file's names
 * now rather than at the next file: only the person's own file, as their friends are their own; only names still
 * matched to nobody; and only as the file's last part would match them, so a name two saved profiles share matches
 * neither. What the file says about them then goes in place, where nothing seen since says otherwise.
 */
export async function matchFileLater(
  ctx: CommandContext,
  me: string,
  platform: Platform,
  saved: readonly { readonly name: string }[],
): Promise<void> {
  const keys = [...new Set(saved.map((p) => nameKey(p.name)))].filter(Boolean);
  if (!keys.length) return;
  const ws = ctx.scope.workspaceId!;
  const done = await ctx.tx
    .select({ id: imports.id, madeAt: imports.madeAt })
    .from(imports)
    .where(
      and(
        eq(imports.workspaceId, ws),
        eq(imports.userId, me),
        eq(imports.platform, platform),
        isNotNull(imports.finishedAt),
      ),
    );
  if (!done.length) return;
  const made = new Map(done.map((d) => [d.id, d.madeAt]));
  const people = (
    await ctx.tx
      .select({
        id: filePeople.id,
        list: filePeople.list,
        nameKey: filePeople.nameKey,
        at: filePeople.at,
        profileId: filePeople.profileId,
        importId: filePeople.importId,
      })
      .from(filePeople)
      .where(
        and(
          eq(filePeople.workspaceId, ws),
          eq(filePeople.userId, me),
          eq(filePeople.platform, platform),
          inArray(filePeople.nameKey, keys),
        ),
      )
  ).filter((p) => made.has(p.importId));
  const chats = await ctx.tx
    .select({ id: fileChats.id, nameKey: fileChats.nameKey, importId: fileChats.importId })
    .from(fileChats)
    .where(
      and(
        eq(fileChats.workspaceId, ws),
        eq(fileChats.userId, me),
        eq(fileChats.platform, platform),
        isNull(fileChats.profileId),
        inArray(fileChats.importId, [...made.keys()]),
        inArray(fileChats.nameKey, keys),
      ),
    );
  if (!chats.length && people.every((p) => p.profileId)) return;

  const matched = await matchNames(ctx, me, platform, people);
  const linkPeople = people.filter((p) => !p.profileId && matched.has(p.nameKey));
  const linkChats = chats.filter((c) => matched.has(c.nameKey));
  for (const [table, list] of [
    ['file_people', linkPeople],
    ['file_chats', linkChats],
  ] as const)
    for (const chunk of inChunks(list))
      await ctx.tx.execute(
        sql`update ${sql.raw(`addon_outreach.${table}`)} t set profile_id = v.profile_id
            from unnest(${uuids(chunk.map((r) => r.id))}, ${uuids(chunk.map((r) => matched.get(r.nameKey)!))})
              as v(id, profile_id)
            where t.id = v.id and t.profile_id is null`,
      );

  // What each file said, the oldest file first, so a newer one's word is the one that stays.
  const byImport = new Map<string, number>();
  for (const r of [...linkPeople, ...linkChats])
    byImport.set(r.importId!, (byImport.get(r.importId!) ?? 0) + 1);
  for (const [importId, madeAt] of [...made].sort((a, b) => a[1].getTime() - b[1].getTime())) {
    const said = linkPeople.filter((p) => p.importId === importId);
    if (said.length)
      await putInPlace(
        ctx,
        me,
        verdicts(said.map((p) => ({ ...p, profileId: matched.get(p.nameKey)! }))),
        madeAt,
      );
    // Its counts: these are linked now.
    const linked = byImport.get(importId);
    if (linked)
      await ctx.tx
        .update(imports)
        .set({
          counts: sql`case when ${imports.counts} is null then null else jsonb_set(jsonb_set(${imports.counts},
            '{linked}', to_jsonb(coalesce((${imports.counts}->>'linked')::int, 0) + ${linked})),
            '{notLinked}', to_jsonb(greatest(coalesce((${imports.counts}->>'notLinked')::int, 0) - ${linked}, 0))) end`,
        })
        .where(eq(imports.id, importId));
  }
}
