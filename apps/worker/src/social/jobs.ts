/**
 * The worker's own Facebook and Instagram jobs (20261025000200).
 *
 * - `meta.resolve_ad`: what an ad somebody came from is (its campaign, ad set and creative), asked of Meta's
 *   Marketing API once per ad with a sign-in here that may read ads. Core queues it the first time anybody comes
 *   from an ad, and again for the ones nobody here could see when somebody connects Facebook with ads allowed.
 * - `meta.plan`, daily for the whole server, queues `meta.check` for each business with a Page connected: each
 *   Page's sign-in is looked at with Meta, a Page Meta isn't sending messages for is asked again, and one whose
 *   sign-in stopped working is marked so, which tells its owners once. Sign-ins nobody finished forget their token.
 */
import {
  adResolve,
  executeCommand,
  metaAccountFail,
  metaAccountRecover,
  SOCIAL_JOBS,
  scheduleJob,
} from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import { ads, metaAccounts } from '@hfos/db/schema';
import { and, eq, ne } from 'drizzle-orm';
import type { JobContext, JobHandler, JobMap } from '../jobs';
import { errorMessage } from '../outbox';
import { systemActor, tenantOf, workerMeta, type TenantScope } from '../services';
import { adsSignIn, openToken, type MetaAccountRow } from './accounts';
import { MetaError } from './graph';

export const META_JOBS = {
  resolveAd: SOCIAL_JOBS.resolveAd,
  plan: 'meta.plan',
  check: 'meta.check',
} as const;
export const META_PLAN_KEY = 'meta:plan';

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
/** When an ad Meta wouldn't say anything about is asked again: within the hour, then less often, for three days. */
const AD_RETRY_MS = [HOUR, 4 * HOUR, 12 * HOUR, DAY, 2 * DAY];

/** What a Page or account needs to answer messages: Messenger's permission, or Instagram's. */
const ANSWERS: Readonly<Record<MetaAccountRow['platform'], string>> = {
  facebook: 'pages_messaging',
  instagram: 'instagram_manage_messages',
};

export const metaResolveAd: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const adId = String(ctx.job.payload['adId'] ?? '');
  const found = await asWorker(ctx.db, scope, async (tx) => {
    const [ad] = await tx
      .select()
      .from(ads)
      .where(and(eq(ads.id, adId), eq(ads.workspaceId, scope.workspaceId)));
    return ad ? { ad, signIn: await adsSignIn(tx, ctx.sealer, scope.workspaceId) } : null;
  });
  if (!found || found.ad.status === 'resolved') return;
  const { ad, signIn } = found;
  const resolve = (
    outcome: 'no_access' | 'not_found' | 'failed',
    error: string,
    retryAt: Date | null,
  ) =>
    executeCommand(
      ctx.db,
      adResolve,
      {
        workspaceId: scope.workspaceId,
        adId: ad.id,
        outcome,
        error: error.slice(0, 2000),
        retryAt: retryAt?.toISOString() ?? null,
      },
      systemActor(scope),
      workerMeta(),
    );
  // Nobody here signed in with ads allowed: asked again when somebody does (meta_connection.activate).
  if (!signIn) {
    await resolve('no_access', 'No Facebook sign-in here may read ads.', null);
    return;
  }
  try {
    const d = await ctx.social.graph.ad({ adId: ad.externalId, userToken: signIn.userToken });
    await executeCommand(
      ctx.db,
      adResolve,
      {
        workspaceId: scope.workspaceId,
        adId: ad.id,
        outcome: 'resolved',
        details: {
          ...d,
          platforms: d.platforms.map((p) => p.slice(0, 40)),
          raw: { ...d.raw },
        },
      },
      systemActor(scope),
      workerMeta(),
    );
  } catch (e) {
    const err = e instanceof MetaError ? e : null;
    if (err?.kind === 'auth' || err?.kind === 'permission') {
      await resolve('no_access', err.message, null);
      return;
    }
    if (err?.kind === 'not_found') {
      await resolve('not_found', err.message, null);
      return;
    }
    // Meta busy, or saying something unexpected: asked again for a few days.
    const wait = AD_RETRY_MS[ad.attempts];
    const retryAt = wait === undefined ? null : new Date(ctx.now + wait);
    await resolve('failed', errorMessage(e), retryAt);
    if (retryAt) return { rescheduleAt: retryAt };
  }
};

