'use client';
/**
 * Microphone trouble in a call, on the web (docs/video-calls.md, "Microphone trouble"). The words and the steps come
 * from core's mic-help.ts, so the phone says the same.
 *
 * - **A blocked microphone (or camera)** gets a box that stays until it works: what's blocking it (the browser, or
 *   the Mac or Windows itself) and the steps for this browser and device, with Try again. Where the browser tells a
 *   page (Chrome, Edge, Safari), allowing it turns the microphone on by itself (`useWhenAllowed`).
 * - **The microphone menu** beside the microphone button: which microphone, with a bar that moves as it hears them,
 *   and, on a computer whose browser lets a page pick, which speaker. Both are remembered (./devices.ts).
 * - **Its sound, watched** (`useMicWatch`): "You're muted" when they talk while muted, and a microphone that sends
 *   nothing at all. It listens to a copy of the microphone on this computer; nothing is sent or kept. Not on an iPhone
 *   or iPad, where the phone pausing the microphone is caught instead (`useMicPaused`).
 */
import {
  MIC_WORDS,
  callDeviceOf,
  mediaHelp,
  mediaTroubleLine,
  mediaTroubleOf,
  mutedTalkGate,
  silentMicJudge,
  type CallDevice,
  type MediaKind,
  type MediaTrouble,
} from '@hfos/core';
import { useMediaDeviceSelect, useTrackVolume } from '@livekit/components-react';
import {
  supportsAudioOutputSelection,
  TrackEvent,
  type LocalAudioTrack,
  type Room,
} from 'livekit-client';
import { AlertTriangle, Check, ChevronUp, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { rememberDevice } from './devices';
import { toast } from './toast';

/** Until the page has read the browser: steps any browser can follow. */
export const ANY_DEVICE: CallDevice = { os: 'other', browser: 'other' };

/** This computer or phone and its browser, for the steps they'll see; null until the page has read it. */
export function useCallDevice(): CallDevice | null {
  const [device, setDevice] = useState<CallDevice | null>(null);
  useEffect(() => {
    setDevice(callDeviceOf(navigator.userAgent, navigator.maxTouchPoints ?? 0));
  }, []);
  return device;
}

/** What didn't start, and why, while in the call: the microphone's trouble opens the box; the camera's, if blocked. */
export interface MediaTroubles {
  readonly mic: MediaTrouble | null;
  readonly camera: MediaTrouble | null;
  /** The box is showing (they can close it; the microphone button still shows the trouble). */
  readonly open: boolean;
  /** An error from starting the microphone or camera. Each error is told once, however many places hear of it. */
  report(e: unknown, kind: MediaKind): void;
  clear(kind: MediaKind): void;
  setOpen(open: boolean): void;
}

export function useMediaTroubles(first?: MediaTrouble | null): MediaTroubles {
  const [state, setState] = useState<{
    mic: MediaTrouble | null;
    camera: MediaTrouble | null;
    open: boolean;
  }>({ mic: first ?? null, camera: null, open: false });
  // LiveKit tells the room about a device's error and throws it too: the same error object, told once.
  const told = useRef(new WeakSet<object>());
  const report = useCallback((e: unknown, kind: MediaKind) => {
    if (e && typeof e === 'object') {
      if (told.current.has(e)) return;
      told.current.add(e);
    }
    const trouble = mediaTroubleOf(e);
    if (kind === 'camera' && trouble !== 'blocked' && trouble !== 'system') {
      toast.error(mediaTroubleLine(trouble, 'camera'));
      return;
    }
    setState((s) => ({ ...s, [kind === 'camera' ? 'camera' : 'mic']: trouble, open: true }));
  }, []);
  const clear = useCallback((kind: MediaKind) => {
    setState((s) => {
      const next = { ...s, [kind === 'camera' ? 'camera' : 'mic']: null };
      return { ...next, open: next.open && !!(next.mic || next.camera) };
    });
  }, []);
  const setOpen = useCallback((open: boolean) => setState((s) => ({ ...s, open })), []);
  return { ...state, report, clear, setOpen };
}

/** The help for what didn't start, both at once when they're fixed in the same place. */
export function helpFor(
  troubles: { mic: MediaTrouble | null; camera: MediaTrouble | null },
  device: CallDevice,
) {
  const { mic, camera } = troubles;
  if (mic && camera && mic === camera)
    return mediaHelp(mic, device, ['camera', 'microphone'] as const);
  if (mic) return mediaHelp(mic, device, ['microphone']);
  if (camera) return mediaHelp(camera, device, ['camera']);
  return null;
}

/** The box: what's wrong, the steps for this browser and device, and Try again. */
export function MediaHelpBox({
  title,
  steps,
  retrying,
  onRetry,
  onClose,
  className,
  testId = 'call-media-help',
}: {
  title: string;
  steps: readonly string[];
  retrying?: boolean;
  onRetry: () => void;
  onClose?: () => void;
  className?: string;
  testId?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-col gap-2 rounded-control bg-warning-soft px-3.5 py-3 text-[13px] text-warning-text shadow-sm',
        className,
      )}
      role="alert"
      data-testid={testId}
    >
      <div className="flex items-start gap-2">
        <AlertTriangle size={16} className="mt-0.5 flex-none" aria-hidden />
        <p className="flex-1 font-medium" data-testid={`${testId}-title`}>
          {title}
        </p>
        {onClose ? (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="-mr-1 -mt-0.5 inline-flex h-6 w-6 flex-none items-center justify-center rounded-full hover:bg-black/10"
          >
            <X size={14} />
          </button>
        ) : null}
      </div>
      <ol className="ml-6 list-decimal space-y-1" data-testid={`${testId}-steps`}>
        {steps.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ol>
      <Button
        variant="secondary"
        size="sm"
        className="ml-6 w-fit"
        loading={retrying}
        onClick={onRetry}
        data-testid={`${testId}-retry`}
      >
        {MIC_WORDS.tryAgain}
      </Button>
    </div>
  );
}

