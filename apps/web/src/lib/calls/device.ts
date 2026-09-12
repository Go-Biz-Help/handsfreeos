'use client';
import type { VoiceToken } from '@/lib/api/worker';

/**
 * What the call provider needs from a voice device. Twilio's Voice SDK implements it in real use (loaded only
 * when a browser turns calls on); when the worker runs the fake carrier (local runs and browser tests) a
 * stand-in takes its place, so the same screens work end to end.
 */
export type CallEvent = 'accept' | 'disconnect' | 'cancel' | 'reject' | 'error' | 'ringing';
export interface VoiceCall {
  /** Twilio's own parameters (From, CallSid, …). */
  readonly parameters: Readonly<Record<string, string>>;
  /** What our TwiML passed along with <Parameter> (who is calling, what else rings). */
  readonly customParameters: ReadonlyMap<string, string>;
  accept(): void;
  /** Stops ringing here only; the call keeps ringing everywhere else. */
  ignore(): void;
  disconnect(): void;
  mute(muted: boolean): void;
  sendDigits(digits: string): void;
  on(event: CallEvent, listener: (...args: never[]) => void): unknown;
}

export type DeviceEvent = 'registered' | 'unregistered' | 'incoming' | 'tokenWillExpire' | 'error';
export interface VoiceDevice {
  register(): Promise<void>;
  updateToken(token: string): void;
  connect(options: { params: Record<string, string> }): Promise<VoiceCall>;
  destroy(): void;
  on(event: DeviceEvent, listener: (...args: never[]) => void): unknown;
}

export class CallsUnsupportedError extends Error {
  constructor() {
    super('This browser can’t make calls. Try Chrome, Edge, Safari or Firefox.');
    this.name = 'CallsUnsupportedError';
  }
}

export async function createDevice(token: VoiceToken): Promise<VoiceDevice> {
  if (token.provider === 'fake') {
    const { createFakeDevice } = await import('./fake-device');
    return createFakeDevice(token);
  }
  const { Call, Device } = await import('@twilio/voice-sdk');
  if (!Device.isSupported) throw new CallsUnsupportedError();
  return new Device(token.token, {
    // Opus holds up better than PCMU on a weak connection.
    codecPreferences: [Call.Codec.Opus, Call.Codec.PCMU],
    // Leaving or reloading the page ends a call, so the browser asks first.
    closeProtection: true,
    logLevel: 'error',
  }) as unknown as VoiceDevice;
}
