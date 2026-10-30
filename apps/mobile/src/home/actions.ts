import {
  assignedToast,
  ATTENTION_WORDS,
  attentionReachOf,
  attentionTargetOf,
  firstNameOr,
  itemCustomerOf,
  LEAD_ITEM_KINDS,
  lessonKnowsOtherwise,
  snoozedUntilWords,
  type AttentionItemOut,
} from '@hfos/core';
import { usePowerSync } from '@powersync/react-native';
import * as React from 'react';

import { toast } from '@/components/ui/toast';
import { change, changes, ChangeError } from '@/changes';
import type { ChangeTransaction } from '@/changes/controller';
import type { OutboxRow } from '@/changes/outbox';
import { startCall } from '@/inbox/calls';
import { networkSnapshot } from '@/lib/network';

import { openWebPath } from './open';
import { HOME_PHONE_WORDS } from './words';

type Item = AttentionItemOut;

/** What a card's buttons open: Let HandsFreeOS Handle, ⋯, Dismiss this?, Snooze until. */
export type HomeSheet =
  | { readonly type: 'let_handle'; readonly item: Item }
  | { readonly type: 'menu'; readonly item: Item }
  | { readonly type: 'dismiss'; readonly item: Item }
  | { readonly type: 'pick_time'; readonly item: Item };

export interface HomeActions {
  /** The main button (a draft's Approve is the card's own). */
  handle(item: Item): void;
  call(item: Item): void;
  letHandle(item: Item): void;
  more(item: Item): void;
  snooze(item: Item, until: number): void;
  pickTime(item: Item): void;
  dismiss(item: Item): void;
  dismissNow(item: Item, reason: string | null): void;
  assign(item: Item, userId: string | null): void;
  cancelAuto(item: Item): void;
  /** Got it, on an add-on's alert that asks to be acknowledged (online: the add-on hears at once). */
  acknowledge(item: Item): void;
  /** Opens the record behind an item. */
  open(item: Item): void;
}

const failed = (error: unknown) =>
  toast.error(
    error instanceof ChangeError || error instanceof Error ? error.message : String(error),
  );

/** The item's row, changed at once on the phone while the change waits. */
const updateItem =
  (itemId: string, sets: string, values: readonly unknown[]) => (tx: ChangeTransaction) =>
    tx.execute(`UPDATE attention_items SET ${sets}, updated_at = ? WHERE id = ?`, [
      ...values,
      new Date().toISOString(),
      itemId,
    ]);

/** Undo: a change that hasn't gone is taken back off the phone; one that went is undone on HandsFreeOS. */
type Db = ReturnType<typeof usePowerSync>;

async function undo(db: Db, workspaceId: string, itemId: string, changeId: string): Promise<void> {
  try {
    const row = await db.getOptional<OutboxRow>('SELECT * FROM outbox WHERE id = ?', [changeId]);
    if (row && row.state !== 'sent' && row.state !== 'sending') {
      await changes.discard([changeId]);
      return;
    }
    await change(
      'attention.restore',
      { workspaceId, itemId },
      {
        optimistic: updateItem(
          itemId,
          "state = 'open', snoozed_until = NULL, dismissed_at = NULL",
          [],
        ),
      },
    );
  } catch (error) {
    failed(error);
  }
}

/**
 * What each card's buttons do on the phone, as the web's `useItemActions` does: the same commands, through `change()`
 * so they wait for signal (snooze, dismiss, assign any time; Let HandsFreeOS Handle fresh for 30 minutes), with the
 * item's row changed at once and the web's words in the toasts. Calls go through the person's own cell (`startCall`).
 */
