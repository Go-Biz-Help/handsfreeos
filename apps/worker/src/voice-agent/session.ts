/**
 * One live phone call the AI teammate answers (M18 step 5): the caller's audio in, its voice out, and the turns
 * in between. It knows nothing about websockets: the route (http/voice-agent.ts) hands it a `CallLink` that
 * sends audio, marks and "stop playing" to Twilio, and feeds it what Twilio sends.
 *
 * - It listens for the whole call. A turn starts when the listener says the caller finished a thought; words
 *   heard while it's thinking wait for the next turn.
 * - It speaks a sentence at a time, and knows a reply has been heard when Twilio plays back the mark sent after
 *   it. The caller talking over it stops it at once (barge-in), except while it says goodbye or connects them.
 * - Quiet after it spoke: it asks whether they're still there, then says goodbye and hangs up.
 * - A hand-off rings the team on the same call (the transfer TwiML); a goodbye hangs up; the caller hanging up
 *   ends it. However it ends, the call's words are saved and its run closed.
 *
 * When it can't start (the teammate turned off, no balance, a reply running on the conversation), `start` says
 * so and the route closes the stream: Twilio then goes on to the voicemail after the stream in the TwiML.
 */
import type { Logger } from 'pino';
import type { ConversationHandoffReason } from '@hfos/core/server';
import {
  finishCall,
  handOffForTransfer,
  prepareCall,
  thinkTurn,
  type BrainDeps,
  type CallEnding,
  type PreparedCall,
  type TurnOutcome,
} from './brain';
import { CANT_GO_ON, GOODBYE, greetingOf, STILL_THERE, tongue, type CallLine } from './prompt';
import type { HeardWords, Listening, SpeechServices } from './speech';
import type { StreamTicket } from './ticket';

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

export interface SessionDeps extends BrainDeps {
  readonly speech: SpeechServices;
  /** The TwiML that rings the team for this call (http/voice.ts), or voicemail when nobody can be rung. */
  readonly transferTwiml: (ticket: StreamTicket) => Promise<string>;
  readonly timings?: Partial<SessionTimings>;
}

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

