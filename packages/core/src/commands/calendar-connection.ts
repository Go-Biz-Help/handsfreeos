/**
 * Calendar connections: each person links their own Google or Outlook calendar. HandsFreeOS reads the times
 * they're busy there (never what the events are) so nobody is double-booked, and adds their HandsFreeOS
 * appointments to it as events. People start a sign-in, ask for a sync and disconnect; signing in, tokens and
 * syncing are the worker's (`activate` and `fail` run as the system). Column grants keep sealed tokens and
 * sign-in secrets out of what people read, so every select here names its columns.
 */
import { createHash, randomBytes } from 'node:crypto';
import { and, eq, inArray, ne } from 'drizzle-orm';
import { calendarConnections, users } from '@hfos/db/schema';
import { z } from 'zod';
import { HfosError } from '../errors';
import { requireHuman } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import type { CommandContext } from '../kernel/types';
import { hasWorkspacePermission } from '../permissions';
import { email, isoDateTime, uuid } from '../schemas/common';

const calendarProvider = z.enum(['google', 'microsoft']);
const connectionStatus = z.enum(['pending', 'active', 'reauth_required', 'error', 'disconnected']);

const ConnectInput = z.object({ workspaceId: uuid, provider: calendarProvider });
/** `state` goes to the worker's /oauth/<provider>/start once; only its hash is stored. */
const ConnectOutput = z.object({ connectionId: uuid, state: z.string() });
const RefInput = z.object({ workspaceId: uuid, connectionId: uuid });
const RefOutput = z.object({ connectionId: uuid });

