'use client';
/**
 * A live test call from the test console (@hfos/core's ai-team/test-call.ts has the contract): the AI teammate
 * answers in real time, on the live call loop a real call runs, and the manager hears it the way a caller would.
 *
 * - `browser`: the microphone goes to the worker over the console's websocket as phone audio (8 kHz μ-law, a frame
 *   every 20 ms), and what the teammate says comes back the same way and plays at once. Talking over it stops it:
 *   the worker says `clear`, and whatever is still queued is dropped. A `mark` is answered `played` once everything
 *   before it has played, as Twilio does, so the worker knows when a reply was heard.
 * - `phone`: the worker hands back a ticket, and this browser places a call with it over the business's own line
 *   (Twilio's browser calling, the device the inbox's calls use), so the call is heard end to end as a phone
 *   call. The websocket then only carries what happened.
 *
 * `start` has to run inside the click that starts the call: the browser only lets a page use the microphone and
 * make sound after someone has touched it (and Safari only then).
 */
import {
  decodeMulaw,
  dialParams,
  encodeMulaw,
  parseTestCallMessage,
  PHONE_FRAME,
  PHONE_RATE,
  PhoneDownsampler,
  type TestCallServerMessage,
  type TestCallSettings,
  type TestCallWay,
} from '@hfos/core';
import { voiceToken } from '../api/worker';
import { errorMessage } from '../api/client';
import { createDevice, type VoiceCall, type VoiceDevice } from '../calls/device';
import { publicEnv } from '../env';
import { supabaseBrowser } from '../supabase/client';

/** connecting: opening the call; ringing: the call over the phone line is being placed; live: it picked up. */
export type LiveCallPhase = 'connecting' | 'ringing' | 'live' | 'ended';

export interface LiveCallSnapshot {
  readonly phase: LiveCallPhase;
  readonly way: TestCallWay;
  /** Why it couldn't start or go on; null when it ended the usual way. */
  readonly error: string | null;
  /** Its voice is playing now (in this browser; over the phone line the call plays it). */
  readonly speaking: boolean;
  /** When it picked up: the call's timer runs from here. */
  readonly answeredAt: number | null;
  readonly muted: boolean;
}

const UNREACHABLE = 'The test call couldn’t reach the worker. Try again in a minute.';
const MIC_BLOCKED = 'Your browser blocked the microphone. Allow it for this site, then try again.';
const NO_AUDIO = 'This browser can’t make a live call. Try Chrome, Edge, Safari or Firefox.';

/**
 * The microphone's samples, handed over as they come (an audio worklet runs off the page's thread, so nothing is
 * missed while the page is busy). The downsampling and μ-law happen on the page, in @hfos/core.
 */
const MIC_WORKLET = `
class HfosPhoneMic extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel && channel.length) this.port.postMessage(channel.slice(0));
    return true;
  }
}
registerProcessor('hfos-phone-mic', HfosPhoneMic);
`;
let workletUrl: string | null = null;

type AudioContextClass = typeof AudioContext;

export class LiveTestCall {
  private snap: LiveCallSnapshot;
  private readonly listeners = new Set<() => void>();
  private ws: WebSocket | null = null;
  private over = false;
  // This browser's way.
  private ctx: AudioContext | null = null;
  private mic: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private worklet: AudioWorkletNode | null = null;
  private down: PhoneDownsampler | null = null;
  private outbox = new Uint8Array(0);
  /** When what's queued to play runs out, in the context's time. */
  private playhead = 0;
  private readonly playing = new Set<AudioBufferSourceNode>();
  private marks: { readonly name: string; readonly at: number }[] = [];
  private markTimer: ReturnType<typeof setInterval> | null = null;
  // The phone line's way.
  private device: Promise<VoiceDevice> | null = null;
  private call: VoiceCall | null = null;

  constructor(
    private readonly o: {
      readonly way: TestCallWay;
      readonly settings: TestCallSettings;
      /** Every message from the worker, for the console's turns and log. */
      readonly onMessage: (m: TestCallServerMessage) => void;
    },
  ) {
    this.snap = {
      phase: 'connecting',
      way: o.way,
      error: null,
      speaking: false,
      answeredAt: null,
      muted: false,
    };
  }

  readonly subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  readonly getSnapshot = (): LiveCallSnapshot => this.snap;

  private set(patch: Partial<LiveCallSnapshot>): void {
    const next = { ...this.snap, ...patch };
    if (
      Object.keys(patch).every(
        (k) => next[k as keyof LiveCallSnapshot] === this.snap[k as keyof LiveCallSnapshot],
      )
    )
      return;
    this.snap = next;
    for (const fn of this.listeners) fn();
  }

