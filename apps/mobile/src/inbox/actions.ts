import {
  CONVERSATION_DONE,
  handBackToast,
  joinName,
  SENT_WORDS,
  takeOverToast,
  type ConversationFolderValue,
  type NameParts,
} from '@hfos/core';

import { toast } from '@/components/ui/toast';
import { change } from '@/changes';

import { cancelHeldHere, markMovedHere } from './outbox';

/**
 * What a person does to a conversation on the phone, each a change that can wait for signal (`conversation.*` go any
 * time; handing back to the AI teammate is fresh for 30 minutes), with the conversation's synced row updated at once
 * and the web's words for what it did. A change a later one overtook (the customer wrote after a close made with no
 * signal) doesn't apply on the server, and the synced row says so when it arrives.
 *
 * Moving an email thread between folders, sharing someone's own mail (M19) and sending a text or email that didn't go
 * out again are online only: with signal they go at once, and with none the toast says so.
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
  // Messages being sent again: a second tap before the first answer is ignored, so a double tap sends it once.
  const retrying = new Set<string>();
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
    /**
     * An email thread to the Inbox, Other mail or Spam (M19); with `remember`, the sender's next new thread too.
     * Whether it left the folder it was in: false when it was there already, or it couldn't be moved.
     */
    move: async (folder: ConversationFolderValue, remember = false): Promise<boolean> => {
      try {
        const { output } = await change('conversation.move', { ...input, folder, remember });
        if (output.changed) markMovedHere(ref.conversationId, { folder });
        toast.show(
          output.changed || remember
            ? CONVERSATION_DONE.moved(folder, remember)
            : CONVERSATION_DONE.alreadyThere,
        );
        return output.changed;
      } catch (error) {
        failed(error);
        return false;
      }
    },
    /** Out of the person's own mail and into the team's Inbox (M19). */
    share: () =>
      run(async () => {
        await change('conversation.share', input);
        markMovedHere(ref.conversationId, { shared: true });
      }, CONVERSATION_DONE.shared),
    /**
     * Someone's own mail shared straight onto a customer (M19), since it is never a customer's while it's theirs: the
     * one picked to link it to, or its sender added as a new one with the phone's id for them. Online only, like
     * sharing it as it is, and the thread is theirs at once, as the synced row will say.
     */
    shareOnto: (
      to:
        | { readonly personId: string; readonly fullName: string }
        | { readonly newPerson: NameParts & { readonly id: string } },
      done: string,
    ) =>
      run(async () => {
        await change('conversation.share', {
          ...input,
          ...('personId' in to ? { personId: to.personId } : { newPerson: to.newPerson }),
        });
        markMovedHere(ref.conversationId, {
          shared: true,
          folder: 'inbox',
          person:
            'personId' in to
              ? { id: to.personId, fullName: to.fullName }
              : { id: to.newPerson.id, fullName: joinName(to.newPerson) },
        });
      }, done),
    /**
     * The team's thread onto a customer who already exists; they gain its number or address. Any time, like the web's
     * Link: the thread is theirs on this phone at once.
     */
    link: (personId: string, done: string) =>
      run(
        () =>
          change(
            'conversation.link_person',
            { ...input, personId },
            {
              // Linking a customer puts an email thread in the Inbox, as the server does (M19).
              optimistic: update(
                "person_id = ?, folder = CASE WHEN channel = 'email' THEN 'inbox' ELSE folder END",
                [personId],
              ),
            },
          ),
        done,
      ),
    /**
     * A text or email that didn't go out, sent again. Its row says Sending… once HandsFreeOS's copy arrives. In quiet
     * hours a text waits for them to end, like any held text, and the toast says when it goes (`who` and the
     * business's `timeZone` word that).
     */
    retry: async (messageId: string, who: string, timeZone: string): Promise<boolean> => {
      if (retrying.has(messageId)) return false;
      retrying.add(messageId);
      try {
        const { output } = await change('message.retry', {
          workspaceId: ref.workspaceId,
          messageId,
        });
        toast.show(
          output.scheduledFor
            ? SENT_WORDS.held(who, output.scheduledFor, timeZone)
            : CONVERSATION_DONE.retrying,
        );
        return true;
      } catch (error) {
        failed(error);
        return false;
      } finally {
        retrying.delete(messageId);
      }
    },
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