export function useHomeActions(o: {
  readonly workspaceId: string;
  readonly timeZone: string;
  readonly myUserId: string;
  readonly members: readonly { readonly id: string; readonly fullName: string }[];
  readonly open: (sheet: HomeSheet) => void;
  /** An alert this phone just acknowledged: its Got it goes at once, before HandsFreeOS's row comes down. */
  readonly onAcknowledged?: (alertId: string) => void;
}): HomeActions {
  const { workspaceId, timeZone, myUserId, members, open, onAcknowledged } = o;
  const db = usePowerSync();
  return React.useMemo<HomeActions>(() => {
    const said = (words: string) =>
      networkSnapshot().online ? words : HOME_PHONE_WORDS.queued(words);
    const call = (item: Item) => {
      if (item.conversationId && !item.personId) startCall({ conversationId: item.conversationId });
      else if (item.personId) startCall({ personId: item.personId });
      else openWebPath(attentionReachOf(item, workspaceId));
    };
    const reply = (item: Item) => openWebPath(attentionReachOf(item, workspaceId));
    const target = (item: Item) => openWebPath(attentionTargetOf(item, workspaceId).href);

    return {
      handle(item) {
        switch (item.kind) {
          case 'hot_lead':
            return item.personId ? call(item) : reply(item);
          case 'unanswered_lead':
          case 'customer_waiting':
          case 'stale_opportunity':
            return reply(item);
          case 'missing_next_action':
            return target(item);
          // Asking to confirm is Let HandsFreeOS Handle: its sheet says exactly what goes, and why not when it can't.
          case 'unconfirmed_appointment':
            return open({ type: 'let_handle', item });
          case 'ai_approval':
            return target(item);
          case 'overdue_task':
            return openWebPath(`/app/w/${workspaceId}/tasks`);
          // A money card: a call while the business is open, otherwise the follow-up already written, in the sheet.
          case 'estimate_waiting':
          case 'invoice_overdue':
            if (item.callable && item.personId) return call(item);
            if (item.reach) return open({ type: 'let_handle', item });
            return target(item);
          // The balance's three reach nobody: they open Balance, where topping up and the card are.
          case 'wallet_low':
          case 'wallet_empty':
          case 'wallet_card_declined':
            return target(item);
          // Thanking a customer is a reply to them; a referral opens the customer who mentioned them, where
          // the web's one-tap "Create lead" is a press away.
          case 'job_not_thanked':
            return item.conversationId ? reply(item) : target(item);
          case 'referral_mentioned':
            return target(item);
          // Two texts went already, or they're hot after a webinar: a call when this phone can, else a reply.
          case 'maintenance_due':
          case 'quiet_after_price':
          case 'client_quiet':
          case 'promise_due':
          case 'webinar_hot':
            if (item.personId) return call(item);
            return item.conversationId ? reply(item) : target(item);
          // A deal on the wrong stage opens it, where the move is a press away.
          case 'pipeline_mismatch':
            return target(item);
          // A visit whose time passed: marked done from here, when signal allows.
          case 'job_unconfirmed':
          case 'job_never_completed':
            return void (async () => {
              try {
                await change('appointment.set_status', {
                  workspaceId,
                  appointmentId: item.subject.id,
                  status: 'completed',
                });
                toast.show(said('Marked done.'));
              } catch (error) {
                failed(error);
              }
            })();
          // The address goes on the customer, where every visit at their place reads it.
          // The week's money opens Money.
          case 'revenue_moved':
            return target(item);
          // A lesson from correcting the AI goes into what it knows in one tap, as on the web. When what it knows
          // said otherwise, the card asked which is right and this is "Use the new one": the new words take the
          // old ones' place (dismissing keeps them). It needs signal; the card clears when the phone next syncs.
          case 'ai_corrections':
            return void (async () => {
              try {
                const replace = lessonKnowsOtherwise(item);
                const made = await change('teammate_lesson.apply', {
                  workspaceId,
                  lessonId: item.subject.id,
                  ...(replace ? { replace } : {}),
                });
                const { replaced } = made.output;
                toast.show(
                  replaced
                    ? `Added to its instructions, and changed ${replaced.where} to match.`
                    : 'Added to its instructions.',
                );
              } catch (error) {
                failed(error);
              }
            })();
          // Health and quality: the page that checks or fixes it.
          case 'channel_quiet':
          case 'connection_error':
          case 'connection_silent':
          case 'ai_unreviewed':
          case 'website_changed':
          case 'faq_suggestions':
          case 'offer_lapsing':
          case 'texting_rejected':
            return target(item);
          // An add-on's alert opens its page (the deal), on the phone's own screen once this build has it.
          case 'addon_alert':
            return target(item);
          case 'job_no_address':
            return item.personId
              ? openWebPath(`/app/w/${workspaceId}/customers/people/${item.personId}`)
              : target(item);
        }
      },
      call,
      letHandle: (item) => open({ type: 'let_handle', item }),
      more: (item) => open({ type: 'menu', item }),
      pickTime: (item) => open({ type: 'pick_time', item }),
      dismiss: (item) => open({ type: 'dismiss', item }),
      open: target,
      snooze(item, until) {
        void (async () => {
          try {
            const iso = new Date(until).toISOString();
            const made = await change(
              'attention.snooze',
              { workspaceId, itemId: item.id, until: iso },
              { optimistic: updateItem(item.id, "state = 'snoozed', snoozed_until = ?", [iso]) },
            );
            toast.show(
              said(ATTENTION_WORDS.snoozedToast(snoozedUntilWords(until, timeZone, Date.now()))),
              {
                action: {
                  label: ATTENTION_WORDS.undo,
                  onPress: () => void undo(db, workspaceId, item.id, made.id),
                },
              },
            );
          } catch (error) {
            failed(error);
          }
        })();
      },
      dismissNow(item, reason) {
        void (async () => {
          try {
            const made = await change(
              'attention.dismiss',
              { workspaceId, itemId: item.id, reason },
              {
                optimistic: updateItem(
                  item.id,
                  "state = 'dismissed', dismissed_at = ?, dismiss_reason = ?",
                  [new Date().toISOString(), reason],
                ),
              },
            );
            toast.show(said(ATTENTION_WORDS.dismissedToast), {
              action: {
                label: ATTENTION_WORDS.undo,
                onPress: () => void undo(db, workspaceId, item.id, made.id),
              },
            });
          } catch (error) {
            failed(error);
          }
        })();
      },
      assign(item, userId) {
        if ((item.assignee?.id ?? null) === userId) return;
        void (async () => {
          try {
            await change(
              'attention.assign',
              { workspaceId, itemId: item.id, assigneeUserId: userId },
              { optimistic: updateItem(item.id, 'assignee_user_id = ?', [userId]) },
            );
            // What the server passes it to: a lead's owner, a conversation's, a task's (the command's own rule).
            const passedTo = LEAD_ITEM_KINDS.has(item.kind)
              ? 'lead'
              : item.kind === 'customer_waiting'
                ? 'conversation'
                : item.kind === 'overdue_task'
                  ? 'task'
                  : null;
            const who = members.find((m) => m.id === userId);
            toast.show(
              said(
                assignedToast(
                  passedTo,
                  userId === myUserId,
                  who ? firstNameOr(who.fullName) : null,
                ),
              ),
            );
          } catch (error) {
            failed(error);
          }
        })();
      },
      cancelAuto(item) {
        void (async () => {
          try {
            await change(
              'attention.cancel_auto',
              { workspaceId, itemId: item.id },
              {
                optimistic: updateItem(
                  item.id,
                  "auto_state = 'cancelled', auto_scheduled_for = NULL",
                  [],
                ),
              },
            );
            toast.show(
              said(
                ATTENTION_WORDS.cancelledAutoToast(
                  item.auto.action === 'confirm_request',
                  firstNameOr(itemCustomerOf(item)),
                ),
              ),
            );
          } catch (error) {
            failed(error);
          }
        })();
      },
      // "I've seen this" (addon_alert.acknowledge, as the web's Acknowledge): online only, so with no signal it says so.
      acknowledge(item) {
        const alertId = item.addonAlert?.alertId;
        if (!alertId) return;
        void (async () => {
          try {
            await change('addon_alert.acknowledge', { workspaceId, alertId });
            onAcknowledged?.(alertId);
            toast.show(ATTENTION_WORDS.acknowledgedToast);
          } catch (error) {
            failed(error);
          }
        })();
      },
    };
  }, [db, workspaceId, timeZone, myUserId, members, open, onAcknowledged]);
}
