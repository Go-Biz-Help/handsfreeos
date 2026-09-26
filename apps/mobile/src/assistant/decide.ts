import { ASSISTANT_CONFIRM_WORDS, assistantCancelledText, type AssistantCard } from '@hfos/core';

import type { CallState } from './chat';
import { AssistantError, cancelToolCall, confirmToolCall } from './stream';

export type ConfirmCardData = Extract<AssistantCard, { type: 'confirm' }>;

/**
 * Confirm or Cancel, pressed on the card or said out loud: runs it, and the card says how it went. Answers that in
 * words, for voice mode to say. A card answered on another screen, or one that lapsed, says so; any other failure
 * throws.
 */
export async function decideCard(
  workspaceId: string,
  setCall: (id: string, patch: Partial<CallState>) => void,
  card: ConfirmCardData,
  kind: 'confirm' | 'cancel',
  reason?: string,
): Promise<string> {
  try {
    const out =
      kind === 'confirm'
        ? await confirmToolCall(card.toolCallId, workspaceId, reason)
        : await cancelToolCall(card.toolCallId, workspaceId);
    const status =
      out.status === 'confirmed'
        ? 'confirmed'
        : out.status === 'cancelled'
          ? 'cancelled'
          : 'failed';
    setCall(card.toolCallId, { status, outcome: out.outcome, href: out.href, error: out.error });
    return status === 'confirmed'
      ? (out.outcome ?? ASSISTANT_CONFIRM_WORDS.done)
      : status === 'cancelled'
        ? assistantCancelledText(card)
        : (out.error ?? ASSISTANT_CONFIRM_WORDS.failed);
  } catch (e) {
    // Answered on another screen, or it lapsed: the card says so.
    if (e instanceof AssistantError && (e.status === 409 || e.status === 404)) {
      setCall(card.toolCallId, { status: 'expired', note: e.message });
      return e.message;
    }
    throw e;
  }
}
