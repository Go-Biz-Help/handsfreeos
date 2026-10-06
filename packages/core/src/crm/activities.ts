import { activities } from '@hfos/db/schema';
import type { Actor, CommandContext } from '../kernel/types';
import { storedActorType, userIdOf } from '../kernel/actor';
import { changeMoment } from '../kernel/moment';

export interface SystemActivityInput {
  readonly subtype: string;
  readonly personId?: string | null;
  readonly companyId?: string | null;
  readonly leadId?: string | null;
  /** A record of a kind the business made up: a pet, a vehicle, a property (0101). */
  readonly customRecordId?: string | null;
  readonly body?: string | null;
  readonly meta?: Record<string, unknown>;
  /** The event this entry mirrors (unique per activity). */
  readonly eventId?: string | null;
  /** Left out, when the change was made (a phone's moment, or now). */
  readonly occurredAt?: Date;
}

export interface ChannelActivityInput {
  readonly kind: 'sms' | 'email' | 'call' | 'chat' | 'portal' | 'messenger' | 'instagram';
  /** The record it's about (a portal message's deal), so a private record's line is sealed with it. */
  readonly customRecordId?: string | null;
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
 * What a timeline entry records about who wrote it, when that isn't a person: whose request the system
 * fulfilled (`onBehalfOf`, shown as "Import"), which workflow run did it (`workflow`, shown as
 * "Workflow: <name>" and linking to the run), the AI teammate (`aiTeammate`, shown as "Ava (AI)", with
 * "approved by Chris" when a person's OK sent it), or the customer in their portal (`portal`). People's own entries
 * carry nothing extra.
 */
export function actorMeta(actor: Actor): Record<string, unknown> {
  switch (actor.type) {
    case 'system':
      return {
        onBehalfOf: userIdOf(actor),
        // The Action Center acting on its own ("HandsFreeOS"), and the item it was for.
        ...(actor.via
          ? { actionCenter: { itemId: actor.via.itemId, itemKind: actor.via.itemKind } }
          : {}),
      };
    case 'workflow':
      return { workflow: { id: actor.workflowId, name: actor.workflowName, runId: actor.runId } };
    case 'ai_employee':
      return {
        aiTeammate: {
          id: actor.teammateId,
          name: actor.teammateName,
          runId: actor.runId,
          approvedBy: actor.approvedBy,
        },
      };
    // The customer, in their own portal: their name leads the line.
    case 'customer':
      return { portal: { personId: actor.personId } };
    // Someone on one of the business's public pages: which page's site they used.
    case 'public':
      return { publicPage: { site: actor.site } };
    default:
      return {};
  }
}

/**
 * The timeline entry for a text, email or call. Written by whoever acted: a person (their own entry), or the
 * worker or a workflow (an entry on the customer's behalf). Conversations without a customer yet get none;
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
      ...(input.customRecordId ? { customRecordId: input.customRecordId } : {}),
      body: input.body ?? null,
      occurredAt: input.occurredAt ?? new Date(),
      authorUserId:
        input.authorUserId !== undefined
          ? input.authorUserId
          : ctx.actor.type === 'human'
            ? ctx.actor.userId
            : null,
      actorType: storedActorType(ctx.actor),
      eventId: input.eventId ?? null,
      meta: { ...(input.meta ?? {}), ...actorMeta(ctx.actor) },
    })
    .returning({ id: activities.id });
  return row?.id ?? null;
}

/**
 * Writes the timeline entry for a change, in the same transaction as the change and its event. It happened when the
 * change was made: on a phone with no signal, that can be well before it arrived.
 */
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
      customRecordId: input.customRecordId ?? null,
      body: input.body ?? null,
      occurredAt: input.occurredAt ?? changeMoment(ctx.meta),
      authorUserId: ctx.actor.type === 'human' ? ctx.actor.userId : null,
      actorType: storedActorType(ctx.actor),
      eventId: input.eventId ?? null,
      meta: { ...(input.meta ?? {}), ...actorMeta(ctx.actor) },
    })
    .returning({ id: activities.id });
  return row!.id;
}
