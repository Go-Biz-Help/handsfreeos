'use client';
/**
 * The Assistant's smart listening (@hfos/core's voice/index.ts has the contract, GET /v1/speech/listen): one turn of
 * the microphone streamed live to the worker as 16 kHz 16-bit sound, where Deepgram Flux decides when they've
 * finished a thought, from what they said and how, not only a pause. The words come back as the turn, so nothing is
 * uploaded afterwards.
 *
 * What's recorded before the worker says it's ready waits here and goes first, so the first words aren't lost. It
 * gives up (`failed`) when the worker can't be reached, isn't ready in time, or the connection drops before the turn:
 * voice mode then ends the turn the old way, on a pause, from the recording it keeps alongside.
 */
import {
  encodeLinear16,
  LISTEN_RATE,
  parseListenMessage,
  PhoneDownsampler,
  type HeardSpeech,
} from '@hfos/core';
import { publicEnv } from '../env';
import { browserAccessToken } from '../supabase/token';
import { loadMicWorklet, MIC_WORKLET_NAME } from './mic-worklet';

/** Not ready by now: listen the old way. */
const READY_WITHIN_MS = 4_000;
/** After Done, how long to wait for the worker's words before listening the old way. */
const DONE_WITHIN_MS = 3_000;
/** 20 ms of 16 kHz 16-bit sound: what goes at a time. */
const FRAME_BYTES = (LISTEN_RATE / 50) * 2;
/** At most this much waits for the worker to be ready (about ten seconds). */
const WAITING_MAX_BYTES = LISTEN_RATE * 2 * 10;

export interface LiveEarEvents {
  /** They started talking (the worker heard words begin). */
  onTalking(): void;
  /** They finished: the words heard (text '' when nothing was). */
  onTurn(heard: HeardSpeech): void;
  /** The worker refused: talking out loud can't go on this way (`rule` says why). */
  onRefused(message: string, rule: string): void;
  /** The live way didn't work out: the turn goes on the old way. */
  onFailed(): void;
}

export class LiveEar {
  private ws: WebSocket | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private worklet: AudioWorkletNode | null = null;
  private down: PhoneDownsampler | null = null;
  private outbox = new Uint8Array(0);
  private waiting: Uint8Array[] = [];
  private waitingBytes = 0;
  private ready = false;
  private asked = false;
  private over = false;
  private readonly timers: ReturnType<typeof setTimeout>[] = [];

  constructor(
    private readonly ctx: AudioContext,
    private readonly stream: MediaStream,
    private readonly workspaceId: string,
    private readonly events: LiveEarEvents,
  ) {}

  /** Starts listening: the microphone's sound waits here until the worker is ready. */
  async start(): Promise<void> {
    try {
      this.timers.push(setTimeout(() => this.fail(), READY_WITHIN_MS));
      await loadMicWorklet(this.ctx);
      if (this.over) return;
      this.down = new PhoneDownsampler(this.ctx.sampleRate, LISTEN_RATE);
      this.source = this.ctx.createMediaStreamSource(this.stream);
      this.worklet = new AudioWorkletNode(this.ctx, MIC_WORKLET_NAME, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      this.worklet.port.onmessage = (e: MessageEvent<Float32Array>) => this.hear(e.data);
      this.source.connect(this.worklet);
      // Connected so the browser keeps it running; it makes no sound.
      this.worklet.connect(this.ctx.destination);
      const token = await browserAccessToken();
      if (this.over) return;
      if (!token) return this.fail();
      this.connect(token);
    } catch {
      this.fail();
    }
  }

  /** Done was pressed (or a long quiet): the worker sends what it has heard. Once is enough. */
  done(): void {
    if (this.over || this.asked) return;
    if (!this.ready) return this.fail();
    this.asked = true;
    this.send({ type: 'done' });
    this.timers.push(setTimeout(() => this.fail(), DONE_WITHIN_MS));
  }

  /** Lets it go: the connection and the microphone's tap (the microphone itself stays the session's). */
  close(): void {
    if (this.over) return;
    this.over = true;
    for (const t of this.timers) clearTimeout(t);
    this.worklet?.port.close();
    this.worklet?.disconnect();
    this.source?.disconnect();
    this.worklet = null;
    this.source = null;
    const ws = this.ws;
    this.ws = null;
    if (ws && ws.readyState <= WebSocket.OPEN) ws.close(1000);
  }

  private fail(): void {
    if (this.over) return;
    this.close();
    this.events.onFailed();
  }

  private connect(token: string): void {
    let ws: WebSocket;
    try {
      ws = new WebSocket(`${publicEnv.workerUrl.replace(/^http/, 'ws')}/v1/speech/listen`);
    } catch {
      return this.fail();
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () =>
      ws.send(JSON.stringify({ type: 'start', token, workspaceId: this.workspaceId }));
    ws.onmessage = (e: MessageEvent<unknown>) => {
      if (typeof e.data !== 'string') return;
      let m;
      try {
        m = parseListenMessage(JSON.parse(e.data));
      } catch {
        return;
      }
      if (!m || this.over) return;
      switch (m.type) {
        case 'ready':
          this.ready = true;
          this.flush();
          return;
        case 'talking':
          this.events.onTalking();
          return;
        case 'turn': {
          const heard = { text: m.text, language: m.language };
          this.close();
          this.events.onTurn(heard);
          return;
        }
        case 'error': {
          this.close();
          // A refusal the old way would meet too (not set up, no balance, not allowed) is said; anything else
          // (the listener in trouble) goes on the old way.
          if (m.rule === 'speech_failed') this.events.onFailed();
          else this.events.onRefused(m.message, m.rule);
          return;
        }
      }
    };
    ws.onerror = () => this.fail();
    ws.onclose = () => this.fail();
  }

  private send(m: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  /** The microphone, as 16 kHz 16-bit sound, a frame at a time: sent once ready, kept until then. */
  private hear(samples: Float32Array): void {
    if (this.over || !this.down) return;
    const bytes = encodeLinear16(this.down.push(samples));
    const all = new Uint8Array(this.outbox.length + bytes.length);
    all.set(this.outbox);
    all.set(bytes, this.outbox.length);
    let at = 0;
    for (; at + FRAME_BYTES <= all.length; at += FRAME_BYTES)
      this.out(all.slice(at, at + FRAME_BYTES));
    this.outbox = all.slice(at);
  }

  private out(frame: Uint8Array): void {
    if (this.ready && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(frame);
      return;
    }
    if (this.waitingBytes + frame.length > WAITING_MAX_BYTES) return;
    this.waiting.push(frame);
    this.waitingBytes += frame.length;
  }

  private flush(): void {
    for (const t of this.timers.splice(0)) clearTimeout(t);
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    for (const frame of this.waiting) ws.send(frame);
    this.waiting = [];
    this.waitingBytes = 0;
  }
}
