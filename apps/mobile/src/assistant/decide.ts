import {
  ASSISTANT_CONFIRM_WORDS,
  assistantCancelledText,
  spokenDecision,
  type AssistantCard,
} from '@hfos/core';

import type { AnswerMessage, AssistantChat, CallState } from './chat';
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

/**
 * The cards in the chat still waiting for an OK that a yes could give (not ones a rule stops), as on the web
 * (apps/web/src/components/assistant/waiting.ts). They're the newest answer's cards: a card keeps waiting while other
 * things are asked, until a newer answer shows cards of its own and they replace it (the worker does the same).
 */
export function waitingCards(chat: Pick<AssistantChat, 'messages' | 'calls'>): ConfirmCardData[] {
  let latest: AnswerMessage | undefined;
  for (let i = chat.messages.length - 1; i >= 0 && !latest; i--) {
    const m = chat.messages[i]!;
    if (m.role === 'assistant' && m.cards.some((c) => c.type === 'confirm')) latest = m;
  }
  return (latest?.cards ?? []).flatMap((c) =>
    c.type === 'confirm' &&
    !!c.confirmLabel &&
    (chat.calls[c.toolCallId]?.status ?? 'awaiting_confirmation') === 'awaiting_confirmation'
      ? [c]
      : [],
  );
}

/**
 * A plain yes or no, said or typed, answers the cards waiting for an OK, just as their buttons do: all of them, so a
 * two-part change goes ahead with one yes. Null when it isn't one (a new question), nothing waits, or a card needs a
 * reason picked first (those are left for the buttons). Otherwise what happened, in words, for voice mode to say.
 */
export async function answerWaiting(
  chat: Pick<AssistantChat, 'messages' | 'calls' | 'setCall'>,
  workspaceId: string,
  words: string,
): Promise<string | null> {
  const waiting = waitingCards(chat);
  if (!waiting.length || waiting.some((c) => c.reasons.length)) return null;
  const decision = spokenDecision(words);
  if (!decision) return null;
  const said: string[] = [];
  for (const card of waiting) {
    try {
      said.push(
        await decideCard(
          workspaceId,
          chat.setCall,
          card,
          decision === 'yes' ? 'confirm' : 'cancel',
        ),
      );
    } catch (e) {
      said.push(e instanceof Error ? e.message : ASSISTANT_CONFIRM_WORDS.failed);
    }
  }
  return said.join(' ');
}
