/** Handing a conversation to a person, as the teammate (its own conversation) or as the worker. */
import {
  conversationHandOff,
  executeCommandIn,
  HfosError,
  type AiEmployeeActor,
  type ConversationHandoffReason,
  type RequestMeta,
} from '@hfos/core/server';
import type { Tx } from '@hfos/db/client';
import { systemActor, type TenantScope } from '../services';

const NOTE_MAX = 500;

/** As the worker: a loop, a limit, an opt-out core couldn't record, an approved draft that couldn't go out. */
export async function handOffAsSystem(
  tx: Tx,
  scope: TenantScope,
  conversationId: string,
  reason: ConversationHandoffReason,
  note: string,
  meta: RequestMeta,
): Promise<void> {
  await executeCommandIn(
    tx,
    conversationHandOff,
    { workspaceId: scope.workspaceId, conversationId, reason, note: note.slice(0, NOTE_MAX) },
    systemActor(scope),
    meta,
  );
}

/**
 * As the teammate, in the conversation it's answering. False when it isn't its to hand off anymore (a person
 * took it over while it worked): the run is then superseded, quietly.
 */
export async function handOffAsAi(
  tx: Tx,
  ai: AiEmployeeActor,
  meta: RequestMeta,
  reason: ConversationHandoffReason,
  note: string,
): Promise<boolean> {
  if (!ai.conversationId) return false;
  try {
    await executeCommandIn(
      tx,
      conversationHandOff,
      {
        workspaceId: ai.workspaceId,
        conversationId: ai.conversationId,
        reason,
        note: note.slice(0, NOTE_MAX),
      },
      ai,
      meta,
    );
    return true;
  } catch (e) {
    if (
      e instanceof HfosError &&
      (e.rule === 'not_handled_by_ai' || e.rule === 'outside_its_conversation')
    )
      return false;
    throw e;
  }
}
