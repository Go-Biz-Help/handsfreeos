/**
 * Calls through someone's own cell (M10), the worker's side.
 *
 * - **Confirming a cell** (`user_phone.verification_requested`): HandsFreeOS calls it from the business number; the
 *   TwiML routes (http/voice.ts) say "This is HandsFreeOS confirming this is your phone. Press 1." and pressing 1
 *   marks it verified. Once per request: a retry finds the call already recorded.
 * - **Calling a customer** (`call.started` from call.connect_me): HandsFreeOS rings the person's verified cell from the
 *   business number with a short timeout; the routes play "Press 1 to call Mike Johnson" and only a 1 dials the
 *   customer, showing the business number, recorded on two channels. The call's own status reports (the `status`
 *   route) and the customer's leg (`leg-status`) move the call on as they do for every call.
 * - **Cancelling it** (`call.bridge_cancelled` from call.cancel_connect): the call already ended in HandsFreeOS; the
 *   carrier's call is hung up. A call cancelled while it was being placed is hung up as soon as it is recorded.
 * - **The words** of a recorded call: once the recording is stored (processors/twilio-voice.ts), `call.transcribe` asks
 *   the provider for them and `call.transcript` reads them back until they're ready; they're attached to the call and
 *   the provider's copies deleted. A provider that refuses (Conversational Intelligence not turned on) or stays down
 *   for hours leaves the call with its recording and no words, never a failed recording.
 * Placing a call and recording that it was placed are two steps, as sending a text is: a retry sees the record.
 */
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import {
  BRIDGE_CELL_RING_SECONDS,
  callAttachTranscript,
  callRecord,
  callUpdateStatus,
  executeCommand,
  liveNumber,
  scheduleJob,
  userPhoneRecordCall,
} from '@hfos/core/server';
import { asWorker, rows, sql, type Tx } from '@hfos/db/client';
import { calls, userPhones } from '@hfos/db/schema';
import type { EventHandler } from '../handlers/types';
import type { JobContext, JobHandler } from '../jobs';
import { errorMessage } from '../outbox';
import {
  tenantOf,
  systemActor,
  workerMeta,
  type TenantScope,
  type WorkerServices,
} from '../services';
import { loadAccount } from './accounts';
import {
  isPermanentProviderError,
  ProviderError,
  type ProviderAccount,
  type TranscriptionState,
} from './provider';
import { voiceUrls } from './voice';

const MIN = 60_000;
/** A call through someone's cell that waited this long for the worker (it was down) isn't placed: nobody waits for it. */
const BRIDGE_STALE_MS = 2 * MIN;
/** A verification call that waited this long isn't placed either; they can ask again. */
const VERIFY_STALE_MS = 10 * MIN;
/** How long a verification call rings. */
const VERIFY_RING_SECONDS = 30;
/** How long HandsFreeOS keeps asking for a recorded call's words. */
const TRANSCRIPT_GIVE_UP_MS = 6 * 60 * MIN;
/** The longest transcript a call keeps (app.calls.transcript's limit). */
const TRANSCRIPT_MAX = 10_000;

export const CELL_JOBS = {
  /** One per recorded call through someone's cell: asks the provider for its words. */
  transcribe: 'call.transcribe',
  /** Then reads them back, once the provider has them. */
  transcript: 'call.transcript',
} as const;
export const transcribeJobKey = (callId: string): string => `call-transcribe:${callId}`;
export const transcriptJobKey = (callId: string): string => `call-transcript:${callId}`;

const isUuid = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

