'use client';
/**
 * A call's sounds (docs/video-calls.md, "Sounds"): one when someone comes in, and for the team one when someone asks
 * to. The files are the phone's too (scripts/video-call-sounds.mjs), and core decides who and when
 * (`joinSoundFor`, `videoCallSoundGate`), so the web and the phone agree.
 *
 * They play through Web Audio, which a browser lets play at any time once the page has been pressed (Join counts).
 * A browser that still holds sound back (an iPhone's, sometimes) is asked again on the next press, the same one
 * that turns the call's own sound on.
 */
import { joinSoundFor, videoCallSoundGate, type VideoCallSound } from '@hfos/core';
import { useRoomContext } from '@livekit/components-react';
import { RoomEvent, type RemoteParticipant } from 'livekit-client';
import { useCallback, useEffect, useRef, useState } from 'react';

const FILES: Record<VideoCallSound, string> = {
  join: '/sounds/call-join.wav',
  knock: '/sounds/call-knock.wav',
};
/** Under the voices: noticed, never louder than the person talking. */
const VOLUME = 0.7;
/** Said on the window as each sound plays: its name. */
export const CALL_SOUND_EVENT = 'hfos:call-sound';

let audio: AudioContext | null = null;
const loaded = new Map<VideoCallSound, Promise<AudioBuffer | null>>();

function context(): AudioContext | null {
  if (audio) return audio;
  if (typeof window === 'undefined') return null;
  const Made =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Made) return null;
  try {
    audio = new Made();
  } catch {
    return null;
  }
  // Held back until a press: the next one lets it play.
  const wake = () => {
    if (audio?.state === 'suspended') void audio.resume().catch(() => undefined);
  };
  for (const e of ['pointerdown', 'keydown'] as const)
    window.addEventListener(e, wake, { capture: true, passive: true });
  return audio;
}

function load(sound: VideoCallSound): Promise<AudioBuffer | null> {
  const ctx = context();
  if (!ctx) return Promise.resolve(null);
  let got = loaded.get(sound);
  if (!got) {
    got = fetch(FILES[sound])
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
      .then((b) => ctx.decodeAudioData(b))
      .catch(() => {
        // Tried again the next time it's due.
        loaded.delete(sound);
        return null;
      });
    loaded.set(sound, got);
  }
  return got;
}

/** Plays one now, or says nothing: a sound that can't play is never a problem to show. */
export function playCallSound(sound: VideoCallSound): void {
  const ctx = context();
  if (!ctx) return;
  // Still held back: asked again now, for the next one.
  if (ctx.state !== 'running') {
    void ctx.resume().catch(() => undefined);
    return;
  }
  void load(sound).then((buffer) => {
    if (!buffer || ctx.state !== 'running') return;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const gain = ctx.createGain();
    gain.gain.value = VOLUME;
    source.connect(gain).connect(ctx.destination);
    source.start();
    // Which one played, for the browser test (e2e/video-call.spec.ts) to hear.
    window.dispatchEvent(new CustomEvent(CALL_SOUND_EVENT, { detail: sound }));
  });
}

/**
 * The call's sounds, inside the room: the join sound as someone comes in (in a webinar, only someone from the team),
 * and `knock`, which the team's page calls as someone asks to come in. Both come at most once every couple of
 * seconds, and never for the people already there when the page's own connection comes back.
 */
export function useCallSounds(webinar: boolean): { knock: () => void } {
  const room = useRoomContext();
  const [gate] = useState(() => videoCallSoundGate());
  const isWebinar = useRef(webinar);
  isWebinar.current = webinar;

  useEffect(() => {
    void load('join');
    void load('knock');
  }, []);

  useEffect(() => {
    const joined = (p: RemoteParticipant) => {
      if (
        !joinSoundFor({
          identity: p.identity,
          attributes: p.attributes,
          webinar: isWebinar.current,
        })
      )
        return;
      if (gate.due('join', Date.now())) playCallSound('join');
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

  const knock = useCallback(() => {
    if (gate.due('knock', Date.now())) playCallSound('knock');
  }, [gate]);
  return { knock };
}
