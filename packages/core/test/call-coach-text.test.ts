import { describe, expect, it } from 'vitest';
import {
  CALL_COACH_TEXT_SIZES,
  CALL_COACH_TEXT_SIZE_START,
  callCoachTextStep,
} from '../src/meetings/video-calls';

/**
 * How big the coach's words go over a video call (the owner, 12 Nov 2026: "need to be able to adjust the text
 * size"): the steps A− and A+ move through on the web and the phone, and a kept step read back.
 */
describe('the coach’s text sizes over a call', () => {
  it('start at the usual size and only grow from one step to the next', () => {
    expect(CALL_COACH_TEXT_SIZES[CALL_COACH_TEXT_SIZE_START]).toBe(1);
    for (let i = 1; i < CALL_COACH_TEXT_SIZES.length; i++)
      expect(CALL_COACH_TEXT_SIZES[i]!).toBeGreaterThan(CALL_COACH_TEXT_SIZES[i - 1]!);
    // Down a little for more on the box; up to twice as big to read across the room.
    expect(CALL_COACH_TEXT_SIZES[0]).toBeLessThan(1);
    expect(CALL_COACH_TEXT_SIZES.at(-1)).toBe(2);
  });

  it('read a kept step back as one that exists, else the usual size', () => {
    expect(callCoachTextStep(0)).toBe(0);
    expect(callCoachTextStep(CALL_COACH_TEXT_SIZES.length - 1)).toBe(
      CALL_COACH_TEXT_SIZES.length - 1,
    );
    for (const kept of [CALL_COACH_TEXT_SIZES.length, -1, 1.5, '3', null, undefined, Number.NaN])
      expect(callCoachTextStep(kept)).toBe(CALL_COACH_TEXT_SIZE_START);
  });
});
