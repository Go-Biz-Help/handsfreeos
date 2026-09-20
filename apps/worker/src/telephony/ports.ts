/**
 * Moving a number a business already owns to us: the carrier side (M17).
 *
 * The twin of `advanceRegistrations`, and for the same reason — the shape of the problem is identical.
 * Paperwork goes to a carrier, the carrier takes days or weeks, a job asks where things stand, an answer
 * comes back. **Every provider call here is a job, never an outbox handler**, so a carrier that is throttling
 * or simply not answering costs one retry with backoff rather than replaying every handler the event has.
 *
 * **The losing carrier's account number and PIN pass through this file and are never written down by it.**
 * They go straight from `number_ports.submission` into the provider call. Nothing here logs the submission,
 * and the log lines below deliberately name the port and the number and nothing else.
 *
 * What actually lands is different for the two kinds, and the difference is the whole feature:
 *
 * - `full` — the number becomes an ordinary number of ours, so it has to be **pointed at our webhooks**
 *   (`configureNumber`) before a customer texting it reaches anybody. A bought number gets that in the same
 *   call that buys it; a ported one arrives bare.
 * - `hosted_messaging` — the number stays with the old carrier for calls and only its texting comes here, so
 *   there is no incoming-number row to configure; the messaging service is the whole arrangement.
 */
import {
  executeCommand,
  numberPortComplete,
  numberPortRecordState,
  scheduleJob,
  type NumberPortStatus,
} from '@hfos/core/server';
import { asWorker } from '@hfos/db/client';
import { eq } from 'drizzle-orm';
import { numberPorts } from '@hfos/db/schema';
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
import { ensureAccount, loadAccount, webhookUrls } from './accounts';
import { isPermanentProviderError, type PortState, type ProviderAccount } from './provider';

export const PORT_JOBS = {
  submit: 'port.submit',
  poll: 'port.poll',
  cancel: 'port.cancel',
} as const;

/** How often to ask the carrier about a port. Slower than a registration: these take weeks, not hours. */
const POLL_MS = 6 * 60 * 60_000;

/** The statuses that mean the carrier still has it and an answer is still coming. */
const IN_FLIGHT: ReadonlySet<NumberPortStatus> = new Set<NumberPortStatus>([
  'submitted',
  'carrier_review',
  'scheduled',
]);

type PortRow = typeof numberPorts.$inferSelect;

/** The port and the credentials to talk to the carrier about it, read in one worker transaction. */
async function readPort(
  services: WorkerServices,
  scope: TenantScope,
  portId: string,
): Promise<readonly [PortRow | undefined, ProviderAccount | null]> {
  return asWorker(
    services.db,
    scope,
    async (tx) =>
      [
        (await tx.select().from(numberPorts).where(eq(numberPorts.id, portId)))[0],
        await loadAccount(tx, scope.workspaceId, services.sealer),
      ] as const,
  );
}

/** Writes what the carrier said, through the command so the guard and the audit trail both see it. */
async function record(
  services: WorkerServices,
  scope: TenantScope,
  port: PortRow,
  state: PortState,
): Promise<void> {
  const stillGoing = IN_FLIGHT.has(state.status as NumberPortStatus);
  await executeCommand(
    services.db,
    numberPortRecordState,
    {
      workspaceId: scope.workspaceId,
      portId: port.id,
      status: state.status,
      providerSid: state.providerSid,
      providerStatus: state.providerStatus,
      rejectionReason: state.rejectionReason,
      scheduledFor: state.scheduledFor,
      nextPollAt: stillGoing ? new Date(Date.now() + POLL_MS).toISOString() : null,
    },
    systemActor(scope),
    workerMeta(),
  );
}

async function ensurePoll(
  services: WorkerServices,
  scope: TenantScope,
  portId: string,
  runAt = new Date(Date.now() + POLL_MS),
): Promise<void> {
  await asWorker(services.db, scope, (tx) =>
    scheduleJob(tx, {
      kind: PORT_JOBS.poll,
      dedupeKey: `port:${portId}`,
      runAt,
      payload: { portId },
      workspaceId: scope.workspaceId,
      organizationId: scope.organizationId,
    }),
  );
}

/** A person sent a port: the provider call is queued, so it retries on its own if it has to. */
export const onPortSubmitted: EventHandler = async (ctx) => {
  const { workspaceId, organizationId } = ctx.scope;
  const portId = ctx.event.entityId;
  if (!workspaceId || !organizationId || !portId) return;
  await scheduleJob(ctx.tx, {
    kind: PORT_JOBS.submit,
    dedupeKey: `port:submit:${portId}`,
    runAt: new Date(),
    payload: { portId, correlationId: ctx.event.correlationId },
    workspaceId,
    organizationId,
  });
};

/** A person called a port off: tell the carrier, if it ever heard of it. */
export const onPortCancelled: EventHandler = async (ctx) => {
  const { workspaceId, organizationId } = ctx.scope;
  const portId = ctx.event.entityId;
  const providerSid = (ctx.event.payload as { providerSid?: string | null }).providerSid;
  if (!workspaceId || !organizationId || !portId || !providerSid) return;
  await scheduleJob(ctx.tx, {
    kind: PORT_JOBS.cancel,
    dedupeKey: `port:cancel:${portId}`,
    runAt: new Date(),
    payload: { portId, providerSid },
    workspaceId,
    organizationId,
  });
};

