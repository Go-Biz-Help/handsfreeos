import {
  PUSH_BUTTONS,
  PUSH_CATEGORIES,
  PUSH_CATEGORY_IDS,
  type PushButton,
  type PushCategory,
} from '@hfos/core';

/**
 * The notification categories the phone registers, from the lists the worker names them from (`@hfos/core`'s
 * `PUSH_CATEGORIES` and `PUSH_BUTTONS`, apps/worker/src/push/README.md): each kind of push with its buttons in order.
 *
 * - **Buttons that reach a customer or approve something** (Reply, Let AI handle, Let HandsFreeOS handle, Approve) need
 *   the phone unlocked: on an iPhone `isAuthenticationRequired`, so iOS asks for Face ID or the passcode before the
 *   app hears of the press, without opening the app. Expo's Android code ignores that option, so the app asks for
 *   unlocking itself before it runs one (`press.ts`).
 * - **Snooze 1 hour** works straight from the lock screen.
 * - **Call, Review and Open** open the app.
 * - **Reply** is typed in the notification.
 */

/** A button as `Notifications.setNotificationCategoryAsync` takes it. */
export interface CategoryAction {
  readonly identifier: PushButton;
  readonly buttonTitle: string;
  readonly textInput?: { readonly placeholder: string; readonly submitButtonTitle: string };
  readonly options: {
    readonly opensAppToForeground: boolean;
    readonly isAuthenticationRequired: boolean;
    readonly isDestructive: boolean;
  };
}

export function actionOf(button: PushButton): CategoryAction {
  const def = PUSH_BUTTONS[button];
  const textInput =
    'textInput' in def && def.textInput
      ? { placeholder: def.textInput.placeholder, submitButtonTitle: def.textInput.submit }
      : undefined;
  return {
    identifier: button,
    buttonTitle: def.title,
    ...(textInput ? { textInput } : {}),
    options: {
      opensAppToForeground: def.opensApp,
      isAuthenticationRequired: def.unlock,
      isDestructive: false,
    },
  };
}

/** A category's buttons, in the order the notification shows them. */
export function categoryActions(category: PushCategory): CategoryAction[] {
  return PUSH_CATEGORIES[category].buttons.map(actionOf);
}

/** Every category the worker sends, with its buttons. */
export function allCategories(): {
  readonly id: PushCategory;
  readonly actions: CategoryAction[];
}[] {
  return PUSH_CATEGORY_IDS.map((id) => ({ id, actions: categoryActions(id) }));
}

export function isPushButton(value: string): value is PushButton {
  return Object.prototype.hasOwnProperty.call(PUSH_BUTTONS, value);
}

export function isPushCategory(value: string): value is PushCategory {
  return Object.prototype.hasOwnProperty.call(PUSH_CATEGORIES, value);
}
