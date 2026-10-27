/**
 * The AI hearing a HandsFreeOS video call (docs/video-calls.md, "The AI hears it"), without LiveKit or a database:
 * the voice gate, and one call heard with the stand-in speech service, which hears a moment of talking and the
 * pause after it as "Hello, can you hear me?".
 *
 * What's worth holding:
 *   - quiet is never sent, and talking is sent with the moment before it and the pause after it;
 *   - each person is heard on their own: their captions and lines say who, and a line's key never clashes with a
 *     listener's that restarted;
 *   - only the sound sent goes on the balance;
 *   - lines that couldn't be kept are sent again; the listener leaves once it's alone.
 */
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { captionOf, VIDEO_CALL_CAPTIONS_TOPIC } from '@hfos/core';
import { ALONE_MS, CallHearing, GATE, VoiceGate, type HeardLine } from '../src/video-calls/hearing';
import { createFakeSpeech, FAKE_HEARD } from '../src/voice-agent/fake-speech';
import { frame, microphone, SAID } from './sound';

const log = pino({ level: 'silent' });
const ANA = '0b6c4e8e-1f2a-4c3d-8e9f-0a1b2c3d4e5f';
const BO = '5a1f0c2e-3b4d-4e6f-8a9b-0c1d2e3f4a5b';

function hearing(opts: { keep?: (lines: readonly HeardLine[]) => Promise<void> } = {}) {
  let clock = Date.parse('2026-10-27T15:00:00Z');
  const lines: HeardLine[] = [];
  const said: { topic: string; payload: Uint8Array }[] = [];
  const billed: number[] = [];
  let people = 2;
  const h = new CallHearing('6f1d2c3b-4a59-4e8f-9a0b-1c2d3e4f5a6b', {
    speech: createFakeSpeech(),
    log,
    now: () => clock,
    keep:
      opts.keep ??
      (async (l) => {
        lines.push(...l);
      }),
    bill: async (s) => {
      billed.push(s);
    },
    say: async (topic, payload) => {
      said.push({ topic, payload });
    },
    people: () => people,
  });
  return {
    h,
    lines,
    said,
    billed,
    advance: (ms: number) => {
      clock += ms;
    },
    setPeople: (n: number) => {
      people = n;
    },
  };
}

describe('the voice gate', () => {
  it('sends nothing while it’s quiet', () => {
    const g = new VoiceGate();
    for (let i = 0; i < 100; i++) expect(g.push(frame(false))).toEqual([]);
    expect(g.talking).toBe(false);
  });

  it('sends talking with the moment before it, through the pause after it, then stops', () => {
    const g = new VoiceGate();
    for (let i = 0; i < 50; i++) g.push(frame(false));
    // Not yet: a click isn't talking.
    expect(g.push(frame(true, 1))).toEqual([]);
    expect(g.push(frame(true, 2))).toEqual([]);
    const opened = g.push(frame(true, 3));
    expect(g.talking).toBe(true);
    // The 300 ms before it, and the three loud frames.
    expect(opened.length * 20).toBeGreaterThanOrEqual(GATE.beforeMs);
    expect(opened.length * 20).toBeLessThanOrEqual(GATE.beforeMs + 80);
    // A short pause mid-sentence is still sent.
    for (let i = 0; i < 10; i++) expect(g.push(frame(false))).toHaveLength(1);
    expect(g.push(frame(true, 4))).toHaveLength(1);
    let sent = 0;
    while (g.talking) sent += g.push(frame(false)).length;
    expect(sent * 20).toBe(GATE.hangMs);
    expect(g.push(frame(false))).toEqual([]);
  });
});

