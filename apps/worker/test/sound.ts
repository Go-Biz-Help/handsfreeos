/**
 * A microphone's sound for tests of the AI hearing a video call: 16 kHz mono, 20 ms at a time, either a tone loud
 * enough to be talking or silence. The stand-in speech service hears a moment of talking and the pause after it as
 * FAKE_HEARD.
 */
import { WIDE_SAMPLE_RATE } from '../src/voice-agent/speech';

export const FRAME = WIDE_SAMPLE_RATE / 50;

/** 20 ms of sound: a tone loud enough to be talking, or silence. */
export function frame(loud: boolean, n = 0): Int16Array {
  const f = new Int16Array(FRAME);
  if (loud)
    for (let i = 0; i < FRAME; i++)
      f[i] = Math.round(8000 * Math.sin((2 * Math.PI * 300 * (n * FRAME + i)) / WIDE_SAMPLE_RATE));
  return f;
}

export interface Stretch {
  readonly ms: number;
  readonly loud: boolean;
}

/** A microphone: quiet, then talking, then quiet, 20 ms at a time. */
export async function* microphone(parts: readonly Stretch[]): AsyncIterable<Int16Array> {
  let n = 0;
  for (const p of parts) for (let t = 0; t < p.ms; t += 20) yield frame(p.loud, n++);
}

/** A moment of quiet, a second of talking, and the pause that ends it: heard as one line. */
export const SAID: readonly Stretch[] = [
  { ms: 400, loud: false },
  { ms: 1000, loud: true },
  { ms: 2000, loud: false },
];
