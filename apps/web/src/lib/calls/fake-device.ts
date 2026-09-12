'use client';
import type { VoiceToken } from '@/lib/api/worker';
import type { CallEvent, DeviceEvent, VoiceCall, VoiceDevice } from './device';

type Listener = (...args: never[]) => void;

class Emitter<E extends string> {
  private readonly listeners = new Map<E, Listener[]>();
  on(event: E, listener: Listener): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }
  emit(event: E, ...args: unknown[]): void {
    for (const l of this.listeners.get(event) ?? []) (l as (...a: unknown[]) => void)(...args);
  }
}

/** Controls for browser tests and local runs, on `window.__hfosVoice` while the stand-in is live. */
export interface FakeVoiceControls {
  /** The identity this browser rings as (u + the user id). */
  readonly identity: string;
  /** Rings this browser the way a customer's call would, with the parameters our TwiML sends. */
  ring(params: Record<string, string>): void;
  /** The caller hangs up before anyone answers, or a teammate took the call. */
  cancel(): void;
  /** The other end of the current call hangs up. */
  hangUp(): void;
  /** Keypad tones sent, and the calls this browser placed (their connect parameters). */
  readonly digits: string[];
  readonly outgoing: Record<string, string>[];
}

declare global {
  interface Window {
    __hfosVoice?: FakeVoiceControls;
  }
}

class FakeCall extends Emitter<CallEvent | 'mute'> implements VoiceCall {
  constructor(
    readonly parameters: Readonly<Record<string, string>>,
    readonly customParameters: ReadonlyMap<string, string>,
    private readonly digits: string[],
  ) {
    super();
  }
  accept() {
    setTimeout(() => this.emit('accept', this), 150);
  }
  ignore() {}
  disconnect() {
    this.emit('disconnect', this);
  }
  mute(muted: boolean) {
    this.emit('mute', muted, this);
  }
  sendDigits(digits: string) {
    this.digits.push(digits);
  }
}

/**
 * A stand-in for Twilio's Device when the worker runs the fake carrier: it registers at once, rings when
 * told to, and a placed call "picks up" after a moment. Nothing leaves the browser.
 */
export function createFakeDevice(token: VoiceToken): VoiceDevice {
  const device = new Emitter<DeviceEvent>();
  const digits: string[] = [];
  const outgoing: Record<string, string>[] = [];
  let current: FakeCall | null = null;
  const track = (call: FakeCall) => {
    current = call;
    const clear = () => {
      if (current === call) current = null;
    };
    call.on('disconnect', clear);
    call.on('cancel', clear);
    return call;
  };
  window.__hfosVoice = {
    identity: token.identity,
    digits,
    outgoing,
    ring(params) {
      const call = track(
        new FakeCall(
          { From: params['from'] ?? '', CallSid: params['callSid'] ?? 'CAfakebrowserleg' },
          new Map(Object.entries(params)),
          digits,
        ),
      );
      device.emit('incoming', call);
    },
    cancel() {
      current?.emit('cancel', current);
    },
    hangUp() {
      current?.emit('disconnect', current);
    },
  };
  return {
    async register() {
      device.emit('registered');
    },
    updateToken() {},
    async connect({ params }) {
      outgoing.push(params);
      const call = track(new FakeCall({}, new Map(Object.entries(params)), digits));
      // The customer picks up after a moment.
      setTimeout(() => call.emit('accept', call), 1200);
      return call;
    },
    destroy() {
      if (window.__hfosVoice?.identity === token.identity) delete window.__hfosVoice;
    },
    on(event, listener) {
      device.on(event, listener);
      return undefined;
    },
  };
}
