import { HfosError } from '../errors';
import type { Actor, AiEmployeeActor, HumanActor, MachineActor } from './types';

/**
 * The system, a workflow or the AI teammate: nobody signed in behind the request. The kernel runs them as
 * root within their own workspace (the service_actor policies) with no permission check, and they can never
 * give a person's say-so (confirming a text in quiet hours).
 */
export function isMachine(actor: Actor): actor is MachineActor {
  return actor.type !== 'human';
}

/**
 * The person a request is for: the signed-in human, or whoever a system actor works on behalf of. A workflow
 * works for the business, not for a person, and the AI teammate is never a person: null.
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

/** The AI teammate, when it's the one acting. */
export function aiEmployeeOf(actor: Actor): AiEmployeeActor | null {
  return actor.type === 'ai_employee' ? actor : null;
}

/**
 * Every command the AI teammate may run, and nothing else: the kernel refuses any other command for it, even
 * one that lists 'ai_employee' in its actors (a registry test keeps both lists the same). Never an archive, a
 * delete or anything above risk level 2. Each command keeps it to the conversation it's answering.
 */
export const AI_EMPLOYEE_COMMANDS = [
  'message.send',
  'person.create',
  'person.update',
  'lead.create',
  'lead.update',
  'lead.move_stage',
  'lead.set_next_action',
  'lead.record_answers',
  'task.create',
  'activity.log',
  'record.set_tags',
  'knowledge_item.record_use',
  'knowledge_suggestion.propose',
  'conversation.hand_off',
  'conversation.pick_up',
  'appointment.book_for_customer',
  'attendee.reschedule_for_customer',
  'attendee.cancel_for_customer',
  // M15: asking one of the business's forms in the conversation, a question at a time.
  'form_response.start',
  'form_response.save',
  'form_response.submit',
] as const;

/** The look-ups the AI teammate runs through the kernel (the rest it reads in the worker, for its run). */
export const AI_EMPLOYEE_QUERIES = ['calendar.availability'] as const;

const AI_EMPLOYEE_OPERATIONS: ReadonlySet<string> = new Set([
  ...AI_EMPLOYEE_COMMANDS,
  ...AI_EMPLOYEE_QUERIES,
]);

/** Whether the AI teammate may run this command or query at all (its own rules still apply). */
export function aiEmployeeMayRun(name: string): boolean {
  return AI_EMPLOYEE_OPERATIONS.has(name);
}
