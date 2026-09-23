/**
 * A business's RCS sender: the Twilio side (0101).
 *
 * The twin of the number-port jobs (telephony/ports.ts), and for the same reason: every provider call here is a
 * job, never an outbox handler, so a Twilio that is slow or throttling costs one retry with backoff rather than
 * replaying every handler an event has.
 *
 * **What "connected" means at Twilio is one thing: the sender is in the business's messaging-service pool.**
 * While it is there, Twilio tries RCS first for every text sent through the service and falls back to SMS or
 * MMS by itself. So the pool is kept in step with what the business wants, every time a job runs:
 *
 *   approved, and switched on   → in the pool: texts go RCS first
 *   anything else               → out of it: texts go exactly as they did before RCS
 *
 * That is why switching RCS off takes the sender out of the pool rather than setting a flag somewhere: a sender
 * left in the pool would still be tried first, whatever this system believed.
 *
 * **Twilio makes senders only in its own console.** Nothing here creates one. Connecting finds the sender the
 * business made in its own subaccount by its id, and a job asks after it until the carriers approve it — every
 * `registrationPollMs` while it is in review or offline, and once a day once it is live, so a sender the
 * carriers take down stops being tried first within a day rather than never.
 */
import { executeCommand, rcsSenderRecordState, scheduleJob } from '@hfos/core/server';
import { asWorker } from '@hfos/db/client';
import { eq } from 'drizzle-orm';
import { rcsSenders, workspaces } from '@hfos/db/schema';
import { rcsLiveEmail, rcsStoppedEmail } from '../emails/templates';
import { managers } from '../handlers/telephony';
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
import { ensureAccount, loadAccount } from './accounts';
import { isPermanentProviderError, type ProviderAccount, type RcsSenderInfo } from './provider';

export const RCS_JOBS = {
  connect: 'rcs_sender.connect',
  check: 'rcs_sender.check',
  disconnect: 'rcs_sender.disconnect',
} as const;

const DAY = 86_400_000;

type SenderRow = typeof rcsSenders.$inferSelect;
type Status = SenderRow['status'];

/** The sender and the credentials to talk to Twilio about it, read in one worker transaction. */
async function readSender(
  services: WorkerServices,
  scope: TenantScope,
  id: string,
): Promise<readonly [SenderRow | undefined, ProviderAccount | null]> {
  return asWorker(
    services.db,
    scope,
    async (tx) =>
      [
        (await tx.select().from(rcsSenders).where(eq(rcsSenders.id, id)))[0],
        await loadAccount(tx, scope.workspaceId, services.sealer),
      ] as const,
  );
}

/** Writes what Twilio said, through the command so the guard and the audit trail both see it. */
async function record(
  services: WorkerServices,
  scope: TenantScope,
  sender: SenderRow,
  state: {
    readonly status: Status;
    readonly accountId?: string | null;
    readonly providerSid?: string | null;
    readonly providerStatus?: string | null;
    readonly displayName?: string | null;
    readonly inService?: boolean;
    readonly lastError?: string | null;
    readonly nextPollAt?: Date | null;
  },
): Promise<void> {
  await executeCommand(
    services.db,
    rcsSenderRecordState,
    {
      workspaceId: scope.workspaceId,
      rcsSenderId: sender.id,
      status: state.status,
      ...(state.accountId !== undefined ? { accountId: state.accountId } : {}),
      ...(state.providerSid !== undefined ? { providerSid: state.providerSid } : {}),
      ...(state.providerStatus !== undefined ? { providerStatus: state.providerStatus } : {}),
      ...(state.displayName !== undefined ? { displayName: state.displayName } : {}),
      ...(state.inService !== undefined ? { inService: state.inService } : {}),
      ...(state.lastError !== undefined ? { lastError: state.lastError } : {}),
      nextPollAt: state.nextPollAt ? state.nextPollAt.toISOString() : null,
    },
    systemActor(scope),
    workerMeta(),
  );
}

async function schedule(
  services: WorkerServices,
  scope: TenantScope,
  kind: string,
  senderId: string,
  runAt: Date,
  opts: { readonly pullEarlier?: boolean } = {},
): Promise<void> {
  await asWorker(services.db, scope, (tx) =>
    scheduleJob(
      tx,
      {
        kind,
        dedupeKey: `${kind}:${senderId}`,
        runAt,
        payload: { rcsSenderId: senderId },
        workspaceId: scope.workspaceId,
        organizationId: scope.organizationId,
      },
      opts,
    ),
  );
}