/** call.connect_me asked for a call: ring the person's verified cell from the business number. */
export const onBridgeRequested: EventHandler = async (ctx) => {
  const payload = (ctx.event.payload ?? {}) as Record<string, unknown>;
  if (payload['via'] !== 'bridge' || !isUuid(ctx.event.entityId)) return;
  const scope = tenantOf(ctx.scope);
  const callId = ctx.event.entityId;
  const [c] = await ctx.tx
    .select()
    .from(calls)
    .where(and(eq(calls.id, callId), eq(calls.workspaceId, scope.workspaceId)));
  // Already placed (a retry), or no longer waiting.
  if (!c || c.answeredVia !== 'bridge' || c.providerSid || c.status !== 'initiated') return;
  const meta = workerMeta(ctx.event.correlationId, ctx.event.id);
  const actor = systemActor(scope, c.placedBy);
  const fail = async (why: string) => {
    ctx.log.warn({ callId, why }, 'a call through someone’s cell was not placed');
    await executeCommand(
      ctx.db,
      callUpdateStatus,
      { workspaceId: scope.workspaceId, callId, status: 'failed' },
      actor,
      meta,
    );
  };
  if (Date.now() - c.startedAt.getTime() > BRIDGE_STALE_MS) return fail('stale');
  const [cell] = c.placedBy
    ? await ctx.tx
        .select({ e164: userPhones.e164 })
        .from(userPhones)
        .where(and(eq(userPhones.userId, c.placedBy), isNotNull(userPhones.verifiedAt)))
    : [];
  const number = await liveNumber(ctx.tx, scope.workspaceId);
  const account = await loadAccount(ctx.tx, scope.workspaceId, ctx.sealer);
  if (!cell) return fail('no_verified_cell');
  if (!number || number.status !== 'active' || number.e164 !== c.fromE164 || !c.toE164 || !account)
    return fail('no_number');
  const urls = voiceUrls(ctx.publicUrl);
  let sid: string;
  try {
    ({ sid } = await ctx.telephony.placeCall(account, {
      from: number.e164,
      to: cell.e164,
      answerUrl: urls.bridge(callId),
      statusCallbackUrl: urls.status,
      timeoutSeconds: BRIDGE_CELL_RING_SECONDS,
    }));
  } catch (e) {
    if (!isPermanentProviderError(e)) throw e;
    return fail(`carrier: ${e.code}`);
  }
  await executeCommand(
    ctx.db,
    callRecord,
    {
      workspaceId: scope.workspaceId,
      providerSid: sid,
      callId,
      direction: 'outbound',
      from: number.e164,
      to: c.toE164,
      status: 'ringing',
    },
    actor,
    meta,
  );
  // Cancelled while it was being placed (call.cancel_connect saw no carrier call to hang up yet): hang it up now.
  const [now] = await asWorker(ctx.db, scope, (tx) =>
    tx.select({ status: calls.status }).from(calls).where(eq(calls.id, callId)),
  );
  if (now?.status === 'canceled') await ctx.telephony.endCall(account, sid);
};

/** call.cancel_connect ended a call through someone's cell: hang the carrier's call up, whatever state it's in. */
export const onBridgeCancelled: EventHandler = async (ctx) => {
  if (!isUuid(ctx.event.entityId)) return;
  const scope = tenantOf(ctx.scope);
  const [c] = await ctx.tx
    .select({ providerSid: calls.providerSid, answeredVia: calls.answeredVia })
    .from(calls)
    .where(and(eq(calls.id, ctx.event.entityId), eq(calls.workspaceId, scope.workspaceId)));
  // Not placed yet: onBridgeRequested sees the cancel and never places it (or hangs it up once recorded).
  if (!c?.providerSid || c.answeredVia !== 'bridge') return;
  const account = await loadAccount(ctx.tx, scope.workspaceId, ctx.sealer);
  if (!account) return;
  await ctx.telephony.endCall(account, c.providerSid);
};

/** Someone set their cell: call it from the business number so they can press 1. */
export const onVerificationRequested: EventHandler = async (ctx) => {
  const payload = (ctx.event.payload ?? {}) as Record<string, unknown>;
  const userPhoneId = payload['userPhoneId'];
  if (!isUuid(userPhoneId)) return;
  const scope = tenantOf(ctx.scope);
  const [row] = await ctx.tx.select().from(userPhones).where(eq(userPhones.id, userPhoneId));
  // Gone (a different number took its place), already verified, or this request's call already placed.
  if (!row || row.verifiedAt) return;
  if (row.lastVerificationAt && row.lastVerificationAt >= ctx.event.createdAt) return;
  if (Date.now() - ctx.event.createdAt.getTime() > VERIFY_STALE_MS) return;
  const number = await liveNumber(ctx.tx, scope.workspaceId);
  const account = await loadAccount(ctx.tx, scope.workspaceId, ctx.sealer);
  if (!number || number.status !== 'active' || !account) {
    ctx.log.warn({ userPhoneId }, 'no business number to confirm a cell from');
    return;
  }
  const urls = voiceUrls(ctx.publicUrl);
  try {
    await ctx.telephony.placeCall(account, {
      from: number.e164,
      to: row.e164,
      answerUrl: urls.verify(row.id),
      statusCallbackUrl: urls.verifyStatus(row.id),
      timeoutSeconds: VERIFY_RING_SECONDS,
    });
  } catch (e) {
    if (!isPermanentProviderError(e)) throw e;
    // The carrier won't call that number: it still counts as one they asked for, and the app offers to try again.
    ctx.log.warn({ userPhoneId, code: e.code }, 'the carrier refused a verification call');
  }
  await executeCommand(
    ctx.db,
    userPhoneRecordCall,
    { workspaceId: scope.workspaceId, userPhoneId: row.id },
    systemActor(scope, row.userId),
    workerMeta(ctx.event.correlationId, ctx.event.id),
  );
};

