/**
 * Reading what customers said, and answering them.
 *
 * Polled rather than pushed: neither Google nor Facebook will reliably tell us the moment somebody writes
 * one, so each connected place is asked on a timer. A review is written here as it stands over there —
 * including a reply somebody left on their phone — so the list opens instantly, a reply can be written
 * beside the rest of a customer's history, and nothing is lost the day the connection ends.
 *
 * Their dates, never ours: a review written in 2019 belongs in 2019, the same promise the migration makes.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { reviewConnections } from '@hfos/db/schema';
import { asWorker, rows } from '@hfos/db/client';
import type { JobHandler, JobResult } from '../jobs';
import type { TenantScope, WorkerServices } from '../services';
import { tenantOf } from '../services';
import { ReviewAuthError, ReviewError, type ReviewProvider, type TokenSet } from './provider';

/** Refreshed this long before it expires, so a read never races the clock. */
const REFRESH_AHEAD_MS = 5 * 60_000;
/** Pages read in one pass. A place with years of reviews catches up over a few passes rather than one long one. */
const MAX_PAGES = 5;
/** A place that keeps failing is asked less often, up to a day apart. */
const BACKOFF_MS = [5 * 60_000, 30 * 60_000, 2 * 3_600_000, 6 * 3_600_000, 24 * 3_600_000];

type Connection = typeof reviewConnections.$inferSelect;

const usable = (c: Connection) => c.status === 'connected' || c.status === 'needs_attention';

function openTokens(s: WorkerServices, sealed: string): TokenSet {
  return JSON.parse(s.sealer.open(sealed)) as TokenSet;
}

/** Holds the sign-in open: refreshes before it expires, and once more if the provider says 401. */
function session(s: WorkerServices, scope: TenantScope, c: Connection, provider: ReviewProvider) {
  let tokens: TokenSet | null = null;
  const fresh = async (force: boolean): Promise<TokenSet> => {
    if (!c.tokenEnc) throw new ReviewAuthError('This place has no sign-in.', 'missing');
    const current = tokens ?? openTokens(s, c.tokenEnc);
    if (!force && Date.parse(current.expiresAt) - Date.now() > REFRESH_AHEAD_MS)
      return (tokens = current);
    const next = await provider.refresh(current);
    // Only while it is still connected: a disconnect in the meantime cleared the tokens, and they stay cleared.
    await asWorker(s.db, scope, (tx) =>
      tx
        .update(reviewConnections)
        .set({
          tokenEnc: s.sealer.seal(JSON.stringify(next)),
          tokenKeyId: s.sealer.keyId,
          tokenExpiresAt: new Date(next.expiresAt),
        })
        .where(
          and(
            eq(reviewConnections.id, c.id),
            inArray(reviewConnections.status, ['connected', 'needs_attention']),
          ),
        ),
    );
    return (tokens = next);
  };
  return async <T>(fn: (accessToken: string) => Promise<T>): Promise<T> => {
    const t = await fresh(false);
    try {
      return await fn(t.accessToken);
    } catch (e) {
      if (!(e instanceof ReviewError && e.status === 401)) throw e;
      return fn((await fresh(true)).accessToken);
    }
  };
}

/** A sign-in that stopped working asks to be connected again; anything else is tried later. */
async function stumbled(
  ctx: WorkerServices,
  scope: TenantScope,
  c: Connection,
  error: unknown,
): Promise<void> {
  const needsPerson = error instanceof ReviewAuthError;
  const failures = Math.min(c.failures + 1, 1_000_000);
  const wait = BACKOFF_MS[Math.min(failures - 1, BACKOFF_MS.length - 1)]!;
  await asWorker(ctx.db, scope, (tx) =>
    tx
      .update(reviewConnections)
      .set({
        status: needsPerson ? 'needs_attention' : c.status,
        failures,
        lastError: (error instanceof Error ? error.message : String(error)).slice(0, 2000),
        // A connection waiting on a person is not polled until they come back to it.
        nextSyncAt: needsPerson ? null : new Date(Date.now() + wait),
      })
      .where(eq(reviewConnections.id, c.id)),
  );
}

/**
 * One connected place, read.
 *
 * Every review is written as the source has it, including its reply: somebody answering on their phone is
 * the normal case, and a screen that does not know that shows a review as unanswered forever.
 */