/** Why a sender could not be found, in words that say where to look. */
const notFound = (sender: SenderRow, account: ProviderAccount) =>
  `Twilio has no RCS sender called ${sender.senderId} in this business’s account (${account.sid}). Make it in the Twilio console under that account, or check the id, then connect it again.`;

/**
 * Where Twilio's answer leaves the business, and the pool made to match it. The one place the rule in the header
 * is carried out, so connecting, checking and switching RCS on and off can never disagree about it.
 */
async function settle(
  services: WorkerServices,
  scope: TenantScope,
  sender: SenderRow,
  account: ProviderAccount,
  found: RcsSenderInfo,
): Promise<void> {
  const serviceSid = account.messagingServiceSid;
  const wanted = found.state === 'online' && sender.enabled && !!serviceSid;
  let inService = sender.inService;
  if (serviceSid && wanted && !inService) {
    await services.telephony.addRcsSenderToService(account, serviceSid, found.sid);
    inService = true;
  } else if (serviceSid && !wanted && inService) {
    await services.telephony.removeRcsSenderFromService(account, serviceSid, found.sid);
    inService = false;
  }
  const status: Status =
    found.state === 'online'
      ? 'active'
      : found.state === 'offline'
        ? 'offline'
        : found.state === 'failed'
          ? 'failed'
          : 'in_review';
  const settled = status === 'active';
  await record(services, scope, sender, {
    status,
    accountId: account.id,
    providerSid: found.sid,
    providerStatus: found.providerStatus,
    displayName: found.displayName,
    inService,
    lastError:
      status === 'offline' || status === 'failed'
        ? (found.reason ?? 'Twilio says this RCS sender is not taking messages.')
        : null,
    nextPollAt:
      status === 'failed'
        ? null
        : new Date(Date.now() + (settled ? DAY : services.registrationPollMs)),
  });
}

/** A person asked to connect a sender: the Twilio side is a job, so it retries on its own. */
export const onRcsConnectRequested: EventHandler = async (ctx) => {
  const { workspaceId, organizationId } = ctx.scope;
  const id = ctx.event.entityId;
  if (!workspaceId || !organizationId || !id) return;
  await scheduleJob(ctx.tx, {
    kind: RCS_JOBS.connect,
    dedupeKey: `${RCS_JOBS.connect}:${id}`,
    runAt: new Date(),
    payload: { rcsSenderId: id },
    workspaceId,
    organizationId,
  });
};

/**
 * A person asked for a fresh look, or switched RCS on or off, or chose another line: all three are a check now,
 * which puts the pool right as a side effect of reading where the sender stands.
 */
export const onRcsCheckWanted: EventHandler = async (ctx) => {
  const { workspaceId, organizationId } = ctx.scope;
  const id = ctx.event.entityId;
  if (!workspaceId || !organizationId || !id) return;
  await scheduleJob(
    ctx.tx,
    {
      kind: RCS_JOBS.check,
      dedupeKey: `${RCS_JOBS.check}:${id}`,
      runAt: new Date(),
      payload: { rcsSenderId: id },
      workspaceId,
      organizationId,
    },
    { pullEarlier: true },
  );
};

/** A person let the sender go: it comes out of the pool, and then it is gone. */
export const onRcsDisconnectRequested: EventHandler = async (ctx) => {
  const { workspaceId, organizationId } = ctx.scope;
  const id = ctx.event.entityId;
  if (!workspaceId || !organizationId || !id) return;
  await scheduleJob(ctx.tx, {
    kind: RCS_JOBS.disconnect,
    dedupeKey: `${RCS_JOBS.disconnect}:${id}`,
    runAt: new Date(),
    payload: { rcsSenderId: id },
    workspaceId,
    organizationId,
  });
};

/**
 * Finds the sender the business made at Twilio and connects it: into the pool at once when the carriers have
 * already approved it, otherwise into review with a check scheduled.
 */
