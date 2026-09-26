import { createTurnDetector, speechChunks, VOICE_WORDS, type PhoneVoice } from '@hfos/core';
import {
  createAudioPlayer,
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  type AudioPlayer,
  type AudioRecorder,
  type RecordingOptions,
} from 'expo-audio';

import { forget, hear, say, SpeechError } from './speech';

/**
 * Talking out loud on the phone, as the web does it (apps/web/src/lib/voice/session.ts): the Assistant's voice mode
 * and the test console's calls.
 *
 * - Listening records one turn (an M4A) and reads the recorder's loudness meter as it goes (@hfos/core's
 *   createTurnDetector), so the turn ends by itself when they stop talking; then the worker turns it into words.
 * - Speaking says text a piece at a time, fetching the next piece while one plays, through the phone's speaker
 *   even while the microphone is in use.
 *
 * The microphone is only recording while it listens (iOS shows it's in use), and the recordings and clips are
 * deleted once they've been heard or played.
 */

/** off: voice mode is off; idle: on, and waiting for a tap; then what it's doing. */
export type VoicePhase = 'off' | 'idle' | 'listening' | 'hearing' | 'thinking' | 'speaking';

export interface VoiceSnapshot {
  readonly phase: VoicePhase;
  /** Why it stopped, couldn't start or didn't hear, for people. */
  readonly error: string | null;
}

export const VOICE_OFF: VoiceSnapshot = { phase: 'off', error: null };

/** Mono speech at a modest bit rate: a minute is about half a megabyte. */
export const VOICE_RECORDING: RecordingOptions = {
  ...RecordingPresets.HIGH_QUALITY,
  numberOfChannels: 1,
  bitRate: 64_000,
  isMeteringEnabled: true,
};

interface Piece {
  text: string;
  audio: Promise<string | null> | null;
}

/** Talking out loud has to stop for now: it isn't set up, or the business's balance has run out. */
const stopsVoice = (e: unknown): e is SpeechError =>
  e instanceof SpeechError && (e.failure === 'not_configured' || e.failure === 'no_balance');

const PIECE_MAX = 280;
/** How often the recorder's meter is read. */
const TICK_MS = 100;

export class VoiceSession {
  private snap: VoiceSnapshot = VOICE_OFF;
  private readonly listeners = new Set<() => void>();
  private readonly levelListeners = new Set<(level: number) => void>();
  private queue: Piece[] = [];
  private playing: { player: AudioPlayer; uri: string; done: () => void } | null = null;
  private starting: Piece | null = null;
  private idleWaiters: (() => void)[] = [];
  private listening: { readonly stop: (send: boolean) => void } | null = null;
  private fetches = new AbortController();
  private gen = 0;
  private language: string | null = null;
  private held = false;

