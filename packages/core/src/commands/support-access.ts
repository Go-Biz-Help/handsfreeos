/**
 * HandsFreeOS support let into a business's private records (Real Estate, step 4). A support look (M13) sees no record
 * kept to its people; support asks from their look, or someone here lets them in unasked, and for 24 hours (or until
 * ended) the look also shows what the person who let them in sees, read-only. Owners and admins, and the main person
 * on any private record, may let support in, answer a request, and end what they gave; owners and admins may end
 * any. The database decides every one of those (`private.grant_support_access` and its siblings).
 */
import { rows, sql } from '@hfos/db/client';
import { HfosError } from '../errors';
import { requireHuman } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import {
  SupportAccessDeclineInput,
  SupportAccessDoneOutput,
  SupportAccessEndInput,
  SupportAccessGrantInput,
  SupportAccessGrantOutput,
  SupportAccessRequestInput,
  SupportAccessRequestOutput,
} from '../schemas/support-access';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

/** Support, from their look at a business: platform-scoped, since a look changes nothing in the business itself. */
export const supportAccessRequest = defineCommand({
  name: 'support_access.request',
  description:
    'Support: ask a business to let you see its private records (its deals) from your look at it, for 24 hours. Its owners and admins are emailed.',
  risk: 2,
  input: SupportAccessRequestInput,
  output: SupportAccessRequestOutput,
  permission: 'platform.view_as',
  scope: () => ({ kind: 'platform' as const }),
  emits: ['support_access.requested'],
  async handler(ctx, input) {
    const [row] = await rows<{ id: string }>(
      ctx.tx,
      sql`select private.request_support_access(${input.workspaceId}::uuid, ${input.note}) as id`,
    );
    if (!row) throw HfosError.internal();
    await ctx.emit({
      type: 'support_access.requested',
      entityType: 'workspace',
      entityId: input.workspaceId,
      payload: {
        workspaceId: input.workspaceId,
        requestId: row.id,
        note: input.note,
        by: requireHuman(ctx).userId,
      },
    });
    return { requestId: row.id };
  },
});

export const supportAccessGrant = defineCommand({
  name: 'support_access.grant',
  description:
    'Let HandsFreeOS support see the private records you see (your deals), read-only, for 24 hours: answering their request, or unasked.',
  risk: 3,
  input: SupportAccessGrantInput,
  output: SupportAccessGrantOutput,
  permission: 'records.read',
  scope: inWorkspace,
  emits: ['support_access.granted'],
  async handler(ctx, input) {
    const [row] = await rows<{ id: string; expires_at: string }>(
      ctx.tx,
      sql`select id, expires_at::text from private.grant_support_access(${input.workspaceId}::uuid,
            ${input.requestId ?? null}::uuid)`,
    );
    if (!row) throw HfosError.internal();
    const expiresAt = new Date(row.expires_at).toISOString();
    await ctx.emit({
      type: 'support_access.granted',
      entityType: 'workspace',
      entityId: input.workspaceId,
      payload: { grantId: row.id, requestId: input.requestId ?? null, expiresAt },
    });
    return { grantId: row.id, expiresAt };
  },
});

export const supportAccessDecline = defineCommand({
  name: 'support_access.decline',
  description: 'Say no to HandsFreeOS support’s request to see this business’s private records.',
  risk: 1,
  input: SupportAccessDeclineInput,
  output: SupportAccessDoneOutput,
  permission: 'records.read',
  scope: inWorkspace,
  emits: ['support_access.declined'],
  async handler(ctx, input) {
    await rows(
      ctx.tx,
      sql`select private.decline_support_access(${input.workspaceId}::uuid, ${input.requestId}::uuid)`,
    );
    await ctx.emit({
      type: 'support_access.declined',
      entityType: 'workspace',
      entityId: input.workspaceId,
      payload: { requestId: input.requestId },
    });
    return { id: input.requestId };
  },
});

export const supportAccessEnd = defineCommand({
  name: 'support_access.end',
  description: 'End HandsFreeOS support’s access to this business’s private records now.',
  risk: 1,
  input: SupportAccessEndInput,
  output: SupportAccessDoneOutput,
  permission: 'records.read',
  scope: inWorkspace,
  emits: ['support_access.ended'],
  async handler(ctx, input) {
    await rows(
      ctx.tx,
      sql`select private.end_support_access(${input.workspaceId}::uuid, ${input.grantId}::uuid)`,
    );
    await ctx.emit({
      type: 'support_access.ended',
      entityType: 'workspace',
      entityId: input.workspaceId,
      payload: { grantId: input.grantId },
    });
    return { id: input.grantId };
  },
});

export const supportAccessCommands = [
  supportAccessRequest,
  supportAccessGrant,
  supportAccessDecline,
  supportAccessEnd,
];