  /** Starts the call. Run it from the click that asks for it. */
  async start(): Promise<void> {
    const way = this.o.way;
    if (way === 'browser') {
      // Made and resumed inside the click, before anything is awaited, or Safari keeps it silent.
      const Ctx: AudioContextClass | undefined =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: AudioContextClass }).webkitAudioContext;
      if (!Ctx || !navigator.mediaDevices?.getUserMedia || typeof AudioWorkletNode === 'undefined')
        return this.finish(NO_AUDIO);
      this.ctx = new Ctx();
      void this.ctx.resume().catch(() => undefined);
    } else {
      // The browser's phone gets ready while the worker checks the test.
      this.device = voiceToken(this.o.settings.workspaceId).then((t) => createDevice(t));
      this.device.catch(() => undefined);
    }
    try {
      if (way === 'browser') await this.openMicrophone();
      const token = (await supabaseBrowser().auth.getSession()).data.session?.access_token;
      if (!token) return this.finish('Sign in to continue.');
      if (this.over) return;
      this.connect(token);
    } catch (e) {
      const blocked =
        e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
      this.finish(blocked ? MIC_BLOCKED : errorMessage(e, UNREACHABLE));
    }
  }

  /** Hangs up: the worker says how it ended, and the call closes. */
  hangUp(): void {
    if (this.over) return;
    this.send({ type: 'hang_up' });
    this.call?.disconnect();
    if (this.ws?.readyState !== WebSocket.OPEN) this.finish(null);
  }

  toggleMute(): void {
    if (this.over) return;
    const muted = !this.snap.muted;
    this.call?.mute(muted);
    this.set({ muted });
  }

  /** Lets everything go: the microphone, the sound, the call and the connection. */
  close(): void {
    if (this.over) return;
    this.send({ type: 'hang_up' });
    this.finish(null);
  }

  // ---- the connection ----

  private connect(token: string): void {
    let ws: WebSocket;
    try {
      ws = new WebSocket(`${publicEnv.workerUrl.replace(/^http/, 'ws')}/v1/ai-team/test/call`);
    } catch {
      return this.finish(UNREACHABLE);
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () =>
      ws.send(JSON.stringify({ type: 'start', token, way: this.o.way, test: this.o.settings }));
    ws.onmessage = (e: MessageEvent<string | ArrayBuffer>) => {
      if (typeof e.data === 'string') this.onText(e.data);
      else this.play(new Uint8Array(e.data));
    };
    ws.onclose = () => {
      if (!this.over) this.finish(this.snap.phase === 'connecting' ? UNREACHABLE : null);
    };
  }

  private send(m: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  private onText(raw: string): void {
    let m: TestCallServerMessage | null;
    try {
      m = parseTestCallMessage(JSON.parse(raw));
    } catch {
      return;
    }
    if (!m) return;
    switch (m.type) {
      case 'dial':
        void this.dial(m.ticket);
        break;
      case 'answered':
        this.set({ phase: 'live', answeredAt: Date.now() });
        break;
      case 'clear':
        this.clearPlayback();
        break;
      case 'mark':
        this.markAt(m.name);
        break;
      case 'ended':
        this.finish(null);
        break;
      case 'error':
        this.finish(m.message);
        break;
      default:
        break;
    }
    this.o.onMessage(m);
  }

  // ---- the phone line's way ----

  private async dial(ticket: string): Promise<void> {
    try {
      const device = await this.device!;
      if (this.over) return;
      this.set({ phase: 'ringing' });
      const call = await device.connect({ params: dialParams(ticket) });
      if (this.over) {
        call.disconnect();
        return;
      }
      this.call = call;
      if (this.snap.muted) call.mute(true);
      // Hanging up in the browser (or the line dropping) ends the call; the worker then says how it went.
      const gone = () => {
        this.call = null;
        this.send({ type: 'hang_up' });
      };
      call.on('disconnect', gone);
      call.on('cancel', gone);
      call.on('reject', gone);
      call.on('error', (err: unknown) => {
        const code =
          typeof err === 'object' && err !== null && 'code' in err ? Number(err.code) : NaN;
        this.send({ type: 'hang_up' });
        this.finish(
          [31401, 31402, 31208].includes(code) ? MIC_BLOCKED : 'The call dropped. Try again.',
        );
      });
    } catch (e) {
      this.send({ type: 'hang_up' });
      this.finish(
        errorMessage(e, 'The call couldn’t be placed from this browser. Use This browser instead.'),
      );
    }
  }

  // ---- this browser's way ----

  private async openMicrophone(): Promise<void> {
    const ctx = this.ctx!;
    const mic = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
    });
    // Closed while the browser was asking: let the microphone go, or it stays on.
    if (this.over) {
      for (const track of mic.getTracks()) track.stop();
      return;
    }
    this.mic = mic;
    workletUrl ??= URL.createObjectURL(new Blob([MIC_WORKLET], { type: 'text/javascript' }));
    await ctx.audioWorklet.addModule(workletUrl);
    if (this.over) return;
    this.down = new PhoneDownsampler(ctx.sampleRate);
    this.source = ctx.createMediaStreamSource(this.mic);
    this.worklet = new AudioWorkletNode(ctx, 'hfos-phone-mic', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    this.worklet.port.onmessage = (e: MessageEvent<Float32Array>) => this.hear(e.data);
    this.source.connect(this.worklet);
    // Connected so the browser keeps it running; it makes no sound.
    this.worklet.connect(ctx.destination);
  }

  /** The microphone, as phone audio, a frame at a time, once the call is up (silence while muted). */
  private hear(samples: Float32Array): void {
    const ws = this.ws;
    if (!this.down || !ws || ws.readyState !== WebSocket.OPEN || this.snap.phase !== 'live') return;
    const phone = this.down.push(samples);
    const bytes = this.snap.muted ? new Uint8Array(phone.length).fill(0xff) : encodeMulaw(phone);
    const all = new Uint8Array(this.outbox.length + bytes.length);
    all.set(this.outbox);
    all.set(bytes, this.outbox.length);
    let at = 0;
    for (; at + PHONE_FRAME <= all.length; at += PHONE_FRAME)
      ws.send(all.slice(at, at + PHONE_FRAME));
    this.outbox = all.slice(at);
  }

  /** What it says: played right after whatever is still playing. */
  private play(bytes: Uint8Array): void {
    const ctx = this.ctx;
    if (!ctx || this.over || !bytes.length) return;
    const buffer = ctx.createBuffer(1, bytes.length, PHONE_RATE);
    buffer.getChannelData(0).set(decodeMulaw(bytes));
    const node = ctx.createBufferSource();
    node.buffer = buffer;
    node.connect(ctx.destination);
    const at = Math.max(ctx.currentTime + 0.03, this.playhead);
    node.start(at);
    this.playhead = at + buffer.duration;
    this.playing.add(node);
    node.onended = () => {
      this.playing.delete(node);
      this.set({ speaking: this.playing.size > 0 });
    };
    this.set({ speaking: true });
  }

  /** They talked over it: what's queued goes, and every mark waiting on it is played, as Twilio does. */
  private clearPlayback(): void {
    for (const node of this.playing) {
      node.onended = null;
      try {
        node.stop();
      } catch {
        // Not started yet, or already over.
      }
    }
    this.playing.clear();
    this.playhead = this.ctx?.currentTime ?? 0;
    for (const m of this.marks) this.send({ type: 'played', name: m.name });
    this.marks = [];
    this.set({ speaking: false });
  }

  private markAt(name: string): void {
    const ctx = this.ctx;
    if (!ctx || this.playhead <= ctx.currentTime) {
      this.send({ type: 'played', name });
      return;
    }
    this.marks.push({ name, at: this.playhead });
    this.markTimer ??= setInterval(() => {
      const now = this.ctx?.currentTime ?? Number.POSITIVE_INFINITY;
      const due = this.marks.filter((m) => m.at <= now);
      this.marks = this.marks.filter((m) => m.at > now);
      for (const m of due) this.send({ type: 'played', name: m.name });
      if (!this.marks.length && this.markTimer) {
        clearInterval(this.markTimer);
        this.markTimer = null;
      }
    }, 40);
  }

  // ---- the end ----

  private finish(error: string | null): void {
    if (this.over) return;
    this.over = true;
    if (this.markTimer) clearInterval(this.markTimer);
    this.markTimer = null;
    for (const track of this.mic?.getTracks() ?? []) track.stop();
    this.worklet?.port.close();
    this.source?.disconnect();
    this.worklet?.disconnect();
    for (const node of this.playing) node.onended = null;
    this.playing.clear();
    void this.ctx?.close().catch(() => undefined);
    this.call?.disconnect();
    this.call = null;
    void this.device?.then((d) => d.destroy()).catch(() => undefined);
    const ws = this.ws;
    if (ws && ws.readyState <= WebSocket.OPEN) ws.close(1000);
    this.set({ phase: 'ended', error, speaking: false });
  }
}