/** Daily: each business with a Page or account connected gets its check. */
export const metaPlan: JobHandler = async (ctx) => {
  // A Facebook sign-in nobody finished keeps neither its token nor who it was.
  const [forgotten] = await asWorker(ctx.db, {}, (tx) =>
    rows<{ n: number }>(tx, sql`select private.meta_forget_unfinished_sign_ins() as n`),
  );
  if (forgotten?.n) ctx.log.info({ count: forgotten.n }, 'forgot unfinished Facebook sign-ins');
  const businesses = await asWorker(ctx.db, {}, (tx) =>
    rows<{ workspace_id: string; organization_id: string }>(
      tx,
      sql`select workspace_id, organization_id from private.meta_account_workspaces()`,
    ),
  );
  for (const b of businesses) {
    const scope = { workspaceId: b.workspace_id, organizationId: b.organization_id };
    try {
      await asWorker(ctx.db, scope, (tx) =>
        scheduleJob(
          tx,
          {
            kind: META_JOBS.check,
            dedupeKey: `${META_JOBS.check}:${scope.workspaceId}`,
            runAt: new Date(ctx.now),
            payload: {},
            workspaceId: scope.workspaceId,
            organizationId: scope.organizationId,
          },
          { pullEarlier: true },
        ),
      );
    } catch (e) {
      ctx.log.warn(
        { workspaceId: scope.workspaceId, err: errorMessage(e) },
        'could not queue a business’s Facebook check',
      );
    }
  }
  return { rescheduleAt: new Date(ctx.now + DAY) };
};

/** One business's Pages and Instagram accounts, each looked at with Meta. One's trouble never stops the rest. */
export const metaCheck: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const list = await asWorker(ctx.db, scope, (tx) =>
    tx
      .select()
      .from(metaAccounts)
      .where(
        and(
          eq(metaAccounts.workspaceId, scope.workspaceId),
          ne(metaAccounts.status, 'disconnected'),
        ),
      ),
  );
  for (const a of list) {
    try {
      await checkAccount(ctx, scope, a);
    } catch (e) {
      // Meta not answering today: tomorrow's look.
      ctx.log.warn({ accountId: a.id, err: errorMessage(e) }, 'could not check a Facebook Page');
    }
  }
};

async function checkAccount(ctx: JobContext, scope: TenantScope, a: MetaAccountRow): Promise<void> {
  const actor = systemActor(scope);
  const fail = (reason: string) =>
    executeCommand(
      ctx.db,
      metaAccountFail,
      { workspaceId: scope.workspaceId, accountId: a.id, problem: 'reauth', reason },
      actor,
      workerMeta(),
    );
  const token = openToken(ctx.sealer, a.tokenEnc);
  if (!token) {
    await fail('Its sign-in can’t be read anymore.');
    return;
  }
  const check = await ctx.social.graph.checkToken(token);
  if (!check.valid) {
    await fail('Facebook stopped accepting its sign-in.');
    return;
  }
  // Somebody took back the permission to answer messages in Facebook's settings: the token works, the replies won't.
  if (check.scopes.length && !check.scopes.includes(ANSWERS[a.platform])) {
    await fail(`Facebook took back ${ANSWERS[a.platform]}.`);
    return;
  }
  let subscribed = !!a.subscribedAt;
  if (!subscribed || a.status === 'needs_attention') {
    try {
      await ctx.social.graph.subscribe(a.pageId, token);
      subscribed = true;
    } catch (e) {
      ctx.log.warn(
        { accountId: a.id, err: errorMessage(e) },
        'Meta still won’t send a Page’s messages here',
      );
    }
  }
  const humanAgent = ctx.social.humanAgent;
  if (
    a.status === 'needs_attention' ||
    (subscribed && !a.subscribedAt) ||
    a.humanAgent !== humanAgent
  )
    await executeCommand(
      ctx.db,
      metaAccountRecover,
      {
        workspaceId: scope.workspaceId,
        accountId: a.id,
        ...(subscribed && (!a.subscribedAt || a.status === 'needs_attention')
          ? { subscribed: true }
          : {}),
        humanAgent,
      },
      actor,
      workerMeta(),
    );
}

export const metaJobs: JobMap = {
  [META_JOBS.resolveAd]: metaResolveAd,
  [META_JOBS.plan]: metaPlan,
  [META_JOBS.check]: metaCheck,
};
