/**
 * The push service seam (M10): Expo's in production (expo.ts), the stand-in locally and in tests (fake.ts). Both
 * take Expo's message shape and answer with Expo's tickets and receipts, so the send job (send.ts) can't tell them
 * apart.
 */

export type PushPlatform = 'ios' | 'android';

/** One message to one phone, in Expo's shape (payload.ts builds them). */
export interface PushMessage {
  readonly to: string;
  readonly data: Record<string, unknown>;
  /** iPhones only: Android pushes are data-only and the app draws them. */
  readonly title?: string;
  readonly subtitle?: string;
  readonly body?: string;
  readonly categoryId?: string;
  /** iPhones: a notification with the same id replaces this one; the thread groups them. */
  readonly collapseId?: string;
  readonly threadId?: string;
  readonly sound?: 'default';
  readonly interruptionLevel?: 'active' | 'passive' | 'time-sensitive';
  readonly priority: 'high';
  /** Seconds the push services keep trying a phone that is off. */
  readonly ttl: number;
}

/** Expo's answer for one message: accepted (a receipt comes later under `id`), or refused outright. */
export type PushTicket =
  | { readonly status: 'ok'; readonly id: string }
  | { readonly status: 'error'; readonly message: string; readonly error: string | null };

/** What happened when Expo handed a message on to Apple or Google. */
export type PushReceipt =
  | { readonly status: 'ok' }
  | { readonly status: 'error'; readonly message: string; readonly error: string | null };

export interface PushProvider {
  readonly name: 'expo' | 'fake';
  /** Up to PUSH_CHUNK messages: one ticket per message, in their order. */
  send(messages: readonly PushMessage[]): Promise<PushTicket[]>;
  /** Up to RECEIPT_CHUNK ticket ids. A receipt not ready yet, or kept no longer (a day), is missing. */
  receipts(ids: readonly string[]): Promise<Record<string, PushReceipt>>;
}

/** Expo takes 100 messages a request, and 300 receipt ids. */
export const PUSH_CHUNK = 100;
export const RECEIPT_CHUNK = 300;

/** Expo's word for a phone the app is gone from (uninstalled, or its token replaced). */
export const DEVICE_GONE = 'DeviceNotRegistered';

/**
 * A send that failed. `refused`: Expo answered the request with an error, so none of it went and all of it can be
 * sent again. Otherwise nobody can say (the connection dropped, it timed out): some of it may have gone, so none
 * of it is sent again.
 */
export class PushSendError extends Error {
  constructor(
    message: string,
    readonly refused: boolean,
    options?: { readonly cause?: unknown },
  ) {
    super(message, options);
    this.name = 'PushSendError';
  }
}
