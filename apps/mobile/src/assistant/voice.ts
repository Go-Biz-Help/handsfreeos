import {
  ASSISTANT_VOICE,
  closingSpoken,
  nextSpoken,
  SPOKEN_START,
  spokenDecision,
  type SpokenAnswer,
} from '@hfos/core';
import * as React from 'react';

import { useVoice } from '@/voice/use-voice';

import type { AnswerMessage, AssistantChat } from './chat';
import { decideCard, type ConfirmCardData } from './decide';

/** The answer being read out: where it starts in the chat, and how much of it has been said. */
interface Following {
  readonly from: number;
  spoken: SpokenAnswer;
  done: boolean;
}

/** The cards still waiting for an OK that a yes could give (not ones a rule stops). */
function waitingCards(chat: AssistantChat, answer?: AnswerMessage): ConfirmCardData[] {
  const answers = answer
    ? [answer]
    : chat.messages.filter((m): m is AnswerMessage => m.role === 'assistant').slice(-1);
  return answers.flatMap((m) =>
    m.cards.flatMap((c) =>
      c.type === 'confirm' &&
      !!c.confirmLabel &&
      (chat.calls[c.toolCallId]?.status ?? 'awaiting_confirmation') === 'awaiting_confirmation'
        ? [c]
        : [],
    ),
  );
}

/**
 * Ask HandsFreeOS out loud and hands-free, as on the web (apps/web/src/components/assistant/voice.ts): it listens,
 * asks what was said, reads the answer as it's written (in its own voice), and listens again. When a card waits for
 * an OK it asks "Should I go ahead?", and a plain yes or no confirms or cancels it, just as the buttons do. Anything
 * else is a new question. Talk cuts it off to speak; Stop turns it off.
 */
export function useAssistantVoice(chat: AssistantChat, workspaceId: string) {
  const { session, snap } = useVoice(workspaceId, ASSISTANT_VOICE);
  const latest = React.useRef(chat);
  latest.current = chat;
  const following = React.useRef<Following | null>(null);

  /** Hears one turn and acts on it. */
  const turn = React.useRef(async () => {});
  turn.current = async () => {
    const words = await session.listen();
    if (!words) return;
    const now = latest.current;
    const waiting = waitingCards(now);
    const only = waiting.length === 1 && !waiting[0]!.reasons.length ? waiting[0]! : null;
    const decision = only ? spokenDecision(words) : null;
    if (only && decision) {
      const cut = session.generation;
      let said: string;
      try {
        said = await decideCard(
          workspaceId,
          now.setCall,
          only,
          decision === 'yes' ? 'confirm' : 'cancel',
        );
      } catch (e) {
        said = e instanceof Error ? e.message : 'That didn’t work. Try again.';
      }
      if (!session.on || session.generation !== cut) return;
      session.speak(said);
      await session.finishSpeaking();
      if (session.on && session.generation === cut) await turn.current();
      return;
    }
    if (now.running) {
      session.idle();
      return;
    }
    const f: Following = { from: now.messages.length, spoken: SPOKEN_START, done: false };
    following.current = f;
    session.hold(true);
    if (now.ask(words, { spoken: true })) return;
    // The question didn't go (the screen can't take one now): nothing to wait for.
    f.done = true;
    session.hold(false);
    session.idle();
  };

  // The answer is read out as it arrives, a sentence at a time; once it's finished, what's left to say, and then
  // it listens again.
  React.useEffect(() => {
    const f = following.current;
    if (!f || f.done || !session.on) return;
    const answer = chat.messages
      .slice(f.from)
      .find((m): m is AnswerMessage => m.role === 'assistant');
    if (!answer) {
      // The question was taken back (not set up after all): nothing to wait for.
      if (!chat.running && chat.messages.length <= f.from) {
        f.done = true;
        session.hold(false);
        session.idle();
      }
      return;
    }
    const next = nextSpoken(f.spoken, answer.text, !answer.live);
    f.spoken = next.state;
    for (const words of next.say) session.speak(words);
    if (answer.live) return;
    f.done = true;
    session.hold(false);
    const closing = closingSpoken({
      state: f.spoken,
      notice: answer.notice && answer.notice.code !== 'stopped' ? answer.notice.message : null,
      waiting: waitingCards(chat, answer).map((c) => ({
        title: c.title,
        needsReason: c.reasons.length > 0,
      })),
    });
    for (const words of closing) session.speak(words);
    const cut = session.generation;
    void session.finishSpeaking().then(() => {
      if (session.on && session.generation === cut && following.current === f) void turn.current();
    });
  }, [chat.messages, chat.calls, chat.running, session]);

  return {
    session,
    snap,
    /** The mic: turns talking out loud on (and listens) or off. */
    async toggle() {
      if (session.on) {
        following.current = null;
        session.stop();
        return;
      }
      if (await session.start()) void turn.current();
    },
    /** Talk: listen now, cutting off whatever it's saying. */
    talk() {
      if (following.current) following.current.done = true;
      session.hold(false);
      void turn.current();
    },
  };
}

export type AssistantVoice = ReturnType<typeof useAssistantVoice>;
