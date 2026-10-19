/**
 * One live phone call the AI teammate answers (M18 step 5): the caller's audio in, its voice out, and the turns
 * in between. It knows nothing about websockets: the route (http/voice-agent.ts) hands it a `CallLink` that
 * sends audio, marks and "stop playing" to Twilio, and feeds it what Twilio sends.
 *
 * - It listens for the whole call. A turn starts when the listener says the caller finished a thought; words
 *   heard while it's thinking wait for the next turn.
 * - It speaks a sentence at a time, and knows a reply has been heard when Twilio plays back the mark sent after
 *   it. A reply starts while the model is still writing it: each checked sentence is said as it's ready
 *   (brain.ts, early-speech.ts), and the rest follows once the turn is done. The caller talking over it stops it
 *   as soon as their first words are heard (barge-in), except while it says goodbye or connects them; a sound
 *   that isn't words doesn't, and nor does its own voice coming back through their microphone (echoOf).
 * - Sentences go down one voice connection opened while the greeting plays (VoiceLine), which saves each the
 *   time a request takes to start; one the connection can't take goes by request, as the greeting does.
 * - Quiet after it spoke: it asks whether they're still there, then says goodbye and hangs up.
 * - A hand-off rings the team on the same call (the transfer TwiML); a goodbye hangs up; the caller hanging up
 *   ends it. However it ends, the call's words are saved and its run closed.
 *
 * When it can't start (the teammate turned off, no balance, a reply running on the conversation), `start` says
 * so and the route closes the stream: Twilio then goes on to the voicemail after the stream in the TwiML.
 *
 * What it listened to and said is the business's to pay for (money/speech-usage.ts): the minutes it listened and
 * the characters it spoke are added to the running totals when the call ends.
 *
 * What thinks on the call, and what its endings do, is its CallMind: a real call's (brain.ts `realCall`), or a live
 * test call's from the test console (ai-team/test-call.ts), which thinks the way the console does and only
 * pretends to change anything. Everything about hearing, speaking and timing is this file's, so a test call's
 * pauses are a real call's.
 */
import type { Logger } from 'pino';
import type { ConversationHandoffReason, PhoneVoice } from '@hfos/core/server';
import type { CallEnding, TurnOutcome } from './brain';
import { CANT_GO_ON, GOODBYE, STILL_THERE, tongue, type CallLine } from './prompt';
import {
  LineBusy,
  voiceModel,
  type HeardWords,
  type Listening,
  type SpeechServices,
  type VoiceLine,
} from './speech';
import { TurnClock } from './turn-clock';

/** What the session sends Twilio. */
export interface CallLink {
  sendAudio(audio: Buffer): void;
  /** Twilio sends it back once everything before it has played. */
  sendMark(name: string): void;
  /** Stops what's playing (the caller talked over it). */
  clear(): void;
  close(): void;
}

export interface SessionTimings {
  /** Quiet this long after it spoke: "Are you still there?". */
  readonly quietMs: number;
  /** Then this much longer: goodbye. */
  readonly goneMs: number;
  /** Longest it waits for Twilio to say a reply has played. */
  readonly markMs: number;
  /** Longest call it takes before handing it to the team. */
  readonly maxCallMs: number;
}

export const SESSION_TIMINGS: SessionTimings = {
  quietMs: 12_000,
  goneMs: 10_000,
  markMs: 30_000,
  maxCallMs: 20 * 60_000,
};

export interface SessionDeps {
  readonly speech: SpeechServices;
  readonly log: Logger;
  readonly timings?: Partial<SessionTimings>;
}

/** A call set up and ready to answer: what it says first, and the voice it says everything in. */
export interface MindReady {
  readonly ok: true;
  readonly greeting: string;
  readonly voice: PhoneVoice;
  /** It placed this call (AI outbound calls) rather than answered it: how its ending is described. */
  readonly placed: boolean;
}

/** One caller turn, as the session hands it to the mind. */
export interface MindTurn {
  readonly turn: number;
  /** The call's words before this turn. */
  readonly lines: readonly CallLine[];
  readonly said: string;
  readonly language: string | null;
  /** Says a checked sentence of the reply while the rest is still being written; `ending` for a goodbye. */
  readonly speak: (sentence: string, ending: boolean) => void;
  /** The turn's stopwatch, started when they finished talking. */
  readonly clock: TurnClock;
}

/**
 * What thinks on a call and what its endings do. The session does the hearing, the speaking and the waiting; the
 * mind sets the call up, answers each turn, and says what hanging up, handing on and finishing mean.
 */
