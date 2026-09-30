/**
 * Deleting a business, the worker's job. `workspace.delete` marks the business (hidden from everybody from that
 * moment) and records `workspace.deletion_requested`; that event queues one `workspace.delete` job, which, in order:
 *
 * 1. **The phone sub-account** is closed with the master account. That releases every number in it and stops it
 *    billing. A failure here is retried, never skipped: a number left behind is a bill nobody will ever look at.
 * 2. **Stored files**: every object under the business's `<workspace id>/` folder, in every bucket, goes through
 *    the Storage API. Retried too: once the rows are gone nothing would say where they were.
 * 3. **Everything else outside** — a connected Stripe or Square account is told we are gone, sending domains are
 *    taken off Postmark, a branded web address is given back to the host. Best effort: each is already useless
 *    to us, a refusal is logged and the deletion goes on.
 * 4. **The rows** (private.purge_workspace): the history first, then the business, which takes every other table
 *    with it. In the same transaction, one `workspace.deleted` line in the organization's own log, which names
 *    the business and whoever asked and nothing that was in it.
 *
 * Every step is safe to run again, so a retry carries on where the last try stopped.
 */
import { eq } from 'drizzle-orm';
import { scheduleJob } from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import { paymentConnections, telephonyAccounts, workspaces } from '@hfos/db/schema';
import type { EventHandler } from '../handlers/types';
import { assertInWorkspace } from '../handlers/file-removed';
import { forgetPublicOrigin } from '../hosting/origin';
import type { JobHandler } from '../jobs';
import { errorMessage } from '../outbox';
import { tellProviderDisconnected } from '../payments/refresh';
import { recordSystemEvent } from '../system-event';

export const WORKSPACE_JOBS = {
  /** One per business being deleted. */
  delete: 'workspace.delete',
} as const;
export const workspaceDeleteJobKey = (workspaceId: string): string =>
  `workspace-delete:${workspaceId}`;

const isUuid = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

/**
 * An owner asked for the business to be deleted: queue the job. It belongs to the organization, not to the
 * business — a job row of the business's own would be deleted out from under itself by the purge.
 */
export const onWorkspaceDeletionRequested: EventHandler = async (ctx) => {
  const { workspaceId, organizationId } = ctx.scope;
  if (!workspaceId || !organizationId) return;
  await scheduleJob(ctx.tx, {
    kind: WORKSPACE_JOBS.delete,
    dedupeKey: workspaceDeleteJobKey(workspaceId),
    runAt: new Date(),
    payload: {
      workspaceId,
      organizationId,
      requestedBy: ctx.event.actorId,
      requestEventId: ctx.event.id,
      correlationId: ctx.event.correlationId,
    },
    workspaceId: null,
    organizationId,
  });
};

