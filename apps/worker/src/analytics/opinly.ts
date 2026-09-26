/**
 * Conversions, told to Opinly from the server.
 *
 * handsfreeos.com runs Opinly's pixel, which sees which campaign or blog post brought a visitor in, and
 * identifies them by email when they type it into the founding application. What the pixel cannot see is what
 * happened next, here: an account made, a checkout opened, a seat paid for. Those are sent from the worker,
 * where they cannot be blocked or missed, with two join keys:
 *
 * - **The visitor id**, exact. The website adds the pixel's anonymous id to its "Start free" links (`?oa=`),
 *   and the sign-up form keeps it on the new sign-in as `opinly_anon_id` (apps/web sign-up-form.tsx). It is read
 *   back here through Supabase's admin API, because the worker's database roles cannot see `auth.users`.
 * - **The email**, the fallback: Opinly hashes it and finds the visitor who typed the same address on the
 *   website, which covers everybody who applied for a founding seat before signing up.
 *
 * Either way a paid seat is credited to the post that started it.
 *
 * Three rules:
 *
 * - **Off unless configured.** No `OPINLY_API_KEY`, no `analytics` service, and nothing is queued at all: tests,
 *   the seed and local development never see a job.
 * - **Never in the way.** An event is queued in the same transaction as what it describes (so it is only sent
 *   if that committed) and sent by a job, which retries an outage with backoff. Queueing can never fail the work
 *   it rides on, and a refusal from Opinly is logged and dropped rather than retried forever.
 * - **Ids, not addresses, at rest.** The job carries the user's id; their email and visitor id are read when it
 *   is sent, so the jobs table holds neither, and a person who has deleted their account in between (which
 *   clears both) is sent as nobody.
 */
import { createClient } from '@supabase/supabase-js';
import { scheduleJob } from '@hfos/core/server';
import { asWorker, rows, sql, type Db, type Tx } from '@hfos/db/client';
import type { Logger } from 'pino';
import type { EventHandler } from '../handlers/types';
import type { JobHandler, JobMap } from '../jobs';
import { errorMessage } from '../outbox';

export const ANALYTICS_JOB = 'analytics.event';

/** The standard names Opinly counts as conversions, or reports beside them. */
export type ConversionEvent = 'sign_up' | 'begin_checkout' | 'purchase';

export interface AnalyticsService {
  readonly apiKey: string;
  /** https://sdk.opinly.ai unless pointed at a stand-in. */
  readonly url: string;
  /**
   * The website visitor a person signed up as, or null. Absent without Supabase's admin key (local development
   * and tests): events then go with the email alone.
   */
  readonly visitorOf?: (userId: string) => Promise<string | null>;
}

/** What Opinly's anonymous ids look like (a random UUID); anything else a sign-in claims is ignored. */
export const VISITOR_ID = /^[A-Za-z0-9-]{8,128}$/;

