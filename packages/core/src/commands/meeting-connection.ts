/**
 * Meeting connections: each person links their own Zoom account, so HandsFreeOS can make a Zoom meeting for
 * their online appointments (HANDSFREEOS_MEETINGS_IMPLEMENTATION_PLAN.md). Built like calendar connections:
 * people start a sign-in and disconnect; signing in and tokens are the worker's (`activate` and `fail` run as
 * the system). Column grants keep sealed tokens and sign-in secrets out of what people read, so every select
 * here names its columns.
 */
import { createHash, randomBytes } from 'node:crypto';
import { and, desc, eq, inArray, ne, type SQL } from 'drizzle-orm';
import { appointments, appointmentTranscripts, meetingConnections, users } from '@hfos/db/schema';
import { z } from 'zod';
import { userNames } from '../calendar/load';
import { HfosError } from '../errors';
import { requireHuman } from '../kernel/actor';
import { defineCommand, defineQuery } from '../kernel/define';
import { scopeCan } from '../kernel/execute';
import type { CommandContext } from '../kernel/types';
import { email, isoDateTime, uuid } from '../schemas/common';
import { MEETING_SETTINGS_PROBLEMS } from '../meetings/settings';

export const MeetingProvider = z.enum(['zoom']);
export type MeetingProvider = z.infer<typeof MeetingProvider>;
const connectionStatus = z.enum(['pending', 'active', 'reauth_required', 'error', 'disconnected']);

/** How Settings names each provider. */
export const MEETING_PROVIDER_NAMES: Record<MeetingProvider, string> = { zoom: 'Zoom' };

const ConnectInput = z.object({ workspaceId: uuid, provider: MeetingProvider });
/** `state` goes to the worker's /oauth/<provider>/start once; only its hash is stored. */
const ConnectOutput = z.object({ connectionId: uuid, state: z.string() });
const RefInput = z.object({ workspaceId: uuid, connectionId: uuid });
const RefOutput = z.object({ connectionId: uuid });

// worker-only (system actor)
const ActivateInput = z.object({
  workspaceId: uuid,
  connectionId: uuid,
  accountEmail: email,
  externalUserId: z.string().trim().min(1).max(200),
  scopes: z.array(z.string().trim().min(1).max(200)).max(50),
  /** Sealed by the worker; stored as is and never echoed. */
  tokenEnc: z.string().min(1).max(20_000),
  tokenKeyId: z.string().trim().min(1).max(100),
  tokenExpiresAt: isoDateTime.nullable(),
});
const FailInput = z.object({
  workspaceId: uuid,
  connectionId: uuid,
  reason: z.enum(['reauth_required', 'error']),
  message: z.string().trim().min(1).max(2000),
});
const SystemOutput = z.object({
  connectionId: uuid,
  status: connectionStatus,
  changed: z.boolean(),
});

export const MeetingConnectionOut = z.object({
  id: uuid,
  userId: uuid,
  fullName: z.string(),
  provider: MeetingProvider,
  status: connectionStatus,
  accountEmail: z.string().nullable(),
  scopes: z.array(z.string()),
  failures: z.int(),
  lastError: z.string().nullable(),
  connectedAt: isoDateTime.nullable(),
  disconnectedAt: isoDateTime.nullable(),
  createdAt: isoDateTime,
  /** When the account's settings were last read, and what they mean for transcripts (`meetingSettingsWords`). */
  settingsCheckedAt: isoDateTime.nullable(),
  settingsProblems: z.array(z.string()),
});
const ListInput = z.object({
  workspaceId: uuid,
  /** Only this person's (anyone's needs calendars.manage; otherwise you see your own). */
  userId: uuid.optional(),
  includeDisconnected: z.boolean().default(false),
});
const ListOutput = z.object({ items: z.array(MeetingConnectionOut) });

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

/** How long a sign-in state stays good. */
const STATE_TTL_MS = 10 * 60_000;
/** One of these per person and provider per workspace at a time (a partial unique index). */
const LIVE = ['active', 'reauth_required', 'error'] as const;

