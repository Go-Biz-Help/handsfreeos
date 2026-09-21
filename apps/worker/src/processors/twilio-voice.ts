import { and, eq } from 'drizzle-orm';
import {
  callAttachRecording,
  callRecord,
  callUpdateStatus,
  executeCommand,
} from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import { calls } from '@hfos/db/schema';
import type { DeliveryContext, DeliveryProcessor } from '../deliveries';
import { chargeCall, chargeCallLeg, type NumberKind } from '../money/usage-capture';
import { systemActor, workerMeta, type TenantScope } from '../services';
import { loadAccount } from '../telephony/accounts';
import { queueTranscript } from '../telephony/cell';
import type { ProviderAccount } from '../telephony/provider';
import { isPhone, userIdOfIdentity } from '../telephony/voice';

type Params = Readonly<Record<string, string | undefined>>;
type Status =
  'ringing' | 'in_progress' | 'completed' | 'busy' | 'no_answer' | 'failed' | 'canceled';
type Call = typeof calls.$inferSelect;

/** Twilio's call statuses → ours ("answered" is how a leg's answered event reads in some callbacks). */
const CALL_STATUS: Readonly<Record<string, Status>> = {
  ringing: 'ringing',
  'in-progress': 'in_progress',
  answered: 'in_progress',
  completed: 'completed',
  busy: 'busy',
  'no-answer': 'no_answer',
  failed: 'failed',
  canceled: 'canceled',
};
const ENDED = new Set<Status>(['completed', 'busy', 'no_answer', 'failed', 'canceled']);

function tenant(ctx: DeliveryContext): TenantScope | null {
  const { workspaceId, organizationId } = ctx.delivery;
  return workspaceId && organizationId ? { workspaceId, organizationId } : null;
}
const paramsOf = (ctx: DeliveryContext) => ctx.delivery.params as Params;
const statusOf = (p: Params) => CALL_STATUS[(p.CallStatus ?? '').toLowerCase()];
const secondsOf = (v: string | undefined): number | undefined => {
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.min(Math.round(n), 86_400) : undefined;
};
/** A caller who withheld their number never gets a call record, so its later reports need no work. */
const untracked = (p: Params) => !isPhone(p.From) && !(p.From ?? '').startsWith('client:');

/** The call, or a retry while the delivery that records it (the inbound call or the browser's call) is on its way. */
async function callFor(
  ctx: DeliveryContext,
  scope: TenantScope,
  providerSid: string,
  p: Params,
): Promise<Call | null> {
  const [c] = await asWorker(ctx.db, scope, (tx) =>
    tx
      .select()
      .from(calls)
      .where(and(eq(calls.workspaceId, scope.workspaceId), eq(calls.providerSid, providerSid))),
  );
  if (c) return c;
  if (untracked(p)) return null;
  throw new Error(`call ${providerSid} is not recorded yet`);
}

const update = (ctx: DeliveryContext, scope: TenantScope, input: Record<string, unknown>) =>
  executeCommand(
    ctx.db,
    callUpdateStatus,
    { workspaceId: scope.workspaceId, ...input },
    systemActor(scope),
    workerMeta(),
  );

async function accountOf(ctx: DeliveryContext, scope: TenantScope): Promise<ProviderAccount> {
  const account = await asWorker(ctx.db, scope, (tx) =>
    loadAccount(tx, scope.workspaceId, ctx.sealer),
  );
  if (!account) throw new Error('no telephony account for this workspace');
  return account;
}

/**
 * Drops the carrier's copy of a recording we are not keeping. A recording we do keep is deleted later instead, by
 * `settleTranscript`, once its words have settled — the transcriber may still need to read it.
 * Failures only log: a copy left behind costs pennies, and failing the delivery would replay the whole thing.
 */
async function forget(
  ctx: DeliveryContext,
  account: ProviderAccount,
  recordingSid: string | null | undefined,
): Promise<void> {
  try {
    if (recordingSid) await ctx.telephony.deleteRecording(account, recordingSid);
  } catch (e) {
    ctx.log.warn({ err: e }, 'could not delete the carrier copy of a recording');
  }
}

/** A customer called: the call record and its conversation (the ringing itself was answered in TwiML). */
export const onInboundCall: DeliveryProcessor = async (ctx) => {
  const scope = tenant(ctx);
  const p = paramsOf(ctx);
  if (!scope || !p.CallSid || !isPhone(p.From) || !isPhone(p.To)) return 'ignored';
  await executeCommand(
    ctx.db,
    callRecord,
    {
      workspaceId: scope.workspaceId,
      providerSid: p.CallSid,
      direction: 'inbound',
      from: p.From,
      to: p.To,
      status: 'ringing',
      startedAt: ctx.delivery.receivedAt.toISOString(),
    },
    systemActor(scope),
    workerMeta(),
  );
};