/**
 * A recorded call's words are wanted: marked as on their way (so a repeated recording report doesn't ask twice, and the
 * app can say so), and `call.transcribe` asks the provider. Nothing here calls the provider, so storing the recording
 * never waits on (or fails with) the transcription service.
 */
export async function queueTranscript(
  tx: Tx,
  scope: TenantScope,
  call: { readonly id: string },
  recordingSid: string,
): Promise<void> {
  const [marked] = await tx
    .update(calls)
    .set({ transcriptStatus: 'pending' })
    .where(and(eq(calls.id, call.id), isNull(calls.transcriptStatus)))
    .returning({ id: calls.id });
  if (!marked) return;
  await scheduleJob(tx, {
    kind: CELL_JOBS.transcribe,
    dedupeKey: transcribeJobKey(call.id),
    runAt: new Date(),
    payload: { callId: call.id, recordingSid, askedAt: new Date().toISOString() },
    workspaceId: scope.workspaceId,
    organizationId: scope.organizationId,
  });
}

/** The provider said no to the request itself (not down, not busy): asking again won't change it. */
const refused = (e: unknown): e is ProviderError =>
  e instanceof ProviderError &&
  (e.permanent || e.httpStatus === 401 || e.httpStatus === 403 || e.httpStatus === 404);

/** A transcript job's call, and the account to ask with; null once the words are settled either way. */
async function transcriptTarget(ctx: JobContext, scope: TenantScope, callId: string) {
  const [call] = await asWorker(ctx.db, scope, (tx) =>
    tx
      .select()
      .from(calls)
      .where(and(eq(calls.id, callId), eq(calls.workspaceId, scope.workspaceId))),
  );
  if (!call || call.transcriptStatus === 'completed' || call.transcriptStatus === 'failed')
    return null;
  const account = await asWorker(ctx.db, scope, (tx) =>
    loadAccount(tx, scope.workspaceId, ctx.sealer),
  );
  if (!account) throw new Error('no telephony account for this workspace');
  return { call, account };
}

/** Attaches the words (or that there are none) and deletes the provider's copies: ours are what's kept. */
async function settleTranscript(
  ctx: JobContext,
  scope: TenantScope,
  account: ProviderAccount,
  callId: string,
  transcript: string | null,
  sids: { readonly recordingSid: string; readonly transcriptionSid?: string },
): Promise<void> {
  await executeCommand(
    ctx.db,
    callAttachTranscript,
    {
      workspaceId: scope.workspaceId,
      callId,
      transcript,
      status: transcript ? 'completed' : 'failed',
    },
    systemActor(scope),
    workerMeta(null, ctx.job.id),
  );
  try {
    if (sids.transcriptionSid)
      await ctx.telephony.deleteTranscription(account, sids.transcriptionSid);
    await ctx.telephony.deleteRecording(account, sids.recordingSid);
  } catch (e) {
    ctx.log.warn(
      { err: errorMessage(e) },
      'could not delete the provider copy of a call recording',
    );
  }
}

/**
 * Comes back a little later while the provider is still working (every 20 seconds, then every 2 minutes) or isn't
 * answering (every minute, then every 10), up to TRANSCRIPT_GIVE_UP_MS after the words were first wanted.
 */
const again = (
  ctx: JobContext,
  askedAt: number,
  why: 'working' | 'unreachable',
): { readonly rescheduleAt: Date } | null => {
  const waited = ctx.now - askedAt;
  if (waited >= TRANSCRIPT_GIVE_UP_MS) return null;
  const soon = waited < 10 * MIN;
  const ms = why === 'working' ? (soon ? 20_000 : 2 * MIN) : soon ? MIN : 10 * MIN;
  return { rescheduleAt: new Date(ctx.now + ms) };
};

const askedAtOf = (ctx: JobContext, p: Record<string, unknown>): number =>
  Date.parse(String(p['askedAt'] ?? '')) || ctx.job.createdAt.getTime();

