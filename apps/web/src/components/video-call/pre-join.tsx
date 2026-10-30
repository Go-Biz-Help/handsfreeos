'use client';
/**
 * The camera and microphone check before a HandsFreeOS video call (docs/video-calls.md): what they look like, that
 * their microphone hears them, their name, and Join. The same for the team, a customer on their own link and anyone
 * asking to be let in. What they pick is remembered on this device for next time.
 *
 * - **Facebook's and Instagram's own browsers** can block the camera, so the page says to open the link in Safari or
 *   Chrome instead (the plan's "Things that can go wrong"), with the link to copy.
 * - **A blocked camera or microphone** says where to allow it; they can still join without it.
 */
import { VIDEO_CALL_WORDS, WEBINAR_WORDS, isInAppBrowser } from '@hfos/core';
import { useMediaDevices, useTrackVolume } from '@livekit/components-react';
import {
  createLocalAudioTrack,
  createLocalVideoTrack,
  VideoPresets,
  type LocalAudioTrack,
  type LocalVideoTrack,
} from 'livekit-client';
import { Copy, FileText, Mic, MicOff, Sparkles, Video, VideoOff } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { canBlur, setBlur } from './blur';
import type { DeviceChoices } from './types';

const REMEMBERED = 'hfos.call.devices';

function remembered(): DeviceChoices {
  try {
    const kept = JSON.parse(localStorage.getItem(REMEMBERED) ?? 'null') as Partial<DeviceChoices>;
    if (kept && typeof kept === 'object')
      return {
        mic: kept.mic !== false,
        camera: kept.camera !== false,
        blur: kept.blur === true,
        ...(typeof kept.audioDeviceId === 'string' ? { audioDeviceId: kept.audioDeviceId } : {}),
        ...(typeof kept.videoDeviceId === 'string' ? { videoDeviceId: kept.videoDeviceId } : {}),
      };
  } catch {
    // Storage is off (a private window): start with everything on.
  }
  return { mic: true, camera: true, blur: false };
}

function remember(c: DeviceChoices) {
  try {
    localStorage.setItem(REMEMBERED, JSON.stringify(c));
  } catch {
    // Nothing kept; they pick again next time.
  }
}

/** What went wrong getting a camera or microphone, in words: blocked, or not there. */
export function mediaProblem(e: unknown, what: 'camera' | 'microphone'): string {
  const name = e instanceof Error ? e.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return VIDEO_CALL_WORDS.noCamera;
  if (name === 'NotFoundError' || name === 'OverconstrainedError')
    return `We couldn’t find a ${what}. Plug one in, or join without it.`;
  if (name === 'NotReadableError')
    return `Another app is using your ${what}. Close it, then try again, or join without it.`;
  return `Your ${what} didn’t start. Try again, or join without it.`;
}

/** A preview of one camera or microphone, while it's on; stopped when it's turned off or the page moves on. */
function usePreview<K extends 'audio' | 'video'>(
  kind: K,
  on: boolean,
  deviceId: string | undefined,
  onError: (e: unknown) => void,
): (K extends 'video' ? LocalVideoTrack : LocalAudioTrack) | null {
  type T = K extends 'video' ? LocalVideoTrack : LocalAudioTrack;
  const [track, setTrack] = useState<T | null>(null);
  const failed = useRef(onError);
  failed.current = onError;
  useEffect(() => {
    if (!on) return;
    let gone = false;
    let made: T | null = null;
    const make =
      kind === 'video'
        ? createLocalVideoTrack({
            ...(deviceId ? { deviceId } : {}),
            resolution: VideoPresets.h720.resolution,
          })
        : createLocalAudioTrack({ ...(deviceId ? { deviceId } : {}) });
    make
      .then((t) => {
        if (gone) t.stop();
        else {
          made = t as T;
          setTrack(t as T);
        }
      })
      .catch((e: unknown) => {
        if (!gone) failed.current(e);
      });
    return () => {
      gone = true;
      made?.stop();
      setTrack(null);
    };
  }, [kind, on, deviceId]);
  return on ? track : null;
}