const sha256Hex = (value: string) => createHash('sha256').update(value).digest('hex');

async function loadConnection(ctx: CommandContext, connectionId: string) {
  const [c] = await ctx.tx
    .select({
      id: meetingConnections.id,
      userId: meetingConnections.userId,
      provider: meetingConnections.provider,
      status: meetingConnections.status,
      accountEmail: meetingConnections.accountEmail,
    })
    .from(meetingConnections)
    .where(
      and(
        eq(meetingConnections.id, connectionId),
        eq(meetingConnections.workspaceId, ctx.scope.workspaceId!),
      ),
    );
  // People see their own connection; owners and admins see everyone's (RLS).
  if (!c)
    throw HfosError.notFound(
      'That Zoom account isn’t connected anymore. It may have been disconnected. Refresh and try again.',
    );
  return c;
}

export const meetingConnectionConnect = defineCommand({
  name: 'meeting_connection.connect',
  description:
    'Start connecting your own Zoom account, for video links on your online appointments. Returns a one-time state; the browser signs in to Zoom through the worker.',
  risk: 2,
  input: ConnectInput,
  output: ConnectOutput,
  permission: 'appointments.write',
  scope: inWorkspace,
  emits: ['meeting_connection.connect_started'],
  // The state is a one-time secret: never kept in a stored answer.
  shownOnce: ['state'],
  async handler(ctx, input) {
    const me = requireHuman(ctx);
    const state = randomBytes(32).toString('base64url');
    // Only a pending sign-in for yourself (the insert policy); RETURNING names a column people may read.
    const [row] = await ctx.tx
      .insert(meetingConnections)
      .values({
        workspaceId: ctx.scope.workspaceId!,
        userId: me.userId,
        provider: input.provider,
        status: 'pending',
        oauthStateHash: sha256Hex(state),
        oauthStateExpiresAt: new Date(Date.now() + STATE_TTL_MS),
        createdBy: me.userId,
      })
      .returning({ id: meetingConnections.id });
    if (!row) throw HfosError.forbidden();
    await ctx.emit({
      type: 'meeting_connection.connect_started',
      entityType: 'meeting_connection',
      entityId: row.id,
      payload: { provider: input.provider },
      after: { provider: input.provider },
      broadcast: false,
    });
    return { connectionId: row.id, state };
  },
});

export const meetingConnectionDisconnect = defineCommand({
  name: 'meeting_connection.disconnect',
  description:
    'Disconnect a Zoom account: your own, or anyone’s for owners and admins. HandsFreeOS forgets the sign-in; meetings it already made stay in Zoom.',
  risk: 2,
  input: RefInput,
  output: RefOutput,
  permission: 'appointments.write',
  scope: inWorkspace,
  emits: ['meeting_connection.disconnected'],
  async handler(ctx, input) {
    const me = requireHuman(ctx);
    const c = await loadConnection(ctx, input.connectionId);
    const own = c.userId === me.userId;
    if (!own && !scopeCan(ctx.scope, 'calendars.manage'))
      throw HfosError.forbidden(
        'You can only disconnect your own Zoom account. Ask an owner or admin of this business to disconnect someone else’s.',
      );
    if (c.status === 'disconnected') return { connectionId: c.id };
    // The update guard clears the sealed tokens and the sign-in secret.
    const [row] = await ctx.tx
      .update(meetingConnections)
      .set({ status: 'disconnected' })
      .where(eq(meetingConnections.id, c.id))
      .returning({ id: meetingConnections.id });
    if (!row) throw HfosError.forbidden();
    let person: string | null = null;
    if (!own) {
      const [u] = await ctx.tx
        .select({ fullName: users.fullName, email: users.email })
        .from(users)
        .where(eq(users.id, c.userId));
      person = u ? u.fullName || String(u.email) : null;
    }
    await ctx.emit({
      type: 'meeting_connection.disconnected',
      entityType: 'meeting_connection',
      entityId: c.id,
      payload: { provider: c.provider, userId: c.userId },
      before: { status: c.status },
      after: {
        account: c.accountEmail,
        provider: c.provider,
        status: 'disconnected',
        ...(person ? { person } : {}),
      },
    });
    return { connectionId: c.id };
  },
});

