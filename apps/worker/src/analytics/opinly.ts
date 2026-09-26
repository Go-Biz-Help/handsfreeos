/**
 * Conversions, told to Opinly from the server.
 *
 * handsfreeos.com runs Opinly's pixel, which sees which campaign or blog post brought a visitor in, and
 * identifies them by email when they type it into the founding application. What the pixel cannot see is what
 * happened next, here: an account made, a checkout opened, a seat paid for. Those are sent from the worker,
 * where they cannot be blocked or missed, with the person's email as the join key — Opinly hashes it and finds
 * the visitor who typed the same address on the website, so a paid seat is credited to the post that started it.
 *
 * Three rules:
 *
 * - **Off unless configured.** No `OPINLY_API_KEY`, no `analytics` service, and nothing is queued at all: tests,
 *   the seed and local development never see a job.
 * - **Never in the way.** An event is queued in the same transaction as what it describes (so it is only sent
 *   if that committed) and sent by a job, which retries an outage with backoff. Queueing can never fail the work
 *   it rides on, and a refusal from Opinly is logged and dropped rather than retried forever.
 * - **Ids, not addresses, at rest.** The job carries the user's id; their email is read when it is sent, so the
 *   jobs table never holds one, and a person who has deleted their account in between is sent as nobody.
 */
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
}

export function createAnalytics(env: {
  opinlyApiKey: string | null;
  opinlyApiUrl: string;
}): { analytics: AnalyticsService } | Record<string, never> {
  return env.opinlyApiKey
    ? { analytics: { apiKey: env.opinlyApiKey, url: env.opinlyApiUrl.replace(/\/$/, '') } }
    : {};
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
  if (p.userId) {
    const [user] = await asWorker(ctx.db, ctx.scope, (tx) =>
      rows<{ email: string | null }>(
        tx,
        sql`select email::text as email from app.users where id = ${p.userId}::uuid`,
      ),
    );
    email = user?.email || undefined;
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