/** "Hi there. How can I help?" → two sentences, spoken one after the other. */
export function sentencesOf(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export class CallSession {
  private call: PreparedCall | null = null;
  private listening: Listening | null = null;
  private readonly lines: CallLine[] = [];
  private heard: string[] = [];
  private language: string | null = null;
  private thinking = false;
  private speaking: { readonly abort: AbortController; readonly interruptible: boolean } | null =
    null;
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

  constructor(
    private readonly deps: SessionDeps,
    private readonly link: CallLink,
    private readonly ticket: StreamTicket,
  ) {
    this.timings = { ...SESSION_TIMINGS, ...deps.timings };
    this.log = deps.log.child({ callSid: ticket.callSid });
  }

  /** Sets the call up and says hello; false when it can't answer (the caller then gets voicemail). */
  async start(): Promise<boolean> {
    try {
      this.listening = await this.deps.speech.listen({
        onWords: (w) => this.onWords(w),
        onSpeechStarted: () => this.onSpeechStarted(),
        onUtteranceEnd: () => this.maybeTurn(),
        onError: (e) => this.log.warn({ err: e }, 'the call’s listener failed'),
      });
    } catch (e) {
      this.log.warn({ err: e }, 'couldn’t start listening to a call');
      return false;
    }
    let prepared;
    try {
      prepared = await prepareCall(this.deps, this.ticket);
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
    this.call = prepared.call;
    // They hung up while it was getting ready: the run it just started is closed like any other call's.
    if (this.closed) {
      await finishCall(this.deps, prepared.call, this.lines, {
        outcome: 'no_reply',
        summary: 'A call it was about to answer; they hung up first.',
        turns: 0,
        lastSaid: null,
      }).catch((e: unknown) => this.log.error({ err: e }, 'couldn’t close a call’s run'));
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
    const said = await this.say(greetingOf(this.call.config, this.call.rc.grounding.business.name));
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

  private onSpeechStarted(): void {
    this.clearQuiet();
    // They're talking over it: stop, and let them finish.
    if (this.speaking?.interruptible) {
      this.speaking.abort.abort();
      this.link.clear();
      const last = this.lines[this.lines.length - 1];
      if (last?.who === 'teammate')
        this.lines[this.lines.length - 1] = { ...last, text: `${last.text} (interrupted)` };
    }
  }

  private onWords(w: HeardWords): void {
    if (this.closed) return;
    this.clearQuiet();
    if (w.language) this.language = w.language;
    if (w.final && w.text) this.heard.push(w.text);
    if (w.endOfTurn) this.maybeTurn();
  }

  private maybeTurn(): void {
    if (this.closed || !this.call || this.thinking || !this.heard.length) return;
    if (this.speaking && !this.speaking.interruptible) return;
    void this.runTurn();
  }

  private async runTurn(): Promise<void> {
    const call = this.call!;
    this.thinking = true;
    const said = this.heard.join(' ').trim();
    this.heard = [];
    const before = [...this.lines];
    this.lines.push({ who: 'caller', text: said });
    const turn = ++this.turn;
    let outcome: TurnOutcome;
    try {
      outcome = await thinkTurn(this.deps, call, {
        turn,
        lines: before,
        said,
        language: this.language,
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
    await this.act(outcome);
  }

  // ---- doing ----

  private async act(o: TurnOutcome): Promise<void> {
    if (this.closed) return;
    if (o.language) this.language = o.language;
    if (o.kind === 'say') {
      const said = await this.say(o.text);
      if (said === 'done') this.armQuiet();
      this.maybeTurn();
      return;
    }
    this.clearQuiet();
    if (o.kind === 'end') {
      await this.say(o.text, { interruptible: false });
      this.ending = {
        outcome: 'replied',
        summary: `Answered a call (${this.turn} ${this.turn === 1 ? 'turn' : 'turns'}) and said goodbye.`,
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
    const call = this.call;
    if (!call || this.closed) return 'cut';
    this.lines.push({ who: 'teammate', text });
    const abort = new AbortController();
    this.speaking = { abort, interruptible: opts.interruptible ?? true };
    try {
      for (const sentence of sentencesOf(text)) {
        for await (const audio of this.deps.speech.speak(sentence, {
          voice: call.config.phone.voice,
          language: this.language,
          signal: abort.signal,
        })) {
          if (abort.signal.aborted) break;
          this.link.sendAudio(audio);
        }
        if (abort.signal.aborted) break;
      }
      if (!abort.signal.aborted) {
        const name = `said-${++this.markSeq}`;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, this.timings.markMs);
          const done = () => {
            clearTimeout(timer);
            abort.signal.removeEventListener('abort', done);
            resolve();
          };
          this.marks.set(name, done);
          abort.signal.addEventListener('abort', done);
          this.link.sendMark(name);
        });
      }
    } catch (e) {
      if (!abort.signal.aborted) this.log.warn({ err: e }, 'couldn’t speak on a call');
    } finally {
      if (this.speaking?.abort === abort) this.speaking = null;
    }
    return abort.signal.aborted || this.closed ? 'cut' : 'done';
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
      summary: 'Answered a call; the line went quiet, so it said goodbye.',
      turns: this.turn,
      lastSaid: text,
    };
    await this.hangUp();
  }

  private async hangUp(): Promise<void> {
    const call = this.call!;
    try {
      await this.deps.telephony.endCall(call.account, this.ticket.callSid);
    } catch (e) {
      this.log.warn({ err: e }, 'couldn’t hang up a call');
    }
    this.link.close();
    await this.stop();
  }

  /** Rings the team on this call; nobody answering goes to voicemail (the TwiML's own dial result). */
  private async transfer(reason: ConversationHandoffReason, note: string): Promise<void> {
    const call = this.call!;
    this.ending = {
      outcome: 'handed_off',
      summary: `Answered a call and connected them to the team: ${REASON_WORDS[reason] ?? 'they needed a person'}.`,
      turns: this.turn,
      lastSaid: this.lines.findLast((l) => l.who === 'teammate')?.text ?? null,
    };
    try {
      await handOffForTransfer(this.deps, call, reason, note);
    } catch (e) {
      this.log.warn({ err: e }, 'couldn’t hand a call’s conversation to the team');
    }
    try {
      await this.deps.telephony.redirectCall(
        call.account,
        this.ticket.callSid,
        await this.deps.transferTwiml(this.ticket),
      );
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
    const call = this.call;
    if (!call) return;
    const ending: CallEnding = this.ending ?? {
      outcome: this.lines.some((l) => l.who === 'caller') ? 'replied' : 'no_reply',
      summary: `Answered a call (${this.turn} ${this.turn === 1 ? 'turn' : 'turns'}); they hung up.`,
      turns: this.turn,
      lastSaid: this.lines.findLast((l) => l.who === 'teammate')?.text ?? null,
    };
    try {
      await finishCall(this.deps, call, this.lines, ending);
    } catch (e) {
      this.log.error({ err: e }, 'couldn’t close a call’s run');
    }
  }
}
