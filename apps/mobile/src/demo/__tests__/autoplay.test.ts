jest.mock('@/lib/auth', () => ({
  session: { getState: () => ({ status: 'signedOut' }) },
}));

import { AUTO_LEAD_MS, autoNext, sayingMs } from '../autoplay';
import { findPhoneScene } from '../scenes';
import type { PhoneDemo } from '../state';

/**
 * Play on its own (src/demo/autoplay.ts): each step plays once the last one's voiceover has been said, a step played
 * from the notification waits for that press, and the player comes back when the scene is over.
 */

const START = Date.UTC(2026, 10, 4, 23, 0, 0);
const scene = findPhoneScene('lock-screen-approve')!;

const demo = (playedAt: readonly number[]): PhoneDemo => ({
  viewerId: '11111111-1111-4111-8111-111111111111',
  workspaceId: '22222222-2222-4222-8222-222222222222',
  scene: scene.id,
  steps: playedAt,
  startedAt: START,
  business: 'Bayou Plumbing Co.',
  teammate: 'Ava',
  me: 'Dale',
  myName: 'Dale Ramsey',
  timeZone: 'America/Chicago',
  read: [],
  typed: [],
});

test('a voiceover takes about 2.4 words a second with a breath after it, and never under 3 seconds', () => {
  expect(sayingMs('Put it away.')).toBe(3000);
  expect(sayingMs(Array.from({ length: 24 }, () => 'word').join(' '))).toBe(11_000);
});

test('the first step plays a moment after starting, so it never lands as the player disappears', () => {
  expect(autoNext(demo([]), scene, START, START)).toEqual({ kind: 'play', inMs: AUTO_LEAD_MS });
  expect(autoNext(demo([]), scene, START, START + 1000)).toEqual({
    kind: 'play',
    inMs: AUTO_LEAD_MS - 1000,
  });
});

test('the next step plays once the last one’s voiceover has been said', () => {
  const said = sayingMs(scene.steps[0]!.voiceover);
  // The first step played 5 seconds into the scene; 2 seconds of its voiceover have gone by.
  expect(autoNext(demo([5000]), scene, START, START + 7000)).toEqual({
    kind: 'play',
    inMs: said - 2000,
  });
});

test('started part way through, it still waits a moment before the next step', () => {
  const later = START + 60_000;
  expect(autoNext(demo([5000]), scene, later, later)).toEqual({
    kind: 'play',
    inMs: AUTO_LEAD_MS,
  });
});

test('Approve on the lock screen is the presenter’s to press: it waits for it', () => {
  expect(scene.steps[2]!.press).toBe('approve');
  expect(autoNext(demo([5000, 25_000]), scene, START, START + 90_000)).toEqual({ kind: 'press' });
});

test('after the press, time spent unlocking the phone counts toward its voiceover', () => {
  // Approved at 40 seconds; the app opened a minute later, long after its voiceover.
  expect(autoNext(demo([5000, 25_000, 40_000]), scene, START, START + 100_000)).toEqual({
    kind: 'play',
    inMs: 0,
  });
});

test('the player comes back once the last voiceover has been said', () => {
  const played = [5000, 25_000, 40_000, 60_000];
  const said = sayingMs(scene.steps[3]!.voiceover);
  expect(autoNext(demo(played), scene, START, START + 60_000)).toEqual({ kind: 'end', inMs: said });
});