/** `workspace.delete`: the whole deletion, in the order the module comment gives. */
export const deleteWorkspaceJob: JobHandler = async (ctx) => {
  const { workspaceId, organizationId } = ctx.job.payload;
  if (!isUuid(workspaceId) || !isUuid(organizationId)) return;
  const scope = { workspaceId, organizationId };

  const found = await asWorker(ctx.db, scope, async (tx) => {
    const [ws] = await tx
      .select({
        name: workspaces.name,
        organizationId: workspaces.organizationId,
        deletionRequestedAt: workspaces.deletionRequestedAt,
        deletionRequestedBy: workspaces.deletionRequestedBy,
      })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId));
    if (!ws) return null;
    const [account] = await tx
      .select({ accountSid: telephonyAccounts.accountSid })
      .from(telephonyAccounts)
      .where(eq(telephonyAccounts.workspaceId, workspaceId));
    const payments = await tx
      .select({
        id: paymentConnections.id,
        provider: paymentConnections.provider,
        externalAccountId: paymentConnections.externalAccountId,
      })
      .from(paymentConnections)
      .where(eq(paymentConnections.workspaceId, workspaceId));
    // Only the names nobody else has a claim on, as with branded domains below: Postmark keeps one domain per
    // name, and another business may be using it (M19). Each receiving domain's server stops either way, unless
    // another business receives the name now.
    const mailDomains = await rows<{
      provider_domain_id: string | null;
      inbound_server_id: string | null;
      claimed: boolean;
      received_elsewhere: boolean;
    }>(
      tx,
      sql`select d.provider_domain_id, d.inbound_server_id,
            private.email_domain_claimed(d.domain, ${workspaceId}) as claimed,
            (select h.receiving from private.email_domain_held_elsewhere(d.domain, d.id) h) as received_elsewhere
          from app.email_domains d
          where d.workspace_id = ${workspaceId}`,
    );
    // Only the names nobody else has a claim on: another business may be working on the same one.
    const branded = await rows<{ domain: string }>(
      tx,
      sql`select d.domain from app.branded_domains d
          where d.workspace_id = ${workspaceId}
            and not private.branded_domain_claimed(d.domain, ${workspaceId})`,
    );
    const objects = await rows<{ bucket: string; name: string }>(
      tx,
      sql`select bucket, name from private.workspace_stored_objects(${workspaceId})`,
    );
    return { ws, accountSid: account?.accountSid ?? null, payments, mailDomains, branded, objects };
  });
  // Already gone: a retry after the purge committed has nothing left to do.
  if (!found) return;
  const requestedAt = found.ws.deletionRequestedAt;
  // Only ever a business an owner asked to delete, and only within its own organization.
  if (!requestedAt || found.ws.organizationId !== organizationId) {
    ctx.log.error(
      { workspaceId },
      'a workspace deletion job found a business nobody asked to delete',
    );
    return;
  }

  // 1. The phone sub-account, and every number in it.
  if (found.accountSid) await ctx.telephony.closeSubaccount(found.accountSid);

  // 2. Stored files.
  for (const o of found.objects) {
    assertInWorkspace(o.name, workspaceId);
    await ctx.store.remove(o.bucket, o.name);
  }

  // 3. Everything else outside, best effort.
  for (const c of found.payments) await tellProviderDisconnected(ctx, c);
  for (const d of found.mailDomains) {
    if (d.inbound_server_id && !d.received_elsewhere)
      try {
        await ctx.email.domains.closeInbound(d.inbound_server_id);
      } catch (e) {
        ctx.log.warn(
          { workspaceId, inboundServerId: d.inbound_server_id, err: errorMessage(e) },
          'a deleted business’s receiving domain was not taken off the provider',
        );
      }
    if (!d.provider_domain_id || d.claimed) continue;
    try {
      await ctx.email.domains.remove(d.provider_domain_id);
    } catch (e) {
      ctx.log.warn(
        { workspaceId, providerDomainId: d.provider_domain_id, err: errorMessage(e) },
        'a deleted business’s sending domain was not taken off the provider',
      );
    }
  }
  forgetPublicOrigin(workspaceId);
  for (const d of found.branded) {
    if (!ctx.siteHost) break;
    try {
      await ctx.siteHost.remove(d.domain);
    } catch (e) {
      ctx.log.warn(
        { workspaceId, domain: d.domain, err: errorMessage(e) },
        'a deleted business’s web address was not given back to the host',
      );
    }
  }

  // 4. The rows, and the one line that says they went.
  const requestedBy = found.ws.deletionRequestedBy ?? ctx.job.payload['requestedBy'] ?? null;
  const correlationId = ctx.job.payload['correlationId'];
  const causationId = ctx.job.payload['requestEventId'];
  await asWorker(ctx.db, scope, async (tx) => {
    await tx.execute(sql`select private.purge_workspace(${workspaceId})`);
    await recordSystemEvent(tx, {
      type: 'workspace.deleted',
      action: 'workspace.delete',
      organizationId,
      workspaceId: null,
      entityType: 'workspace',
      entityId: workspaceId,
      payload: {
        name: found.ws.name,
        requestedBy,
        requestedAt: requestedAt.toISOString(),
        numbersReleased: !!found.accountSid,
        filesRemoved: found.objects.length,
      },
      before: { name: found.ws.name },
      after: null,
      correlationId: isUuid(correlationId) ? correlationId : ctx.job.id,
      causationId: isUuid(causationId) ? causationId : ctx.job.id,
    });
  });
  ctx.log.info({ workspaceId, organizationId }, 'deleted a business');
};

export const workspaceJobs = {
  [WORKSPACE_JOBS.delete]: deleteWorkspaceJob,
};