  constructor(
    private readonly opts: {
      readonly workspaceId: () => string;
      /** The voice to speak in; null is the AI teammate's own. */
      readonly voice: () => PhoneVoice | null;
      readonly recorder: () => AudioRecorder;
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

  /** Turns voice mode on, asking for the microphone the first time. */
  async start(): Promise<boolean> {
    if (this.on) return true;
    const permission = await requestRecordingPermissionsAsync().catch(() => null);
    if (!permission?.granted) {
      this.set('off', VOICE_WORDS.noMic);
      return false;
    }
    // Recording and playing at once, out of the speaker rather than the earpiece, and heard in silent mode.
    await setAudioModeAsync({
      playsInSilentMode: true,
      allowsRecording: true,
      shouldRouteThroughEarpiece: false,
      interruptionMode: 'duckOthers',
    }).catch(() => undefined);
    this.fetches = new AbortController();
    this.set('idle');
    return true;
  }

  /** Turns voice mode off: stops listening and speaking, and gives the audio back to other apps. */
  stop(error: string | null = null): void {
    this.hush();
    this.listening?.stop(false);
    this.language = null;
    this.held = false;
    const wasOn = this.on;
    this.set('off', error);
    if (wasOn)
      void setAudioModeAsync({ allowsRecording: false, interruptionMode: 'mixWithOthers' }).catch(
        () => undefined,
      );
  }

  /** Stops listening and speaking, and waits for a tap. */
  quiet(): void {
    this.hush();
    this.listening?.stop(false);
    if (this.on) this.set('idle');
  }

  thinking(): void {
    if (this.on) this.set('thinking');
  }

  idle(error: string | null = null): void {
    if (this.on) this.set('idle', error);
  }

  /** More is still to come (an answer still being written): between pieces it's thinking. */
  hold(more: boolean): void {
    this.held = more;
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
    if (!this.on) return null;
    this.hush();
    this.listening?.stop(false);
    const recorder = this.opts.recorder();
    try {
      await recorder.prepareToRecordAsync(VOICE_RECORDING);
      recorder.record();
    } catch {
      this.set('idle', VOICE_WORDS.failed);
      return null;
    }
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
        let metering: number | undefined;
        try {
          metering = recorder.getStatus().metering;
        } catch {
          metering = undefined;
        }
        const state = detector.feed(metering ?? -160, Date.now());
        this.level(detector.level);
        if (state === 'done' || state === 'nothing') end(state);
      }, TICK_MS);
      this.listening = { stop: (send) => end(send && detector.heard ? 'done' : 'cancelled') };
    });
    await recorder.stop().catch(() => undefined);
    this.level(0);
    const uri = recorder.uri;
    if (outcome === 'cancelled' || !this.on) {
      if (uri) forget(uri);
      return null;
    }
    if (outcome === 'nothing' || !uri) {
      if (uri) forget(uri);
      this.set('idle', VOICE_WORDS.heardNothing);
      return null;
    }

    this.set('hearing');
    const gen = this.gen;
    try {
      const heard = await hear(this.opts.workspaceId(), uri);
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
      if (stopsVoice(e)) this.stop(e.message);
      else if (e instanceof SpeechError && e.failure === 'no_signal')
        this.set('idle', VOICE_WORDS.needsSignal);
      else this.set('idle', e instanceof Error ? e.message : VOICE_WORDS.failed);
      return null;
    } finally {
      forget(uri);
    }
  }

  /** Says `text` after anything already waiting to be said. */
  speak(text: string): void {
    if (!this.on) return;
    for (const piece of speechChunks(text, PIECE_MAX)) {
      const last = this.queue[this.queue.length - 1];
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
    for (const piece of this.queue)
      void piece.audio?.then((uri) => (uri ? forget(uri) : undefined));
    this.queue = [];
    this.starting = null;
    const playing = this.playing;
    this.playing = null;
    if (playing) playing.done();
    if (this.snap.phase === 'speaking') this.set('idle');
    this.settled();
  }

  private settled(): void {
    const waiting = this.idleWaiters;
    this.idleWaiters = [];
    for (const resolve of waiting) resolve();
  }

  private pump(): void {
    if (!this.on) return;
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
    void next.audio!.then((uri) => {
      if (gen !== this.gen || this.starting !== next) {
        if (uri) forget(uri);
        return;
      }
      this.starting = null;
      if (!uri) {
        this.queue.shift();
        this.pump();
        return;
      }
      const player = createAudioPlayer({ uri }, { updateInterval: 100 });
      let finished = false;
      const done = () => {
        if (finished) return;
        finished = true;
        subscription.remove();
        try {
          player.pause();
          player.remove();
        } catch {
          // Already let go.
        }
        forget(uri);
      };
      const subscription = player.addListener('playbackStatusUpdate', (status) => {
        if (!status.didJustFinish || this.playing?.player !== player) return;
        this.playing = null;
        done();
        this.queue.shift();
        this.pump();
      });
      this.playing = { player, uri, done };
      player.play();
    });
  }

  private async fetchPiece(text: string): Promise<string | null> {
    const signal = this.fetches.signal;
    try {
      return await say(
        {
          workspaceId: this.opts.workspaceId(),
          text,
          voice: this.opts.voice(),
          language: this.language,
        },
        signal,
      );
    } catch (e) {
      if (!signal.aborted && this.on && stopsVoice(e)) this.stop(e.message);
      return null;
    }
  }
}
