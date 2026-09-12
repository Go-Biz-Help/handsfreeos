import { activities } from '@hfos/db/schema';
import type { CommandContext } from '../kernel/types';
import { userIdOf } from '../kernel/actor';

export interface SystemActivityInput {
  readonly subtype: string;
  readonly personId?: string | null;
  readonly companyId?: string | null;
  readonly leadId?: string | null;
  readonly body?: string | null;
  readonly meta?: Record<string, unknown>;
  /** The event this entry mirrors (unique per activity). */
  readonly eventId?: string | null;
  readonly occurredAt?: Date;
}

export interface ChannelActivityInput {
  readonly kind: 'sms' | 'email' | 'call';
  /** inbound / outbound for texts and email; answered / missed / voicemail / outbound for calls. */
  readonly subtype: string;
  readonly personId: string | null;
  readonly body?: string | null;
  readonly occurredAt?: Date;
  readonly meta?: Record<string, unknown>;
  readonly eventId?: string | null;
  /** Credit someone other than the actor (the worker settles a call a teammate placed). */
  readonly authorUserId?: string | null;
}

/**
 * The timeline entry for a text, email or call. Written by whoever acted: a person (their own entry) or
 * the worker (a system entry on the customer's behalf). Conversations without a customer yet get none;
 * linking the conversation later backfills them.
 */
export async function logChannelActivity(
  ctx: CommandContext,
  input: ChannelActivityInput,
): Promise<string | null> {
  if (!input.personId) return null;
  const [row] = await ctx.tx
    .insert(activities)
    .values({
      workspaceId: ctx.scope.workspaceId!,
      kind: input.kind,
      subtype: input.subtype,
      personId: input.personId,
      body: input.body ?? null,
      occurredAt: input.occurredAt ?? new Date(),
      authorUserId:
        input.authorUserId !== undefined
          ? input.authorUserId
          : ctx.actor.type === 'human'
            ? ctx.actor.userId
            : null,
      actorType: ctx.actor.type,
      eventId: input.eventId ?? null,
      meta: {
        ...(input.meta ?? {}),
        ...(ctx.actor.type === 'system' ? { onBehalfOf: userIdOf(ctx.actor) } : {}),
      },
    })
    .returning({ id: activities.id });
  return row?.id ?? null;
}

/** Writes the timeline entry for a change, in the same transaction as the change and its event. */
export async function logSystemActivity(
  ctx: CommandContext,
  input: SystemActivityInput,
): Promise<string> {
  const [row] = await ctx.tx
    .insert(activities)
    .values({
      workspaceId: ctx.scope.workspaceId!,
      kind: 'system',
      subtype: input.subtype,
      personId: input.personId ?? null,
      companyId: input.companyId ?? null,
      leadId: input.leadId ?? null,
      body: input.body ?? null,
      occurredAt: input.occurredAt ?? new Date(),
      authorUserId: ctx.actor.type === 'human' ? ctx.actor.userId : null,
      actorType: ctx.actor.type,
      eventId: input.eventId ?? null,
      meta: {
        ...(input.meta ?? {}),
        ...(ctx.actor.type === 'system' ? { onBehalfOf: userIdOf(ctx.actor) } : {}),
      },
    })
    .returning({ id: activities.id });
  return row!.id;
}
