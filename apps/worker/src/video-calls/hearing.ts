/**
 * The AI hearing a HandsFreeOS video call (docs/video-calls.md, "The AI hears it"). The listener (listener.ts) joins
 * the call's room unseen and hears each person's microphone on its own, so every line knows who said it.
 *
 * - **Only while they talk.** Each person's sound goes through a voice gate, and quiet is never sent: Deepgram,
 *   which bills the sound it's sent, hears only talking, with a moment before it (so the first word isn't cut) and
 *   after it (so Deepgram can tell the sentence is over). A person's stream opens the first time they talk and
 *   closes after a stretch of quiet.
 * - **Captions** go to everyone in the call as the words are heard, a guess first and then the finished words
 *   (VIDEO_CALL_CAPTIONS_TOPIC). The screens show them with CC on.
 * - **Lines** are each person's turns, kept a few at a time (`video_call.heard`), so a listener that restarts in
 *   the middle of a call (a deploy) loses next to nothing. When the stretch of the call is over they become the
 *   appointment's transcript (`video_call.keep_words`, from handlers.ts).
 * - **The balance**: the seconds of sound sent, on the live speech line, about once a minute.
 *
 * The room is behind `ListenerRoom`, so this file and its tests never load LiveKit's native media library
 * (listener-room.ts does, in the media process alone).
 */
import { randomUUID } from 'node:crypto';
import { VIDEO_CALL_CAPTIONS_TOPIC, type VideoCallCaption } from '@hfos/core';
import type { Logger } from 'pino';
import {
  spokenLanguage,
  WIDE_BYTES_A_SECOND,
  WIDE_SAMPLE_RATE,
  type HeardWords,
  type Listening,
  type SpeechServices,
} from '../voice-agent/speech';
import type { VideoTicket } from './provider';

/** Someone's microphone in the room, to hear. */
export interface RoomVoice {
  /** Their identity in the room: their row of the call's people. */
  readonly identity: string;
  /** The name the call shows for them. */
  readonly name: string;
  /** Their sound, 16 kHz 16-bit mono, frame by frame, until the microphone goes (they left, or it was taken down). */
  readonly frames: AsyncIterable<Int16Array>;
}

export interface ListenerRoomEvents {
  onVoice(voice: RoomVoice): void;
  /** The listener is out of the room: another listener took its place, the room closed, or the connection went. */
  onGone(why: 'replaced' | 'closed' | 'lost'): void;
}

export interface ListenerRoom {
  /** How many people are in the room now, the listener aside. */
  people(): number;
  /** Sends everyone in the room a message on a topic. */
  say(topic: string, payload: Uint8Array): Promise<void>;
  leave(): Promise<void>;
}

/** Joins a room with the listener's ticket. */
export type JoinRoom = (ticket: VideoTicket, events: ListenerRoomEvents) => Promise<ListenerRoom>;

/** One person's finished turn, as `video_call.heard` keeps it. */
export interface HeardLine {
  readonly key: string;
  readonly personId: string;
  readonly text: string;
  readonly saidAt: string;
  readonly language: string | null;
}

/**
 * The voice gate's settings. Browsers clean up their microphone's sound (echo, noise), so quiet comes through as
 * near silence and talking as far louder than this (16-bit RMS, about -38 dBFS).
 */
export const GATE = {
  loud: 400,
  /** Loud for this long is talking, not a click or a cough's start. */
  openMs: 60,
  /** Quiet this long after talking is the end of it: Deepgram has heard the pause that ends a sentence. */
  hangMs: 1_200,
  /** Sound kept from just before talking starts, sent with it. */
  beforeMs: 300,
} as const;

const msOf = (frame: Int16Array) => (frame.length / WIDE_SAMPLE_RATE) * 1000;

/** How loud a frame is: its samples' root mean square. */
export function loudness(frame: Int16Array): number {
  let sum = 0;
  for (const s of frame) sum += s * s;
  return Math.sqrt(sum / Math.max(1, frame.length));
}