export const meetingConnectionActivate = defineCommand({
  name: 'meeting_connection.activate',
  description:
    'Worker: the person signed in to Zoom and their account is connected. It replaces their earlier Zoom connection in this workspace.',
  risk: 1,
  input: ActivateInput,
  output: SystemOutput,
  permission: 'appointments.write',
  scope: inWorkspace,
  emits: ['meeting_connection.connected', 'meeting_connection.disconnected'],
  actors: ['system'],
  async handler(ctx, input) {
    const c = await loadConnection(ctx, input.connectionId);
    if (c.status === 'active' && c.accountEmail === input.accountEmail)
      return { connectionId: c.id, status: 'active' as const, changed: false };
    if (c.status !== 'pending')
      throw HfosError.rule(
        'meeting_connection_not_pending',
        409,
        'This Zoom account is not waiting to connect.',
      );
    const now = new Date();
    // One live connection per person and provider: the earlier one steps down first.
    const replaced = await ctx.tx
      .update(meetingConnections)
      .set({ status: 'disconnected', disconnectedAt: now, tokenEnc: null, pkceVerifierEnc: null })
      .where(
        and(
          eq(meetingConnections.workspaceId, ctx.scope.workspaceId!),
          eq(meetingConnections.userId, c.userId),
          eq(meetingConnections.provider, c.provider),
          inArray(meetingConnections.status, [...LIVE]),
          ne(meetingConnections.id, c.id),
        ),
      )
      .returning({ id: meetingConnections.id, accountEmail: meetingConnections.accountEmail });
    for (const old of replaced)
      await ctx.emit({
        type: 'meeting_connection.disconnected',
        entityType: 'meeting_connection',
        entityId: old.id,
        payload: { provider: c.provider, userId: c.userId, replacedBy: c.id },
        after: { account: old.accountEmail, provider: c.provider, status: 'disconnected' },
      });
    await ctx.tx
      .update(meetingConnections)
      .set({
        status: 'active',
        accountEmail: input.accountEmail,
        externalUserId: input.externalUserId,
        scopes: input.scopes,
        tokenEnc: input.tokenEnc,
        tokenKeyId: input.tokenKeyId,
        tokenExpiresAt: input.tokenExpiresAt ? new Date(input.tokenExpiresAt) : null,
        connectedAt: now,
        disconnectedAt: null,
        oauthStateHash: null,
        oauthStateExpiresAt: null,
        pkceVerifierEnc: null,
        failures: 0,
        lastError: null,
      })
      .where(eq(meetingConnections.id, c.id));
    // Never the tokens: events, audit rows and the output carry whose account and which provider only.
    await ctx.emit({
      type: 'meeting_connection.connected',
      entityType: 'meeting_connection',
      entityId: c.id,
      payload: { provider: c.provider, userId: c.userId, replaced: replaced.map((r) => r.id) },
      before: { status: c.status },
      after: { account: input.accountEmail, provider: c.provider },
    });
    return { connectionId: c.id, status: 'active' as const, changed: true };
  },
});

