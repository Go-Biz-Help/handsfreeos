/**
 * The listener in a LiveKit room, through LiveKit's media library for Node (`@livekit/rtc-node`). Only the media
 * process loads this file: the library is native code, built for Debian's C library (glibc), which is why the
 * worker's image is Debian (Dockerfile). Everything else about hearing a call is in hearing.ts.
 *
 * The listener asks only for microphones (never cameras or a shared screen's sound) and hears each one as 16 kHz
 * mono, the sound Deepgram is sent.
 */
import { isPersonIdentity, LISTENER_IDENTITY } from '@hfos/core';
import {
  AudioStream,
  DisconnectReason,
  Room,
  RoomEvent,
  TrackKind,
  TrackSource,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
} from '@livekit/rtc-node';
import { WIDE_SAMPLE_RATE } from '../voice-agent/speech';
import type { JoinRoom, ListenerRoomEvents } from './hearing';

const isPerson = (p: RemoteParticipant) =>
  p.identity !== LISTENER_IDENTITY && isPersonIdentity(p.identity);

const isMicrophone = (pub: RemoteTrackPublication) =>
  pub.kind === TrackKind.KIND_AUDIO && pub.source === TrackSource.SOURCE_MICROPHONE;

/** A microphone's frames until it goes; stopping early lets the stream go too. */
async function* framesOf(stream: AudioStream): AsyncIterable<Int16Array> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value.data;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

export const joinLiveKitRoom: JoinRoom = async (ticket, events: ListenerRoomEvents) => {
  const room = new Room();
  let left = false;

  const want = (pub: RemoteTrackPublication, p: RemoteParticipant) => {
    if (isPerson(p) && isMicrophone(pub)) pub.setSubscribed(true);
  };
  room.on(RoomEvent.TrackPublished, want);
  room.on(
    RoomEvent.TrackSubscribed,
    (track: RemoteTrack, pub: RemoteTrackPublication, p: RemoteParticipant) => {
      if (!isPerson(p) || !isMicrophone(pub)) return;
      const stream = new AudioStream(track, {
        sampleRate: WIDE_SAMPLE_RATE,
        numChannels: 1,
        frameSizeMs: 20,
      });
      events.onVoice({ identity: p.identity, name: p.name || 'Someone', frames: framesOf(stream) });
    },
  );
  room.on(RoomEvent.Disconnected, (reason: DisconnectReason) => {
    if (left) return;
    left = true;
    events.onGone(
      reason === DisconnectReason.DUPLICATE_IDENTITY
        ? 'replaced'
        : reason === DisconnectReason.ROOM_DELETED || reason === DisconnectReason.ROOM_CLOSED
          ? 'closed'
          : 'lost',
    );
  });

  // Nothing comes unasked: the listener picks the microphones itself.
  await room.connect(ticket.url, ticket.token, { autoSubscribe: false, dynacast: false });
  for (const p of room.remoteParticipants.values())
    for (const pub of p.trackPublications.values()) want(pub, p);

  return {
    people: () => [...room.remoteParticipants.values()].filter(isPerson).length,
    async say(topic, payload) {
      if (!left) await room.localParticipant?.publishData(payload, { reliable: true, topic });
    },
    async leave() {
      if (left) return;
      left = true;
      await room.disconnect();
    },
  };
};
