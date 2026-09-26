import type { PhoneVoice } from '@hfos/core';
import { useAudioRecorder } from 'expo-audio';
import * as React from 'react';

import { VOICE_OFF, VOICE_RECORDING, VoiceSession, type VoiceSnapshot } from './session';

/**
 * One voice session for a screen, and what it's doing now. It lives as long as the screen does, and stops listening
 * and speaking when the screen closes.
 */
export function useVoice(
  workspaceId: string,
  voice: PhoneVoice | null,
): { readonly session: VoiceSession; readonly snap: VoiceSnapshot } {
  const recorder = useAudioRecorder(VOICE_RECORDING);
  const recorderRef = React.useRef(recorder);
  recorderRef.current = recorder;
  const workspaceRef = React.useRef(workspaceId);
  workspaceRef.current = workspaceId;
  const voiceRef = React.useRef(voice);
  voiceRef.current = voice;
  const [session] = React.useState(
    () =>
      new VoiceSession({
        workspaceId: () => workspaceRef.current,
        voice: () => voiceRef.current,
        recorder: () => recorderRef.current,
      }),
  );
  const snap = React.useSyncExternalStore(session.subscribe, session.getSnapshot, () => VOICE_OFF);
  React.useEffect(() => () => session.stop(), [session]);
  return { session, snap };
}