/** `call.transcribe`: asks the provider for a recorded call's words, then `call.transcript` reads them back. */
export const callTranscribeJob: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const p = ctx.job.payload as Record<string, unknown>;
  const callId = p['callId'];
  const recordingSid = p['recordingSid'];
  if (!isUuid(callId) || typeof recordingSid !== 'string') return;
  const target = await transcriptTarget(ctx, scope, callId);
  if (!target) return;
  const askedAt = askedAtOf(ctx, p);
  let transcriptionSid: string;
  try {
    ({ transcriptionSid } = await ctx.telephony.transcribeRecording(target.account, recordingSid));
  } catch (e) {
    const later = refused(e) ? null : again(ctx, askedAt, 'unreachable');
    ctx.log.warn(
      { err: errorMessage(e), callId, giveUp: !later },
      later
        ? 'the provider could not take a call recording for transcription yet'
        : 'the provider would not transcribe a call recording (is Conversational Intelligence turned on?)',
    );
    if (later) return later;
    await settleTranscript(ctx, scope, target.account, callId, null, { recordingSid });
    return;
  }
  await asWorker(ctx.db, scope, (tx) =>
    scheduleJob(tx, {
      kind: CELL_JOBS.transcript,
      dedupeKey: transcriptJobKey(callId),
      runAt: new Date(ctx.now + 15_000),
      payload: {
        callId,
        recordingSid,
        transcriptionSid,
        askedAt: new Date(askedAt).toISOString(),
      },
      workspaceId: scope.workspaceId,
      organizationId: scope.organizationId,
    }),
  );
};

/** "Dale: … / Mike: …": the business's side is channel 1, the customer's channel 2. */
async function wordsOf(
  s: WorkerServices,
  scope: TenantScope,
  call: typeof calls.$inferSelect,
  sentences: readonly { readonly channel: number; readonly text: string }[],
): Promise<string | null> {
  const [names] = await asWorker(s.db, scope, (tx) =>
    rows<{ team: string | null; customer: string | null }>(
      tx,
      sql`select (select nullif(split_part(trim(full_name), ' ', 1), '') from app.users where id = ${call.placedBy}) as team,
            (select nullif(trim(first_name), '') from app.people where id = ${call.personId}) as customer`,
    ),
  );
  const team = names?.team ?? 'Team';
  const customer = names?.customer ?? 'Customer';
  const lines: { who: string; text: string }[] = [];
  for (const sentence of sentences) {
    const who = sentence.channel === 2 ? customer : team;
    const last = lines.at(-1);
    if (last?.who === who) last.text = `${last.text} ${sentence.text}`;
    else lines.push({ who, text: sentence.text });
  }
  const text = lines.map((l) => `${l.who}: ${l.text}`).join('\n');
  return text ? text.slice(0, TRANSCRIPT_MAX) : null;
}

/** `call.transcript`: a recorded call's words, once ready; then the provider's copies go. */
export const callTranscriptJob: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const p = ctx.job.payload as Record<string, unknown>;
  const callId = p['callId'];
  const transcriptionSid = p['transcriptionSid'];
  const recordingSid = p['recordingSid'];
  if (!isUuid(callId) || typeof transcriptionSid !== 'string' || typeof recordingSid !== 'string')
    return;
  const target = await transcriptTarget(ctx, scope, callId);
  if (!target) return;
  const askedAt = askedAtOf(ctx, p);
  const sids = { recordingSid, transcriptionSid };
  let state: TranscriptionState;
  try {
    state = await ctx.telephony.fetchTranscription(target.account, transcriptionSid);
  } catch (e) {
    const later = refused(e) ? null : again(ctx, askedAt, 'unreachable');
    ctx.log.warn(
      { err: errorMessage(e), callId, giveUp: !later },
      'could not read a call’s words from the provider',
    );
    if (later) return later;
    await settleTranscript(ctx, scope, target.account, callId, null, sids);
    return;
  }
  if (state.status === 'pending') {
    const later = again(ctx, askedAt, 'working');
    if (later) return later;
  }
  const transcript =
    state.status === 'completed' ? await wordsOf(ctx, scope, target.call, state.sentences) : null;
  await settleTranscript(ctx, scope, target.account, callId, transcript, sids);
};

export const cellJobs = {
  [CELL_JOBS.transcribe]: callTranscribeJob,
  [CELL_JOBS.transcript]: callTranscriptJob,
};
