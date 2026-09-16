/**
 * Calling a customer through your own cell (M10). HandsFreeOS rings the person's verified cell from the business
 * number; they answer and hear "Press 1 to call Mike Johnson"; pressing 1 dials the customer, who sees the business
 * number. Nobody pressing 1 (no answer, a declined call, the cell's own voicemail) ends it: the customer never rings.
 *
 * The app shows where a call is from the call's own row, which phones sync:
 * - `answered_via = 'bridge'` from the moment it is asked for;
 * - `answered_by_user_id` once the person pressed 1 (the customer's phone rings from then);
 * - `answered_at` once the customer picked up.
 * Browser-safe.
 */

/** How long the person's cell rings before HandsFreeOS gives up (Twilio adds a few seconds of its own). */
export const BRIDGE_CELL_RING_SECONDS = 25;
/** How long the person has to press 1 once they answer (the prompt plays twice in that time). */
export const BRIDGE_GATE_SECONDS = 10;
/** How long the customer's phone rings. */
export const BRIDGE_CUSTOMER_RING_SECONDS = 30;

export type BridgeStatus =
  /** The person's cell is ringing, or they answered and haven't pressed 1 yet. */
  | 'calling_cell'
  /** They pressed 1; the customer's phone is ringing. */
  | 'calling_customer'
  | 'connected'
  /** The call with the customer is over. */
  | 'ended'
  /** Nobody pressed 1: the cell wasn't answered, was declined, or its voicemail picked up. The customer never rang. */
  | 'cell_unanswered'
  | 'customer_unanswered'
  | 'customer_busy'
  /** The carrier couldn't place it. */
  | 'failed';

/** What a call row says (as synced, or as the API returns it). */
export interface BridgeCallFacts {
  readonly status: string;
  readonly answeredVia: string | null;
  readonly answeredByUserId: string | null;
  readonly answeredAt: string | Date | null;
}

const ENDED: ReadonlySet<string> = new Set([
  'completed',
  'no_answer',
  'busy',
  'failed',
  'canceled',
]);

/** Where a call through the person's own cell is; null for any other call. */
export function bridgeStatusOf(call: BridgeCallFacts): BridgeStatus | null {
  if (call.answeredVia !== 'bridge') return null;
  if (!ENDED.has(call.status)) {
    if (call.answeredAt) return 'connected';
    return call.answeredByUserId ? 'calling_customer' : 'calling_cell';
  }
  if (call.answeredAt) return 'ended';
  if (!call.answeredByUserId) return call.status === 'failed' ? 'failed' : 'cell_unanswered';
  if (call.status === 'busy') return 'customer_busy';
  return call.status === 'failed' ? 'failed' : 'customer_unanswered';
}

/** The words the call sheet shows: "Calling your cell…", "Connected", "You didn’t answer". */
export function bridgeStatusWords(status: BridgeStatus, customerName: string | null): string {
  const who = customerName?.trim() || 'the customer';
  switch (status) {
    case 'calling_cell':
      return 'Calling your cell…';
    case 'calling_customer':
      return `Calling ${who}…`;
    case 'connected':
      return 'Connected';
    case 'ended':
      return 'Call ended';
    case 'cell_unanswered':
      return 'You didn’t answer';
    case 'customer_unanswered':
      return `${customerName?.trim() || 'The customer'} didn’t answer`;
    case 'customer_busy':
      return `${customerName?.trim() || 'The customer'}’s line is busy`;
    case 'failed':
      return 'The call didn’t go through';
  }
}
