/**
 * Getting a business's own domain working, and keeping it that way (M17).
 *
 * The shape `email_domains` already has: a business adds a name, the host is asked what records it wants,
 * the business puts them in its DNS, and a job looks until they are there. Nothing here is clever; what it
 * mostly is, is patient — DNS takes hours, and the one thing this must never do is tell a business its
 * domain is working when a browser would show a certificate warning.
 *
 * **Every call to the host is a job**, the same rule every provider call in this repo follows. A handler
 * that called Vercel directly would replay every other handler on the event when Vercel had a bad minute.
 */
import { brandedDomainRecord, executeCommand, ownershipHost, scheduleJob } from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import { eq } from 'drizzle-orm';
import { brandedDomains } from '@hfos/db/schema';
import type { EventHandler } from '../handlers/types';
import type { JobHandler, JobMap } from '../jobs';
import { errorMessage } from '../outbox';
import {
  systemActor,
  tenantOf,
  workerMeta,
  type TenantScope,
  type WorkerServices,
} from '../services';
import { isPermanentHostError, type HostedDomain, type SiteHost } from './host';
import { forgetPublicOrigin } from './origin';

export const DOMAIN_JOBS = {
  check: 'branded_domain.check',
  remove: 'branded_domain.remove',
} as const;

/**
 * How long between looks while a domain is still waiting.
 *
 * Fifteen minutes, not one: DNS propagation is measured in hours, and a business watching the screen has a
 * Check now button. Asking the host four times an hour for a day is 96 calls to be told the same thing.
 */
const WAIT_MS = 15 * 60_000;

type DomainRow = typeof brandedDomains.$inferSelect;

const readDomain = (services: WorkerServices, scope: TenantScope, id: string) =>
  asWorker(
    services.db,
    scope,
    async (tx) => (await tx.select().from(brandedDomains).where(eq(brandedDomains.id, id)))[0],
  );

/**
 * Whether this business has proved the name is its own: its claim token published in DNS. Asked until it
 * has, and never again after — the command keeps the answer.
 */
async function ownershipProved(host: SiteHost, row: DomainRow): Promise<boolean> {
  if (row.ownershipProvedAt) return true;
  return host.owns(ownershipHost(row.domain), row.ownershipToken);
}

/** Writes what the host said, through the command, so the guard and the audit trail both see it. */
async function record(
  services: WorkerServices,
  scope: TenantScope,
  row: DomainRow,
  state: HostedDomain,
  proved: boolean,
): Promise<void> {
  const settled = state.status === 'verified' && state.certificateReady && proved;
  await executeCommand(
    services.db,
    brandedDomainRecord,
    {
      workspaceId: scope.workspaceId,
      domainId: row.id,
      status: state.status,
      verificationHost: state.verification?.host ?? null,
      verificationValue: state.verification?.value ?? null,
      cnameHost: state.cname?.host ?? null,
      cnameValue: state.cname?.value ?? null,
      certificateReady: state.certificateReady,
      lastError: state.error,
      // A settled domain still gets looked at daily by `branded_domains.sweep`; this is the close watch
      // while somebody is actually waiting for it.
      nextCheckAt: settled ? null : new Date(Date.now() + WAIT_MS).toISOString(),
      ownershipProved: proved,
    },
    systemActor(scope),
    workerMeta(),
  );
  // This process builds links too, and it has just changed the answer. Cheap, and it is what stops a link
  // being built on a name that stopped working a moment ago.
  forgetPublicOrigin(scope.workspaceId);
}

/** A business added a domain: claim it with the host and find out what its DNS needs. */
export const onBrandedDomainAdded: EventHandler = async (ctx) => {
  const { workspaceId, organizationId } = ctx.scope;
  if (!workspaceId || !organizationId || !ctx.event.entityId) return;
  await scheduleJob(ctx.tx, {
    kind: DOMAIN_JOBS.check,
    dedupeKey: `branded_domain:${ctx.event.entityId}`,
    runAt: new Date(),
    payload: { domainId: ctx.event.entityId, first: true },
    workspaceId,
    organizationId,
  });
};

/** Somebody pressed Check now. */
export const onBrandedDomainCheckRequested: EventHandler = onBrandedDomainAdded;