/**
 * Sends the port, then puts the papers on it.
 *
 * In that order on purpose: the carrier gives back the reference the documents hang off, and a submission the
 * carrier already has is a thing we can ask about, whereas an uploaded document belonging to nothing is not.
 * A paper that fails to upload therefore leaves a port the carrier is holding for its LOA — which is what the
 * status says (`PENDING_LOA`) and what a retry fixes.
 */
export const portSubmit: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const portId = String(ctx.job.payload['portId'] ?? '');
  const [port] = await readPort(ctx, scope, portId);
  if (!port || port.status !== 'submitted') return;
  // Already with the carrier: this is a retry of a job whose provider call went through. Ask rather than send
  // again — a second submission for the same number is how a business ends up with two ports fighting.
  if (port.providerSid) {
    await ensurePoll(ctx, scope, port.id, new Date());
    return;
  }

  const account = await ensureAccount(ctx, scope);
  const documents = port.documents as Record<string, { objectPath?: string; name?: string }>;
  const papers = Object.values(documents).filter(
    (d): d is { objectPath: string; name: string } =>
      typeof d?.objectPath === 'string' && typeof d?.name === 'string',
  );

  let state: PortState;
  try {
    state = await ctx.telephony.submitPort(account, {
      e164: port.e164,
      kind: port.kind,
      submission: port.submission as Record<string, unknown>,
      documentPaths: papers.map((d) => d.objectPath),
    });
  } catch (e) {
    // A carrier saying no to the details is an answer, not a blip: the business has to fix something, and a
    // retry would only be told the same thing more slowly.
    if (!isPermanentProviderError(e)) throw e;
    ctx.log.warn({ portId: port.id, err: e.message }, 'the carrier refused the port');
    await record(ctx, scope, port, {
      providerSid: port.providerSid ?? 'none',
      providerStatus: 'refused',
      status: 'rejected',
      rejectionReason: e.message,
      scheduledFor: null,
    });
    return;
  }

  await record(ctx, scope, port, state);

  for (const paper of papers) {
    try {
      const data = await ctx.store.download('attachments', paper.objectPath);
      await ctx.telephony.uploadPortDocument(account, {
        portSid: state.providerSid,
        name: paper.name,
        contentType: 'application/pdf',
        data,
      });
    } catch (e) {
      // The port is sent and recorded; the paper is what is missing. Throwing retries this job, which now
      // takes the `providerSid` path above and comes back here without submitting twice.
      ctx.log.warn({ portId: port.id, err: errorMessage(e) }, 'the port document did not go up');
      throw e;
    }
  }
  await ensurePoll(ctx, scope, port.id);
};

/** Asks the carrier where a port stands, and finishes it the moment it lands. */
export const portPoll: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const portId = String(ctx.job.payload['portId'] ?? '');
  const [port, account] = await readPort(ctx, scope, portId);
  if (!port || !IN_FLIGHT.has(port.status)) return;
  if (!port.providerSid) {
    // Sent but never acknowledged: the submit job is the one that can fix that.
    await asWorker(ctx.db, scope, (tx) =>
      scheduleJob(tx, {
        kind: PORT_JOBS.submit,
        dedupeKey: `port:submit:${port.id}`,
        runAt: new Date(),
        payload: { portId: port.id },
        workspaceId: scope.workspaceId,
        organizationId: scope.organizationId,
      }),
    );
    return;
  }
  if (!account) throw new Error('no telephony account for this workspace');

  const state = await ctx.telephony.fetchPort(account, port.providerSid);
  if (state.status !== 'complete') {
    await record(ctx, scope, port, state);
    return IN_FLIGHT.has(state.status as NumberPortStatus)
      ? { rescheduleAt: new Date(Date.now() + POLL_MS) }
      : undefined;
  }

  // It landed. The provider side has to be finished before the number is called active, or the first customer
  // to text it gets nothing: a full port arrives with no webhooks on it at all.
  const owned = await ctx.telephony.findOwnedNumber(account, port.e164);
  if (owned) {
    if (port.kind === 'full')
      await ctx.telephony.configureNumber(account, owned.sid, webhookUrls(ctx.publicUrl));
    if (account.messagingServiceSid)
      await ctx.telephony.addNumberToService(account, account.messagingServiceSid, owned.sid);
  }
  await executeCommand(
    ctx.db,
    numberPortComplete,
    {
      workspaceId: scope.workspaceId,
      portId: port.id,
      // Hosted messaging leaves no incoming-number row of its own, so the port's own reference is the number's.
      providerSid: owned?.sid ?? state.providerSid,
    },
    systemActor(scope),
    workerMeta(),
  );
};

/** Tells the carrier a port is off. Too late is an answer, not a failure. */
export const portCancel: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const providerSid = String(ctx.job.payload['providerSid'] ?? '');
  if (!providerSid) return;
  const account = await asWorker(ctx.db, scope, (tx) =>
    loadAccount(tx, scope.workspaceId, ctx.sealer),
  );
  if (!account) return;
  try {
    await ctx.telephony.cancelPort(account, providerSid);
  } catch (e) {
    if (!isPermanentProviderError(e)) throw e;
    ctx.log.warn({ providerSid, err: e.message }, 'the carrier would not call the port off');
  }
};

export const portJobs: JobMap = {
  [PORT_JOBS.submit]: portSubmit,
  [PORT_JOBS.poll]: portPoll,
  [PORT_JOBS.cancel]: portCancel,
};
