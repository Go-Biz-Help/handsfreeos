import { renderHook } from '@testing-library/react-native';
import { EventEmitter } from 'events';
import { createAudioPlayer } from 'expo-audio';
import { RoomEvent, type Room } from 'livekit-client';

import { LISTENER_IDENTITY, VIDEO_CALL_ATTRIBUTES } from '@hfos/core';

import { useCallSounds } from '@/video-call/call-sounds';

/**
 * A call's sounds on the phone (docs/video-calls.md, "Sounds"): the chime as someone comes in and the door chime as
 * someone asks to, played inside the call's own sound, and kept quiet for everyone already there when the phone's
 * connection comes back. LiveKit's room is a stand-in that tells of people the way the real one does.
 */

const made = createAudioPlayer as unknown as jest.Mock;

interface FakePlayer {
  play: () => void;
  remove: () => void;
}

/** The players the hook made, by the options and file they were made with, each with `play` and `remove` watched. */
function players() {
  const all = made.mock.results.map((r) => r.value as FakePlayer);
  for (const p of all) {
    if (!jest.isMockFunction(p.play)) jest.spyOn(p, 'play');
    if (!jest.isMockFunction(p.remove)) jest.spyOn(p, 'remove');
  }
  const [join, knock] = all;
  return { join: join!, knock: knock! };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
let now = 1_000_000;
const person = (n: number, kind = 'customer') => ({
  identity: `0000000${n}-0000-4000-8000-000000000000`,
  attributes: { [VIDEO_CALL_ATTRIBUTES.kind]: kind },
});

beforeEach(() => {
  made.mockClear();
  now = 1_000_000;
  jest.spyOn(Date, 'now').mockImplementation(() => now);
});
afterEach(() => jest.restoreAllMocks());

async function inRoom(webinar = false) {
  const room = new EventEmitter();
  const hook = await renderHook(() => useCallSounds(room as unknown as Room, webinar));
  return { room, hook, ...players() };
}

describe('the join sound', () => {
  it('plays once someone comes in, without changing the call’s sound', async () => {
    const { room, join, knock } = await inRoom();
    expect(made).toHaveBeenCalledTimes(2);
    for (const [, options] of made.mock.calls)
      expect(options).toEqual({ keepAudioSessionActive: true });
    room.emit(RoomEvent.ParticipantConnected, person(1));
    await flush();
    expect(join.play).toHaveBeenCalledTimes(1);
    expect(knock.play).not.toHaveBeenCalled();
  });

  it('plays once for several people coming in together, and again a little later', async () => {
    const { room, join } = await inRoom();
    room.emit(RoomEvent.ParticipantConnected, person(1));
    room.emit(RoomEvent.ParticipantConnected, person(2));
    await flush();
    expect(join.play).toHaveBeenCalledTimes(1);
    now += 5_000;
    room.emit(RoomEvent.ParticipantConnected, person(3));
    await flush();
    expect(join.play).toHaveBeenCalledTimes(2);
  });

  it('never plays for the AI’s listener', async () => {
    const { room, join } = await inRoom();
    room.emit(RoomEvent.ParticipantConnected, { identity: LISTENER_IDENTITY, attributes: {} });
    await flush();
    expect(join.play).not.toHaveBeenCalled();
  });

  it('plays in a webinar only as someone from the team comes in', async () => {
    const { room, join } = await inRoom(true);
    room.emit(RoomEvent.ParticipantConnected, person(1, 'guest'));
    await flush();
    expect(join.play).not.toHaveBeenCalled();
    room.emit(RoomEvent.ParticipantConnected, person(2, 'team'));
    await flush();
    expect(join.play).toHaveBeenCalledTimes(1);
  });

  it('stays quiet for everyone already there when the phone’s connection comes back', async () => {
    const { room, join } = await inRoom();
    room.emit(RoomEvent.Reconnecting);
    now += 4_000;
    room.emit(RoomEvent.Reconnected);
    room.emit(RoomEvent.ParticipantConnected, person(1));
    room.emit(RoomEvent.ParticipantConnected, person(2));
    await flush();
    expect(join.play).not.toHaveBeenCalled();
    now += 10_000;
    room.emit(RoomEvent.ParticipantConnected, person(3));
    await flush();
    expect(join.play).toHaveBeenCalledTimes(1);
  });
});

describe('the knock', () => {
  it('plays when the screen says someone is asking to come in, once for several', async () => {
    const { hook, join, knock } = await inRoom();
    hook.result.current.knock();
    hook.result.current.knock();
    await flush();
    expect(knock.play).toHaveBeenCalledTimes(1);
    expect(join.play).not.toHaveBeenCalled();
  });
});

it('lets go of its players when the call screen closes', async () => {
  const { hook, join, knock } = await inRoom();
  await hook.unmount();
  expect(join.remove).toHaveBeenCalled();
  expect(knock.remove).toHaveBeenCalled();
});
