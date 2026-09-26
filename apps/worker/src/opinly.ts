/**
 * Opinly, the website's marketing analytics, from the server's side: the money it cannot see from a browser.
 *
 * The pixel runs on handsfreeos.com only, never in the app, because the app is full of other people's customers and
 * the pixel records what is on the page. So what happens in the app reaches Opinly from here, with two join keys:
 *
 * - **The visitor id**, exact. The website adds the pixel's anonymous id to its "Start free" links (`?oa=`), and the
 *   sign-up form keeps it on the new sign-in as `opinly_anon_id` (apps/web sign-up-form.tsx). It is read back through
 *   Supabase's admin API (`visitorOf`), because the worker's database roles cannot see `auth.users`.
 * - **The email address** a person gave the website, which Opinly holds only as a hash and matches to the visit where
 *   it was typed.
 *
 * Either way a sign-up or a payment is credited to the ad or post that brought them.
 *
 * **Null when OPINLY_API_KEY is unset**, which is local runs, tests and a production that has not been given a key:
 * nothing is sent and nothing is queued, the same as SITE_HOST=off.
 */
import { createClient } from '@supabase/supabase-js';
import { createOpinlyClient } from '@opinly/backend';
import { scheduleJob } from '@hfos/core/server';
import { asWorker, rows, sql, type Db, type Tx } from '@hfos/db/client';
import type { Logger } from 'pino';
import type { EventHandler } from './handlers/types';
import type { JobHandler, JobMap } from './jobs';
import { errorMessage } from './outbox';

export interface Opinly {
  track(
    event: string,
    properties: Record<string, unknown>,
    opts: { readonly externalEventId: string; readonly email?: string; readonly anonId?: string },
  ): Promise<unknown>;
  /**
   * The website visitor a person signed up as, or null. Absent without Supabase's admin key: events then go with the
   * email alone.
   */
  visitorOf?(userId: string): Promise<string | null>;
}

/** What Opinly's anonymous ids look like (a random UUID); anything else a sign-in claims is ignored. */
export const VISITOR_ID = /^[A-Za-z0-9-]{8,128}$/;

