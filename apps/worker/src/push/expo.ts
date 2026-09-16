/**
 * Expo's push service, through expo-server-sdk, with enhanced push security: every request carries the project's
 * access token (EXPO_ACCESS_TOKEN, the worker's alone), so a push token that leaks can't be used to send anything.
 * Apple's and Google's own keys stay in EAS. Expo retries its own rate limits (429) a couple of times; everything
 * else is the send job's to decide.
 *
 * A request that doesn't come back within `timeoutMs` counts as one that may have gone: nothing waits five minutes
 * on a slow connection, and nothing is sent twice.
 */
import {
  Expo,
  type ExpoPushMessage,
  type ExpoPushReceipt,
  type ExpoPushTicket,
} from 'expo-server-sdk';
import { errorMessage } from '../outbox';
import { PushSendError, type PushProvider, type PushReceipt, type PushTicket } from './provider';

export interface ExpoPushOptions {
  readonly accessToken: string;
  readonly timeoutMs?: number;
}

const ticketOf = (t: ExpoPushTicket): PushTicket =>
  t.status === 'ok'
    ? { status: 'ok', id: t.id }
    : { status: 'error', message: t.message, error: t.details?.error ?? null };

const receiptOf = (r: ExpoPushReceipt): PushReceipt =>
  r.status === 'ok'
    ? { status: 'ok' }
    : { status: 'error', message: r.message, error: r.details?.error ?? null };

function within<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} took longer than ${ms} ms`)), ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

export function createExpoPush(opts: ExpoPushOptions): PushProvider {
  const expo = new Expo({ accessToken: opts.accessToken, maxConcurrentRequests: 2 });
  const timeoutMs = opts.timeoutMs ?? 30_000;
  return {
    name: 'expo',
    async send(messages) {
      const tickets: PushTicket[] = [];
      for (const chunk of expo.chunkPushNotifications(messages as ExpoPushMessage[])) {
        try {
          const got = await within(expo.sendPushNotificationsAsync(chunk), timeoutMs, 'Expo push');
          tickets.push(...got.map(ticketOf));
        } catch (e) {
          // An HTTP status means Expo answered and took none of this request. Anything else (a dropped connection,
          // a timeout, a ticket count that doesn't match) may have sent some of it.
          const status = (e as { statusCode?: unknown }).statusCode;
          throw new PushSendError(
            `Expo push: ${errorMessage(e)}`,
            typeof status === 'number' && tickets.length === 0,
            { cause: e },
          );
        }
      }
      return tickets;
    },
    async receipts(ids) {
      const out: Record<string, PushReceipt> = {};
      for (const chunk of expo.chunkPushNotificationReceiptIds([...ids])) {
        const got = await within(
          expo.getPushNotificationReceiptsAsync(chunk),
          timeoutMs,
          'Expo receipts',
        );
        for (const [id, r] of Object.entries(got)) out[id] = receiptOf(r);
      }
      return out;
    },
  };
}
