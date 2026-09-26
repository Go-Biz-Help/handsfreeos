import { CONVERSATION_DONE, handBackToast, takeOverToast } from '@hfos/core';

import { toast } from '@/components/ui/toast';
import { change } from '@/changes';

import { cancelHeldHere } from './outbox';

/**
 * What a person does to a conversation on the phone, each a change that can wait for signal (`conversation.*` go any
 * time; handing back to the AI teammate is fresh for 30 minutes), with the conversation's synced row updated at once
 * and the web's words for what it did. A change a later one overtook (the customer wrote after a close made with no
 * signal) doesn't apply on the server, and the synced row says so when it arrives.
 */

export interface ConversationRef {
  readonly workspaceId: string;
  readonly conversationId: string;
  readonly myUserId: string;
}

const failed = (error: unknown) =>
  toast.error(error instanceof Error ? error.message : String(error));

async function run(work: () => Promise<unknown>, done: string | null): Promise<boolean> {
  try {
    await work();
    if (done) toast.show(done);
    return true;
  } catch (error) {
    failed(error);
    return false;
  }
}

const nowIso = () => new Date().toISOString();

export function conversationActions(ref: ConversationRef) {
  const input = { workspaceId: ref.workspaceId, conversationId: ref.conversationId };
  const update =
    (sets: string, values: unknown[]) =>
    (tx: { execute(sql: string, params?: unknown[]): Promise<unknown> }) =>
      tx.execute(`UPDATE conversations SET ${sets}, updated_at = ? WHERE id = ?`, [
        ...values,
        nowIso(),
        ref.conversationId,
      ]);
  return {
    assign: (userId: string | null, fullName?: string) =>
      run(
        () =>
          change(
            'conversation.assign',
            { ...input, assigneeUserId: userId },
            { optimistic: update('assignee_user_id = ?', [userId]) },
          ),
        CONVERSATION_DONE.assigned(userId, ref.myUserId, fullName),
      ),
    snooze: (until: Date, message: string) =>
      run(
        () =>
          change(
            'conversation.snooze',
            { ...input, until: until.toISOString() },
            {
              optimistic: update("status = 'snoozed', snoozed_until = ?", [until.toISOString()]),
            },
          ),
        message,
      ),
    close: (message: string) =>
      run(
        () =>
          change('conversation.close', input, {
            optimistic: update("status = 'closed', snoozed_until = NULL, closed_at = ?", [
              nowIso(),
            ]),
          }),
        message,
      ),
    reopen: () =>
      run(
        () =>
          change('conversation.reopen', input, {
            optimistic: update("status = 'open', snoozed_until = NULL", []),
          }),
        CONVERSATION_DONE.reopened,
      ),
    markRead: () =>
      run(
        () =>
          change('conversation.mark_read', input, {
            optimistic: update('unread_count = 0', []),
          }),
        null,
      ),
    markUnread: () =>
      run(
        () =>
          change('conversation.mark_unread', input, {
            optimistic: update('unread_count = max(1, coalesce(unread_count, 0))', []),
          }),
        CONVERSATION_DONE.markedUnread,
      ),
    takeOver: (teammateName: string) =>
      run(
        () =>
          change('conversation.take_over', input, {
            optimistic: update(
              "handled_by = 'person', needs_person_since = NULL, taken_over_by = ?",
              [ref.myUserId],
            ),
          }),
        takeOverToast(teammateName, false),
      ),
    handBack: (teammateName: string, who: string) =>
      run(
        () =>
          change('conversation.hand_to_ai', input, {
            optimistic: update("handled_by = 'ai', needs_person_since = NULL", []),
          }),
        handBackToast(teammateName, who),
      ),
    /** A new text leaves the thread; a failed text tried again goes back as it was, not delivered. */
    cancelHeld: async (messageId: string) => {
      let stays = false;
      const done = await run(
        () =>
          change(
            'message.cancel_scheduled',
            { workspaceId: ref.workspaceId, messageId },
            {
              optimistic: async (tx) => {
                stays = await cancelHeldHere(tx, messageId);
              },
            },
          ),
        null,
      );
      if (done)
        toast.show(stays ? CONVERSATION_DONE.retryCancelled : CONVERSATION_DONE.heldCancelled);
      return done;
    },
  };
}

export type ConversationActions = ReturnType<typeof conversationActions>;
