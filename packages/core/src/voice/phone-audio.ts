/**
 * Phone audio in a browser: a live test call from the console (ai-team/test-call.ts) sends the microphone to the
 * worker and plays what comes back the way a phone line carries it, 8 kHz G.711 μ-law, mono. The worker's
 * listener and voice then get exactly what a real call gives them, and nothing on the worker converts audio.
 * Browser-safe and pure: the web's audio worklet only hands samples over, and these do the rest.
 */

/** A phone line's sample rate. */
export const PHONE_RATE = 8000;
/** 20 ms of phone audio, what Twilio sends a frame at a time: the size the browser sends too. */
export const PHONE_FRAME = 160;

const BIAS = 0x84;
const CLIP = 32635;

/** One 16-bit sample as its μ-law byte (G.711). */
export function mulawOf(sample: number): number {
  let s = Math.round(Math.max(-32768, Math.min(32767, sample)));
  const sign = s < 0 ? 0x80 : 0;
  if (sign) s = -s;
  if (s > CLIP) s = CLIP;
  s += BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (s & mask) === 0 && exponent > 0; mask >>= 1) exponent--;
  const mantissa = (s >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

/** One μ-law byte as its 16-bit sample. */
export function linearOf(byte: number): number {
  const u = ~byte & 0xff;
  const exponent = (u >> 4) & 0x07;
  const sample = ((((u & 0x0f) << 3) + BIAS) << exponent) - BIAS;
  return u & 0x80 ? -sample : sample;
}

/** Samples from -1 to 1 as μ-law bytes. */
export function encodeMulaw(samples: ArrayLike<number>): Uint8Array {
  const out = new Uint8Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = mulawOf((samples[i] ?? 0) * 32767);
  return out;
}

/** μ-law bytes as samples from -1 to 1. */
export function decodeMulaw(bytes: ArrayLike<number>): Float32Array {
  const out = new Float32Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = linearOf(bytes[i] ?? 0xff) / 32768;
  return out;
}

/**
 * The microphone's samples at whatever rate the browser records (44.1 or 48 kHz, usually) given back at a phone's
 * 8 kHz. A low-pass comes first, a little under what a phone line carries, so nothing higher folds back into what
 * the listener hears; then it steps through at the phone's rate, in between samples when the rates don't divide.
 * It keeps what it needs between calls, so a stream fed in pieces comes out as one.
 */
export class PhoneDownsampler {
  private readonly step: number;
  private readonly taps: Float32Array;
  private readonly half: number;
  /** What hasn't been used yet, with the samples before it that the filter still reads. */
  private buf: Float32Array;
  /** Where the next phone sample falls in `buf`. */
  private pos: number;

  constructor(readonly rate: number) {
    if (!(rate >= PHONE_RATE))
      throw new Error(`A ${rate} Hz microphone is below a phone line’s rate`);
    this.step = rate / PHONE_RATE;
    // 3.4 kHz, the top of what a phone line carries, as a fraction of the recording's rate. The taps grow with
    // the rate so the filter is as sharp at 48 kHz as at 16: past about 4.3 kHz nothing gets through.
    const cutoff = 3400 / rate;
    const n = Math.max(31, Math.ceil(this.step * 24)) | 1;
    this.half = (n - 1) / 2;
    const taps = new Float32Array(n);
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const x = i - this.half;
      const sinc = x === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x);
      // Blackman, so the filter doesn't ring.
      const window =
        0.42 -
        0.5 * Math.cos((2 * Math.PI * i) / (n - 1)) +
        0.08 * Math.cos((4 * Math.PI * i) / (n - 1));
      taps[i] = sinc * window;
      sum += taps[i]!;
    }
    for (let i = 0; i < n; i++) taps[i] = taps[i]! / sum;
    this.taps = taps;
    // Silence before the first sample, so the first ones come out whole.
    this.buf = new Float32Array(this.half);
    this.pos = this.half;
  }

  /** More of the recording; the phone-rate samples it makes, from -1 to 1 (none until there's enough). */
  push(input: ArrayLike<number>): Float32Array {
    const buf = new Float32Array(this.buf.length + input.length);
    buf.set(this.buf);
    for (let i = 0; i < input.length; i++) buf[this.buf.length + i] = input[i] ?? 0;
    const out: number[] = [];
    // The last sample whose filter has everything it reads.
    const last = buf.length - 1 - this.half;
    while (this.pos + 1 <= last) {
      const i0 = Math.floor(this.pos);
      const frac = this.pos - i0;
      const a = this.filtered(buf, i0);
      out.push(frac > 0 ? a + (this.filtered(buf, i0 + 1) - a) * frac : a);
      this.pos += this.step;
    }
    const keepFrom = Math.max(0, Math.floor(this.pos) - this.half);
    this.buf = buf.slice(keepFrom);
    this.pos -= keepFrom;
    return Float32Array.from(out);
  }

  private filtered(buf: Float32Array, i: number): number {
    let acc = 0;
    const start = i - this.half;
    for (let k = 0; k < this.taps.length; k++) acc += this.taps[k]! * buf[start + k]!;
    return acc;
  }
}
