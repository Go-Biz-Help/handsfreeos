/**
 * The stand-in for hearing and speaking (development and tests). Audio here is words: a frame the caller sends
 * is taken as UTF-8 text they said, finished and done (so one frame is one turn), and what the teammate says
 * comes back as its own words in UTF-8. A test reads a call's outgoing audio as text.
 *
 * Words wrapped in `[es]…` are heard as Spanish; a frame of `[talking]` is them starting to talk over it.
 */
import type { ListenHandlers, Listening, SpeakOptions, SpeechServices } from './speech';

export const FAKE_TALKING = '[talking]';

export function createFakeSpeech(): SpeechServices & { readonly spoken: string[] } {
  const spoken: string[] = [];
  return {
    name: 'fake',
    spoken,

    async listen(handlers: ListenHandlers): Promise<Listening> {
      let closed = false;
      return {
        send(audio) {
          if (closed) return;
          const said = audio.toString('utf8').trim();
          if (!said) return;
          if (said === FAKE_TALKING) return handlers.onSpeechStarted();
          const es = /^\[es\]\s*/.exec(said);
          handlers.onSpeechStarted();
          handlers.onWords({
            text: es ? said.slice(es[0].length) : said,
            final: true,
            endOfTurn: true,
            language: es ? 'es' : 'en',
          });
        },
        async close() {
          closed = true;
        },
      };
    },

    async *speak(text: string, options: SpeakOptions): AsyncIterable<Buffer> {
      if (options.signal?.aborted) return;
      spoken.push(text);
      yield Buffer.from(text, 'utf8');
    },
  };
}