export const meetingConnectionFail = defineCommand({
  name: 'meeting_connection.fail',
  description:
    'Worker: a connected Zoom account needs its person to sign in again, or keeps failing.',
  risk: 1,
  input: FailInput,
  output: SystemOutput,
  permission: 'appointments.write',
  scope: inWorkspace,
  emits: ['meeting_connection.reauth_required', 'meeting_connection.failed'],
  actors: ['system'],
  async handler(ctx, input) {
    const c = await loadConnection(ctx, input.connectionId);
    if (c.status === 'disconnected' || c.status === 'pending')
      return { connectionId: c.id, status: c.status, changed: false };
    await ctx.tx
      .update(meetingConnections)
      .set({ status: input.reason, lastError: input.message })
      .where(eq(meetingConnections.id, c.id));
    const changed = c.status !== input.reason;
    // Once per change: an account that keeps failing doesn't tell its person every time.
    if (changed)
      await ctx.emit({
        type:
          input.reason === 'reauth_required'
            ? 'meeting_connection.reauth_required'
            : 'meeting_connection.failed',
        entityType: 'meeting_connection',
        entityId: c.id,
        payload: { provider: c.provider, userId: c.userId, error: input.message },
        before: { status: c.status },
        after: {
          account: c.accountEmail,
          provider: c.provider,
          status: input.reason,
          error: input.message,
        },
      });
    return { connectionId: c.id, status: input.reason, changed };
  },
});

export const meetingConnectionCheckSettings = defineCommand({
  name: 'meeting_connection.check_settings',
  description:
    'Read your Zoom account’s recording and transcript settings again now (after changing them in Zoom).',
  risk: 1,
  input: RefInput,
  output: RefOutput,
  permission: 'appointments.write',
  scope: inWorkspace,
  emits: ['meeting_connection.settings_check_requested'],
  async handler(ctx, input) {
    const me = requireHuman(ctx);
    const c = await loadConnection(ctx, input.connectionId);
    if (c.userId !== me.userId)
      throw HfosError.forbidden(
        'You can only check your own Zoom settings. Ask them to press Check again in Settings → My calendar.',
      );
    if (c.status !== 'active' && c.status !== 'error')
      throw HfosError.rule(
        'meeting_connection_not_active',
        409,
        c.status === 'reauth_required'
          ? 'Zoom needs you to sign in again before its settings can be read. Press Reconnect in Settings → My calendar.'
          : 'This Zoom account isn’t connected, so its settings can’t be read. Connect Zoom in Settings → My calendar.',
      );
    // The worker reads them when it sees this.
    await ctx.emit({
      type: 'meeting_connection.settings_check_requested',
      entityType: 'meeting_connection',
      entityId: c.id,
      payload: { provider: c.provider },
      after: { account: c.accountEmail, provider: c.provider },
      broadcast: false,
    });
    return { connectionId: c.id };
  },
});

const RecordSettingsInput = z.object({
  workspaceId: uuid,
  connectionId: uuid,
  problems: z.array(z.enum(MEETING_SETTINGS_PROBLEMS)).max(20),
});

export const meetingConnectionRecordSettings = defineCommand({
  name: 'meeting_connection.record_settings',
  description:
    'Worker: what a connected Zoom account’s settings mean for transcripts, read just now.',
  risk: 1,
  input: RecordSettingsInput,
  output: SystemOutput,
  permission: 'appointments.write',
  scope: inWorkspace,
  emits: ['meeting_connection.settings_changed'],
  actors: ['system'],
  async handler(ctx, input) {
    const c = await loadConnection(ctx, input.connectionId);
    const [before] = await ctx.tx
      .select({ problems: meetingConnections.settingsProblems })
      .from(meetingConnections)
      .where(eq(meetingConnections.id, c.id));
    const problems = [...new Set(input.problems)];
    await ctx.tx
      .update(meetingConnections)
      .set({ settingsProblems: problems, settingsCheckedAt: new Date() })
      .where(eq(meetingConnections.id, c.id));
    const was = [...(before?.problems ?? [])].sort().join(',');
    const changed = was !== [...problems].sort().join(',');
    // Once per change: the daily read of unchanged settings tells nobody anything.
    if (changed)
      await ctx.emit({
        type: 'meeting_connection.settings_changed',
        entityType: 'meeting_connection',
        entityId: c.id,
        payload: { provider: c.provider, userId: c.userId, problems },
        before: { problems: before?.problems ?? [] },
        after: { account: c.accountEmail, provider: c.provider, problems },
      });
    return { connectionId: c.id, status: c.status, changed };
  },
});

