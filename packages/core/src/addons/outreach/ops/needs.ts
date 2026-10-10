/**
 * Steps the extension needs the person for (../waiting-words.ts, docs/outreach.md decision 42): one it couldn't do
 * there and then is handed to them, and the step noted later, however it was taken, clears it. Server-only, and kept
 * apart from ./waiting.ts so the operations that note steps (./activity.ts, ./friends.ts, ./sends.ts) can open and
 * clear one without reading the list.
 */
import { and, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type { CommandContext } from '../../../kernel/types';
import { clipLine } from '../live';
import { FacebookUrl } from '../saves';
import { NEED_QUIET_DAYS, NEED_SHOWN_DAYS, NEED_WHY_MOST, type NeedStep } from '../waiting-words';
import { needs, posts } from '../tables';

const DAY = 86_400_000;

export interface NeedSeen {
  readonly step: NeedStep;
  readonly profileId: string;
  readonly postId?: string | null;
  readonly sendId?: string | null;
  readonly name: string;
  readonly url: string | null;
  readonly why: string;
}

/**
 * Hands a step the extension couldn't do to the person, at `at` (the moment it couldn't):
 *
 * - the same step for the same person or post open already: it's seen again, with the newest why (and, for a message,
 *   the newest send); fresh again only when it had left the list (not seen for `NEED_SHOWN_DAYS`), so the person
 *   hears of it once more;
 * - the same let go within `NEED_QUIET_DAYS`: nothing is kept;
 * - else a new one, which the person hears of (`outreach.need.noted`).
 */
export async function openNeed(
  ctx: CommandContext,
  me: string,
  given: NeedSeen,
  at: Date,
): Promise<{ needId: string | null; fresh: boolean }> {
  const ws = ctx.scope.workspaceId!;
  // Cut to what's kept, never refused for its length.
  const seen = {
    ...given,
    name: clipLine(given.name, 200),
    // Only a Facebook address is kept: the lists link to it.
    url: given.url && FacebookUrl.safeParse(given.url).success ? given.url.trim() : null,
    why: clipLine(given.why.trim() || 'it couldn’t', NEED_WHY_MOST),
  };
  const postId = seen.postId ?? null;
  const same = and(
    eq(needs.workspaceId, ws),
    eq(needs.userId, me),
    eq(needs.step, seen.step),
    sql`coalesce(${needs.postId}, ${needs.profileId}) = ${postId ?? seen.profileId}::uuid`,
  );
  const [quiet] = await ctx.tx
    .select({ id: needs.id })
    .from(needs)
    .where(
      and(
        same,
        eq(needs.state, 'dismissed'),
        sql`${needs.clearedAt} >= ${new Date(at.getTime() - NEED_QUIET_DAYS * DAY).toISOString()}::timestamptz`,
      ),
    )
    .limit(1);
  if (quiet) return { needId: null, fresh: false };
  const tell = async (needId: string) => {
    await ctx.emit({
      type: 'outreach.need.noted',
      entityType: 'outreach_need',
      entityId: needId,
      payload: { userId: me, step: seen.step, profileId: seen.profileId },
    });
    return { needId, fresh: true };
  };
  const [open] = await ctx.tx
    .select()
    .from(needs)
    .where(and(same, eq(needs.state, 'open')));
  if (open) {
    const newer = at >= open.seenAt;
    const aged = open.seenAt.getTime() < at.getTime() - NEED_SHOWN_DAYS * DAY;
    await ctx.tx
      .update(needs)
      .set({
        ...(newer
          ? {
              seenAt: at,
              why: seen.why,
              name: seen.name,
              url: seen.url,
              ...(seen.sendId ? { sendId: seen.sendId } : {}),
            }
          : {}),
        // Back on the list after a week off it: it begins to wait again, as it reaches HandsFreeOS.
        ...(aged ? { createdAt: new Date() } : {}),
        updatedAt: new Date(),
      })
      .where(eq(needs.id, open.id));
    return aged ? tell(open.id) : { needId: open.id, fresh: false };
  }
  const [made] = await ctx.tx
    .insert(needs)
    .values({
      workspaceId: ws,
      userId: me,
      step: seen.step,
      profileId: seen.profileId,
      postId,
      sendId: seen.sendId ?? null,
      name: seen.name,
      url: seen.url,
      why: seen.why,
      // When it couldn't; it begins to wait (`created_at`) as it reaches HandsFreeOS, however long the extension
      // kept it, so the bundled push never takes it for one told already.
      seenAt: at,
    })
    .onConflictDoNothing()
    .returning({ id: needs.id });
  if (made) return tell(made.id);
  // Noted twice at the same moment: the first is the one.
  const [had] = await ctx.tx
    .select({ id: needs.id })
    .from(needs)
    .where(and(same, eq(needs.state, 'open')));
  return { needId: had?.id ?? null, fresh: false };
}

/**
 * The step was taken at `at` (noted by the extension, however it was done): the person's open needs for it are done.
 * One the extension couldn't do again after that moment stays. A comment's is by its post (found by the link the step
 * was noted with), or the profile's with no post kept or the same link.
 */
export async function clearNeeds(
  ctx: CommandContext,
  me: string,
  to: {
    readonly profileId: string;
    readonly steps: readonly NeedStep[];
    readonly postUrl?: string | null;
  },
  at: Date,
): Promise<void> {
  const ws = ctx.scope.workspaceId!;
  const [post] = to.postUrl
    ? await ctx.tx
        .select({ id: posts.id })
        .from(posts)
        .where(and(eq(posts.workspaceId, ws), eq(posts.userId, me), eq(posts.url, to.postUrl)))
    : [];
  await ctx.tx
    .update(needs)
    .set({ state: 'done', clearedAt: at, updatedAt: new Date() })
    .where(
      and(
        eq(needs.workspaceId, ws),
        eq(needs.userId, me),
        eq(needs.state, 'open'),
        inArray(needs.step, [...to.steps]),
        lte(needs.seenAt, at),
        // Their own, by the post's link, or with no post kept: a post spelled another way still clears it.
        or(
          post ? eq(needs.postId, post.id) : undefined,
          and(
            eq(needs.profileId, to.profileId),
            or(isNull(needs.postId), to.postUrl ? eq(needs.url, to.postUrl) : undefined),
          ),
        ),
      ),
    );
}