/** Lets through a person's sound while they talk, and nothing while they're quiet. */
export class VoiceGate {
  private open_ = false;
  private loudMs = 0;
  private quietMs = 0;
  private before: Int16Array[] = [];
  private beforeMs = 0;

  constructor(private readonly settings: typeof GATE = GATE) {}

  get talking(): boolean {
    return this.open_;
  }

  /** One frame: the frames to send now, oldest first (with the moment before, as talking starts), or none. */
  push(frame: Int16Array): Int16Array[] {
    const ms = msOf(frame);
    const loud = loudness(frame) >= this.settings.loud;
    if (this.open_) {
      this.quietMs = loud ? 0 : this.quietMs + ms;
      if (this.quietMs >= this.settings.hangMs) {
        this.open_ = false;
        this.loudMs = 0;
      }
      return [frame];
    }
    this.before.push(frame);
    this.beforeMs += ms;
    while (
      this.before.length > 1 &&
      this.beforeMs - msOf(this.before[0]!) >= this.settings.beforeMs
    )
      this.beforeMs -= msOf(this.before.shift()!);
    this.loudMs = loud ? this.loudMs + ms : 0;
    if (this.loudMs < this.settings.openMs) return [];
    this.open_ = true;
    this.quietMs = 0;
    const out = this.before;
    this.before = [];
    this.beforeMs = 0;
    return out;
  }
}

/** A turn longer than this is kept as it goes, rather than all at its end. */
const TURN_MAX_CHARS = 1_500;
/** Words that stopped coming this long ago end the turn, even without Deepgram saying so. */
const TURN_STALE_MS = 3_000;
/** A person's stream to Deepgram closes after this long quiet, and opens again when they next talk. */
const STREAM_IDLE_MS = 20_000;
/** Sound held while a stream opens, at most (it opens in well under a second). */
const OPENING_MAX_BYTES = 5 * WIDE_BYTES_A_SECOND;

interface EarDeps {
  readonly speech: SpeechServices;
  readonly log: Logger;
  readonly now: () => number;
  /** This listener's own name, so the lines of one that restarted never clash with the last one's. */
  readonly session: string;
  readonly onCaption: (c: VideoCallCaption) => void;
  readonly onLine: (l: HeardLine) => void;
  /** Bytes of sound sent to Deepgram, for the balance. */
  readonly onSent: (bytes: number) => void;
}

/** One person's microphone: the gate, their stream to Deepgram, and their turns. */
export class PersonEar {
  private readonly gate = new VoiceGate();
  private stream: Listening | null = null;
  private opening = false;
  private held: Buffer[] = [];
  private heldBytes = 0;
  private lastTalk: number;
  private lastWords = 0;
  /** Each caption's number, and each turn's. */
  private caption = 0;
  private turn = 0;
  private said: string[] = [];
  private saidFrom: number | null = null;
  private language: string | null = null;
  private closed = false;

  constructor(
    readonly who: { readonly identity: string; readonly name: string },
    private readonly deps: EarDeps,
  ) {
    this.lastTalk = deps.now();
  }

  /** Hears their microphone until it goes. */
  async hear(frames: AsyncIterable<Int16Array>): Promise<void> {
    for await (const frame of frames) {
      if (this.closed) return;
      this.frame(frame);
    }
  }

  frame(frame: Int16Array): void {
    const out = this.gate.push(frame);
    if (this.gate.talking) this.lastTalk = this.deps.now();
    for (const f of out) this.send(Buffer.from(f.buffer, f.byteOffset, f.byteLength));
  }

