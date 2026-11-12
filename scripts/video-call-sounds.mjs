#!/usr/bin/env node
/**
 * The two sounds a HandsFreeOS video call plays (docs/video-calls.md, "Sounds"), made here so the web and the phone
 * play the same ones:
 *
 *   - `call-join.wav`: two soft bell notes going up, when someone comes into the call;
 *   - `call-knock.wav`: two going down, a door chime, for the team when someone asks to be let in.
 *
 *   node scripts/video-call-sounds.mjs
 *
 * Run it by hand when a sound changes; nothing in CI depends on it, because the only thing checked in is its output:
 * one copy for the web (apps/web/public/sounds) and one for the phone (apps/mobile/assets/sounds). Plain 16-bit mono
 * WAV, which every browser and both phones play without a decoder, and short enough that its size doesn't matter.
 */
import { Buffer } from 'node:buffer';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PLACES = ['apps/web/public/sounds', 'apps/mobile/assets/sounds'];
const RATE = 24_000;

/** A bell-ish note: a sine with two quieter overtones, a quick start and a long fade. */
function note(out, { at, hz, gain, fade }) {
  const start = Math.round(at * RATE);
  for (let i = 0; start + i < out.length; i++) {
    const t = i / RATE;
    const attack = Math.min(1, t / 0.006);
    const env = attack * Math.exp(-t / fade);
    if (env < 1e-4 && t > 0.05) break;
    const w = 2 * Math.PI * hz * t;
    out[start + i] +=
      gain *
      env *
      (Math.sin(w) + 0.22 * Math.sin(2 * w) * Math.exp(-t / 0.08) + 0.06 * Math.sin(3 * w));
  }
}

function sound(seconds, notes) {
  const out = new Float32Array(Math.round(seconds * RATE));
  for (const n of notes) note(out, n);
  // The last few milliseconds fade to nothing, so it never ends on a click.
  const tail = Math.round(0.03 * RATE);
  for (let i = 0; i < tail; i++) out[out.length - 1 - i] *= i / tail;
  return out;
}

function wav(samples) {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) =>
    data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, s)) * 32_767), i * 2),
  );
  const head = Buffer.alloc(44);
  head.write('RIFF', 0);
  head.writeUInt32LE(36 + data.length, 4);
  head.write('WAVE', 8);
  head.write('fmt ', 12);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20); // PCM
  head.writeUInt16LE(1, 22); // mono
  head.writeUInt32LE(RATE, 24);
  head.writeUInt32LE(RATE * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36);
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

const SOUNDS = {
  // E5 then A5.
  'call-join.wav': sound(0.8, [
    { at: 0, hz: 659.25, gain: 0.32, fade: 0.16 },
    { at: 0.14, hz: 880, gain: 0.34, fade: 0.24 },
  ]),
  // G5 then E5, a little slower: someone at the door.
  'call-knock.wav': sound(0.95, [
    { at: 0, hz: 783.99, gain: 0.34, fade: 0.2 },
    { at: 0.24, hz: 659.25, gain: 0.34, fade: 0.28 },
  ]),
};

for (const place of PLACES) {
  mkdirSync(join(root, place), { recursive: true });
  for (const [name, samples] of Object.entries(SOUNDS)) {
    const path = join(root, place, name);
    writeFileSync(path, wav(samples));
    console.log(`wrote ${relative(root, path)}`);
  }
}
