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