export function createOpinly(
  apiKey: string | null,
  supabase?: { readonly url: string; readonly secretKey: string } | null,
): Opinly | null {
  if (!apiKey) return null;
  const client = createOpinlyClient({ apiKey });
  const opinly: Opinly = {
    track: (event, properties, opts) => client.track(event, properties, opts),
  };
  if (!supabase) return opinly;
  const admin = createClient(supabase.url, supabase.secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return {
    ...opinly,
    async visitorOf(userId) {
      const found = await admin.auth.admin.getUserById(userId);
      const id: unknown = found.data.user?.user_metadata?.['opinly_anon_id'];
      return typeof id === 'string' && VISITOR_ID.test(id) ? id : null;
    },
  };
}

/**
 * The visitor id to send with an event about this person, or undefined. Never a reason to hold an event back: a
 * lookup that fails is logged and the event goes with the email alone.
 */
export async function visitorIdFor(
  ctx: { readonly opinly: Opinly | null; readonly log: Logger },
  userId: string | null | undefined,
): Promise<string | undefined> {
  if (!userId || !ctx.opinly?.visitorOf) return undefined;
  try {
    return (await ctx.opinly.visitorOf(userId)) ?? undefined;
  } catch (err) {
    ctx.log.warn(
      { err: errorMessage(err) },
      'the Opinly visitor id could not be read; sending by email',
    );
    return undefined;
  }
}

/**
 * Who a founding checkout was for, as the website knows them: the address the application was made with there
 * (the one the pixel matched to the visit), else the address of whoever is paying, and the paying account's id.
 */
export async function foundingContact(
  db: Db,
  scope: Scope,
  checkoutId: string,
): Promise<{ email: string | null; requestedBy: string | null } | null> {
  const [c] = await asWorker(db, scope, (tx) =>
    rows<{ email: string | null; requested_by: string | null }>(
      tx,
      sql`select coalesce(
              (select a.email::text from platform.founding_applications a
                where a.grant_id = c.grant_id order by a.created_at limit 1),
              u.email::text) as email,
            c.requested_by::text as requested_by
          from platform.founding_checkouts c
          left join app.users u on u.id = c.requested_by
          where c.id = ${checkoutId}::uuid and c.workspace_id = ${scope.workspaceId}::uuid`,
    ),
  );
  return c ? { email: c.email, requestedBy: c.requested_by } : null;
}

export const OPINLY_JOBS = {
  /** One event about one person, sent with their email and visitor id (sign-ups, checkouts opened). */
  track: 'opinly.track',
} as const;

export interface QueuedEvent {
  readonly event: 'sign_up' | 'begin_checkout';
  readonly properties: Record<string, unknown>;
  /** Opinly's dedup key: a repeat, from here or from the browser, merges into the same event. */
  readonly externalEventId: string;
  /** Whose event it is. Their email and visitor id are read when it is sent, so the jobs table holds neither. */
  readonly userId: string | null;
  /** A founding checkout's event goes with the address the application used, as its purchase does. */
  readonly checkoutId?: string;
}

type Scope = { readonly workspaceId: string | null; readonly organizationId: string | null };

/**
 * Queue one event in the caller's transaction, so it goes out only if what it describes committed. Does nothing
 * without a key, and never fails the work it rides on: a lost sign-up count is smaller than a lost sign-up.
 */
export async function queueOpinlyEvent(
  ctx: { readonly opinly: Opinly | null; readonly log: Logger },
  tx: Tx,
  scope: Scope,
  e: QueuedEvent,
): Promise<void> {
  if (!ctx.opinly) return;
  try {
    // A savepoint: if the insert fails it is undone alone, and the transaction it rode in on still commits.
    await tx.transaction((sp) =>
      scheduleJob(sp, {
        kind: OPINLY_JOBS.track,
        dedupeKey: `${OPINLY_JOBS.track}:${e.externalEventId}`,
        runAt: new Date(),
        payload: { ...e },
        workspaceId: scope.workspaceId,
        organizationId: scope.organizationId,
      }),
    );
  } catch (err) {
    ctx.log.warn({ event: e.event, err: errorMessage(err) }, 'an Opinly event could not be queued');
  }
}

/** The same, from code that holds the database rather than a transaction (jobs, webhook processors). */
export async function queueOpinlyEventFrom(
  ctx: { readonly opinly: Opinly | null; readonly log: Logger; readonly db: Db },
  scope: Scope,
  e: QueuedEvent,
): Promise<void> {
  if (!ctx.opinly) return;
  try {
    await asWorker(ctx.db, scope, (tx) => queueOpinlyEvent(ctx, tx, scope, e));
  } catch (err) {
    ctx.log.warn({ event: e.event, err: errorMessage(err) }, 'an Opinly event could not be queued');
  }
}

/** Send one queued event. Throws when Opinly does not take it, so the job tries again with backoff. */
export const sendOpinlyEvent: JobHandler = async (ctx) => {
  if (!ctx.opinly) return; // Switched off since it was queued.
  const p = ctx.job.payload as Partial<QueuedEvent>;
  if (!p.event || !p.externalEventId) return;
  let email: string | undefined;
  if (p.checkoutId) {
    const contact = await foundingContact(
      ctx.db,
      {
        workspaceId: ctx.scope.workspaceId ?? null,
        organizationId: ctx.scope.organizationId ?? null,
      },
      p.checkoutId,
    );
    email = contact?.email || undefined;
  } else if (p.userId) {
    const [user] = await asWorker(ctx.db, ctx.scope, (tx) =>
      rows<{ email: string | null }>(
        tx,
        sql`select email::text as email from app.users where id = ${p.userId}::uuid`,
      ),
    );
    email = user?.email || undefined;
  }
  const anonId = await visitorIdFor(ctx, p.userId);
  await ctx.opinly.track(p.event, p.properties ?? {}, {
    externalEventId: p.externalEventId,
    ...(email ? { email } : {}),
    ...(anonId ? { anonId } : {}),
  });
};

/**
 * A business made in onboarding: the person who made it has signed up. Keyed on the person, so a second business
 * they add is the same sign-up, not another one.
 */
export const onBusinessCreated: EventHandler = async (ctx) => {
  const userId = ctx.event.actorId;
  if (!ctx.opinly || !userId) return; // Made by the system (a seed, an agency template): nobody signed up.
  const industry = (ctx.event.payload as { industry?: unknown } | null)?.industry;
  await queueOpinlyEvent(
    ctx,
    ctx.tx,
    {
      workspaceId: ctx.scope.workspaceId ?? null,
      organizationId: ctx.scope.organizationId ?? null,
    },
    {
      event: 'sign_up',
      properties: typeof industry === 'string' && industry ? { industry } : {},
      externalEventId: `sign_up:${userId}`,
      userId,
    },
  );
};

export const opinlyJobs: JobMap = {
  [OPINLY_JOBS.track]: sendOpinlyEvent,
};
