import {
  PHONE_VOICE_PICK_WORDS,
  phoneVoiceInfo,
  phoneVoiceOf,
  phoneVoiceSampleOf,
  VOICES_ASSUMED,
  withPhoneVoice,
  type PhoneVoice,
  type VoiceReadiness,
} from '@hfos/core';
import { createAudioPlayer, type AudioPlayer } from 'expo-audio';
import * as React from 'react';

import { toast } from '@/components/ui/toast';
import { api, unwrap } from '@/lib/api';
import { forget, sayClip, voiceReadiness } from '@/voice/speech';

/** The saved settings a voice is kept in. */
interface Saved {
  readonly teammateId: string;
  readonly revision: number;
  readonly config: unknown;
}

/**
 * The test console's voice picker on the phone (the owner's pick 7a, 28 Oct 2026), as the web's: a call can try any
 * voice, Deepgram's or Rime's, without changing the settings; Hear it says the greeting in it; and Use this voice
 * saves it as the teammate's own straight away, since the phone tests the saved settings. A Rime voice can't be
 * picked until the worker has Rime's key. `tryVoice` is what the call speaks in: null is the saved voice.
 */
export function useVoicePick(workspaceId: string, name: string) {
  const [saved, setSaved] = React.useState<Saved | null>(null);
  const [ready, setReady] = React.useState<VoiceReadiness | null>(null);
  // Tried over the saved voice as it was: once that changes (Use this voice), the call speaks in it.
  const [tried, setTried] = React.useState<{ voice: PhoneVoice; over: PhoneVoice } | null>(null);
  const [playing, setPlaying] = React.useState<PhoneVoice | null>(null);
  const [keeping, setKeeping] = React.useState(false);
  const player = React.useRef<{ player: AudioPlayer | null; uri: string | null; gen: number }>({
    player: null,
    uri: null,
    gen: 0,
  });

  React.useEffect(() => {
    let live = true;
    void api
      .POST('/v1/queries/ai_teammate.get', { body: { workspaceId } })
      .then((r) => {
        const t = r.data?.teammate;
        if (live && t) setSaved({ teammateId: t.id, revision: t.revision, config: t.config });
      })
      .catch(() => undefined);
    void voiceReadiness()
      .then((r) => {
        if (live) setReady(r);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [workspaceId]);

  const savedVoice = phoneVoiceOf(saved?.config) ?? 'warm';
  const tryVoice = tried && tried.over === savedVoice ? tried.voice : null;
  const callVoice = tryVoice ?? savedVoice;
  const trying = tryVoice !== null && tryVoice !== savedVoice;

  const stopHearing = React.useCallback(() => {
    const p = player.current;
    p.gen++;
    if (p.player) {
      try {
        p.player.pause();
        p.player.remove();
      } catch {
        // Already let go.
      }
    }
    if (p.uri) forget(p.uri);
    p.player = null;
    p.uri = null;
    setPlaying(null);
  }, []);

  React.useEffect(() => stopHearing, [stopHearing]);

  const pick = (v: PhoneVoice) => {
    stopHearing();
    setTried(v === savedVoice ? null : { voice: v, over: savedVoice });
  };

  /** Hear it: the greeting, said by the worker in the voice picked. */
  const hear = () => {
    stopHearing();
    const voice = callVoice;
    const gen = player.current.gen;
    setPlaying(voice);
    void (async () => {
      try {
        const clip = await sayClip({
          workspaceId,
          text: phoneVoiceSampleOf(saved?.config, name),
          voice,
          language: null,
        });
        if (player.current.gen !== gen) {
          forget(clip.uri);
          return;
        }
        const p = createAudioPlayer({ uri: clip.uri }, { updateInterval: 100 });
        player.current.player = p;
        player.current.uri = clip.uri;
        const subscription = p.addListener('playbackStatusUpdate', (status) => {
          if (!status.didJustFinish || player.current.player !== p) return;
          subscription.remove();
          stopHearing();
        });
        p.play();
        if (clip.voice && clip.voice !== voice)
          toast.show(
            PHONE_VOICE_PICK_WORDS.saidInstead(
              phoneVoiceInfo(voice).name,
              phoneVoiceInfo(clip.voice).name,
            ),
          );
      } catch (e) {
        if (player.current.gen !== gen) return;
        stopHearing();
        toast.error(e instanceof Error ? e.message : 'Couldn’t play it. Try again.');
      }
    })();
  };

  /** Use this voice: saved as the teammate's own straight away, as a new revision. */
  const keep = async () => {
    if (!saved || !tryVoice || keeping) return;
    setKeeping(true);
    try {
      const config = withPhoneVoice(saved.config, tryVoice) as Record<string, unknown>;
      const out = unwrap(
        await api.POST('/v1/commands/ai_teammate.save_config', {
          body: {
            workspaceId,
            teammateId: saved.teammateId,
            baseRevision: saved.revision,
            config: config as never,
          },
        }),
      );
      setSaved({ ...saved, revision: out.revision, config });
      toast.show(PHONE_VOICE_PICK_WORDS.saved(phoneVoiceInfo(tryVoice).name));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Couldn’t save that. Try again.');
    } finally {
      setKeeping(false);
    }
  };

  return {
    /** The voice the call speaks in, and the one the settings say. */
    callVoice,
    savedVoice,
    /** Another voice being tried: what the call asks the worker to speak in (null is the saved one). */
    tryVoice: trying ? tryVoice : null,
    trying,
    /** Which providers can speak, and whether the worker has said yet. */
    ready: ready ?? VOICES_ASSUMED,
    known: ready !== null,
    /** The settings are loaded, so Use this voice can save. */
    canKeep: saved !== null,
    pick,
    playing,
    hear,
    stopHearing,
    keeping,
    keep,
  };
}

export type VoicePick = ReturnType<typeof useVoicePick>;