export const reviewsSync: JobHandler = async (ctx): Promise<JobResult> => {
  const scope = tenantOf(ctx.scope);
  const connectionId = String(ctx.job.payload['connectionId'] ?? '');
  const [c] = await asWorker(ctx.db, scope, (tx) =>
    tx.select().from(reviewConnections).where(eq(reviewConnections.id, connectionId)),
  );
  // Disconnected, or waiting on somebody to sign in again: the job stops rather than asking forever.
  if (!c || !usable(c) || !c.externalAccountId) return;
  const provider = ctx.reviews.providers[c.provider];
  try {
    const call = session(ctx, scope, c, provider);
    let cursor = (c.syncCursor as { next?: string } | null)?.next ?? null;
    let written = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      const got = await call((token) =>
        provider.list({ accessToken: token, place: c.externalAccountId!, cursor }),
      );
      if (!got) break;
      for (const r of got.reviews) {
        await asWorker(ctx.db, scope, (tx) =>
          tx.execute(sql`
            insert into app.reviews (workspace_id, connection_id, provider, external_id, author_name,
              author_photo_url, rating, sentiment, body, posted_at, source_updated_at, url,
              reply_body, reply_posted_at, created_at, updated_at)
            values (${scope.workspaceId}, ${c.id}::uuid, ${c.provider}::app.review_provider,
              ${r.externalId}, ${r.authorName}, ${r.authorPhotoUrl}, ${r.rating},
              ${r.sentiment}::app.review_sentiment, ${r.body},
              ${r.postedAt.toISOString()}::timestamptz,
              ${r.updatedAt?.toISOString() ?? null}::timestamptz, ${r.url},
              ${r.reply?.body ?? null},
              ${r.reply ? (r.reply.postedAt ?? r.postedAt).toISOString() : null}::timestamptz,
              -- Their date, not the day we happened to read it.
              ${r.postedAt.toISOString()}::timestamptz, now())
            on conflict (workspace_id, provider, external_id) do update set
              author_name = excluded.author_name,
              rating = excluded.rating,
              sentiment = excluded.sentiment,
              body = excluded.body,
              source_updated_at = excluded.source_updated_at,
              url = coalesce(excluded.url, app.reviews.url),
              /*
               * An answer over there wins, because somebody may have written it on their phone or edited
               * it. An *absence* over there does not: an answer written here a second ago has not reached
               * Google yet, and letting a read that overtakes the post erase it would throw away what
               * somebody wrote, silently, at the worst possible moment.
               *
               * The cost is that a reply deleted over there stays here until somebody replaces it. That is
               * the right way round: a stale answer on a screen is a smaller harm than a lost one.
               */
              reply_body = coalesce(excluded.reply_body, app.reviews.reply_body),
              reply_posted_at = coalesce(excluded.reply_posted_at, app.reviews.reply_posted_at)`),
        );
        written += 1;
      }
      cursor = got.cursor;
      if (!cursor) break;
    }
    await asWorker(ctx.db, scope, (tx) =>
      tx
        .update(reviewConnections)
        .set({
          status: 'connected',
          failures: 0,
          lastError: null,
          lastSyncedAt: new Date(),
          // A cursor is kept only while there is more to read; the next pass starts at the newest again.
          syncCursor: cursor ? { next: cursor } : {},
          nextSyncAt: new Date(Date.now() + (cursor ? 60_000 : ctx.reviews.pollMs)),
        })
        .where(eq(reviewConnections.id, c.id)),
    );
    if (written > 0) ctx.log.info({ connectionId: c.id, written }, 'reviews read');
    /**
     * The job asks for itself again, which is what keeps a place being read. A cursor still in hand means
     * there is more of the back catalogue to walk, so that comes round in a minute; otherwise it is the
     * ordinary poll.
     */
    return { rescheduleAt: new Date(Date.now() + (cursor ? 60_000 : ctx.reviews.pollMs)) };
  } catch (e) {
    await stumbled(ctx, scope, c, e);
    throw e;
  }
};

/**
 * An answer, posted where people will read it.
 *
 * Written here first and posted after, so a provider that is having a bad morning delays the answer rather
 * than losing what somebody wrote. If the post fails the row keeps the words and the job retries.
 */
export const reviewReplyPost: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const reviewId = String(ctx.job.payload['reviewId'] ?? '');
  const [row] = await asWorker(ctx.db, scope, (tx) =>
    rows<{
      external_id: string;
      reply_body: string | null;
      connection_id: string;
      provider: 'google' | 'facebook';
    }>(
      tx,
      sql`select external_id, reply_body, connection_id::text as connection_id, provider::text as provider
          from app.reviews where id = ${reviewId}::uuid and workspace_id = ${scope.workspaceId}`,
    ),
  );
  if (!row?.reply_body) return;
  const [c] = await asWorker(ctx.db, scope, (tx) =>
    tx.select().from(reviewConnections).where(eq(reviewConnections.id, row.connection_id)),
  );
  if (!c || !usable(c) || !c.externalAccountId) return;
  const provider = ctx.reviews.providers[row.provider];
  if (!provider.canReply || !provider.reply) return;
  const call = session(ctx, scope, c, provider);
  await call((token) =>
    provider.reply!({
      accessToken: token,
      place: c.externalAccountId!,
      reviewId: row.external_id,
      body: row.reply_body!,
    }),
  );
};
