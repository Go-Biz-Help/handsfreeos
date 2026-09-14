import { HfosError } from '../errors';
import type { Actor, HumanActor, MachineActor } from './types';

/**
 * The system or a workflow: nobody signed in behind the request. The kernel runs them as root within their
 * own workspace (the service_actor policies) with no permission check, and they can never give a person's
 * say-so (confirming a text in quiet hours).
 */
export function isMachine(actor: Actor): actor is MachineActor {
  return actor.type !== 'human';
}

/**
 * The person a request is for: the signed-in human, or whoever a system actor works on behalf of. A workflow
 * works for the business, not for a person: null.
 */
export function userIdOf(actor: Actor): string | null {
  if (actor.type === 'human') return actor.userId;
  return actor.type === 'system' ? (actor.onBehalfOf ?? null) : null;
}

/** For handlers that only make sense for a signed-in person (human-only commands and every query). */
export function requireHuman(ctx: { readonly actor: Actor }): HumanActor {
  if (ctx.actor.type !== 'human')
    throw HfosError.forbidden('This action needs a signed-in person.');
  return ctx.actor;
}