export const rcsSenderConnect: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const id = String(ctx.job.payload['rcsSenderId'] ?? '');
  const [sender] = await readSender(ctx, scope, id);
  if (!sender || sender.status !== 'connecting') return;
  const lastTry = ctx.attempt >= MAX_ATTEMPTS;
  try {
    // The messaging service is what the sender goes into; a business with a number already has one, and this
    // makes it for one that somehow doesn't.
    const account = await ensureAccount(ctx, scope);
    const found = (await ctx.telephony.listRcsSenders(account)).find(
      (x) => x.senderId.toLowerCase() === sender.senderId.toLowerCase(),
    );
    if (!found) {
      await record(ctx, scope, sender, {
        status: 'failed',
        accountId: account.id,
        lastError: notFound(sender, account),
        nextPollAt: null,
      });
      return;
    }
    await settle(ctx, scope, sender, account, found);
    const [after] = await readSender(ctx, scope, id);
    if (after?.nextPollAt) await schedule(ctx, scope, RCS_JOBS.check, id, after.nextPollAt);
  } catch (e) {
    if (isPermanentProviderError(e)) {
      await record(ctx, scope, sender, {
        status: 'failed',
        lastError: e.message,
        nextPollAt: null,
      });
      return;
    }
    if (!lastTry) throw e;
    ctx.log.warn({ rcsSenderId: id, err: errorMessage(e) }, 'could not reach twilio for rcs');
    await record(ctx, scope, sender, {
      status: 'failed',
      lastError: 'We could not reach Twilio to connect this sender. Connect it again in a minute.',
      nextPollAt: null,
    });
  }
};

/** Asks Twilio where the sender stands, and puts the pool right. */
export const rcsSenderCheck: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const id = String(ctx.job.payload['rcsSenderId'] ?? '');
  const [sender, account] = await readSender(ctx, scope, id);
  if (!sender || !['in_review', 'active', 'offline'].includes(sender.status)) return;
  if (!account) return;
  const found = sender.providerSid
    ? await ctx.telephony.fetchRcsSender(account, sender.providerSid)
    : ((await ctx.telephony.listRcsSenders(account)).find(
        (x) => x.senderId.toLowerCase() === sender.senderId.toLowerCase(),
      ) ?? null);
  if (!found) {
    // Deleted at Twilio. Nothing may be left in the pool pointing at it, or every text would be tried on a
    // sender that no longer exists.
    if (sender.inService && sender.providerSid && account.messagingServiceSid)
      await ctx.telephony.removeRcsSenderFromService(
        account,
        account.messagingServiceSid,
        sender.providerSid,
      );
    await record(ctx, scope, sender, {
      status: 'failed',
      inService: false,
      lastError: notFound(sender, account),
      nextPollAt: null,
    });
    return;
  }
  await settle(ctx, scope, sender, account, found);
  const [after] = await readSender(ctx, scope, id);
  return after?.nextPollAt ? { rescheduleAt: after.nextPollAt } : undefined;
};

/** Takes the sender out of the pool — texts go as SMS and MMS again — and marks it gone. */
export const rcsSenderDisconnect: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const id = String(ctx.job.payload['rcsSenderId'] ?? '');
  const [sender, account] = await readSender(ctx, scope, id);
  if (!sender || sender.status !== 'disconnecting') return;
  if (account?.messagingServiceSid && sender.providerSid)
    await ctx.telephony.removeRcsSenderFromService(
      account,
      account.messagingServiceSid,
      sender.providerSid,
    );
  await record(ctx, scope, sender, { status: 'disconnected', inService: false, nextPollAt: null });
};

/**
 * Owners and admins hear when RCS turns on — the carriers approved the sender — and when it stops, the way they
 * hear about the texting registration. Only on the way in and out of live: a sender waiting in review is what
 * they expect, and a failed connection is on the screen of the person who pressed Connect.
 */
export const onRcsStateChanged: EventHandler = async (ctx) => {
  const p = ctx.event.payload as { status?: string; from?: string; senderId?: string };
  const wentLive = p.status === 'active' && p.from !== 'active';
  const stopped = p.from === 'active' && (p.status === 'offline' || p.status === 'failed');
  if (!wentLive && !stopped) return;
  const scope = tenantOf(ctx.scope);
  const [s] = await ctx.tx.select().from(rcsSenders).where(eq(rcsSenders.id, ctx.event.entityId!));
  const [ws] = await ctx.tx
    .select({ name: workspaces.name })
    .from(workspaces)
    .where(eq(workspaces.id, scope.workspaceId));
  const business = ws?.name ?? 'your business';
  const sender = s?.displayName || s?.senderId || p.senderId || 'Your RCS sender';
  const link = `${ctx.webUrl}/app/w/${scope.workspaceId}/settings/texting`;
  const mail = wentLive
    ? rcsLiveEmail({ business, sender, link })
    : rcsStoppedEmail({ business, sender, reason: s?.lastError ?? null, link });
  for (const r of await managers(ctx.tx, scope.workspaceId))
    await ctx.mailer.send({ to: r.email, ...mail });
};

export const rcsJobs: JobMap = {
  [RCS_JOBS.connect]: rcsSenderConnect,
  [RCS_JOBS.check]: rcsSenderCheck,
  [RCS_JOBS.disconnect]: rcsSenderDisconnect,
};
