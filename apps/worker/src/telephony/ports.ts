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
  carrierHasPort,
  executeCommand,
  numberPortComplete,
  numberPortRecordState,
  scheduleJob,
  type NumberPortStatus,
} from '@hfos/core/server';
import { asWorker, sql } from '@hfos/db/client';
import { eq } from 'drizzle-orm';
import { numberPorts } from '@hfos/db/schema';
import type { EventHandler } from '../handlers/types';
import type { JobHandler, JobMap } from '../jobs';
import { errorMessage, MAX_ATTEMPTS } from '../outbox';
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

/**
 * What the carrier said, or did not. `providerSid` is nullable here where `PortState`'s is not: the two
 * writes that mean "the carrier has nothing of ours" have no sid to give, and `number_port.record_state`
 * writes that column only when it is truthy, so null leaves whatever is there alone.
 */
type Recorded = Omit<PortState, 'providerSid'> & { readonly providerSid: string | null };

/** Writes what the carrier said, through the command so the guard and the audit trail both see it. */
async function record(
  services: WorkerServices,
  scope: TenantScope,
  port: PortRow,
  state: Recorded,
  /** Set when this write is the submission itself: which version of the port the carrier now holds. */
  carrierSubmittedAt?: Date | null,
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
      nextPollAt: stillGoing ? new Date(Date.now() + services.portPollMs).toISOString() : null,
      ...(carrierSubmittedAt !== undefined
        ? { carrierSubmittedAt: carrierSubmittedAt ? carrierSubmittedAt.toISOString() : null }
        : {}),
    },
    systemActor(scope),
    workerMeta(),
  );
}

