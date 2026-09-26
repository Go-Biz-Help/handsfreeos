'use client';
/**
 * Talking out loud in the browser: the Assistant's voice mode and the test console's calls.
 *
 * - Listening records one turn from the microphone and reads its loudness as it goes (@hfos/core's
 *   createTurnDetector), so the turn ends by itself when they stop talking; then the worker turns it into words.
 * - Speaking says text a piece at a time (a sentence or a few), fetching the next piece while one plays, so the
 *   first words start soon. Audio plays through one AudioContext made in the click that turned voice mode on:
 *   browsers only let a page make sound after the person has touched it, and Safari only then.
 *
 * The microphone stays open while voice mode is on (the browser shows it's in use) and is let go when it's off.
 * Only one turn is heard at a time, and nothing is kept.
 */
import {
  createTurnDetector,
  levelDb,
  speechChunks,
  VOICE_WORDS,
  type PhoneVoice,
} from '@hfos/core';
import { errorMessage } from '../api/client';
import { hear, say, speechStops } from './speech';

/** off: voice mode is off; idle: on, and waiting for a tap; then what it's doing. */
export type VoicePhase = 'off' | 'idle' | 'listening' | 'hearing' | 'thinking' | 'speaking';

export interface VoiceSnapshot {
  readonly phase: VoicePhase;
  /** Why it stopped, couldn't start or didn't hear, for people. */
  readonly error: string | null;
}

export const VOICE_OFF: VoiceSnapshot = { phase: 'off', error: null };

interface Piece {
  text: string;
  audio: Promise<AudioBuffer | null> | null;
}

/** The longest piece said in one go. */
const PIECE_MAX = 280;
/** How often the microphone's loudness is read. */
const TICK_MS = 50;
/** What the browser records in, best first: Chrome and Firefox make WebM, Safari MP4. */
const RECORDING_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/ogg;codecs=opus',
];

type AudioContextClass = typeof AudioContext;

export class VoiceSession {
  private snap: VoiceSnapshot = VOICE_OFF;
  private readonly listeners = new Set<() => void>();
  private readonly levelListeners = new Set<(level: number) => void>();
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private queue: Piece[] = [];
  private playing: AudioBufferSourceNode | null = null;
  /** The piece waiting for its audio before it plays. */
  private starting: Piece | null = null;
  private idleWaiters: (() => void)[] = [];
  private listening: { readonly stop: (send: boolean) => void } | null = null;
  private fetches = new AbortController();
  private gen = 0;
  /** The language they last spoke, so a Spanish speaker hears Spanish back. */
  private language: string | null = null;
  /** More is still coming (an answer still being written): between pieces it's thinking, not waiting for a tap. */
  private held = false;

  constructor(
    private readonly opts: {
      readonly workspaceId: () => string;
      /** The voice to speak in; null is the AI teammate's own. */
      readonly voice: () => PhoneVoice | null;
    },
  ) {}

  readonly subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  readonly getSnapshot = (): VoiceSnapshot => this.snap;

  /** The microphone's loudness while listening, 0 to 1, for a meter drawn without re-rendering. */
  onLevel(fn: (level: number) => void): () => void {
    this.levelListeners.add(fn);
    return () => this.levelListeners.delete(fn);
  }

  get on(): boolean {
    return this.snap.phase !== 'off';
  }
  get phase(): VoicePhase {
    return this.snap.phase;
  }
  /** Changes whenever what's being said is cut short (Talk over it, Stop): a loop waiting on it stops there. */
  get generation(): number {
    return this.gen;
  }

  private set(phase: VoicePhase, error: string | null = null): void {
    if (this.snap.phase === phase && this.snap.error === error) return;
    this.snap = { phase, error };
    for (const fn of this.listeners) fn();
  }

  private level(value: number): void {
    for (const fn of this.levelListeners) fn(value);
  }