export interface CallMind {
  /** Sets the call up, or says why it can't answer (the caller then gets what comes after the stream). */
  prepare(): Promise<MindReady | { readonly ok: false; readonly why: string }>;
  /** While the greeting plays: whatever gets the first turn ready sooner. */
  warm(): Promise<void>;
  /** One turn: what the caller said, answered. */
  think(turn: MindTurn): Promise<TurnOutcome>;
  /** It said goodbye: end the call on the phone's side (the session closes the stream after). */
  hangUp(): Promise<void>;
  /** Hands the caller on after it said so (the session closes the stream after). */
  transfer(reason: ConversationHandoffReason, note: string): Promise<void>;
  /** However the call ended, once: its words saved, its run closed. */
  finish(lines: readonly CallLine[], ending: CallEnding): Promise<void>;
  /** What it listened to (seconds) and every character it asked to have said: the business's to pay for. */
  noteSpeech(listenedSeconds: number, said: string): Promise<void>;
  /** Words heard so far (interim or final), as the listener gives them. */
  heard?(words: HeardWords): void;
  /** The caller talked over the reply to `turn` (0 is the greeting), so the rest of it wasn't said. */
  cut?(turn: number): void;
  /** A turn's answer has been said: where its time went. */
  timed?(turn: number, timing: ReturnType<TurnClock['log']>): void;
}

/**
 * Says one sentence: down the call's open voice when it has one, and by request when that can't take it. Once any
 * of it went down the line it isn't said again (the caller would hear it twice): a failure then is the sentence's.
 */
export async function sayOne(o: {
  readonly line: VoiceLine | null;
  readonly byRequest: () => AsyncIterable<Buffer>;
  readonly sentence: string;
  readonly signal: AbortSignal;
  readonly send: (audio: Buffer) => void;
  /** The line broke (not merely busy): the call counts it. */
  readonly lineFailed: (e: unknown) => void;
}): Promise<void> {
  if (o.line) {
    let sent = false;
    try {
      for await (const audio of o.line.say(o.sentence, o.signal)) {
        if (o.signal.aborted) return;
        sent = true;
        o.send(audio);
      }
      return;
    } catch (e) {
      if (o.signal.aborted) return;
      if (sent) throw e;
      if (!(e instanceof LineBusy)) o.lineFailed(e);
    }
  }
  for await (const audio of o.byRequest()) {
    if (o.signal.aborted) return;
    o.send(audio);
  }
}

/** After this many failures of the call's open voice, every sentence goes by request for the rest of the call. */
const LINE_FAILURES_MAX = 3;

const REASON_WORDS: Partial<Record<ConversationHandoffReason, string>> = {
  asked_for_person: 'they asked for a person',
  frustrated: 'they sounded frustrated',
  cant_answer: 'it couldn’t answer',
  emergency: 'an emergency',
  legal: 'a legal threat',
  complaint: 'a complaint',
  refund: 'a refund',
  cancellation: 'cancelling service',
  limit: 'a limit was reached',
  budget: 'the AI limit was reached',
  error: 'something went wrong',
};

/** Something it says: sentences are added as they're ready and said in order. */
interface Utterance {
  readonly abort: AbortController;
  readonly interruptible: boolean;
  /** Its line in the call's words. */
  readonly line: number;
  /** The turn it answers (0: the greeting, or anything said before the first turn). */
  readonly turn: number;
  text: string;
  /** Every sentence added so far, said one after the other. */
  voiced: Promise<void>;
  /** Speaking failed: the rest isn't said. */
  failed: boolean;
  /** When it started: a turn's stopwatch counts the first sound of what it began. */
  readonly began: number;
}

