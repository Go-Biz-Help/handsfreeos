import {
  PUSH_BUTTONS,
  PUSH_CATEGORIES,
  PUSH_SNOOZE_MS,
  type PushButton,
  type PushData,
} from '@hfos/core';

import type { CommandName, InputOf } from '@/changes/commands';

import { isPushButton } from './categories';

/**
 * What a press on a notification does (apps/worker/src/push/README.md, "The buttons"): the notification itself and
 * Call, Review and Open open the app at the push's `path`; the other buttons run one command, under the command id
 * the push carries for that button, so a button pressed twice, or on two of the person's phones, does it once.
 */

/** Expo's id for a tap on the notification itself. */
export const TAP = 'expo.modules.notifications.actions.DEFAULT';

/** A command a button runs, typed from the phone's contract. */
export type ButtonCommand = {
  [N in CommandName]: { readonly name: N; readonly input: InputOf<N> };
}[CommandName];

export type PressAction =
  | { readonly kind: 'open'; readonly path: string; readonly button: PushButton | null }
  | {
      readonly kind: 'command';
      readonly button: PushButton;
      readonly command: ButtonCommand;
      /** `data.commandIds[button]`: the same on every phone the push reached. */
      readonly commandId: string;
      /** The phone must be unlocked before it runs. */
      readonly unlock: boolean;
    }
  | { readonly kind: 'nothing'; readonly reason: string };

/** "Snooze 1 hour": an hour from the moment it was pressed. */
export function snoozeUntil(pressedAt: number): string {
  return new Date(pressedAt + PUSH_SNOOZE_MS).toISOString();
}

function commandOf(
  button: PushButton,
  data: PushData,
  typed: string | null,
  pressedAt: number,
): ButtonCommand | string {
  const { workspaceId, refs } = data;
  switch (button) {
    case 'reply': {
      const body = typed?.trim() ?? '';
      if (!body) return 'Nothing was written, so nothing was sent.';
      if (!refs.conversationId) return 'This notification isn’t about a conversation.';
      return {
        name: 'message.send',
        input: {
          workspaceId,
          conversationId: refs.conversationId,
          channel: refs.channel ?? 'sms',
          body,
        },
      };
    }
    case 'let_ai_handle':
      if (!refs.conversationId) return 'This notification isn’t about a conversation.';
      return {
        name: 'conversation.hand_to_ai',
        input: { workspaceId, conversationId: refs.conversationId },
      };
    case 'let_handle':
      if (!refs.itemId) return 'This notification isn’t about an item on Home.';
      return {
        name: 'attention.let_handle',
        input: { workspaceId, itemId: refs.itemId, action: 'hand_to_ai' },
      };
    case 'snooze':
      if (!refs.itemId) return 'This notification isn’t about an item on Home.';
      return {
        name: 'attention.snooze',
        input: { workspaceId, itemId: refs.itemId, until: snoozeUntil(pressedAt) },
      };
    case 'approve':
      if (refs.approvalId)
        return {
          name: 'workflow.decide_approval',
          input: { workspaceId, approvalId: refs.approvalId, decision: 'approve' },
        };
      if (refs.draftId)
        return {
          name: 'ai_teammate.decide_draft',
          input: { workspaceId, draftId: refs.draftId, decision: 'approve' },
        };
      return 'This notification has nothing to approve.';
    // "How did it go?" after a visit.
    case 'done':
    case 'no_show':
      if (!refs.appointmentId) return 'This notification isn’t about a visit.';
      return {
        name: 'appointment.set_status',
        input: {
          workspaceId,
          appointmentId: refs.appointmentId,
          status: button === 'done' ? 'completed' : 'no_show',
        },
      };
    case 'still_there':
      if (!refs.appointmentId) return 'This notification isn’t about a visit.';
      return {
        name: 'appointment.still_going',
        input: { workspaceId, appointmentId: refs.appointmentId },
      };
    default:
      return 'That button doesn’t run anything.';
  }
}

/** What a press does: a tap or an app-opening button opens the push's path; a command button runs its command. */
export function pressAction(input: {
  readonly data: PushData;
  readonly actionId: string;
  readonly typed: string | null;
  readonly pressedAt: number;
}): PressAction {
  const { data, actionId } = input;
  if (actionId === TAP) return { kind: 'open', path: data.path, button: null };
  if (!isPushButton(actionId))
    return { kind: 'nothing', reason: 'That isn’t a HandsFreeOS button.' };
  const buttons: readonly PushButton[] = PUSH_CATEGORIES[data.category].buttons;
  if (!buttons.includes(actionId))
    return { kind: 'nothing', reason: 'That button isn’t on this notification.' };
  const def = PUSH_BUTTONS[actionId];
  if (def.opensApp) return { kind: 'open', path: data.path, button: actionId };
  const commandId = data.commandIds[actionId];
  if (!commandId) return { kind: 'nothing', reason: 'This notification can’t do that from here.' };
  const command = commandOf(actionId, data, input.typed, input.pressedAt);
  if (typeof command === 'string') return { kind: 'nothing', reason: command };
  return { kind: 'command', button: actionId, command, commandId, unlock: def.unlock };
}

/** One press of one button on one moment's notification: the same key on a second press or a replayed response. */
export function pressKey(data: PushData, actionId: string): string {
  return `${data.notificationId}:${actionId}`;
}
