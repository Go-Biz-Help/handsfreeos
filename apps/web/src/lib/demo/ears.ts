import type { ScriptedEars } from '../voice/session';

/**
 * What Ask HandsFreeOS hears in a voice scene: the presenter's lines, said by the player (`p.say`) instead of into
 * the microphone, one turn at a time and in order. Nothing is recorded or sent to be heard.
 */
class DemoEars implements ScriptedEars {
  private said: { readonly words: string; readonly taken: () => void }[] = [];
  private waiting: ((words: string) => void) | null = null;

  hear(fn: (words: string) => void): () => void {
    const next = this.said.shift();
    if (next) {
      next.taken();
      queueMicrotask(() => fn(next.words));
      return () => {};
    }
    this.waiting = fn;
    return () => {
      if (this.waiting === fn) this.waiting = null;
    };
  }

  /** Says `words` to the next turn; resolves once a turn has taken them. */
  say(words: string): Promise<void> {
    return new Promise((taken) => {
      const fn = this.waiting;
      if (fn) {
        this.waiting = null;
        taken();
        fn(words);
      } else this.said.push({ words, taken });
    });
  }

  /** Forgets anything not heard yet (a new scene, or Exit). */
  clear(): void {
    this.said = [];
    this.waiting = null;
  }
}

export const demoEars = new DemoEars();