/**
 * Calls `then` the moment the browser lets this page use the microphone (or camera) it had blocked: Chrome, Edge and
 * Safari tell a page when that changes; Firefox doesn't, so there it's Try again.
 */
export function useWhenAllowed(kinds: readonly MediaKind[], then: () => void) {
  const latest = useRef(then);
  latest.current = then;
  const key = [...kinds].sort().join(' ');
  useEffect(() => {
    if (!key || typeof navigator === 'undefined' || !navigator.permissions?.query) return;
    let gone = false;
    const watched: PermissionStatus[] = [];
    for (const kind of key.split(' ')) {
      navigator.permissions
        .query({ name: kind as PermissionName })
        .then((status) => {
          if (gone) return;
          watched.push(status);
          status.onchange = () => {
            if (status.state === 'granted') latest.current();
          };
        })
        .catch(() => {
          // A browser that can't be asked about it: Try again does the same.
        });
    }
    return () => {
      gone = true;
      for (const status of watched) status.onchange = null;
    };
  }, [key]);
}

/**
 * A microphone the phone (or computer) paused: an iPhone does it for a phone call or Siri, and it stays paused while
 * the button still looks on. LiveKit stops sending it after a few seconds of that; this says so.
 */
export function useMicPaused(track: LocalAudioTrack | undefined): boolean {
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (!track) {
      setPaused(false);
      return;
    }
    setPaused(track.isUpstreamPaused);
    const on = () => setPaused(true);
    const off = () => setPaused(false);
    track.on(TrackEvent.UpstreamPaused, on);
    track.on(TrackEvent.UpstreamResumed, off);
    return () => {
      track.off(TrackEvent.UpstreamPaused, on);
      track.off(TrackEvent.UpstreamResumed, off);
    };
  }, [track]);
  return paused;
}