  /** Turns voice mode on. Call it from a click: the browser then lets the page make sound and use the mic. */
  async start(): Promise<boolean> {
    if (this.on) return true;
    const Ctx: AudioContextClass | undefined =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: AudioContextClass }).webkitAudioContext;
    if (!Ctx || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      this.set('off', VOICE_WORDS.unsupported);
      return false;
    }
    // Made and resumed inside the click, before anything is awaited, or Safari keeps it silent.
    const ctx = this.ctx ?? new Ctx();
    this.ctx = ctx;
    const resumed = ctx.resume().catch(() => undefined);
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (e) {
      const blocked =
        e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
      this.set('off', blocked ? VOICE_WORDS.noMicWeb : VOICE_WORDS.unsupported);
      return false;
    }
    await resumed;
    this.fetches = new AbortController();
    this.set('idle');
    return true;
  }

  /** Turns voice mode off: stops listening and speaking, and lets the microphone go. */
  stop(error: string | null = null): void {
    this.hush();
    this.listening?.stop(false);
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
    this.language = null;
    this.held = false;
    this.set('off', error);
  }

  /** Stops listening and speaking, and waits for a tap. */
  quiet(): void {
    this.hush();
    this.listening?.stop(false);
    if (this.on) this.set('idle');
  }

  /** Waiting on the answer. */
  thinking(): void {
    if (this.on) this.set('thinking');
  }

  /** More is still to come (true) or not (false): what it shows between pieces. */
  hold(more: boolean): void {
    this.held = more;
  }

  /** Nothing to do until they tap. */
  idle(error: string | null = null): void {
    if (this.on) this.set('idle', error);
  }

  /** Ends the turn being heard now and sends it, as if they'd stopped talking. */
  finishTurn(): void {
    this.listening?.stop(true);
  }

  /**
   * Hears one turn: records until they stop talking, then answers their words, or null when nothing was said, it
   * was stopped, or it couldn't be heard (the phase says why).
   */
  async listen(): Promise<string | null> {
    const ctx = this.ctx;
    const stream = this.stream;
    if (!this.on || !ctx || !stream) return null;
    this.hush();
    this.listening?.stop(false);
    const type = RECORDING_TYPES.find((t) => MediaRecorder.isTypeSupported(t));
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
    } catch {
      this.set('idle', VOICE_WORDS.unsupported);
      return null;
    }
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data);
    };
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    const detector = createTurnDetector();
    this.set('listening');

    const outcome = await new Promise<'done' | 'nothing' | 'cancelled'>((resolve) => {
      let over = false;
      const end = (why: 'done' | 'nothing' | 'cancelled') => {
        if (over) return;
        over = true;
        clearInterval(timer);
        this.listening = null;
        resolve(why);
      };
      const timer = setInterval(() => {
        analyser.getFloatTimeDomainData(samples);
        const state = detector.feed(levelDb(samples), performance.now());
        this.level(detector.level);
        if (state === 'done' || state === 'nothing') end(state);
      }, TICK_MS);
      this.listening = { stop: (send) => end(send && detector.heard ? 'done' : 'cancelled') };
      recorder.start(250);
    });
    const recording = await new Promise<Blob>((resolve) => {
      const whole = () =>
        resolve(new Blob(chunks, { type: recorder.mimeType || type || 'audio/webm' }));
      if (recorder.state === 'inactive') return whole();
      recorder.onstop = whole;
      recorder.stop();
    });
    source.disconnect();
    this.level(0);
    if (outcome === 'cancelled' || !this.on) return null;
    if (outcome === 'nothing' || !recording.size) {
      this.set('idle', VOICE_WORDS.heardNothing);
      return null;
    }

    this.set('hearing');
    const gen = this.gen;
    try {
      const heard = await hear(this.opts.workspaceId(), recording, this.fetches.signal);
      if (gen !== this.gen || !this.on) return null;
      if (heard.language) this.language = heard.language;
      if (!heard.text) {
        this.set('idle', VOICE_WORDS.heardNothing);
        return null;
      }
      this.set('thinking');
      return heard.text;
    } catch (e) {
      if (gen !== this.gen || !this.on) return null;
      const stops = speechStops(e);
      if (stops) this.stop(stops);
      else this.set('idle', errorMessage(e));
      return null;
    }
  }

  /** Says `text` after anything already waiting to be said. */
  speak(text: string): void {
    if (!this.on || !this.ctx) return;
    for (const piece of speechChunks(text, PIECE_MAX)) {
      const last = this.queue[this.queue.length - 1];
      // A piece not fetched yet takes the next one with it, so a list isn't a request per line.
      if (last && !last.audio && last.text.length + piece.length + 1 <= PIECE_MAX)
        last.text = `${last.text} ${piece}`;
      else this.queue.push({ text: piece, audio: null });
      // The first piece starts fetching now, so it isn't joined to the rest and the voice starts soon.
      this.pump();
    }
  }

  /** Resolves once everything waiting to be said has been said, or cut short. */
  finishSpeaking(): Promise<void> {
    if (!this.playing && !this.starting && !this.queue.length) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  /** Stops speaking now and forgets what was waiting. */
  hush(): void {
    this.gen++;
    this.fetches.abort();
    this.fetches = new AbortController();
    this.queue = [];
    this.starting = null;
    const playing = this.playing;
    this.playing = null;
    if (playing) {
      playing.onended = null;
      try {
        playing.stop();
      } catch {
        // Already stopped.
      }
    }
    if (this.snap.phase === 'speaking') this.set('idle');
    this.settled();
  }

  private settled(): void {
    const waiting = this.idleWaiters;
    this.idleWaiters = [];
    for (const resolve of waiting) resolve();
  }

  private pump(): void {
    const ctx = this.ctx;
    if (!ctx || !this.on) return;
    // The piece playing next and the one after are fetched while this one plays.
    for (const piece of this.queue.slice(0, 2)) piece.audio ??= this.fetchPiece(piece.text);
    if (this.playing || this.starting) return;
    const next = this.queue[0];
    if (!next) {
      if (this.snap.phase === 'speaking') this.set(this.held ? 'thinking' : 'idle');
      this.settled();
      return;
    }
    this.set('speaking');
    this.starting = next;
    const gen = this.gen;
    void next.audio!.then((buffer) => {
      if (gen !== this.gen || this.starting !== next) return;
      this.starting = null;
      if (!buffer || !this.ctx) {
        this.queue.shift();
        this.pump();
        return;
      }
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      source.onended = () => {
        if (this.playing !== source) return;
        this.playing = null;
        this.queue.shift();
        this.pump();
      };
      this.playing = source;
      source.start();
    });
  }

  private async fetchPiece(text: string): Promise<AudioBuffer | null> {
    const ctx = this.ctx;
    if (!ctx) return null;
    const signal = this.fetches.signal;
    try {
      const audio = await say(
        {
          workspaceId: this.opts.workspaceId(),
          text,
          voice: this.opts.voice(),
          language: this.language,
        },
        signal,
      );
      return await ctx.decodeAudioData(audio);
    } catch (e) {
      const stops = signal.aborted || !this.on ? null : speechStops(e);
      if (stops) this.stop(stops);
      return null;
    }
  }
}