describe('a call heard', () => {
  it('hears each person on their own, as captions and as lines that say who', async () => {
    const t = hearing();
    t.h.voice({ identity: ANA, name: 'Ana Customer', frames: microphone(SAID) });
    await vi.waitFor(() => expect(t.said.length).toBe(1));
    t.advance(5_000);
    t.h.voice({ identity: BO, name: 'Bo Team', frames: microphone(SAID) });
    await vi.waitFor(() => expect(t.said.length).toBe(2));

    const captions = t.said.map((s) => {
      expect(s.topic).toBe(VIDEO_CALL_CAPTIONS_TOPIC);
      return captionOf(s.payload);
    });
    expect(captions).toEqual([
      expect.objectContaining({ who: ANA, name: 'Ana Customer', text: FAKE_HEARD, final: true }),
      expect.objectContaining({ who: BO, name: 'Bo Team', text: FAKE_HEARD, final: true }),
    ]);

    t.advance(3_000);
    expect(await t.h.tick()).toBe(true);
    expect(t.lines).toEqual([
      expect.objectContaining({ personId: ANA, text: FAKE_HEARD, language: 'en' }),
      expect.objectContaining({ personId: BO, text: FAKE_HEARD, language: 'en' }),
    ]);
    expect(Date.parse(t.lines[1]!.saidAt) - Date.parse(t.lines[0]!.saidAt)).toBe(5_000);
    // One listener's keys, each its own; another listener (a restart) has another session.
    const [session] = t.lines[0]!.key.split(':');
    expect(t.lines.map((l) => l.key)).toEqual([`${session}:${ANA}:0`, `${session}:${BO}:0`]);
    expect(await hearingSession(hearing())).not.toBe(session);
  });

  it('puts only the sound it sent on the balance', async () => {
    const t = hearing();
    t.h.voice({ identity: ANA, name: 'Ana Customer', frames: microphone(SAID) });
    await vi.waitFor(() => expect(t.said.length).toBe(1));
    await t.h.stop();
    const seconds = t.billed.reduce((a, b) => a + b, 0);
    // A second of talking, with the moment before it and 1.2 s after: not the 3.4 s the microphone ran.
    expect(seconds).toBeGreaterThan((1000 + GATE.hangMs) / 1000);
    expect(seconds).toBeLessThanOrEqual((1000 + GATE.beforeMs + GATE.hangMs) / 1000);
  });

  it('sends lines again that couldn’t be kept', async () => {
    let fail = true;
    const kept: HeardLine[] = [];
    const t = hearing({
      keep: async (l) => {
        if (fail) throw new Error('the database is away');
        kept.push(...l);
      },
    });
    t.h.voice({ identity: ANA, name: 'Ana Customer', frames: microphone(SAID) });
    await vi.waitFor(() => expect(t.said.length).toBe(1));
    t.advance(3_000);
    await t.h.tick();
    expect(kept).toEqual([]);
    fail = false;
    t.advance(3_000);
    await t.h.tick();
    expect(kept).toEqual([expect.objectContaining({ personId: ANA, text: FAKE_HEARD })]);
  });

  it('says to leave once it’s been alone a while', async () => {
    const t = hearing();
    expect(await t.h.tick()).toBe(true);
    t.setPeople(0);
    expect(await t.h.tick()).toBe(true);
    t.advance(ALONE_MS - 1_000);
    expect(await t.h.tick()).toBe(true);
    t.advance(1_000);
    expect(await t.h.tick()).toBe(false);
    // Someone back in time keeps it there.
    const u = hearing();
    u.setPeople(0);
    await u.h.tick();
    u.advance(ALONE_MS - 1_000);
    u.setPeople(1);
    await u.h.tick();
    u.advance(5_000);
    expect(await u.h.tick()).toBe(true);
  });
});

/** The session a fresh hearing names its lines with, from its first caption. */
function hearingSession(t: ReturnType<typeof hearing>): Promise<string> {
  t.h.voice({ identity: ANA, name: 'Ana Customer', frames: microphone(SAID) });
  return vi
    .waitFor(() => expect(t.said.length).toBe(1))
    .then(() => captionOf(t.said[0]!.payload)!.id.split(':')[0]!);
}
