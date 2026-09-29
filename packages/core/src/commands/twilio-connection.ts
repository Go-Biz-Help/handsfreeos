/**
 * A Twilio account a business connected so its numbers can be brought in (20261010000900).
 *
 * **The worker's commands, on a person's behalf.** Connecting means signing in to Twilio with what they gave us
 * and sealing it with the worker's key, and letting go means wiping that seal — neither is something a person's
 * own database role may write (`app.twilio_connections` grants them no write at all). So the worker's routes ask
 * the permission question (the organization's owners and admins) and then run these as the system, on behalf of
 * the person, which is what puts their name on the audit line.
 *
 * Nothing here ever carries the secret itself, and nothing emitted says more than which account.
 */
import { and, eq } from 'drizzle-orm';
import { twilioConnections } from '@hfos/db/schema';
import { HfosError } from '../errors';
import { userIdOf } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import {
  TwilioConnectionDisconnectInput,
  TwilioConnectionFailInput,
  TwilioConnectionRefOutput,
  TwilioConnectionSaveInput,
} from '../schemas/number-import';

const inOrganization = (i: { organizationId: string }) => ({
  kind: 'organization' as const,
  organizationId: i.organizationId,
});

export const twilioConnectionSave = defineCommand({
  name: 'twilio_connection.save',
  description:
    'Worker: a Twilio account was connected (or connected again) with credentials Twilio accepted.',
  risk: 2,
  input: TwilioConnectionSaveInput,
  output: TwilioConnectionRefOutput,
  permission: null,
  scope: inOrganization,
  emits: ['twilio_connection.connected'],
  actors: ['system'],
  async handler(ctx, input) {
    const values = {
      friendlyName: input.friendlyName,
      apiKeySid: input.apiKeySid,
      secretEnc: input.secretEnc,
      keyId: input.keyId,
      status: 'active' as const,
      lastError: null,
      checkedAt: new Date(),
    };
    const [row] = await ctx.tx
      .insert(twilioConnections)
      .values({
        organizationId: input.organizationId,
        accountSid: input.accountSid,
        createdBy: userIdOf(ctx.actor),
        ...values,
      })
      .onConflictDoUpdate({
        target: [twilioConnections.organizationId, twilioConnections.accountSid],
        set: values,
      })
      .returning({ id: twilioConnections.id });
    await ctx.emit({
      type: 'twilio_connection.connected',
      entityType: 'twilio_connection',
      entityId: row!.id,
      payload: { accountSid: input.accountSid },
      after: {
        account: input.accountSid,
        ...(input.friendlyName ? { name: input.friendlyName } : {}),
        with: input.apiKeySid ? 'an API key' : 'the auth token',
      },
    });
    return { connectionId: row!.id };
  },
});

export const twilioConnectionDisconnect = defineCommand({
  name: 'twilio_connection.disconnect',
  description:
    'Worker: let a connected Twilio account go. Its saved credentials are wiped; numbers already on their way keep coming.',
  risk: 2,
  input: TwilioConnectionDisconnectInput,
  output: TwilioConnectionRefOutput,
  permission: null,
  scope: inOrganization,
  emits: ['twilio_connection.disconnected'],
  actors: ['system'],
  async handler(ctx, input) {
    const [row] = await ctx.tx
      .update(twilioConnections)
      .set({ status: 'disconnected', secretEnc: null, keyId: null })
      .where(
        and(
          eq(twilioConnections.id, input.connectionId),
          eq(twilioConnections.organizationId, input.organizationId),
        ),
      )
      .returning({ id: twilioConnections.id, accountSid: twilioConnections.accountSid });
    if (!row)
      throw HfosError.notFound(
        'That Twilio account isn’t connected to this business anymore. Refresh the page to see what’s connected.',
      );
    await ctx.emit({
      type: 'twilio_connection.disconnected',
      entityType: 'twilio_connection',
      entityId: row.id,
      payload: { accountSid: row.accountSid },
      after: { account: row.accountSid },
    });
    return { connectionId: row.id };
  },
});

export const twilioConnectionFail = defineCommand({
  name: 'twilio_connection.fail',
  description: 'Worker: Twilio stopped accepting a connected account’s credentials.',
  risk: 1,
  input: TwilioConnectionFailInput,
  output: TwilioConnectionRefOutput,
  permission: null,
  scope: inOrganization,
  emits: ['twilio_connection.broken'],
  actors: ['system'],
  async handler(ctx, input) {
    const [row] = await ctx.tx
      .update(twilioConnections)
      .set({ status: 'broken', lastError: input.reason, checkedAt: new Date() })
      .where(
        and(
          eq(twilioConnections.id, input.connectionId),
          eq(twilioConnections.organizationId, input.organizationId),
        ),
      )
      .returning({ id: twilioConnections.id, accountSid: twilioConnections.accountSid });
    if (!row)
      throw HfosError.notFound(
        'That Twilio account isn’t connected to this business anymore. Refresh the page to see what’s connected.',
      );
    await ctx.emit({
      type: 'twilio_connection.broken',
      entityType: 'twilio_connection',
      entityId: row.id,
      payload: { accountSid: row.accountSid },
      after: { account: row.accountSid, why: input.reason },
    });
    return { connectionId: row.id };
  },
});

export const twilioConnectionCommands = [
  twilioConnectionSave,
  twilioConnectionDisconnect,
  twilioConnectionFail,
];
