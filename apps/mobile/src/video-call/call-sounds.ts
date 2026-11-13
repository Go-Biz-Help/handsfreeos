/**
 * A call's sounds on the phone (docs/video-calls.md, "Sounds"): the web's two, from the same files
 * (scripts/video-call-sounds.mjs), at the same moments (core's `joinSoundFor` and `videoCallSoundGate`). One as
 * someone comes in (in a webinar, only someone from the team), and one as someone asks to be let in.
 *
 * They play inside the call's own sound. LiveKit set the phone up for a call, and the players leave that alone: an
 * iPhone's player would otherwise switch the phone's sound off as its sound ends (`keepAudioSessionActive`), and
 * nothing here changes the audio mode. So a sound comes out wherever the call's sound does.
 */
import {
  joinSoundFor,
  VIDEO_CALL_SOUNDS,
  videoCallSoundGate,
  type VideoCallSound,
} from '@hfos/core';
import { createAudioPlayer, type AudioPlayer } from 'expo-audio';
import { RoomEvent, type RemoteParticipant, type Room } from 'livekit-client';
import * as React from 'react';

import JOIN from '@/assets/sounds/call-join.wav';
import KNOCK from '@/assets/sounds/call-knock.wav';

const FILES: Record<VideoCallSound, number> = { join: JOIN, knock: KNOCK };
/** Under the voices: noticed, never louder than the person talking. */
const VOLUME = 0.7;

function play(player: AudioPlayer | undefined): void {
  if (!player) return;
  // From the start each time: a player that played once is left at its end.
  const go = () => {
    try {
      player.play();
    } catch {
      // A sound that can't play is never a problem to show.
    }
  };
  player.seekTo(0).then(go, go);
}

/**
 * The call's sounds, inside the room: the join sound as someone comes in, and `knock`, which the screen calls as
 * someone asks to come in. Both come at most once every couple of seconds, and never for the people already there
 * when the phone's own connection comes back.
 */
export function useCallSounds(room: Room, webinar: boolean): { knock: () => void } {
  const [gate] = React.useState(() => videoCallSoundGate());
  const players = React.useRef<Partial<Record<VideoCallSound, AudioPlayer>>>({});
  const isWebinar = React.useRef(webinar);
  isWebinar.current = webinar;

  React.useEffect(() => {
    const made: Partial<Record<VideoCallSound, AudioPlayer>> = {};
    for (const sound of VIDEO_CALL_SOUNDS) {
      try {
        const player = createAudioPlayer(FILES[sound], { keepAudioSessionActive: true });
        player.volume = VOLUME;
        made[sound] = player;
      } catch {
        // No sound for this one, and the call goes on.
      }
    }
    players.current = made;
    return () => {
      players.current = {};
      for (const player of Object.values(made)) player.remove();
    };
  }, []);

  React.useEffect(() => {
    const joined = (p: RemoteParticipant) => {
      if (
        !joinSoundFor({
          identity: p.identity,
          attributes: p.attributes,
          webinar: isWebinar.current,
        })
      )
        return;
      if (gate.due('join', Date.now())) play(players.current.join);
    };
    const quiet = () => gate.quiet();
    const settled = () => gate.settled(Date.now());
    room.on(RoomEvent.ParticipantConnected, joined);
    room.on(RoomEvent.Reconnecting, quiet);
    room.on(RoomEvent.SignalReconnecting, quiet);
    room.on(RoomEvent.Reconnected, settled);
    return () => {
      room.off(RoomEvent.ParticipantConnected, joined);
      room.off(RoomEvent.Reconnecting, quiet);
      room.off(RoomEvent.SignalReconnecting, quiet);
      room.off(RoomEvent.Reconnected, settled);
    };
  }, [room, gate]);

  const knock = React.useCallback(() => {
    if (gate.due('knock', Date.now())) play(players.current.knock);
  }, [gate]);
  return { knock };
}
