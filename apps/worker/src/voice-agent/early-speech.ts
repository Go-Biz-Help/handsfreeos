/**
 * Saying a reply on a call while the model is still writing it (M18 step 5), so the caller hears the first words
 * about as soon as they exist instead of after the whole reply, its check and its changes.
 *
 * - The reply's words come out of the reply (or goodbye) tool call's JSON as the model writes it
 *   (`streamSpoken` asks the provider to stream those two tools' input), and are cut into sentences.
 * - Each sentence is said once everything said so far passes the safety check. The first one that doesn't stops
 *   it, and the turn goes on the usual way: the check on the whole reply, one rewrite, a hand-off.
 * - Only a reply that's the first tool call of its answer, on a turn that holds nothing (no booking, no money
 *   asked for), is said early: a change has to happen, or wait for the team, before the words that say so. A tool
 *   called before the reply in the same answer runs after it's written, so that reply waits too.
 * - One reply per turn at most: once it chose one, a later reply in the same turn is said the usual way.
 */
import type { AiToolDefinition, AiToolInput } from '@hfos/ai';

/** The tools whose message is what the caller hears. */
const SPOKEN_TOOLS: ReadonlySet<string> = new Set(['reply', 'end_call']);

/** Where a sentence ends: its stop, any closing quote or bracket, and the space after. */
const SENTENCE_END = /[.!?]+["'”’)\]]*\s+/;

/** A tool definition as a call sends it: the reply and goodbye stream as they're written. */
export function streamSpoken(tool: AiToolDefinition): AiToolDefinition {
  return SPOKEN_TOOLS.has(tool.name) ? { ...tool, streamInput: true } : tool;
}

export interface EarlySpeechOptions {
  /** Whether the words so far may be said: the safety check on them. */
  readonly passes: (words: string) => boolean;
  /** Whether the turn may say anything before it's done: nothing held, no money asked for. */
  readonly mayStart: () => boolean;
  /** Says one sentence now; `ending` when it's the goodbye (end_call). */
  readonly say: (sentence: string, ending: boolean) => void;
}

export class EarlySpeech {
  /** The first tool call of each of the model's answers. */
  private readonly firsts = new Map<number, string>();
  /** The call it's saying, once it chose one. */
  private callId: string | null = null;
  private message = '';
  /** How much of the message has been said. */
  private upTo = 0;
  private stopped = false;

  constructor(private readonly options: EarlySpeechOptions) {}

  /** The start of the reply it said while it was written ('' when nothing was). */
  get said(): string {
    return this.message.slice(0, this.upTo).trim();
  }

  /** The tool loop's `onToolInput`. */
  readonly onToolInput = (input: AiToolInput, answer: number): void => {
    if (!this.firsts.has(answer)) this.firsts.set(answer, input.id);
    if (this.stopped) return;
    if (this.callId === null) {
      if (!SPOKEN_TOOLS.has(input.name) || this.firsts.get(answer) !== input.id) return;
      if (!this.options.mayStart()) {
        this.stopped = true;
        return;
      }
      this.callId = input.id;
    }
    if (input.id !== this.callId) return;
    const message = partialString(input.json, 'message');
    if (!message) return;
    this.message = message.text;
    // The last sentence goes as soon as the message's closing quote arrives: what follows it in the call (its
    // language) is never said, so waiting for the whole call only kept a one-sentence answer quiet longer.
    this.sayWhatsReady(input.name === 'end_call', message.whole);
  };

  /** Says every finished sentence not yet said (and, once the message is whole, the last one). */
  private sayWhatsReady(ending: boolean, whole: boolean): void {
    for (;;) {
      const rest = this.message.slice(this.upTo);
      const end = SENTENCE_END.exec(rest);
      const cut = end ? end.index + end[0].length : whole && rest.trim() ? rest.length : 0;
      if (!cut) return;
      if (!this.options.passes(this.message.slice(0, this.upTo + cut).trim())) {
        this.stopped = true;
        return;
      }
      this.upTo += cut;
      this.options.say(rest.slice(0, cut).trim(), ending);
    }
  }
}

const SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
};

/**
 * A string field of a JSON object that's still being written: as much of its value as has arrived, and whether
 * the value is all there. Null when the field hasn't started yet, isn't a string, or the JSON isn't an object.
 */
export function partialString(
  json: string,
  key: string,
): { readonly text: string; readonly whole: boolean } | null {
  let i = 0;
  const skipSpace = () => {
    while (i < json.length && /\s/.test(json[i]!)) i++;
  };
  /** A string starting at i (its opening quote), up to its closing quote or as far as it goes. */
  const readString = (): { text: string; whole: boolean } => {
    let text = '';
    i++;
    while (i < json.length) {
      const c = json[i]!;
      if (c === '"') {
        i++;
        return { text, whole: true };
      }
      if (c !== '\\') {
        text += c;
        i++;
        continue;
      }
      const e = json[i + 1];
      if (e === undefined) break;
      if (e === 'u') {
        const hex = json.slice(i + 2, i + 6);
        if (hex.length < 4) break;
        text += String.fromCharCode(Number.parseInt(hex, 16));
        i += 6;
        continue;
      }
      text += SIMPLE_ESCAPES[e] ?? e;
      i += 2;
    }
    return { text, whole: false };
  };
  /** Skips a whole value at i; false when it isn't all there yet. */
  const skipValue = (): boolean => {
    if (json[i] === '"') return readString().whole;
    let depth = 0;
    while (i < json.length) {
      const c = json[i]!;
      if (c === '"') {
        if (!readString().whole) return false;
        continue;
      }
      if (c === '{' || c === '[') depth++;
      else if (c === '}' || c === ']') {
        if (depth === 0) return true;
        depth--;
      } else if (c === ',' && depth === 0) return true;
      i++;
    }
    return false;
  };

  skipSpace();
  if (json[i] !== '{') return null;
  i++;
  for (;;) {
    skipSpace();
    if (json[i] === ',') {
      i++;
      continue;
    }
    if (json[i] !== '"') return null;
    const name = readString();
    if (!name.whole) return null;
    skipSpace();
    if (json[i] !== ':') return null;
    i++;
    skipSpace();
    if (i >= json.length) return null;
    if (name.text === key) return json[i] === '"' ? readString() : null;
    if (!skipValue()) return null;
  }
}