  /** Every second: a turn whose words stopped is kept, and a stream quiet for a while closes. */
  tick(): void {
    const now = this.deps.now();
    if (this.said.length && !this.gate.talking && now - this.lastWords >= TURN_STALE_MS)
      this.endTurn();
    if (this.stream && !this.gate.talking && now - this.lastTalk >= STREAM_IDLE_MS) {
      this.endTurn();
      const s = this.stream;
      this.stream = null;
      void s.close().catch(() => undefined);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.endTurn();
    this.held = [];
    const s = this.stream;
    this.stream = null;
    void s?.close().catch(() => undefined);
  }

  private send(audio: Buffer): void {
    if (this.closed) return;
    if (this.stream) {
      this.stream.send(audio);
      this.deps.onSent(audio.length);
      return;
    }
    this.held.push(audio);
    this.heldBytes += audio.length;
    while (this.heldBytes > OPENING_MAX_BYTES && this.held.length > 1)
      this.heldBytes -= this.held.shift()!.length;
    if (!this.opening) void this.open();
  }

  private async open(): Promise<void> {
    this.opening = true;
    let stream: Listening | null = null;
    try {
      stream = await this.deps.speech.listen(
        {
          onWords: (w) => this.words(w),
          onSpeechStarted: () => undefined,
          onUtteranceEnd: () => this.endTurn(),
          onError: (e) => {
            this.deps.log.warn({ err: e.message }, 'a video call’s speech stream broke');
            // The next time they talk opens another.
            if (this.stream === stream) this.stream = null;
          },
        },
        { audio: 'wide' },
      );
    } catch (e) {
      this.deps.log.warn(
        { err: e instanceof Error ? e.message : String(e) },
        'couldn’t open a video call’s speech stream',
      );
    } finally {
      this.opening = false;
    }
    if (!stream) {
      // What they said while it tried is lost; the next time they talk tries again.
      this.held = [];
      this.heldBytes = 0;
      return;
    }
    if (this.closed) {
      void stream.close().catch(() => undefined);
      return;
    }
    this.stream = stream;
    for (const audio of this.held) {
      stream.send(audio);
      this.deps.onSent(audio.length);
    }
    this.held = [];
    this.heldBytes = 0;
  }

  private words(w: HeardWords): void {
    if (this.closed) return;
    const text = w.text.trim();
    if (text) {
      this.lastWords = this.deps.now();
      this.saidFrom ??= this.lastWords;
      this.language = spokenLanguage(w.language) ?? this.language;
      this.deps.onCaption({
        id: `${this.deps.session}:${this.who.identity}:${this.caption}`,
        who: this.who.identity,
        name: this.who.name,
        text,
        final: w.final,
      });
      if (w.final) {
        this.caption++;
        this.said.push(text);
      }
    }
    if (w.final && (w.endOfTurn || this.said.join(' ').length >= TURN_MAX_CHARS)) this.endTurn();
  }

  private endTurn(): void {
    const text = this.said.join(' ').replace(/\s+/g, ' ').trim();
    if (text)
      this.deps.onLine({
        key: `${this.deps.session}:${this.who.identity}:${this.turn++}`,
        personId: this.who.identity,
        text: text.slice(0, 4000),
        saidAt: new Date(this.saidFrom ?? this.deps.now()).toISOString(),
        language: this.language,
      });
    this.said = [];
    this.saidFrom = null;
  }
}

export interface CallHearingDeps {
  readonly speech: SpeechServices;
  readonly log: Logger;
  readonly now?: () => number;
  /** Keeps lines heard (`video_call.heard`). Throws when it couldn't, and they're sent again. */
  readonly keep: (lines: readonly HeardLine[]) => Promise<void>;
  /** Seconds of sound sent, on the business's balance. Never throws. */
  readonly bill: (seconds: number) => Promise<void>;
  /** Sends captions to everyone in the call. */
  readonly say: (topic: string, payload: Uint8Array) => Promise<void>;
  /** How many people are in the room now. */
  readonly people: () => number;
}

/** Lines are kept this often, or sooner once this many are waiting. */
const KEEP_EVERY_MS = 2_000;
const KEEP_AT = 20;
/** A batch, at most (`video_call.heard` takes 200). */
const KEEP_BATCH = 100;
/** Lines waiting while they can't be kept (the database is away), at most: the oldest go first. */
const WAITING_MAX = 2_000;
/** Sound sent goes on the balance this often. */
const BILL_EVERY_MS = 60_000;
/** Alone in the room this long, the listener leaves, so the room can close. */
export const ALONE_MS = 10_000;

/** One call heard: everyone's microphone, their captions and lines, and what it costs. */
export class CallHearing {
  private readonly ears = new Map<string, PersonEar>();
  private readonly waiting: HeardLine[] = [];
  private readonly session = randomUUID().slice(0, 8);
  private readonly now: () => number;
  private sent = 0;
  private billed = 0;
  private lastKept: number;
  private lastBilled: number;
  private aloneSince: number | null = null;
  private keeping = false;
  private stopped = false;