// worker-only (system actor)
const ActivateInput = z.object({
  workspaceId: uuid,
  connectionId: uuid,
  accountEmail: email,
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

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

/** How long a calendar sign-in state stays good. */
const STATE_TTL_MS = 10 * 60_000;
/** One of these per person per workspace at a time (a partial unique index). */
const LIVE = ['active', 'reauth_required', 'error'] as const;
const sha256Hex = (value: string) => createHash('sha256').update(value).digest('hex');

async function loadConnection(ctx: CommandContext, connectionId: string) {
  const [c] = await ctx.tx
    .select({
      id: calendarConnections.id,
      userId: calendarConnections.userId,
      provider: calendarConnections.provider,
      status: calendarConnections.status,
      accountEmail: calendarConnections.accountEmail,
    })
    .from(calendarConnections)
    .where(
      and(
        eq(calendarConnections.id, connectionId),
        eq(calendarConnections.workspaceId, ctx.scope.workspaceId!),
      ),
    );
  // People see their own connection; owners and admins see everyone's (RLS).
  if (!c) throw HfosError.notFound('Calendar connection not found.');
  return c;
}

/** Whose calendar it is, for the audit log when someone else disconnects it. */
async function personName(ctx: CommandContext, userId: string): Promise<string | null> {
  const [u] = await ctx.tx
    .select({ fullName: users.fullName, email: users.email })
    .from(users)
    .where(eq(users.id, userId));
  return u ? u.fullName || String(u.email) : null;
}

export const calendarConnectionConnect = defineCommand({
  name: 'calendar_connection.connect',
  description:
    'Start connecting your own Google or Outlook calendar. Returns a one-time state; the browser signs in to Google or Microsoft through the worker.',
  risk: 2,
  input: ConnectInput,
  output: ConnectOutput,
  permission: 'appointments.write',
  scope: inWorkspace,
  emits: ['calendar_connection.connect_started'],
  async handler(ctx, input) {
    const me = requireHuman(ctx);
    const state = randomBytes(32).toString('base64url');
    // Only a pending sign-in for yourself (the insert policy); RETURNING names a column people may read.
    const [row] = await ctx.tx
      .insert(calendarConnections)
      .values({
        workspaceId: ctx.scope.workspaceId!,
        userId: me.userId,
        provider: input.provider,
        status: 'pending',
        oauthStateHash: sha256Hex(state),
        oauthStateExpiresAt: new Date(Date.now() + STATE_TTL_MS),
        createdBy: me.userId,
      })
      .returning({ id: calendarConnections.id });
    if (!row) throw HfosError.forbidden();
    await ctx.emit({
      type: 'calendar_connection.connect_started',
      entityType: 'calendar_connection',
      entityId: row.id,
      payload: { provider: input.provider },
      after: { provider: input.provider },
      broadcast: false,
    });
    return { connectionId: row.id, state };
  },
});

export const calendarConnectionDisconnect = defineCommand({
  name: 'calendar_connection.disconnect',
  description:
    'Disconnect a Google or Outlook calendar: your own, or anyone’s for owners and admins. HandsFreeOS forgets the sign-in and stops reading busy times; events it already added stay in that calendar.',
  risk: 2,
  input: RefInput,
  output: RefOutput,
  permission: 'appointments.write',
  scope: inWorkspace,
  emits: ['calendar_connection.disconnected'],
  async handler(ctx, input) {
    const me = requireHuman(ctx);
    const c = await loadConnection(ctx, input.connectionId);
    const own = c.userId === me.userId;
    if (!own && !hasWorkspacePermission(ctx.scope.workspaceRole, 'calendars.manage'))
      throw HfosError.forbidden('You can only disconnect your own calendar.');
    if (c.status === 'disconnected') return { connectionId: c.id };
    // The update guard clears the sealed tokens, the sign-in secret and the refresh schedule, and a trigger
    // removes the busy times, so the calendar stops blocking time at once.
    const [row] = await ctx.tx
      .update(calendarConnections)
      .set({ status: 'disconnected' })
      .where(eq(calendarConnections.id, c.id))
      .returning({ id: calendarConnections.id });
    if (!row) throw HfosError.forbidden();
    const person = own ? null : await personName(ctx, c.userId);
    await ctx.emit({
      type: 'calendar_connection.disconnected',
      entityType: 'calendar_connection',
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

export const calendarConnectionSyncNow = defineCommand({
  name: 'calendar_connection.sync_now',
  description:
    'Read your connected calendar’s busy times now instead of waiting for the next check (every 10 minutes).',
  risk: 1,
  input: RefInput,
  output: RefOutput,
  permission: 'appointments.write',
  scope: inWorkspace,
  emits: ['calendar_connection.sync_requested'],
  async handler(ctx, input) {
    const me = requireHuman(ctx);
    const c = await loadConnection(ctx, input.connectionId);
    if (c.userId !== me.userId) throw HfosError.forbidden('You can only sync your own calendar.');
    if (c.status !== 'active' && c.status !== 'error')
      throw HfosError.rule(
        'calendar_connection_not_active',
        409,
        'Only a connected calendar can sync. Reconnect it first.',
      );
    // The worker brings the refresh forward when it sees this.
    await ctx.emit({
      type: 'calendar_connection.sync_requested',
      entityType: 'calendar_connection',
      entityId: c.id,
      payload: { provider: c.provider },
      after: { account: c.accountEmail, provider: c.provider },
      broadcast: false,
    });
    return { connectionId: c.id };
  },
});

export const calendarConnectionActivate = defineCommand({
  name: 'calendar_connection.activate',
  description:
    'Worker: the person signed in to Google or Microsoft and their calendar is connected. It replaces their earlier connection in this workspace.',
  risk: 1,
  input: ActivateInput,
  output: SystemOutput,
  permission: 'appointments.write',
  scope: inWorkspace,
  emits: ['calendar_connection.connected', 'calendar_connection.disconnected'],
  actors: ['system'],
  async handler(ctx, input) {
    const c = await loadConnection(ctx, input.connectionId);
    if (c.status === 'active' && c.accountEmail === input.accountEmail)
      return { connectionId: c.id, status: 'active' as const, changed: false };
    if (c.status !== 'pending')
      throw HfosError.rule(
        'calendar_connection_not_pending',
        409,
        'This calendar is not waiting to connect.',
      );
    const now = new Date();
    // One live connection per person: the earlier one steps down first (a trigger clears its busy times).
    const replaced = await ctx.tx
      .update(calendarConnections)
      .set({
        status: 'disconnected',
        disconnectedAt: now,
        tokenEnc: null,
        pkceVerifierEnc: null,
        nextSyncAt: null,
      })
      .where(
        and(
          eq(calendarConnections.workspaceId, ctx.scope.workspaceId!),
          eq(calendarConnections.userId, c.userId),
          inArray(calendarConnections.status, [...LIVE]),
          ne(calendarConnections.id, c.id),
        ),
      )
      .returning({
        id: calendarConnections.id,
        provider: calendarConnections.provider,
        accountEmail: calendarConnections.accountEmail,
      });
    for (const old of replaced)
      await ctx.emit({
        type: 'calendar_connection.disconnected',
        entityType: 'calendar_connection',
        entityId: old.id,
        payload: { provider: old.provider, userId: c.userId, replacedBy: c.id },
        after: { account: old.accountEmail, provider: old.provider, status: 'disconnected' },
      });
    await ctx.tx
      .update(calendarConnections)
      .set({
        status: 'active',
        accountEmail: input.accountEmail,
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
        nextSyncAt: now,
      })
      .where(eq(calendarConnections.id, c.id));
    // Never the tokens: events, audit rows and the output carry whose calendar and which provider only.
    await ctx.emit({
      type: 'calendar_connection.connected',
      entityType: 'calendar_connection',
      entityId: c.id,
      payload: { provider: c.provider, userId: c.userId, replaced: replaced.map((r) => r.id) },
      before: { status: c.status },
      after: { account: input.accountEmail, provider: c.provider },
    });
    return { connectionId: c.id, status: 'active' as const, changed: true };
  },
});

export const calendarConnectionFail = defineCommand({
  name: 'calendar_connection.fail',
  description:
    'Worker: a connected calendar needs its person to sign in again, or keeps failing to sync.',
  risk: 1,
  input: FailInput,
  output: SystemOutput,
  permission: 'appointments.write',
  scope: inWorkspace,
  emits: ['calendar_connection.reauth_required', 'calendar_connection.failed'],
  actors: ['system'],
  async handler(ctx, input) {
    const c = await loadConnection(ctx, input.connectionId);
    if (c.status === 'disconnected' || c.status === 'pending')
      return { connectionId: c.id, status: c.status, changed: false };
    await ctx.tx
      .update(calendarConnections)
      .set({
        status: input.reason,
        lastError: input.message,
        // Waiting on a reconnect: nothing is scheduled until the person signs in again.
        ...(input.reason === 'reauth_required' ? { nextSyncAt: null } : {}),
      })
      .where(eq(calendarConnections.id, c.id));
    const changed = c.status !== input.reason;
    // Once per change: a calendar that keeps failing doesn't email its person on every refresh.
    if (changed)
      await ctx.emit({
        type:
          input.reason === 'reauth_required'
            ? 'calendar_connection.reauth_required'
            : 'calendar_connection.failed',
        entityType: 'calendar_connection',
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

/** In the order the docs list them; the registry spreads this in. */
export const calendarConnectionCommands = [
  calendarConnectionConnect,
  calendarConnectionDisconnect,
  calendarConnectionSyncNow,
  calendarConnectionActivate,
  calendarConnectionFail,
] as const;