export function PreJoin({
  heading,
  name: initialName,
  nameFixed,
  joinLabel,
  notice,
  busy,
  error,
  onJoin,
}: {
  /** Above the preview: the business, or the appointment and its time. */
  heading: ReactNode;
  /** The name everyone else in the call sees: filled in for them, and theirs to change unless it's their account's. */
  name: string;
  nameFixed?: boolean;
  /** Join, or Ask to join for someone who has to be let in. */
  joinLabel: string;
  /** That the AI takes notes from the call, said before they join: joining is agreeing (the owner's 9a). */
  notice?: string | null;
  busy: boolean;
  error: string | null;
  onJoin: (name: string, choices: DeviceChoices) => void;
}) {
  const [choices, setChoices] = useState<DeviceChoices>({ mic: true, camera: true, blur: false });
  const [name, setName] = useState(initialName);
  const [problem, setProblem] = useState<{ camera?: string; mic?: string }>({});
  const [blurs, setBlurs] = useState(false);
  const [inApp, setInApp] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setChoices(remembered());
    setInApp(isInAppBrowser(navigator.userAgent));
    void canBlur().then(setBlurs);
  }, []);

  const pick = (next: Partial<DeviceChoices>) =>
    setChoices((c) => {
      const out = { ...c, ...next };
      remember(out);
      return out;
    });

  const video = usePreview('video', choices.camera, choices.videoDeviceId, (e) => {
    setProblem((p) => ({ ...p, camera: mediaProblem(e, 'camera') }));
    setChoices((c) => ({ ...c, camera: false }));
  });
  const audio = usePreview('audio', choices.mic, choices.audioDeviceId, (e) => {
    setProblem((p) => ({ ...p, mic: mediaProblem(e, 'microphone') }));
    setChoices((c) => ({ ...c, mic: false }));
  });
  const level = useTrackVolume(audio ?? undefined);
  const cameras = useMediaDevices({ kind: 'videoinput' }).filter((d) => d.deviceId && d.label);
  const mics = useMediaDevices({ kind: 'audioinput' }).filter((d) => d.deviceId && d.label);

  const el = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const v = el.current;
    if (!video || !v) return;
    video.attach(v);
    return () => {
      video.detach(v);
    };
  }, [video]);
  useEffect(() => {
    if (video && blurs) void setBlur(video, choices.blur).catch(() => undefined);
  }, [video, blurs, choices.blur]);

  const join = () => {
    const typed = name.trim();
    if (!typed || busy) return;
    onJoin(typed, choices);
  };

  return (
    <div className="mx-auto flex w-full max-w-[560px] flex-1 flex-col justify-center gap-4 px-4 py-6">
      {heading}
      <div className="relative aspect-video w-full overflow-hidden rounded-card bg-[#191d25]">
        {video ? (
          <video
            ref={el}
            muted
            playsInline
            className="h-full w-full -scale-x-100 object-cover"
            data-testid="call-preview"
          />
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-[13px] text-[#a0a5ae]">
            <Avatar name={name || '?'} size="lg" />
            {choices.camera ? 'Starting your camera…' : 'Your camera is off'}
          </div>
        )}
        <div className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-2 p-3">
          <RoundToggle
            on={choices.mic}
            label={choices.mic ? 'Turn off microphone' : 'Turn on microphone'}
            onClick={() => {
              setProblem((p) => ({ ...p, mic: undefined }));
              pick({ mic: !choices.mic });
            }}
            testId="prejoin-mic"
          >
            {choices.mic ? <Mic size={18} /> : <MicOff size={18} />}
          </RoundToggle>
          <RoundToggle
            on={choices.camera}
            label={choices.camera ? 'Turn off camera' : 'Turn on camera'}
            onClick={() => {
              setProblem((p) => ({ ...p, camera: undefined }));
              pick({ camera: !choices.camera });
            }}
            testId="prejoin-camera"
          >
            {choices.camera ? <Video size={18} /> : <VideoOff size={18} />}
          </RoundToggle>
          {blurs ? (
            <RoundToggle
              on={choices.blur}
              soft
              label={choices.blur ? 'Stop blurring my background' : 'Blur my background'}
              onClick={() => pick({ blur: !choices.blur })}
              testId="prejoin-blur"
            >
              <Sparkles size={18} />
            </RoundToggle>
          ) : null}
        </div>
        {audio ? (
          <span
            aria-hidden
            className="absolute left-3 top-3 h-1.5 w-16 overflow-hidden rounded-full bg-white/25"
          >
            <span
              className="block h-full rounded-full bg-[#3ccf7a] transition-[width] duration-100"
              style={{ width: `${Math.min(100, Math.round(level * 400))}%` }}
            />
          </span>
        ) : null}
      </div>

      {cameras.length > 1 || mics.length > 1 ? (
        <div className="grid gap-2 sm:grid-cols-2">
          {mics.length > 1 ? (
            <DeviceSelect
              label="Microphone"
              devices={mics}
              value={choices.audioDeviceId}
              onChange={(audioDeviceId) => pick({ audioDeviceId })}
            />
          ) : null}
          {cameras.length > 1 ? (
            <DeviceSelect
              label="Camera"
              devices={cameras}
              value={choices.videoDeviceId}
              onChange={(videoDeviceId) => pick({ videoDeviceId })}
            />
          ) : null}
        </div>
      ) : null}

      {problem.camera || problem.mic ? (
        <p
          className="rounded-control bg-warning-soft px-3 py-2 text-[13px] text-warning-text"
          data-testid="prejoin-media-problem"
        >
          {problem.camera ?? problem.mic}
        </p>
      ) : null}
      {inApp ? (
        <div
          className="flex flex-col gap-2 rounded-control bg-warning-soft px-3 py-2.5 text-[13px] text-warning-text"
          data-testid="prejoin-in-app"
        >
          {VIDEO_CALL_WORDS.inAppBrowser}
          <Button
            variant="secondary"
            size="sm"
            className="w-fit"
            onClick={() =>
              void navigator.clipboard
                ?.writeText(window.location.href)
                .then(() => setCopied(true))
                .catch(() => undefined)
            }
          >
            <Copy size={14} />
            {copied ? 'Copied' : 'Copy the link'}
          </Button>
        </div>
      ) : null}

      {notice ? (
        <p
          className="flex items-start gap-2 rounded-control bg-card-2 px-3 py-2.5 text-[13px] text-text-2"
          data-testid="prejoin-ai-notice"
        >
          <FileText size={15} className="mt-0.5 flex-none text-text-3" aria-hidden />
          {notice}
        </p>
      ) : null}

      <form
        className="flex flex-col gap-2 sm:flex-row sm:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          join();
        }}
      >
        {nameFixed ? (
          <p className="flex-1 text-[13px] text-text-2">
            Joining as <span className="font-medium text-text">{name}</span>
          </p>
        ) : (
          <label className="flex flex-1 flex-col gap-1 text-[13px] font-medium">
            Your name
            <Input
              value={name}
              maxLength={120}
              autoComplete="name"
              onChange={(e) => setName(e.target.value)}
              data-testid="prejoin-name"
            />
          </label>
        )}
        <Button
          type="submit"
          size="lg"
          loading={busy}
          disabled={!name.trim()}
          className="sm:min-w-[140px]"
          data-testid="prejoin-join"
        >
          {joinLabel}
        </Button>
      </form>
      {error ? (
        <p className="text-[13px] text-danger-text" role="alert" data-testid="prejoin-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Before a webinar, for an attendee: they join watching, muted with their camera off, so there's no camera or
 * microphone to check. Their name, the AI's notice, and Join.
 */
export function WebinarJoin({
  heading,
  name: initialName,
  notice,
  busy,
  error,
  onJoin,
}: {
  heading: ReactNode;
  name: string;
  notice?: string | null;
  busy: boolean;
  error: string | null;
  onJoin: (name: string, choices: DeviceChoices) => void;
}) {
  const [name, setName] = useState(initialName);
  return (
    <div className="mx-auto flex w-full max-w-[460px] flex-1 flex-col justify-center gap-4 px-4 py-6">
      {heading}
      <p className="text-center text-[13.5px] text-text-2" data-testid="prejoin-webinar">
        {WEBINAR_WORDS.joinHint}
      </p>
      {notice ? (
        <p
          className="flex items-start gap-2 rounded-control bg-card-2 px-3 py-2.5 text-[13px] text-text-2"
          data-testid="prejoin-ai-notice"
        >
          <FileText size={15} className="mt-0.5 flex-none text-text-3" aria-hidden />
          {notice}
        </p>
      ) : null}
      <form
        className="flex flex-col gap-2 sm:flex-row sm:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          const typed = name.trim();
          if (typed && !busy) onJoin(typed, { mic: false, camera: false, blur: false });
        }}
      >
        <label className="flex flex-1 flex-col gap-1 text-[13px] font-medium">
          Your name
          <Input
            value={name}
            maxLength={120}
            autoComplete="given-name"
            onChange={(e) => setName(e.target.value)}
            data-testid="prejoin-name"
          />
        </label>
        <Button
          type="submit"
          size="lg"
          loading={busy}
          disabled={!name.trim()}
          className="sm:min-w-[140px]"
          data-testid="prejoin-join"
        >
          {VIDEO_CALL_WORDS.join}
        </Button>
      </form>
      {error ? (
        <p className="text-[13px] text-danger-text" role="alert" data-testid="prejoin-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function RoundToggle({
  on,
  soft,
  label,
  onClick,
  testId,
  children,
}: {
  on: boolean;
  /** An extra that's off by default (blur): not red when off. */
  soft?: boolean;
  label: string;
  onClick: () => void;
  testId?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={on}
      title={label}
      onClick={onClick}
      data-testid={testId}
      className={cn(
        'inline-flex h-11 w-11 items-center justify-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-white/60',
        on
          ? soft
            ? 'bg-accent text-white'
            : 'bg-white/20 text-white hover:bg-white/30'
          : soft
            ? 'bg-white/20 text-white hover:bg-white/30'
            : 'bg-[#c43335] text-white hover:brightness-95',
      )}
    >
      {children}
    </button>
  );
}

function DeviceSelect({
  label,
  devices,
  value,
  onChange,
}: {
  label: string;
  devices: readonly MediaDeviceInfo[];
  value: string | undefined;
  onChange: (deviceId: string) => void;
}) {
  return (
    <label className="flex flex-col gap-1 text-[12px] font-medium text-text-2">
      {label}
      <Select
        selectSize="sm"
        value={value ?? devices[0]?.deviceId}
        onChange={(e) => onChange(e.target.value)}
      >
        {devices.map((d) => (
          <option key={d.deviceId} value={d.deviceId}>
            {d.label}
          </option>
        ))}
      </Select>
    </label>
  );
}
