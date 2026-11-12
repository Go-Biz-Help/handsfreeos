/**
 * A video call's sounds (docs/video-calls.md, "Sounds"), without a database: who coming in plays the join sound, and
 * when a sound that's due really plays, on the web and the phone alike.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  joinSoundFor,
  LISTENER_IDENTITY,
  VIDEO_CALL_ATTRIBUTES,
  VIDEO_CALL_SOUND_GAP_MS,
  VIDEO_CALL_SOUND_SETTLE_MS,
  videoCallSoundGate,
} from '../src/meetings/video-calls';

const as = (kind: string) => ({ [VIDEO_CALL_ATTRIBUTES.kind]: kind });

describe('who coming in plays the join sound', () => {
  it('is anyone in a meeting: the team, a customer or a guest', () => {
    for (const kind of ['team', 'customer', 'guest'])
      expect(joinSoundFor({ identity: randomUUID(), attributes: as(kind), webinar: false })).toBe(
        true,
      );
  });

  it('is never the AI’s listener', () => {
    expect(joinSoundFor({ identity: LISTENER_IDENTITY, attributes: {}, webinar: false })).toBe(
      false,
    );
  });

  it('is only the team in a webinar, so attendees arriving stay quiet', () => {
    expect(joinSoundFor({ identity: randomUUID(), attributes: as('team'), webinar: true })).toBe(
      true,
    );
    for (const kind of ['customer', 'guest'])
      expect(joinSoundFor({ identity: randomUUID(), attributes: as(kind), webinar: true })).toBe(
        false,
      );
    expect(joinSoundFor({ identity: randomUUID(), webinar: true })).toBe(false);
  });
});

describe('when a sound that’s due plays', () => {
  it('plays once when several of a kind come together, and again after the gap', () => {
    const gate = videoCallSoundGate();
    expect(gate.due('join', 1_000)).toBe(true);
    expect(gate.due('join', 1_500)).toBe(false);
    expect(gate.due('join', 1_000 + VIDEO_CALL_SOUND_GAP_MS - 1)).toBe(false);
    expect(gate.due('join', 1_000 + VIDEO_CALL_SOUND_GAP_MS)).toBe(true);
  });

  it('keeps each kind to its own gap', () => {
    const gate = videoCallSoundGate();
    expect(gate.due('join', 1_000)).toBe(true);
    expect(gate.due('knock', 1_100)).toBe(true);
  });

  it('stays quiet while the page’s own connection comes back, and a moment after', () => {
    const gate = videoCallSoundGate();
    gate.quiet();
    expect(gate.due('join', 5_000)).toBe(false);
    expect(gate.due('join', 60_000)).toBe(false);
    gate.settled(60_000);
    // Everyone already there, told of again.
    expect(gate.due('join', 60_000 + VIDEO_CALL_SOUND_SETTLE_MS - 1)).toBe(false);
    expect(gate.due('join', 60_000 + VIDEO_CALL_SOUND_SETTLE_MS)).toBe(true);
  });

  it('isn’t held back by quiet moments that never played', () => {
    const gate = videoCallSoundGate();
    gate.quiet();
    expect(gate.due('join', 1_000)).toBe(false);
    gate.settled(1_000);
    expect(gate.due('join', 1_000 + VIDEO_CALL_SOUND_SETTLE_MS)).toBe(true);
  });
});
