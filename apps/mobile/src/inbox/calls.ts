import { useSyncExternalStore } from 'react';

/**
 * Calling a customer through your own cell (the plan's "Calling a customer"): anything on the phone that offers Call
 * — a conversation, a customer, a card on Home, a notification's Call button — asks for it here, and the call sheet
 * mounted once in the business's layout (`CallSheetHost`) takes it: no signal says so, no verified cell opens My cell
 * phone first, otherwise it runs `call.connect_me` and follows the call's synced row.
 *
 *   import { startCall } from '@/inbox/calls';
 *   startCall({ conversationId });   // a text conversation: its number
 *   startCall({ personId });         // a customer: their phone number
 */

export type CallTarget =
  | { readonly conversationId: string; readonly personId?: undefined }
  | { readonly personId: string; readonly conversationId?: undefined };

export interface CallRequest {
  readonly target: CallTarget;
  /** The business the call is for. Left out, it's the business on screen. */
  readonly workspaceId: string | null;
  /** When it was asked for: a request older than a minute that no sheet took is dropped. */
  readonly at: number;
  /** One number per request, so asking again for the same customer is a new request. */
  readonly seq: number;
}

/** How long a request waits for the business it's for to open (a notification's Call, while the app unlocks). */
export const CALL_REQUEST_KEPT_MS = 60_000;

let request: CallRequest | null = null;
let seq = 0;
const listeners = new Set<() => void>();

function publish() {
  for (const listener of listeners) listener();
}

/**
 * Calls a customer through the person's own cell, with the call sheet over whatever screen is showing. Online only:
 * with no signal the sheet says "This needs signal." instead.
 */
export function startCall(target: CallTarget, options: { workspaceId?: string } = {}): void {
  request = { target, workspaceId: options.workspaceId ?? null, at: Date.now(), seq: ++seq };
  publish();
}

export const callRequests = {
  current: (): CallRequest | null => request,
  /** The sheet for `workspaceId` takes the request meant for it, once. */
  take(workspaceId: string, now = Date.now()): CallRequest | null {
    const value = request;
    if (!value) return null;
    if (now - value.at > CALL_REQUEST_KEPT_MS) {
      request = null;
      publish();
      return null;
    }
    if (value.workspaceId !== null && value.workspaceId !== workspaceId) return null;
    request = null;
    publish();
    return value;
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  /** Tests. */
  clear(): void {
    request = null;
    publish();
  },
};

export function useCallRequest(): CallRequest | null {
  return useSyncExternalStore(callRequests.subscribe, callRequests.current, callRequests.current);
}