/** The words of `text`, lowercase and without punctuation, as the listener's words are compared with its own. */
function wordsOf(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .split(/[^\p{L}\p{N}']+/u)
    .filter(Boolean);
}

/**
 * Words heard that are its own: nearly all of them are in what it said. Its voice reaching the caller's microphone
 * (a laptop's speakers on a test call, a phone on speaker) is heard like their words are. A few words must all be
 * its own; in a longer stretch one may be heard differently.
 */
export function echoOf(heard: string, said: string): boolean {
  const words = wordsOf(heard);
  if (!words.length) return false;
  const saying = new Set(wordsOf(said));
  const found = words.filter((w) => saying.has(w)).length;
  return words.length < 5 ? found === words.length : found / words.length >= 0.8;
}

/**
 * How long after it stops its own voice may still be heard: the listener's words come a moment after the sound.
 * A caller's one-word answer is never taken for it then.
 */
const ECHO_TAIL_MS = 1_200;

/** "Hi there. How can I help?" → two sentences, spoken one after the other. */
export function sentencesOf(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export class CallSession {
  private ready: MindReady | null = null;
  private listening: Listening | null = null;
  private readonly lines: CallLine[] = [];
  private heard: string[] = [];
  private language: string | null = null;
  private thinking = false;
  /** The call's open voice (VoiceLine), and the one being opened. */
  private voiceLine: VoiceLine | null = null;
  private opening: Promise<void> | null = null;
  private lineFailures = 0;
  /** The latest turn's stopwatch (from the pickup, for the greeting), and which turn it times. */
  private clock: TurnClock | null = null;
  private clockTurn = 0;
  private speaking: Utterance | null = null;
  /** What it said last, and until when the listener may still hear it coming back. */
  private lastSaid: { readonly text: string; readonly until: number } | null = null;
  private readonly marks = new Map<string, () => void>();
  private markSeq = 0;
  private turn = 0;
  private closed = false;
  private finished: Promise<void> | null = null;
  private ending: CallEnding | null = null;
  private quiet: NodeJS.Timeout | null = null;
  private maxTimer: NodeJS.Timeout | null = null;
  private readonly timings: SessionTimings;
  private readonly log: Logger;
  /** When it started listening: the call's listening is billed from here to the end. */
  private listenedFrom: number | null = null;
  /** Every character it asked to have said, cut short or not: each one is billed. */
  private saidText = '';
  private started: Promise<boolean> | null = null;

  constructor(
    private readonly deps: SessionDeps,
    private readonly link: CallLink,
    private readonly mind: CallMind,
    /** What its log lines carry (a real call's sid, a test call's id). */
    logBindings: Readonly<Record<string, unknown>> = {},
  ) {
    this.timings = { ...SESSION_TIMINGS, ...deps.timings };
    this.log = deps.log.child(logBindings);
  }

  /**
   * Sets the call up and says hello; false when it can't answer (the caller then gets voicemail). Asking again
   * gets the same answer: the stream's route and a test call's console may both start it.
   */
  start(): Promise<boolean> {
    this.started ??= this.pickUp();
    return this.started;
  }

  private async pickUp(): Promise<boolean> {
    // The greeting's stopwatch: from the pickup to its first sound.
    this.clock = new TurnClock();
    this.clockTurn = 0;
    try {
      this.listening = await this.deps.speech.listen({
        onWords: (w) => this.onWords(w),
        onSpeechStarted: () => this.onSpeechStarted(),
        onUtteranceEnd: () => this.maybeTurn(),
        onError: (e) => this.log.warn({ err: e }, 'the call’s listener failed'),
      });
      this.listenedFrom = Date.now();
    } catch (e) {
      this.log.warn({ err: e }, 'couldn’t start listening to a call');
      return false;
    }
    let prepared: MindReady | { readonly ok: false; readonly why: string };
    try {
      prepared = await this.mind.prepare();
    } catch (e) {
      this.log.error({ err: e }, 'couldn’t set up a call for the AI teammate');
      prepared = { ok: false as const, why: 'error' };
    }
    if (!prepared.ok) {
      this.log.info({ why: prepared.why }, 'the AI teammate didn’t take a call');
      this.closed = true;
      await this.listening.close().catch(() => undefined);
      return false;
    }
    this.ready = prepared;
    // They hung up while it was getting ready: the run it just started is closed like any other call's.
    if (this.closed) {
      await this.mind
        .finish(this.lines, {
          outcome: 'no_reply',
          summary: 'A call it was about to answer; they hung up first.',
          turns: 0,
          lastSaid: null,
        })
        .catch((e: unknown) => this.log.error({ err: e }, 'couldn’t close a call’s run'));
      return false;
    }
    this.maxTimer = setTimeout(
      () =>
        void this.act({
          kind: 'transfer',
          text: CANT_GO_ON[tongue(this.language)],
          language: this.language,
          reason: 'limit',
          note: 'The call ran past twenty minutes, so it handed it to the team.',
        }),
      this.timings.maxCallMs,
    );
    // While the greeting plays: the call's FAQ and open times are read, and the AI reads its instructions, so
    // the first thing the caller asks finds them ready. A turn that starts sooner waits for the reading.
    void this.mind
      .warm()
      .catch((e: unknown) => this.log.warn({ err: e }, 'couldn’t get a call ready'));
    // The call's voice opens meanwhile too: the greeting goes by request, and every sentence after down the line.
    this.openLine(this.language);
    const said = await this.say(prepared.greeting);
    if (said === 'done') this.armQuiet();
    this.maybeTurn();
    return true;
  }

  /** One frame of the caller's audio. */
  onAudio(audio: Buffer): void {
    if (!this.closed) this.listening?.send(audio);
  }

  /** Twilio played everything up to this mark. */
  onMark(name: string): void {
    const done = this.marks.get(name);
    if (done) {
      this.marks.delete(name);
      done();
    }
  }

  /** The stream ended: they hung up, it was handed on, or it failed. Saves the call once. */
  stop(): Promise<void> {
    this.finished ??= this.finish();
    return this.finished;
  }

  // ---- hearing ----

  /**
   * A sound: maybe they're talking, so it doesn't ask whether they're still there. Only their words stop it
   * (talkedOver): a cough, a breath or a noise in the room starts a sound too.
   */
  private onSpeechStarted(): void {
    this.clearQuiet();
  }

  private onWords(w: HeardWords): void {
    if (this.closed) return;
    // Its own voice coming back isn't them: it neither stops it nor is taken as what they said.
    if (w.text && this.ownWords(w.text)) return;
    this.clearQuiet();
    if (w.text) this.talkedOver();
    this.mind.heard?.(w);
    if (w.language) this.language = w.language;
    if (w.final && w.text) this.heard.push(w.text);
    if (w.endOfTurn) this.maybeTurn();
  }

  /** Its own voice heard back: what it's saying, or (two words at least) what it just finished saying. */
  private ownWords(text: string): boolean {
    if (this.speaking && echoOf(text, this.speaking.text)) return true;
    const last = this.lastSaid;
    return !!last && Date.now() < last.until && wordsOf(text).length > 1 && echoOf(text, last.text);
  }

  /** Words while it's talking: they're talking over it, so it stops, once, and lets them finish. */
  private talkedOver(): void {
    const speaking = this.speaking;
    if (!speaking?.interruptible || speaking.abort.signal.aborted) return;
    speaking.abort.abort();
    this.link.clear();
    const last = this.lines[this.lines.length - 1];
    if (last?.who === 'teammate')
      this.lines[this.lines.length - 1] = { ...last, text: `${last.text} (interrupted)` };
    this.mind.cut?.(speaking.turn);
  }

  private maybeTurn(): void {
    if (this.closed || !this.ready || this.thinking || !this.heard.length) return;
    if (this.speaking && !this.speaking.interruptible) return;
    void this.runTurn();
  }

  private async runTurn(): Promise<void> {
    this.thinking = true;
    const said = this.heard.join(' ').trim();
    this.heard = [];
    const before = [...this.lines];
    this.lines.push({ who: 'caller', text: said });
    const turn = ++this.turn;
    const clock = new TurnClock();
    this.clock = clock;
    this.clockTurn = turn;
    // The start of the reply, said while the model is still writing the rest.
    const early: { utterance: Utterance | null } = { utterance: null };
    const speak = (sentence: string, ending: boolean) => {
      if (this.closed) return;
      early.utterance ??= this.begin({ interruptible: !ending });
      this.add(early.utterance, sentence);
    };
    let outcome: TurnOutcome;
    try {
      outcome = await this.mind.think({
        turn,
        lines: before,
        said,
        language: this.language,
        speak,
        clock,
      });
    } catch (e) {
      this.log.error({ err: e, turn }, 'a call turn failed');
      outcome = {
        kind: 'transfer',
        text: CANT_GO_ON[tongue(this.language)],
        language: this.language,
        reason: 'error',
        note: 'Something went wrong on the call.',
      };
    }
    this.thinking = false;
    if (this.closed) return;
    await this.act(outcome, early.utterance);
    // Where the turn's time went, from the end of their words to the first sound (TurnClock).
    this.log.info({ turn, early: !!early.utterance, ...clock.log() }, 'a call turn’s timings');
    // Nothing was said (a silent turn): the stopwatch is told once it's over instead.
    if (clock.firstAudio === null) this.mind.timed?.(turn, clock.log());
  }

  // ---- doing ----

  private async act(o: TurnOutcome, early: Utterance | null = null): Promise<void> {
    if (this.closed) return;
    if (o.language) this.language = o.language;
    // What it started saying early: the reply goes on from there, or it finishes before what comes next.
    let going: Utterance | null = null;
    if (early && o.kind !== 'transfer' && o.spoken) {
      for (const sentence of sentencesOf(o.text.slice(o.spoken))) this.add(early, sentence);
      going = early;
    } else if (early) await this.end(early);
    if (o.kind === 'say') {
      const said = going ? await this.end(going) : await this.say(o.text);
      if (said === 'done') this.armQuiet();
      this.maybeTurn();
      return;
    }
    this.clearQuiet();
    if (o.kind === 'end') {
      if (going) await this.end(going);
      else await this.say(o.text, { interruptible: false });
      this.ending = {
        outcome: 'replied',
        summary: `${this.ready?.placed ? 'Called them' : 'Answered a call'} (${this.turn} ${this.turn === 1 ? 'turn' : 'turns'}) and said goodbye.`,
        turns: this.turn,
        lastSaid: o.text,
      };
      await this.hangUp();
      return;
    }
    await this.say(o.text, { interruptible: false });
    await this.transfer(o.reason, o.note);
  }

  /** Says it, a sentence at a time; 'cut' when the caller talked over it or the call ended. */
  private async say(
    text: string,
    opts: { readonly interruptible?: boolean } = {},
  ): Promise<'done' | 'cut'> {
    if (!this.ready || this.closed) return 'cut';
    const u = this.begin(opts, text);
    for (const sentence of sentencesOf(text)) this.voice(u, sentence);
    return this.end(u);
  }

  /** Starts saying something: its sentences follow (`add`), and `end` waits until they've been heard. */
  private begin(opts: { readonly interruptible?: boolean }, text = ''): Utterance {
    const u: Utterance = {
      abort: new AbortController(),
      interruptible: opts.interruptible ?? true,
      line: this.lines.length,
      turn: this.turn,
      text,
      voiced: Promise.resolve(),
      failed: false,
      began: Date.now(),
    };
    this.lines.push({ who: 'teammate', text });
    this.speaking = u;
    return u;
  }

  /** One more sentence of it, said once the ones before it have been. */
  private add(u: Utterance, sentence: string): void {
    if (this.closed || u.abort.signal.aborted || u.failed) return;
    u.text = u.text ? `${u.text} ${sentence}` : sentence;
    this.lines[u.line] = { who: 'teammate', text: u.text };
    this.voice(u, sentence);
  }

  private voice(u: Utterance, sentence: string): void {
    const ready = this.ready!;
    u.voiced = u.voiced.then(async () => {
      if (u.abort.signal.aborted || u.failed) return;
      this.saidText += sentence;
      try {
        await sayOne({
          line: this.lineFor(this.language),
          byRequest: () =>
            this.deps.speech.speak(sentence, {
              voice: ready.voice,
              language: this.language,
              signal: u.abort.signal,
            }),
          sentence,
          signal: u.abort.signal,
          send: (audio) => {
            const clock = this.clock;
            if (clock && u.began >= clock.started && clock.firstAudio === null) {
              clock.audio();
              // The first sound of the answer: where the wait went, as soon as it's over.
              this.mind.timed?.(this.clockTurn, clock.log());
            }
            this.link.sendAudio(audio);
          },
          lineFailed: (e) => {
            this.lineFailures++;
            this.log.warn({ err: e }, 'the call’s voice failed; saying the sentence by request');
          },
        });
      } catch (e) {
        if (u.abort.signal.aborted) return;
        u.failed = true;
        this.log.warn({ err: e }, 'couldn’t speak on a call');
      }
    });
  }

  /**
   * The call's open voice in the caller's language, when one is ready (VoiceLine). Otherwise it opens one for the
   * sentences after this, and this one goes by request. After a few failures it stops trying for the call.
   */
  private lineFor(language: string | null): VoiceLine | null {
    const ready = this.ready;
    if (!ready || !this.deps.speech.openVoice) return null;
    const model = voiceModel(ready.voice, language);
    const line = this.voiceLine;
    if (line?.open && line.model === model) return line;
    if (line) {
      line.close();
      this.voiceLine = null;
    }
    this.openLine(language);
    return null;
  }

  private openLine(language: string | null): void {
    const ready = this.ready;
    const open = this.deps.speech.openVoice;
    if (!ready || !open || this.opening || this.closed || this.lineFailures >= LINE_FAILURES_MAX)
      return;
    this.opening = open({ voice: ready.voice, language })
      .then((line) => {
        if (this.closed) line.close();
        else this.voiceLine = line;
      })
      .catch((e: unknown) => {
        this.lineFailures++;
        this.log.warn(
          { err: e },
          'couldn’t open a voice for the call; it says each sentence by request',
        );
      })
      .finally(() => {
        this.opening = null;
      });
  }

  /** Waits until all of it has played (Twilio's mark); 'cut' when the caller talked over it or the call ended. */
  private async end(u: Utterance): Promise<'done' | 'cut'> {
    try {
      await u.voiced;
      if (!u.abort.signal.aborted && !u.failed && !this.closed) {
        const name = `said-${++this.markSeq}`;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, this.timings.markMs);
          const done = () => {
            clearTimeout(timer);
            u.abort.signal.removeEventListener('abort', done);
            resolve();
          };
          this.marks.set(name, done);
          u.abort.signal.addEventListener('abort', done);
          this.link.sendMark(name);
        });
      }
    } finally {
      if (this.speaking === u) this.speaking = null;
      this.lastSaid = { text: u.text, until: Date.now() + ECHO_TAIL_MS };
    }
    return u.abort.signal.aborted || this.closed ? 'cut' : 'done';
  }

  private armQuiet(): void {
    this.clearQuiet();
    if (this.closed) return;
    this.quiet = setTimeout(() => {
      if (this.closed || this.thinking || this.heard.length) return;
      void this.say(STILL_THERE[tongue(this.language)]).then((said) => {
        if (said !== 'done' || this.closed) return;
        this.quiet = setTimeout(() => {
          if (this.closed || this.thinking || this.heard.length) return;
          void this.goodbye();
        }, this.timings.goneMs);
      });
    }, this.timings.quietMs);
  }

  private clearQuiet(): void {
    if (this.quiet) clearTimeout(this.quiet);
    this.quiet = null;
  }

  private async goodbye(): Promise<void> {
    const text = GOODBYE[tongue(this.language)];
    await this.say(text, { interruptible: false });
    this.ending = {
      outcome: this.turn ? 'replied' : 'no_reply',
      summary: `${this.ready?.placed ? 'Called them' : 'Answered a call'}; the line went quiet, so it said goodbye.`,
      turns: this.turn,
      lastSaid: text,
    };
    await this.hangUp();
  }

  private async hangUp(): Promise<void> {
    try {
      await this.mind.hangUp();
    } catch (e) {
      this.log.warn({ err: e }, 'couldn’t hang up a call');
    }
    this.link.close();
    await this.stop();
  }

  /** Hands the caller on (a real call rings the team on this call; nobody answering goes to voicemail). */
  private async transfer(reason: ConversationHandoffReason, note: string): Promise<void> {
    this.ending = {
      outcome: 'handed_off',
      summary: `${this.ready?.placed ? 'Called them' : 'Answered a call'} and connected them to the team: ${REASON_WORDS[reason] ?? 'they needed a person'}.`,
      turns: this.turn,
      lastSaid: this.lines.findLast((l) => l.who === 'teammate')?.text ?? null,
    };
    try {
      await this.mind.transfer(reason, note);
    } catch (e) {
      // The stream closing sends the call on to the voicemail after it in the TwiML.
      this.log.warn({ err: e }, 'couldn’t connect a caller to the team');
    }
    this.link.close();
    await this.stop();
  }

  private async finish(): Promise<void> {
    this.closed = true;
    this.clearQuiet();
    if (this.maxTimer) clearTimeout(this.maxTimer);
    this.speaking?.abort.abort();
    for (const done of this.marks.values()) done();
    this.marks.clear();
    await this.listening?.close().catch(() => undefined);
    this.voiceLine?.close();
    this.voiceLine = null;
    const ready = this.ready;
    if (!ready) return;
    const ending: CallEnding = this.ending ?? {
      outcome: this.lines.some((l) => l.who === 'caller') ? 'replied' : 'no_reply',
      summary: `${ready.placed ? 'Called them' : 'Answered a call'} (${this.turn} ${this.turn === 1 ? 'turn' : 'turns'}); they hung up.`,
      turns: this.turn,
      lastSaid: this.lines.findLast((l) => l.who === 'teammate')?.text ?? null,
    };
    try {
      await this.mind.finish(this.lines, ending);
    } catch (e) {
      this.log.error({ err: e }, 'couldn’t close a call’s run');
    }
    await this.mind
      .noteSpeech(this.listenedFrom ? (Date.now() - this.listenedFrom) / 1000 : 0, this.saidText)
      .catch((e: unknown) =>
        this.log.error({ err: e }, 'couldn’t note what a call heard and said'),
      );
  }
}