/** A microphone that needs starting again before it can be turned on: paused, ended, or held quiet by the device. */
export const micNeedsRestart = (track: LocalAudioTrack | undefined): boolean =>
  !!track &&
  (track.isUpstreamPaused ||
    track.mediaStreamTrack.readyState !== 'live' ||
    track.mediaStreamTrack.muted);

/** How often the microphone's copy is listened to. */
const WATCH_EVERY_MS = 100;

/**
 * Listens to a copy of their microphone on this computer: says when they talk while muted (`onTalkingMuted`), and
 * whether it sends pure silence while on (`onSilent`), which no working microphone does however quiet the room.
 * The copy is never sent anywhere, and stops with the call.
 */
export function useMicWatch({
  track,
  muted,
  on,
  onTalkingMuted,
  onSilent,
}: {
  track: LocalAudioTrack | undefined;
  muted: boolean;
  /** Off where it isn't run (an iPhone or iPad), or before the call is connected. */
  on: boolean;
  onTalkingMuted: () => void;
  onSilent: (silent: boolean) => void;
}) {
  const isMuted = useRef(muted);
  isMuted.current = muted;
  const talking = useRef(onTalkingMuted);
  talking.current = onTalkingMuted;
  const silent = useRef(onSilent);
  silent.current = onSilent;
  // A new microphone (picked, or started again) gets listened to afresh.
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!track) return;
    const again = () => setVersion((v) => v + 1);
    track.on(TrackEvent.Restarted, again);
    return () => {
      track.off(TrackEvent.Restarted, again);
    };
  }, [track]);

  useEffect(() => {
    if (!on || !track) return;
    const source = track.mediaStreamTrack;
    if (!source || source.readyState !== 'live') return;
    const Ctx: typeof AudioContext | undefined =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    let copy: MediaStreamTrack;
    let ctx: AudioContext;
    try {
      // A muted microphone is a disabled one, which sounds like nothing: its copy is enabled on its own.
      copy = source.clone();
      copy.enabled = true;
      ctx = new Ctx();
    } catch {
      return;
    }
    const input = ctx.createMediaStreamSource(new MediaStream([copy]));
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    input.connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    const gate = mutedTalkGate();
    const judge = silentMicJudge();
    // A page that hasn't been pressed may hold its sound back; the call's Join press usually counts.
    const resume = () => {
      if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
    };
    resume();
    window.addEventListener('pointerdown', resume);
    const timer = window.setInterval(() => {
      // A context that isn't running hears only silence, which would be no reason to say anything.
      if (ctx.state !== 'running') return;
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      let sound = false;
      for (const x of samples) {
        sum += x * x;
        if (x !== 0) sound = true;
      }
      const now = Date.now();
      if (isMuted.current) {
        judge.reset();
        if (gate.hear(Math.sqrt(sum / samples.length), now)) talking.current();
      } else {
        gate.reset();
        const said = judge.hear(!sound, now);
        if (said) silent.current(said === 'silent');
      }
    }, WATCH_EVERY_MS);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('pointerdown', resume);
      input.disconnect();
      copy.stop();
      void ctx.close().catch(() => undefined);
      silent.current(false);
    };
  }, [on, track, version]);
}

/**
 * The arrow beside the microphone button: which microphone (with a bar that moves as it hears them) and, on a
 * computer whose browser lets a page pick, which speaker. What they pick is remembered for next time.
 */