async function ensurePoll(
  services: WorkerServices,
  scope: TenantScope,
  portId: string,
  runAt = new Date(Date.now() + services.portPollMs),
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

/** What a business is told when the carrier could not be reached at all. Nothing was sent, so they can resend. */
const CARRIER_UNREACHABLE =
  'We could not reach the carrier to send this port, so it has not gone. Nothing was submitted — send it again when you are ready.';

/** One of the papers on a port, as `number_port.attach_document` writes it plus what this file adds. */
interface Paper {
  readonly objectPath: string;
  readonly name: string;
  /** The carrier's own reference for this paper, once it has it. */
  readonly sentSid?: string;
  /**
   * The port-in request it went up against. A resend after a rejection gets a new one from the carrier, so
   * every paper goes again — which is right: the old request is dead and its documents died with it.
   */
  readonly sentFor?: string;
}

/**
 * Writes down that a paper reached the carrier.
 *
 * The job is at-least-once and a retry now goes back through the upload loop rather than past it, so
 * something has to say which papers are already up — otherwise a carrier ends up holding three copies of one
 * business's authorisation. `documents` is already the record of which papers are in, so it is where "and
 * this one has gone" belongs. `jsonb_set` reaches into an object that exists (the paper was attached before
 * any of this ran), so it creates the one missing key rather than nothing at all.
 *
 * Nothing a business sees changes: `NumberPortOut.documents` is `Boolean(documents['loa'])`.
 */
async function markSent(
  services: WorkerServices,
  scope: TenantScope,
  portId: string,
  paper: string,
  sid: string,
  portSid: string,
): Promise<void> {
  await asWorker(services.db, scope, (tx) =>
    tx
      .update(numberPorts)
      .set({
        // `array[…]::text[]`, not `'{loa,sentSid}'`: a bound parameter arrives typed `text`, and
        // `jsonb_set(jsonb, text, jsonb)` is not a function — it fails at runtime, not at typecheck.
        documents: sql`jsonb_set(${numberPorts.documents}, array[${paper}]::text[],
          coalesce(${numberPorts.documents} -> ${paper}, '{}'::jsonb)
            || ${JSON.stringify({ sentSid: sid, sentFor: portSid })}::jsonb)`,
      })
      .where(eq(numberPorts.id, portId)),
  );
}

/**
 * The tries are spent and the port never really went. Say so.
 *
 * A port that reads "with the carrier" when the carrier has half of it, or none of it, is worse than one
 * that reads failed: a business waits weeks for a number that was never going to move, and the papers they
 * signed sit in a bucket. So it fails, in words they can act on, and `number_port.record_state` puts the
 * number back on the market with it.
 *
 * **And what the carrier does hold is pulled back first.** A request sent without its authorisation is one
 * the business cannot see, cannot call off, and which would fight the next one they send — so it goes the
 * same way the call-off button sends it, through `port.cancel`.
 */
async function giveUp(
  services: WorkerServices,
  scope: TenantScope,
  port: PortRow,
  providerSid: string | null,
  reason: string,
): Promise<void> {
  if (providerSid)
    await asWorker(services.db, scope, (tx) =>
      scheduleJob(tx, {
        kind: PORT_JOBS.cancel,
        dedupeKey: `port:cancel:${port.id}`,
        runAt: new Date(),
        payload: { portId: port.id, providerSid },
        workspaceId: scope.workspaceId,
        organizationId: scope.organizationId,
      }),
    );
  await record(services, scope, port, {
    // `null`, never a stand-in string: `number_port.record_state` writes this column only when it is truthy,
    // and anything truthy is read back as "the carrier already has this" — which would skip the next send.
    providerSid,
    providerStatus: 'not_sent',
    status: 'failed',
    rejectionReason: reason,
    scheduledFor: null,
  });
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
 *
 * **A retry comes back through the papers, and that is new.** This used to return the moment it saw a
 * `providerSid` — straight past the upload loop, to schedule a poll and report success. So the first upload
 * failure was the last one: the signed authorisation never went, the carrier held the request at
 * `PENDING_LOA`, and the business was told nothing. A missing LOA is the commonest reason a carrier turns a
 * port down. The comment beside the old `throw` said a retry fixed it; the code it pointed at returned.
 *
 * What makes coming back safe is `markSent`: a paper the carrier already has is skipped, so at-least-once
 * costs nothing, and a submission is still only ever made once.
 */
export const portSubmit: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const portId = String(ctx.job.payload['portId'] ?? '');
  const [port] = await readPort(ctx, scope, portId);
  // `submitted` is what pressing Send leaves, but a carrier can answer `carrier_review` or `scheduled` to the
  // submission itself, and a poll can get in first. The papers still have to go up for all three, so this
  // asks whether the port is in flight rather than whether it is exactly as Send left it.
  if (!port || !IN_FLIGHT.has(port.status)) return;
  const lastTry = ctx.attempt >= MAX_ATTEMPTS;

  // Outside both `try`s it was the one provider call `lastTry` did not cover — and it is the likeliest to
  // fail, because a business's very first port is also when its carrier account is created.
  let account: ProviderAccount;
  try {
    account = await ensureAccount(ctx, scope);
  } catch (e) {
    if (!lastTry) throw e;
    ctx.log.warn(
      { portId: port.id, err: errorMessage(e) },
      'no carrier account to send the port from',
    );
    await giveUp(ctx, scope, port, null, CARRIER_UNREACHABLE);
    return;
  }
  const documents = port.documents as Record<string, Partial<Paper> | undefined>;
  const papers = Object.entries(documents).filter(
    (e): e is [string, Paper] =>
      typeof e[1]?.objectPath === 'string' && typeof e[1]?.name === 'string',
  );

  /*
   * Send it, unless a previous attempt already did. Never twice: a second submission for the same number is
   * how a business ends up with two ports fighting at one carrier.
   *
   * **"Already did" means this version of it.** A person cannot clear `provider_sid` — the guard forbids it
   * on every transition, Send included — so a port the carrier turned down still carries the dead request's
   * reference. Asking `providerSid` alone therefore skipped the submit on every resend, and the corrected
   * account number never left the building. `carrierHasPort` is the registration twin's own comparison.
   */
  const alreadySent = carrierHasPort(port) ? port.providerSid : null;
  let providerSid: string;
  if (alreadySent) {
    providerSid = alreadySent;
  } else {
    let state: PortState;
    try {
      state = await ctx.telephony.submitPort(account, {
        e164: port.e164,
        kind: port.kind,
        submission: port.submission as Record<string, unknown>,
        documentPaths: papers.map(([, d]) => d.objectPath),
      });
    } catch (e) {
      // A carrier saying no to the details is an answer, not a blip: the business has to fix something, and a
      // retry would only be told the same thing more slowly.
      if (isPermanentProviderError(e)) {
        ctx.log.warn({ portId: port.id, err: e.message }, 'the carrier refused the port');
        await record(ctx, scope, port, {
          providerSid: port.providerSid,
          providerStatus: 'refused',
          status: 'rejected',
          rejectionReason: e.message,
          scheduledFor: null,
        });
        return;
      }
      if (!lastTry) throw e;
      ctx.log.warn({ portId: port.id, err: errorMessage(e) }, 'the port never reached the carrier');
      await giveUp(ctx, scope, port, null, CARRIER_UNREACHABLE);
      return;
    }
    await record(ctx, scope, port, state, port.submittedAt);
    providerSid = state.providerSid;
  }

  for (const [key, paper] of papers) {
    if (paper.sentFor === providerSid) continue;
    try {
      const data = await ctx.store.download('attachments', paper.objectPath);
      const { sid } = await ctx.telephony.uploadPortDocument(account, {
        portSid: providerSid,
        name: paper.name,
        contentType: 'application/pdf',
        data,
      });
      await markSent(ctx, scope, port.id, key, sid, providerSid);
    } catch (e) {
      ctx.log.warn(
        { portId: port.id, paper: key, lastTry, err: errorMessage(e) },
        'the port document did not go up',
      );
      if (!lastTry) throw e;
      await giveUp(
        ctx,
        scope,
        port,
        providerSid,
        `We could not send ${paper.name} to the carrier, and a port cannot go ahead without it. The request has been called off. Upload the paper again and resend.`,
      );
      return;
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
      ? { rescheduleAt: new Date(Date.now() + ctx.portPollMs) }
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
