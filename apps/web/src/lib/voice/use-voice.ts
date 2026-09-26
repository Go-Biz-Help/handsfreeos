'use client';
import type { PhoneVoice } from '@hfos/core';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { VOICE_OFF, VoiceSession, type VoiceSnapshot } from './session';

/**
 * One voice session for a screen, and what it's doing now. It lives as long as the screen does and lets the
 * microphone go when the screen closes.
 */
export function useVoice(
  workspaceId: string,
  voice: PhoneVoice | null,
): { readonly session: VoiceSession; readonly snap: VoiceSnapshot } {
  const workspaceRef = useRef(workspaceId);
  workspaceRef.current = workspaceId;
  const voiceRef = useRef(voice);
  voiceRef.current = voice;
  const [session] = useState(
    () =>
      new VoiceSession({ workspaceId: () => workspaceRef.current, voice: () => voiceRef.current }),
  );
  const snap = useSyncExternalStore(session.subscribe, session.getSnapshot, () => VOICE_OFF);
  useEffect(() => () => session.stop(), [session]);
  return { session, snap };
}
