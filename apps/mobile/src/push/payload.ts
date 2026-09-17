import { PushData } from '@hfos/core';

/**
 * Reading a push's `data` (core's `PushData`, apps/worker/src/push/README.md) wherever it turns up:
 * - a notification the app hears of (`content.data`, which expo-notifications fills from an iPhone push's `body`, a
 *   local notification's own data, or an Android push's JSON `body`);
 * - the raw payloads Android hands the background task, where the data is still JSON text (`dataString`, or the
 *   `body` Expo's push service wraps it in).
 * Anything that doesn't parse is not a HandsFreeOS push, and the app leaves it alone.
 */

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function parseJson(text: unknown): unknown {
  if (typeof text !== 'string' || !text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** A push's data, or null when it isn't one of HandsFreeOS's (or is from a version this build doesn't read). */
export function pushDataOf(value: unknown): PushData | null {
  const parsed = PushData.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** The push data in a notification's content: `data`, or its JSON text (`dataString`). */
export function pushDataOfContent(content: unknown): PushData | null {
  if (!isRecord(content)) return null;
  return pushDataOf(content['data']) ?? pushDataOf(parseJson(content['dataString']));
}

/** The push data of a notification, as the listeners and the background task see one. */
export function pushDataOfNotification(notification: unknown): PushData | null {
  if (!isRecord(notification)) return null;
  const request = notification['request'];
  return isRecord(request) ? pushDataOfContent(request['content']) : null;
}

/** A button pressed, or the notification tapped. */
export interface PressEvent {
  readonly data: PushData;
  /** The button's id (`reply`, `snooze`…), or Expo's default action for a tap on the notification itself. */
  readonly actionId: string;
  /** What was typed, for Reply. */
  readonly typed: string | null;
  /** The notification's own id on the phone (its collapse id or notification id). */
  readonly identifier: string | null;
  /** The notification's title as shown (an iPhone push carries its words beside its data, not in it). */
  readonly title?: string;
}

/** What the background task was woken for. */
export type TaskEvent =
  | { readonly kind: 'received'; readonly data: PushData }
  | { readonly kind: 'pressed'; readonly press: PressEvent }
  | { readonly kind: 'other' };

/** A notification response, from a listener or the task: the press, or null when it isn't about one of ours. */
export function pressOf(response: unknown): PressEvent | null {
  if (!isRecord(response) || typeof response['actionIdentifier'] !== 'string') return null;
  const notification = response['notification'];
  const data = pushDataOfNotification(notification);
  if (!data) return null;
  const request = isRecord(notification) ? notification['request'] : null;
  const identifier = isRecord(request) ? request['identifier'] : null;
  const content = isRecord(request) ? request['content'] : null;
  const title = isRecord(content) ? content['title'] : null;
  const typed = response['userText'];
  return {
    data,
    actionId: response['actionIdentifier'],
    typed: typeof typed === 'string' ? typed : null,
    identifier: typeof identifier === 'string' ? identifier : null,
    ...(typeof title === 'string' && title.trim() ? { title } : {}),
  };
}

/**
 * The background task's payload (Android): a data-only push arriving (`data` with the push as JSON text) or a button
 * pressed on a notification the app showed (a notification response).
 */
export function taskEventOf(payload: unknown): TaskEvent {
  if (!isRecord(payload)) return { kind: 'other' };
  if (typeof payload['actionIdentifier'] === 'string') {
    const press = pressOf(payload);
    return press ? { kind: 'pressed', press } : { kind: 'other' };
  }
  const data = payload['data'];
  if (isRecord(data)) {
    const push =
      pushDataOf(parseJson(data['dataString'])) ??
      pushDataOf(parseJson(data['body'])) ??
      pushDataOf(data);
    if (push) return { kind: 'received', data: push };
  }
  return { kind: 'other' };
}

/**
 * What a notification the app showed itself says about a press it's following up (`followUp` in its data, which
 * `PushData` doesn't keep): read from the response's raw content.
 */
export function followUpOfResponse(response: unknown): unknown {
  if (!isRecord(response)) return undefined;
  const notification = response['notification'];
  const request = isRecord(notification) ? notification['request'] : null;
  const content = isRecord(request) ? request['content'] : null;
  if (!isRecord(content)) return undefined;
  const data = isRecord(content['data']) ? content['data'] : parseJson(content['dataString']);
  return isRecord(data) ? data['followUp'] : undefined;
}

/**
 * Whether the notification showing under this identifier is still this push's (or what a press left to say about it):
 * a newer push about the same conversation takes the identifier over, and stays when an older press finishes.
 */
export function showsPush(
  presented: readonly unknown[],
  identifier: string,
  notificationId: string,
): boolean {
  const shown = presented.find(
    (n) => isRecord(n) && isRecord(n['request']) && n['request']['identifier'] === identifier,
  );
  if (!shown) return false;
  const data = pushDataOfNotification(shown);
  return !data || data.notificationId === notificationId;
}

/** The notification's id on the phone: a conversation's one notification (`collapseId`), else the moment's. */
export function notificationIdentifierOf(data: PushData): string {
  return data.collapseId ?? data.notificationId;
}