export function MicMenu({
  room,
  track,
  open,
  onOpenChange,
  onPicked,
  onError,
}: {
  room: Room;
  track: LocalAudioTrack | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** A microphone was picked: the screen turns it on if it had trouble. */
  onPicked: () => void;
  onError: (e: unknown) => void;
}) {
  const mics = useMediaDeviceSelect({ kind: 'audioinput', room, requestPermissions: false });
  const speakers = useMediaDeviceSelect({ kind: 'audiooutput', room, requestPermissions: false });
  const [canPickSpeaker, setCanPickSpeaker] = useState(false);
  useEffect(() => {
    setCanPickSpeaker(supportsAudioOutputSelection());
  }, []);
  const level = useTrackVolume(track);
  const micList = mics.devices.filter((d) => d.deviceId);
  const speakerList = speakers.devices.filter((d) => d.deviceId);

  const pickMic = (id: string) => {
    void mics
      .setActiveMediaDevice(id)
      .then(() => {
        rememberDevice('audioDeviceId', id);
        onPicked();
      })
      .catch(onError);
  };
  const pickSpeaker = (id: string) => {
    void speakers
      .setActiveMediaDevice(id)
      .then(() => rememberDevice('audioOutputId', id))
      .catch(() => toast.error('That speaker didn’t start. Pick another one.'));
  };

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={MIC_WORDS.pick}
          title={MIC_WORDS.pick}
          className="inline-flex h-11 w-7 flex-none items-center justify-center rounded-l-full text-white hover:bg-[#3a4049] focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-white/60"
          data-testid="call-mic-menu"
        >
          <ChevronUp size={16} />
        </button>
      </DropdownMenuTrigger>
      {/* Menus open outside the call's dark frame, so it says dark itself. */}
      <DropdownMenuContent
        side="top"
        align="start"
        data-theme="dark"
        className="w-[300px] max-w-[calc(100vw-24px)]"
        data-testid="call-mic-menu-list"
      >
        <DropdownMenuLabel>{MIC_WORDS.microphone}</DropdownMenuLabel>
        {micList.length ? (
          micList.map((d, i) => (
            <DropdownMenuItem
              key={d.deviceId}
              onSelect={() => pickMic(d.deviceId)}
              data-testid="call-mic-option"
            >
              <Check
                size={14}
                aria-hidden
                className={cn(
                  'flex-none',
                  d.deviceId === mics.activeDeviceId ? 'opacity-100' : 'opacity-0',
                )}
              />
              <span className="truncate">{d.label || `Microphone ${i + 1}`}</span>
            </DropdownMenuItem>
          ))
        ) : (
          <p className="px-2 py-1.5 text-[12.5px] text-text-3">{MIC_WORDS.noMics}</p>
        )}
        {track ? (
          <div className="flex flex-col gap-1 px-2 pb-1.5 pt-1">
            <span
              aria-hidden
              className="block h-1.5 w-full overflow-hidden rounded-full bg-white/15"
              data-testid="call-mic-level"
            >
              <span
                className="block h-full rounded-full bg-[#3ccf7a] transition-[width] duration-100"
                style={{ width: `${Math.min(100, Math.round(level * 400))}%` }}
              />
            </span>
            <span className="text-[11.5px] text-text-3">{MIC_WORDS.levelHint}</span>
          </div>
        ) : null}
        {canPickSpeaker && speakerList.length ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>{MIC_WORDS.speaker}</DropdownMenuLabel>
            {speakerList.map((d, i) => (
              <DropdownMenuItem
                key={d.deviceId}
                onSelect={() => pickSpeaker(d.deviceId)}
                data-testid="call-speaker-option"
              >
                <Check
                  size={14}
                  aria-hidden
                  className={cn(
                    'flex-none',
                    d.deviceId === speakers.activeDeviceId ? 'opacity-100' : 'opacity-0',
                  )}
                />
                <span className="truncate">{d.label || `Speaker ${i + 1}`}</span>
              </DropdownMenuItem>
            ))}
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** One line over the controls about the microphone: paused, silent, or talking while muted. */
export function MicNote({
  text,
  action,
  testId,
}: {
  text: string;
  action?: { label: string; onClick: () => void } | null;
  testId: string;
}) {
  return (
    <div className="flex justify-center px-3 pb-1">
      <p
        className="inline-flex max-w-[560px] items-center gap-2 rounded-full bg-warning-soft px-3.5 py-1.5 text-[13px] text-warning-text"
        role="status"
        data-testid={testId}
      >
        {text}
        {action ? (
          <button
            type="button"
            onClick={action.onClick}
            className="flex-none font-medium underline underline-offset-2"
          >
            {action.label}
          </button>
        ) : null}
      </p>
    </div>
  );
}