export function createAnalytics(env: {
  opinlyApiKey: string | null;
  opinlyApiUrl: string;
  supabaseUrl?: string | null;
  supabaseSecretKey?: string | null;
}): { analytics: AnalyticsService } | Record<string, never> {
  if (!env.opinlyApiKey) return {};
  const url = env.opinlyApiUrl.replace(/\/$/, '');
  if (!env.supabaseUrl || !env.supabaseSecretKey)
    return { analytics: { apiKey: env.opinlyApiKey, url } };
  const admin = createClient(env.supabaseUrl, env.supabaseSecretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const visitorOf = async (userId: string): Promise<string | null> => {
    const found = await admin.auth.admin.getUserById(userId);
    const id: unknown = found.data.user?.user_metadata?.['opinly_anon_id'];
    return typeof id === 'string' && VISITOR_ID.test(id) ? id : null;
  };
  return { analytics: { apiKey: env.opinlyApiKey, url, visitorOf } };
}

export interface QueuedEvent {
  readonly event: ConversionEvent;
  readonly properties: Record<string, unknown>;
  /** Opinly's dedup key. One per real-world thing: a repeat, from here or from the browser, merges into it. */
  readonly externalEventId: string;
  /** Whose event it is. Their email is looked up when it is sent. */
  readonly userId: string | null;
}

/**
 * Queue one event in the caller's transaction. Does nothing when analytics is off, and swallows its own
 * failure: a lost conversion is a smaller problem than a lost seat.
 */
export async function queueConversion(
  ctx: { readonly analytics?: AnalyticsService; readonly log: Logger },
  tx: Tx,
  scope: { readonly workspaceId: string | null; readonly organizationId: string | null },
  e: QueuedEvent,
): Promise<void> {
  if (!ctx.analytics) return;
  try {
    // A savepoint: if the insert fails it is undone alone, and the transaction it rode in on still commits.
    await tx.transaction((sp) =>
      scheduleJob(sp, {
        kind: ANALYTICS_JOB,
        dedupeKey: `${ANALYTICS_JOB}:${e.externalEventId}`,
        runAt: new Date(),
        payload: { ...e },
        workspaceId: scope.workspaceId,
        organizationId: scope.organizationId,
      }),
    );
  } catch (err) {
    ctx.log.warn(
      { event: e.event, err: errorMessage(err) },
      'an analytics event could not be queued',
    );
  }
}

/** The same, from code that holds the database rather than a transaction (jobs, webhook processors). */
export async function queueConversionFrom(
  ctx: { readonly analytics?: AnalyticsService; readonly log: Logger; readonly db: Db },
  scope: { readonly workspaceId: string | null; readonly organizationId: string | null },
  e: QueuedEvent,
): Promise<void> {
  if (!ctx.analytics) return;
  try {
    await asWorker(ctx.db, scope, (tx) => queueConversion(ctx, tx, scope, e));
  } catch (err) {
    ctx.log.warn(
      { event: e.event, err: errorMessage(err) },
      'an analytics event could not be queued',
    );
  }
}

/**
 * A business made in onboarding: the person who made it has signed up. Keyed on the person, so the second
 * business they add is the same sign-up, not another one.
 */
export const onBusinessCreated: EventHandler = async (ctx) => {
  const userId = ctx.event.actorId;
  if (!userId) return; // Made by the system (a seed, an agency template): nobody signed up.
  const industry = (ctx.event.payload as { industry?: unknown } | null)?.industry;
  const scope = {
    workspaceId: ctx.scope.workspaceId ?? null,
    organizationId: ctx.scope.organizationId ?? null,
  };
  await queueConversion(ctx, ctx.tx, scope, {
    event: 'sign_up',
    properties: typeof industry === 'string' && industry ? { industry } : {},
    externalEventId: `sign_up:${userId}`,
    userId,
  });
};

/** Refusals that asking again will not change: a bad key, or an event Opinly will not take. */
const PERMANENT = new Set([400, 401, 403, 404, 422]);

/** Send one queued event to Opinly's `/v1/events`. */
export const sendConversion: JobHandler = async (ctx) => {
  if (!ctx.analytics) return; // Switched off since it was queued.
  const p = ctx.job.payload as Partial<QueuedEvent>;
  if (!p.event || !p.externalEventId) return;

  let email: string | undefined;
  let anonId: string | undefined;
  if (p.userId) {
    const [user] = await asWorker(ctx.db, ctx.scope, (tx) =>
      rows<{ email: string | null }>(
        tx,
        sql`select email::text as email from app.users where id = ${p.userId}::uuid`,
      ),
    );
    email = user?.email || undefined;
    // The exact join key when there is one. Not finding it is never a reason to hold the event back.
    const visitor = await ctx.analytics.visitorOf?.(p.userId).catch((err: unknown) => {
      ctx.log.warn(
        { err: errorMessage(err) },
        'the visitor id could not be read; sending by email',
      );
      return null;
    });
    anonId = visitor ?? undefined;
  }

  let res: Response;
  try {
    res = await fetch(`${ctx.analytics.url}/v1/events`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ctx.analytics.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        event: p.event,
        properties: p.properties ?? {},
        externalEventId: p.externalEventId,
        ...(email ? { email } : {}),
        ...(anonId ? { anonId } : {}),
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    ctx.log.warn({ event: p.event, err: errorMessage(err) }, 'Opinly did not answer; trying again');
    throw err;
  }
  if (res.ok) return;
  const detail = (await res.text().catch(() => '')).slice(0, 300);
  if (PERMANENT.has(res.status)) {
    ctx.log.warn(
      { event: p.event, status: res.status, detail },
      'Opinly refused an analytics event; dropping it',
    );
    return;
  }
  throw new Error(`Opinly answered ${res.status}: ${detail}`);
};

export const analyticsJobs: JobMap = {
  [ANALYTICS_JOB]: sendConversion,
};