  constructor(
    readonly callId: string,
    private readonly deps: CallHearingDeps,
  ) {
    this.now = deps.now ?? Date.now;
    this.lastKept = this.now();
    this.lastBilled = this.now();
  }

  /** Someone's microphone, heard until it goes. Theirs again (a reload, a second device) takes over. */
  voice(v: RoomVoice): void {
    if (this.stopped) return;
    this.ears.get(v.identity)?.close();
    const ear = new PersonEar(
      { identity: v.identity, name: v.name },
      {
        speech: this.deps.speech,
        log: this.deps.log,
        now: this.now,
        session: this.session,
        onCaption: (c) => this.caption(c),
        onLine: (l) => this.line(l),
        onSent: (bytes) => {
          this.sent += bytes;
        },
      },
    );
    this.ears.set(v.identity, ear);
    void ear
      .hear(v.frames)
      .catch((e: unknown) =>
        this.deps.log.warn(
          { callId: this.callId, err: e instanceof Error ? e.message : String(e) },
          'a microphone in a video call stopped being heard',
        ),
      )
      .finally(() => {
        ear.close();
        if (this.ears.get(v.identity) === ear) this.ears.delete(v.identity);
      });
  }

  /** Every second: turns and streams that went quiet, lines kept, the balance. False once it should leave. */
  async tick(): Promise<boolean> {
    for (const ear of this.ears.values()) ear.tick();
    const now = this.now();
    if (this.waiting.length >= KEEP_AT || now - this.lastKept >= KEEP_EVERY_MS) await this.keep();
    if (now - this.lastBilled >= BILL_EVERY_MS) await this.bill();
    if (this.deps.people() > 0) this.aloneSince = null;
    else this.aloneSince ??= now;
    return this.aloneSince === null || now - this.aloneSince < ALONE_MS;
  }

  /** Stops hearing: every turn so far is kept and billed. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    for (const ear of this.ears.values()) ear.close();
    this.ears.clear();
    // Twice at most: once for what's waiting, and once more for a batch that couldn't go the first time.
    await this.keep();
    if (this.waiting.length) await this.keep();
    await this.bill();
  }

  private caption(c: VideoCallCaption): void {
    void this.deps
      .say(VIDEO_CALL_CAPTIONS_TOPIC, new TextEncoder().encode(JSON.stringify(c)))
      .catch(() => undefined);
  }

  private line(l: HeardLine): void {
    this.waiting.push(l);
    if (this.waiting.length > WAITING_MAX) {
      this.waiting.splice(0, this.waiting.length - WAITING_MAX);
      this.deps.log.warn({ callId: this.callId }, 'a video call’s oldest lines were dropped');
    }
  }

  private async keep(): Promise<void> {
    this.lastKept = this.now();
    if (this.keeping) return;
    this.keeping = true;
    try {
      while (this.waiting.length) {
        const batch = this.waiting.slice(0, KEEP_BATCH);
        await this.deps.keep(batch);
        this.waiting.splice(0, batch.length);
      }
    } catch (e) {
      this.deps.log.warn(
        { callId: this.callId, err: e instanceof Error ? e.message : String(e) },
        'couldn’t keep a video call’s lines yet',
      );
    } finally {
      this.keeping = false;
    }
  }

  private async bill(): Promise<void> {
    this.lastBilled = this.now();
    const bytes = this.sent - this.billed;
    if (bytes <= 0) return;
    this.billed = this.sent;
    await this.deps.bill(bytes / WIDE_BYTES_A_SECOND);
  }
}