export const meetingConnectionList = defineQuery({
  name: 'meeting_connection.list',
  description: 'Zoom connections: your own, or everyone’s for owners and admins.',
  input: ListInput,
  output: ListOutput,
  permission: 'workspace.read',
  scope: inWorkspace,
  async handler(ctx, input) {
    const conditions: SQL[] = [eq(meetingConnections.workspaceId, input.workspaceId)];
    if (input.userId) conditions.push(eq(meetingConnections.userId, input.userId));
    if (!input.includeDisconnected) conditions.push(ne(meetingConnections.status, 'disconnected'));
    // Row-level security shows people their own; owners and admins see everyone's.
    const list = await ctx.tx
      .select({
        id: meetingConnections.id,
        userId: meetingConnections.userId,
        provider: meetingConnections.provider,
        status: meetingConnections.status,
        accountEmail: meetingConnections.accountEmail,
        scopes: meetingConnections.scopes,
        failures: meetingConnections.failures,
        lastError: meetingConnections.lastError,
        connectedAt: meetingConnections.connectedAt,
        disconnectedAt: meetingConnections.disconnectedAt,
        createdAt: meetingConnections.createdAt,
        settingsCheckedAt: meetingConnections.settingsCheckedAt,
        settingsProblems: meetingConnections.settingsProblems,
      })
      .from(meetingConnections)
      .where(and(...conditions))
      .orderBy(desc(meetingConnections.createdAt));
    const names = await userNames(
      ctx.tx,
      list.map((c) => c.userId),
    );
    return {
      items: list.map((c) => ({
        ...c,
        fullName: names.get(c.userId) ?? 'Someone',
        connectedAt: c.connectedAt?.toISOString() ?? null,
        disconnectedAt: c.disconnectedAt?.toISOString() ?? null,
        createdAt: c.createdAt.toISOString(),
        settingsCheckedAt: c.settingsCheckedAt?.toISOString() ?? null,
      })),
    };
  },
});

const TranscriptListInput = z.object({ workspaceId: uuid, appointmentId: uuid });
const TranscriptListOutput = z.object({
  items: z.array(
    z.object({ id: uuid, provider: z.string(), createdAt: isoDateTime, body: z.string() }),
  ),
});

export const appointmentTranscriptList = defineQuery({
  name: 'appointment.transcripts',
  description: 'What was said on an appointment’s recorded calls, newest first.',
  input: TranscriptListInput,
  output: TranscriptListOutput,
  permission: 'workspace.read',
  scope: inWorkspace,
  async handler(ctx, input) {
    // Row-level security shows transcripts only for appointments the person can see.
    const [appt] = await ctx.tx
      .select({ id: appointments.id })
      .from(appointments)
      .where(
        and(
          eq(appointments.id, input.appointmentId),
          eq(appointments.workspaceId, input.workspaceId),
        ),
      );
    if (!appt)
      throw HfosError.notFound(
        'That appointment isn’t there anymore. It may have been deleted. Refresh and try again.',
      );
    const list = await ctx.tx
      .select({
        id: appointmentTranscripts.id,
        provider: appointmentTranscripts.provider,
        createdAt: appointmentTranscripts.createdAt,
        body: appointmentTranscripts.body,
      })
      .from(appointmentTranscripts)
      .where(eq(appointmentTranscripts.appointmentId, appt.id))
      .orderBy(desc(appointmentTranscripts.createdAt));
    return { items: list.map((t) => ({ ...t, createdAt: t.createdAt.toISOString() })) };
  },
});

/** In the order the docs list them; the registry spreads this in. */
export const meetingConnectionCommands = [
  meetingConnectionConnect,
  meetingConnectionDisconnect,
  meetingConnectionActivate,
  meetingConnectionFail,
  meetingConnectionCheckSettings,
  meetingConnectionRecordSettings,
] as const;
