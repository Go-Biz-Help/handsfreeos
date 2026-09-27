import { describe, expect, it } from 'vitest';
import {
  decodeMulaw,
  encodeMulaw,
  linearOf,
  mulawOf,
  PHONE_RATE,
  PhoneDownsampler,
} from '../src/index';

/**
 * Phone audio in a browser, for a live test call: μ-law both ways, and the microphone brought down to a phone
 * line's 8 kHz without what a phone can't carry folding back into what's heard.
 */

describe('μ-law', () => {
  it('matches G.711 at the points everyone checks against', () => {
    expect(mulawOf(0)).toBe(0xff);
    expect(mulawOf(-1)).toBe(0x7f);
    expect(mulawOf(32767)).toBe(0x80);
    expect(mulawOf(-32768)).toBe(0x00);
    expect(linearOf(0xff)).toBe(0);
    expect(linearOf(0x80)).toBe(32124);
    expect(linearOf(0x00)).toBe(-32124);
  });

  it('comes back within a step of what went in, across the whole range', () => {
    for (let s = -32000; s <= 32000; s += 97) {
      const back = linearOf(mulawOf(s));
      // μ-law keeps about 3% of a sample's size (more near zero, where the steps are 8 apart).
      expect(Math.abs(back - s)).toBeLessThanOrEqual(Math.max(16, Math.abs(s) * 0.065));
    }
  });

  it('encodes samples from -1 to 1 and decodes them back', () => {
    const samples = Float32Array.from([0, 0.5, -0.5, 1, -1]);
    const back = decodeMulaw(encodeMulaw(samples));
    for (let i = 0; i < samples.length; i++) expect(back[i]).toBeCloseTo(samples[i]!, 1);
  });
});

/** `seconds` of a sine at `hz`, recorded at `rate`. */
function tone(hz: number, rate: number, seconds: number, amplitude = 0.8): Float32Array {
  const out = new Float32Array(Math.round(rate * seconds));
  for (let i = 0; i < out.length; i++) out[i] = amplitude * Math.sin((2 * Math.PI * hz * i) / rate);
  return out;
}

/** Loudness of the settled part (past the filter's start). */
function rms(samples: Float32Array): number {
  const settled = samples.slice(200);
  let sum = 0;
  for (const s of settled) sum += s * s;
  return Math.sqrt(sum / settled.length);
}

/** How many times it crosses zero going up: its frequency, over a second. */
function upCrossings(samples: Float32Array): number {
  let n = 0;
  for (let i = 1; i < samples.length; i++) if (samples[i - 1]! < 0 && samples[i]! >= 0) n++;
  return n;
}

describe('bringing a microphone down to a phone line', () => {
  for (const rate of [48_000, 44_100, 16_000]) {
    it(`keeps a voice at ${rate} Hz, at the phone's rate`, () => {
      const down = new PhoneDownsampler(rate);
      const out = down.push(tone(440, rate, 1));
      // A second in is a second out, less what the filter still holds back.
      expect(out.length).toBeGreaterThan(PHONE_RATE - 40);
      expect(out.length).toBeLessThanOrEqual(PHONE_RATE);
      expect(upCrossings(out)).toBeGreaterThanOrEqual(438);
      expect(upCrossings(out)).toBeLessThanOrEqual(441);
      expect(rms(out)).toBeCloseTo(0.8 / Math.SQRT2, 1);
    });
  }

  it('leaves out what a phone line can’t carry, rather than folding it back', () => {
    const down = new PhoneDownsampler(48_000);
    // 6 kHz would come back as a 2 kHz whistle without the filter.
    expect(rms(down.push(tone(6000, 48_000, 0.5)))).toBeLessThan(0.02);
  });

  it('gives the same out when fed a piece at a time as all at once', () => {
    const input = tone(700, 44_100, 0.3);
    const whole = new PhoneDownsampler(44_100).push(input);
    const pieces = new PhoneDownsampler(44_100);
    const parts: number[] = [];
    // An audio worklet hands over 128 samples at a time.
    for (let i = 0; i < input.length; i += 128) parts.push(...pieces.push(input.slice(i, i + 128)));
    expect(parts.length).toBe(whole.length);
    for (let i = 0; i < whole.length; i++) expect(parts[i]).toBeCloseTo(whole[i]!, 5);
  });

  it('refuses a microphone slower than a phone line', () => {
    expect(() => new PhoneDownsampler(4000)).toThrow();
  });
});