/** A teammate's browser call reached Twilio: link the record call.start made to Twilio's call. */
export const onOutboundCall: DeliveryProcessor = async (ctx) => {
  const scope = tenant(ctx);
  const p = paramsOf(ctx);
  if (!scope || !p.CallSid || !p.CallId) return 'ignored';
  const callId = p.CallId;
  const [c] = await asWorker(ctx.db, scope, (tx) =>
    tx
      .select({ from: calls.fromE164, to: calls.toE164 })
      .from(calls)
      .where(and(eq(calls.id, callId), eq(calls.workspaceId, scope.workspaceId))),
  );
  if (!c?.from || !c.to) return 'ignored';
  await executeCommand(
    ctx.db,
    callRecord,
    {
      workspaceId: scope.workspaceId,
      providerSid: p.CallSid,
      direction: 'outbound',
      from: c.from,
      to: c.to,
      callId,
      status: 'ringing',
    },
    systemActor(scope),
    workerMeta(),
  );
};

/**
 * The call as a whole moved on. Twilio's own "in progress" only means it is running our instructions, so it
 * is not an answer; the leg that carried a conversation usually reports the end first.
 */
export const onCallStatus: DeliveryProcessor = async (ctx) => {
  const scope = tenant(ctx);
  const p = paramsOf(ctx);
  const status = statusOf(p);
  if (!scope || !p.CallSid || !status || status === 'in_progress') return 'ignored';
  const call = await callFor(ctx, scope, p.CallSid, p);
  if (!call) return 'ignored';
  const duration = secondsOf(p.CallDuration);
  await update(ctx, scope, {
    providerSid: p.CallSid,
    status,
    ...(duration !== undefined ? { durationSeconds: duration } : {}),
  });
  // Charged at the end, from the length the carrier reported. The key is the call's own sid, so a status
  // callback arriving twice charges once. An inbound call to a toll-free number costs us two and a half times
  // what a local one does, so which of our numbers it came in on decides the rate.
  if (ENDED.has(status))
    await chargeCall(ctx.wallet, scope, {
      callSid: p.CallSid,
      direction: call.direction === 'outbound' ? 'outbound' : 'inbound',
      seconds: duration ?? call.durationSeconds,
      numberKind: await numberKindOf(ctx, scope, call.phoneNumberId),
      counterpart: (call.direction === 'outbound' ? call.toE164 : call.fromE164) ?? '',
      callId: call.id,
    });
};

/**
 * Which of our numbers a call used. Local when we cannot tell, which is the cheaper of the two and therefore
 * the one that under-charges rather than over-charges when something has gone wrong.
 */
async function numberKindOf(
  ctx: DeliveryContext,
  scope: TenantScope,
  phoneNumberId: string | null,
): Promise<NumberKind> {
  if (!phoneNumberId) return 'local';
  const [n] = await asWorker(ctx.db, scope, (tx) =>
    rows<{ number_type: string }>(
      tx,
      sql`select number_type::text as number_type from app.phone_numbers where id = ${phoneNumberId}`,
    ),
  );
  return n?.number_type === 'toll_free' ? 'tollfree' : 'local';
}