/** A business took its domain off: give the name back, so somebody else can use it. */
export const onBrandedDomainRemoved: EventHandler = async (ctx) => {
  const { workspaceId, organizationId } = ctx.scope;
  const domain = (ctx.event.payload as { domain?: string }).domain;
  if (!workspaceId || !organizationId || !domain) return;
  // Before the job, not after it: from this moment every link must be built on our own address again, and
  // the row is already gone.
  forgetPublicOrigin(workspaceId);
  await scheduleJob(ctx.tx, {
    kind: DOMAIN_JOBS.remove,
    dedupeKey: `branded_domain:remove:${domain}`,
    runAt: new Date(),
    payload: { domain },
    workspaceId,
    organizationId,
  });
};

export const checkBrandedDomain: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const domainId = String(ctx.job.payload['domainId'] ?? '');
  const row = await readDomain(ctx, scope, domainId);
  // Removed while this was queued. Nothing to say about a domain nobody has any more.
  if (!row) return;
  if (!ctx.siteHost) {
    ctx.log.warn({ domainId }, 'a branded domain is waiting but no host is configured');
    return;
  }
  let state: HostedDomain;
  try {
    // `add` is idempotent at the host and returns the same description `check` does, so the first look and
    // every later one are the same call with one more step in front.
    state = ctx.job.payload['first']
      ? await ctx.siteHost.add(row.domain)
      : await ctx.siteHost.check(row.domain);
  } catch (e) {
    if (!isPermanentHostError(e)) throw e;
    // The name is taken, or is not one we can serve. That is an answer for the business, not a retry.
    ctx.log.warn({ domainId, err: e.message }, 'the host refused a branded domain');
    await record(
      ctx,
      scope,
      row,
      {
        status: 'failed',
        verification: null,
        cname: null,
        certificateReady: false,
        error: e.message,
      },
      Boolean(row.ownershipProvedAt),
    );
    return;
  }
  const proved = await ownershipProved(ctx.siteHost, row);
  await record(ctx, scope, row, state, proved);
  if (proved && state.status === 'verified' && state.certificateReady) return;
  return { rescheduleAt: new Date(Date.now() + WAIT_MS) };
};

export const removeBrandedDomain: JobHandler = async (ctx) => {
  const domain = String(ctx.job.payload['domain'] ?? '');
  if (!domain || !ctx.siteHost) return;
  // Another business may still hold a claim on the same name — working, or waiting to be proved. Giving the
  // name back now would take it off the host under them.
  const [claimed] = await asWorker(ctx.db, tenantOf(ctx.scope), (tx) =>
    rows<{ claimed: boolean }>(
      tx,
      sql`select private.branded_domain_claimed(${domain}) as claimed`,
    ),
  );
  if (claimed?.claimed) return;
  try {
    await ctx.siteHost.remove(domain);
  } catch (e) {
    if (!isPermanentHostError(e)) throw e;
    // Already gone at the host is what we were asking for; anything else is worth a line but not a retry.
    ctx.log.warn({ domain, err: errorMessage(e) }, 'the host would not give a domain back');
  }
};

/**
 * Daily: look at every branded domain that is working, in case it has stopped.
 *
 * A business moves its DNS, lets a domain lapse, or has a registrar do something on its behalf, and the
 * first anybody would otherwise know is a customer saying their link is broken. Every domain, not only
 * the unsettled ones — a settled one has `next_check_at` null precisely because the close watch is over.
 */
export const sweepBrandedDomains: JobHandler = async (ctx) => {
  if (!ctx.siteHost) return { rescheduleAt: new Date(Date.now() + DAY_MS) };
  const due = await asWorker(ctx.db, {}, (tx) =>
    rows<{ id: string; workspace_id: string; organization_id: string }>(
      tx,
      sql`select d.id::text as id, d.workspace_id, w.organization_id
          from app.branded_domains d
          join app.workspaces w on w.id = d.workspace_id`,
    ),
  );
  for (const d of due)
    try {
      const scope = { workspaceId: d.workspace_id, organizationId: d.organization_id };
      const row = await readDomain(ctx, scope, d.id);
      if (!row) continue;
      const state = await ctx.siteHost.check(row.domain);
      await record(ctx, scope, row, state, await ownershipProved(ctx.siteHost, row));
    } catch (e) {
      // One domain the host will not answer about waits for tomorrow; the others go on.
      ctx.log.warn({ domainId: d.id, err: errorMessage(e) }, 'branded domain check failed');
    }
  return { rescheduleAt: new Date(Date.now() + DAY_MS) };
};

const DAY_MS = 86_400_000;

export const DOMAIN_SWEEP = 'branded_domains.sweep';

export const domainJobs: JobMap = {
  [DOMAIN_JOBS.check]: checkBrandedDomain,
  [DOMAIN_JOBS.remove]: removeBrandedDomain,
  [DOMAIN_SWEEP]: sweepBrandedDomains,
};
