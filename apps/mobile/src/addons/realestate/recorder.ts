import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
  type RecordingOptions,
} from 'expo-audio';
import { File } from 'expo-file-system';
import * as React from 'react';

import { keptStore } from '@/sync/kept-store';

/**
 * A voice note at a tour stop (board 83): recorded on the phone with or without signal, kept encrypted beside the
 * photos waiting to upload (`sync/kept-files.ts`), and sent on the same track. Its words come from HandsFreeOS once it
 * arrives (the worker's transcriber, billed like any speech).
 */

/** Mono speech at a modest bit rate, with the meter for the bars: a minute is about half a megabyte. */
export const VOICE_NOTE_RECORDING: RecordingOptions = {
  ...RecordingPresets.HIGH_QUALITY,
  numberOfChannels: 1,
  bitRate: 64_000,
  isMeteringEnabled: true,
};

/** The longest a voice note runs before it stops by itself. */
export const VOICE_NOTE_MAX_SECONDS = 5 * 60;
/** How many bars the level shows. */
export const LEVEL_BARS = 40;

export type RecorderPhase = 'idle' | 'recording' | 'done';

export interface VoiceNoteRecording {
  readonly phase: RecorderPhase;
  /** Seconds recorded so far, or in all once it's done. */
  readonly seconds: number;
  /** The last few loudness readings, 0 to 1, newest last. */
  readonly levels: readonly number[];
  /** Why it couldn't record: 'microphone' (not allowed) or 'failed'. */
  readonly problem: 'microphone' | 'failed' | null;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Throws the recording away, for Record again or closing. */
  discard(): void;
  /** Where the finished recording is, until it's kept. */
  readonly uri: string | null;
}

/** dBFS to a bar's height. */
const levelOf = (db: number | undefined) =>
  db === undefined ? 0 : Math.max(0, Math.min(1, (db + 60) / 60));

export function useVoiceNoteRecorder(): VoiceNoteRecording {
  const recorder = useAudioRecorder(VOICE_NOTE_RECORDING);
  const [phase, setPhase] = React.useState<RecorderPhase>('idle');
  const [seconds, setSeconds] = React.useState(0);
  const [levels, setLevels] = React.useState<readonly number[]>([]);
  const [problem, setProblem] = React.useState<VoiceNoteRecording['problem']>(null);
  const [uri, setUri] = React.useState<string | null>(null);
  const timer = React.useRef<ReturnType<typeof setInterval> | null>(null);
  const stopRef = React.useRef<() => Promise<void>>(async () => undefined);

  const clear = () => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
  };

  const stop = React.useCallback(async () => {
    clear();
    const status = (() => {
      try {
        return recorder.getStatus();
      } catch {
        return null;
      }
    })();
    await recorder.stop().catch(() => undefined);
    void setAudioModeAsync({ allowsRecording: false, interruptionMode: 'mixWithOthers' }).catch(
      () => undefined,
    );
    if (status?.durationMillis) setSeconds(status.durationMillis / 1000);
    setUri(recorder.uri);
    setPhase(recorder.uri ? 'done' : 'idle');
    if (!recorder.uri) setProblem('failed');
  }, [recorder]);
  stopRef.current = stop;

  const start = React.useCallback(async () => {
    setProblem(null);
    const permission = await requestRecordingPermissionsAsync().catch(() => null);
    if (!permission?.granted) {
      setProblem('microphone');
      return;
    }
    try {
      await setAudioModeAsync({ playsInSilentMode: true, allowsRecording: true });
      await recorder.prepareToRecordAsync(VOICE_NOTE_RECORDING);
      recorder.record();
    } catch {
      setProblem('failed');
      return;
    }
    const startedAt = Date.now();
    setSeconds(0);
    setLevels([]);
    setUri(null);
    setPhase('recording');
    clear();
    timer.current = setInterval(() => {
      let metering: number | undefined;
      try {
        metering = recorder.getStatus().metering;
      } catch {
        metering = undefined;
      }
      const s = (Date.now() - startedAt) / 1000;
      setSeconds(s);
      setLevels((l) => [...l, levelOf(metering)].slice(-LEVEL_BARS));
      if (s >= VOICE_NOTE_MAX_SECONDS) void stopRef.current();
    }, 150);
  }, [recorder]);

  const discard = React.useCallback(() => {
    clear();
    if (recorder.uri) removeFile(recorder.uri);
    setUri(null);
    setSeconds(0);
    setLevels([]);
    setPhase('idle');
  }, [recorder]);

  React.useEffect(() => () => clear(), []);

  return { phase, seconds, levels, problem, start, stop, discard, uri };
}

function removeFile(uri: string) {
  try {
    const f = new File(uri);
    if (f.exists) f.delete();
  } catch {
    // Already gone.
  }
}

/**
 * Keeps a finished recording in the person's kept files (encrypted, named for its file id) to wait for upload, and
 * deletes the plain one the recorder wrote.
 */
export function keepRecording(input: {
  readonly userId: string;
  readonly fileId: string;
  readonly uri: string;
}): { readonly localName: string; readonly sizeBytes: number } {
  const localName = `${input.fileId}.m4a`;
  const plain = new File(input.uri);
  try {
    const bytes = plain.bytesSync();
    keptStore.of(input.userId).put(localName, 'waiting', bytes, { mimeType: 'audio/mp4' });
    return { localName, sizeBytes: bytes.length };
  } finally {
    if (plain.exists) plain.delete();
  }
}