/** One leg of a call: a teammate's browser, a forwarded phone, or the customer a teammate dialed. */
export const onLegStatus: DeliveryProcessor = async (ctx) => {
  const scope = tenant(ctx);
  const p = paramsOf(ctx);
  const status = statusOf(p);
  if (!scope || !p.ParentCallSid || !status) return 'ignored';
  const call = await callFor(ctx, scope, p.ParentCallSid, p);
  if (!call) return 'ignored';
  const duration = secondsOf(p.CallDuration);
  const parent = { providerSid: p.ParentCallSid };

  if (call.direction === 'outbound') {
    // The customer's phone rang, picked up, or the conversation ended.
    if (status === 'in_progress') {
      await update(ctx, scope, {
        ...parent,
        status,
        answeredNumber: isPhone(p.To) ? p.To : call.toE164,
      });
      return;
    }
    await update(ctx, scope, {
      ...parent,
      status,
      ...(ENDED.has(status) && duration !== undefined ? { durationSeconds: duration } : {}),
    });
    return;
  }

  // A customer ringing the business and being put through to somebody's own phone is **two** billable legs:
  // the one that came in, charged by onCallStatus, and the one we dialled out, charged here. Twilio bills a
  // dialled leg from the moment it is answered — including by that phone's own voicemail, which is why this
  // does not wait for somebody to press 1 and take the call properly.
  //
  // A browser leg (`client:…`) is deliberately not charged: Twilio prices a Client connection differently and
  // the card has no line for it. Step 4's nightly reconciliation against Twilio's own daily records is what
  // catches that, and anything else here misses, as an adjustment.
  if (ENDED.has(status) && isPhone(p.To) && (duration ?? 0) > 0)
    await chargeCallLeg(ctx.wallet, scope, {
      parentCallSid: p.ParentCallSid,
      toE164: p.To,
      seconds: duration ?? 0,
      callId: call.id,
    });

  const userId = userIdOfIdentity(p.To);
  if (status === 'in_progress') {
    // A forwarded phone picking up is not an answer until someone presses 1 (its own voicemail may have).
    if (!userId) return 'ignored';
    await update(ctx, scope, {
      ...parent,
      status,
      answeredVia: 'browser',
      answeredByUserId: userId,
    });
    return;
  }
  // Only the leg that took the call ends it; the others lost the race.
  const tookIt =
    status === 'completed' &&
    (userId
      ? call.answeredVia === 'browser' && call.answeredByUserId === userId
      : call.answeredVia === 'forwarding' && call.answeredNumber === p.To);
  if (!tookIt) return 'ignored';
  await update(ctx, scope, {
    ...parent,
    status: 'completed',
    ...(duration !== undefined ? { durationSeconds: duration } : {}),
  });
};

/** Someone pressed 1 on a forwarded phone: that phone took the call. */
export const onScreened: DeliveryProcessor = async (ctx) => {
  const scope = tenant(ctx);
  const p = paramsOf(ctx);
  if (!scope || !p.ParentCallSid || !isPhone(p.To)) return 'ignored';
  const call = await callFor(ctx, scope, p.ParentCallSid, p);
  if (!call) return 'ignored';
  await update(ctx, scope, {
    providerSid: p.ParentCallSid,
    status: 'in_progress',
    answeredVia: 'forwarding',
    answeredNumber: p.To,
  });
};

/**
 * A recording finished: copy it into the workspace's storage and attach it to the call. A voicemail, or a whole call
 * through someone's own cell (its words are then asked for, and read back by the `call.transcript` job).
 */
export const onRecording: DeliveryProcessor = async (ctx) => {
  const scope = tenant(ctx);
  const p = paramsOf(ctx);
  if (!scope || !p.RecordingSid || !p.CallSid) return 'ignored';
  if ((p.RecordingStatus ?? '').toLowerCase() !== 'completed') return 'ignored';
  const account = await accountOf(ctx, scope);
  const call = await callFor(ctx, scope, p.CallSid, p);
  const seconds = secondsOf(p.RecordingDuration) ?? 0;
  if (!call || seconds < 1) {
    // Nothing to keep (a hidden number, or silence), and nothing left with the provider either.
    await forget(ctx, account, p.RecordingSid);
    return 'ignored';
  }
  const whole = call.answeredVia === 'bridge';
  const got = await ctx.telephony.fetchRecording(account, p.RecordingSid);
  const ext = /wav/i.test(got.contentType) ? 'wav' : 'mp3';
  const objectPath = `${scope.workspaceId}/calls/${call.id}/${whole ? 'recording' : 'voicemail'}.${ext}`;
  await ctx.store.upload('telephony', objectPath, got.data, got.contentType, { upsert: true });
  await executeCommand(
    ctx.db,
    callAttachRecording,
    {
      workspaceId: scope.workspaceId,
      callId: call.id,
      recordingSid: p.RecordingSid,
      objectPath,
      seconds,
      voicemail: !whole,
    },
    systemActor(scope),
    workerMeta(),
  );
  // Every recording's words are asked for the same way now, voicemail included: the `call.transcribe` job reads
  // our own stored copy (telephony/cell.ts), and the carrier's goes once the words have settled either way.
  // Voicemail used to go through Twilio's legacy `<Record transcribe>` instead, which skipped anything under two
  // seconds and is deprecated.
  const recordingSid = p.RecordingSid;
  if (!call.transcriptStatus)
    await asWorker(ctx.db, scope, (tx) => queueTranscript(tx, scope, call, recordingSid));
};
