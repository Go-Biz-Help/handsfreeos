'use client';
import { spokenDecision } from '@hfos/core';
import { errorMessage } from '@/lib/api/client';
import type { AnswerMessage, AssistantValue } from './assistant-provider';
import { decideCard, type ConfirmCardData } from './confirm-card';

/**
 * The cards in the chat still waiting for an OK that a yes could give (not ones a rule stops). They're the newest
 * answer's cards: a card keeps waiting while other things are asked, until a newer answer shows cards of its own and
 * they replace it (the worker does the same). With `answer`, only that answer's.
 */
export function waitingCards(
  a: Pick<AssistantValue, 'messages' | 'calls'>,
  answer?: AnswerMessage,
): ConfirmCardData[] {
  const latest = answer ?? newestWithCards(a.messages);
  return (latest?.cards ?? []).flatMap((c) =>
    c.type === 'confirm' &&
    !!c.confirmLabel &&
    (a.calls[c.toolCallId]?.status ?? 'awaiting_confirmation') === 'awaiting_confirmation'
      ? [c]
      : [],
  );
}

function newestWithCards(messages: AssistantValue['messages']): AnswerMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === 'assistant' && m.cards.some((c) => c.type === 'confirm')) return m;
  }
  return undefined;
}

/**
 * A plain yes or no, said or typed, answers the cards waiting for an OK, just as their buttons do: all of them, so a
 * two-part change goes ahead with one yes. Null when it isn't one (a new question), nothing waits, or a card needs a
 * reason picked first (those are left for the buttons). Otherwise what happened, in words, for voice mode to say.
 */
export async function answerWaiting(
  a: Pick<AssistantValue, 'messages' | 'calls' | 'workspaceId' | 'setCall'>,
  words: string,
): Promise<string | null> {
  const waiting = waitingCards(a);
  if (!waiting.length || waiting.some((c) => c.reasons.length)) return null;
  const decision = spokenDecision(words);
  if (!decision) return null;
  const said: string[] = [];
  for (const card of waiting) {
    try {
      said.push(await decideCard(a, card, decision === 'yes' ? 'confirm' : 'cancel'));
    } catch (e) {
      said.push(errorMessage(e));
    }
  }
  return said.join(' ');
}
