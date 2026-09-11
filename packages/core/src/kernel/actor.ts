import { HfosError } from '../errors';
import type { Actor, HumanActor } from './types';

/** The person a request is for: the signed-in human, or whoever a system actor works on behalf of. */
export function userIdOf(actor: Actor): string | null {
  return actor.type === 'human' ? actor.userId : (actor.onBehalfOf ?? null);
}

/** For handlers that only make sense for a signed-in person (human-only commands and every query). */
export function requireHuman(ctx: { readonly actor: Actor }): HumanActor {
  if (ctx.actor.type !== 'human')
    throw HfosError.forbidden('This action needs a signed-in person.');
  return ctx.actor;
}
