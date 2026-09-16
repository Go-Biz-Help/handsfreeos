/**
 * The stand-in push service (PUSH_PROVIDER=fake: the default locally and in tests; production refuses it). It keeps
 * every message it was handed, in order, so tests read `sent` and browser specs read GET /test/push/sent, and it
 * answers the way Expo does:
 * - a token with `Gone` in it is a phone the app was removed from: its ticket is fine, and its receipt says
 *   DeviceNotRegistered, as Expo's does once Apple or Google have said so;
 * - a token with `Dead` in it is refused on the ticket itself;
 * - `failNext('refused')` fails the next send as Expo answering with an error (nothing went), and
 *   `failNext('lost')` as a connection lost after the request left (the messages went; the answer didn't come).
 */
import { randomUUID } from 'node:crypto';
import {
  DEVICE_GONE,
  PushSendError,
  type PushMessage,
  type PushProvider,
  type PushReceipt,
  type PushTicket,
} from './provider';

export interface FakePushSent {
  readonly message: PushMessage;
  /** Its ticket's id; null when the ticket itself was refused. */
  readonly ticketId: string | null;
  readonly at: number;
}

export interface FakePush extends PushProvider {
  readonly sent: FakePushSent[];
  /** Every receipt lookup, with the ids it asked about. */
  readonly receiptLookups: string[][];
  failNext(kind: 'refused' | 'lost', times?: number): void;
  clear(): void;
}

export function createFakePush(): FakePush {
  const sent: FakePushSent[] = [];
  const receiptLookups: string[][] = [];
  const failures: ('refused' | 'lost')[] = [];
  const tokens = new Map<string, string>();
  return {
    name: 'fake',
    sent,
    receiptLookups,
    failNext(kind, times = 1) {
      for (let i = 0; i < times; i++) failures.push(kind);
    },
    clear() {
      sent.length = 0;
      receiptLookups.length = 0;
      failures.length = 0;
      tokens.clear();
    },
    async send(messages) {
      const failure = failures.shift();
      if (failure === 'refused')
        throw new PushSendError('Expo push: the stand-in refused the request (503)', true);
      const at = Date.now();
      const tickets: PushTicket[] = messages.map((message) => {
        if (message.to.includes('Dead')) {
          sent.push({ message, ticketId: null, at });
          return {
            status: 'error',
            message: `"${message.to}" is not a registered push notification recipient`,
            error: DEVICE_GONE,
          };
        }
        const id = randomUUID();
        tokens.set(id, message.to);
        sent.push({ message, ticketId: id, at });
        return { status: 'ok', id };
      });
      if (failure === 'lost')
        throw new PushSendError('Expo push: the stand-in lost the connection', false);
      return tickets;
    },
    async receipts(ids) {
      receiptLookups.push([...ids]);
      const out: Record<string, PushReceipt> = {};
      for (const id of ids) {
        const to = tokens.get(id);
        if (to === undefined) continue;
        out[id] = to.includes('Gone')
          ? {
              status: 'error',
              message: `"${to}" is not a registered push notification recipient`,
              error: DEVICE_GONE,
            }
          : { status: 'ok' };
      }
      return out;
    },
  };
}
