/**
 * The stopwatch on one turn of a call (and of the test console's calls): when the AI was asked, when its answer
 * started, when its first sentence was ready, and on a real call when its first sound went down the line. The
 * console shows it with the turn (TestSteps); a real call logs it, one line a turn.
 */
import type { AiFirstBlock, AiUsage } from '@hfos/ai';
import type { TestSteps } from '@hfos/core/server';

export class TurnClock {
  readonly started = Date.now();
  /** The AI was asked: after the knowledge search and the budget check. */
  asked: number | null = null;
  /** Its answer started coming back. */
  answered: number | null = null;
  /** It thought before it wrote anything. */
  thought = false;
  /** The first sentence was written and checked, ready to say. */
  firstSentence: number | null = null;
  /** A real call: the reply's first sound went to the phone line. */
  firstAudio: number | null = null;
  /** The first AI call's instructions: how much was found ready, and how much read fresh (tokens). */
  readyTokens = 0;
  freshTokens = 0;
  private counted = false;

  /** The tool loop's `onAsked`: only the turn's first AI call counts. */
  readonly onAsked = (answer: number): void => {
    if (answer === 1 && this.asked === null) this.asked = Date.now();
  };

  /** The tool loop's `onStarted`. */
  readonly onStarted = (answer: number, first: AiFirstBlock): void => {
    if (answer !== 1 || this.answered !== null) return;
    this.answered = Date.now();
    this.thought = first === 'thinking';
  };

  /** Each AI call's tokens: the first says whether its instructions were ready. */
  usage(u: AiUsage): void {
    if (this.counted) return;
    this.counted = true;
    this.readyTokens = u.cacheReadTokens;
    this.freshTokens = u.inputTokens + u.cacheWriteTokens;
  }

  sentence(): void {
    this.firstSentence ??= Date.now();
  }

  audio(): void {
    this.firstAudio ??= Date.now();
  }

  /** The console's steps; null when the AI was never asked (a hand-off before it). */
  steps(): TestSteps | null {
    if (this.asked === null) return null;
    return {
      loadMs: this.asked - this.started,
      waitMs: this.answered === null ? null : this.answered - this.asked,
      sentenceMs:
        this.firstSentence === null || this.answered === null
          ? null
          : this.firstSentence - this.answered,
      thought: this.thought,
      ready: this.readyTokens > 0,
    };
  }

  /** A real call's log line: each step, and the whole wait from the end of their words to the first sound. */
  log(): Record<string, number | boolean | null> {
    const s = this.steps();
    return {
      loadMs: s?.loadMs ?? null,
      waitMs: s?.waitMs ?? null,
      sentenceMs: s?.sentenceMs ?? null,
      voiceMs:
        this.firstAudio === null
          ? null
          : this.firstAudio - (this.firstSentence ?? this.answered ?? this.started),
      firstSoundMs: this.firstAudio === null ? null : this.firstAudio - this.started,
      thought: this.thought,
      readyTokens: this.readyTokens,
      freshTokens: this.freshTokens,
    };
  }
}
