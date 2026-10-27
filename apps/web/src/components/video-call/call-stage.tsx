'use client';
/**
 * Everyone on camera in a HandsFreeOS video call (docs/video-calls.md): a grid that fits the window, or a shared
 * screen big with everyone's camera beside it. Someone with their camera off shows as their initials. The AI's
 * listener (part 2) is in the room but never on the stage.
 */
import { VIDEO_CALL_ATTRIBUTES, isPersonIdentity } from '@hfos/core';
import {
  isTrackReference,
  useIsMuted,
  useIsSpeaking,
  useParticipantAttribute,
  useTracks,
  VideoTrack,
  type TrackReferenceOrPlaceholder,
} from '@livekit/components-react';
import { Track } from 'livekit-client';
import { Hand, MicOff } from 'lucide-react';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { Avatar } from '@/components/ui/avatar';
import { cn } from '@/lib/utils';

/** Columns and rows for `n` cameras: side by side on a wide window, stacked on a tall one (a phone). */
export function gridOf(n: number, wide: boolean): { cols: number; rows: number } {
  const cols = n <= 1 ? 1 : wide ? (n <= 4 ? 2 : n <= 9 ? 3 : 4) : n <= 2 ? 1 : n <= 6 ? 2 : 3;
  return { cols, rows: Math.max(1, Math.ceil(n / cols)) };
}

const keyOf = (t: TrackReferenceOrPlaceholder) => `${t.participant.identity}:${t.source}`;

/** Whether the stage is wider than it is tall, kept up to date as the window changes. */
function useWide(el: RefObject<HTMLDivElement | null>): boolean {
  const [wide, setWide] = useState(true);
  useEffect(() => {
    const node = el.current;
    if (!node) return;
    const look = () => setWide(node.clientWidth >= node.clientHeight);
    look();
    const watch = new ResizeObserver(look);
    watch.observe(node);
    return () => watch.disconnect();
  }, [el]);
  return wide;
}

export function CallStage({ alone }: { alone: string }) {
  const tracks = useTracks(
    [
      { source: Track.Source.Camera, withPlaceholder: true },
      { source: Track.Source.ScreenShare, withPlaceholder: false },
    ],
    { onlySubscribed: false },
  ).filter((t) => isPersonIdentity(t.participant.identity));
  // Everyone else in the order they came, then you.
  const cameras = tracks
    .filter((t) => t.source === Track.Source.Camera)
    .sort((a, b) => Number(a.participant.isLocal) - Number(b.participant.isLocal));
  const screens = tracks.filter(
    (t) => t.source === Track.Source.ScreenShare && isTrackReference(t),
  );
  const box = useRef<HTMLDivElement>(null);
  const wide = useWide(box);
  const { cols, rows } = gridOf(cameras.length, wide);

  return (
    <div ref={box} className="relative h-full min-h-0 w-full" data-testid="call-stage">
      {screens.length ? (
        <div className="flex h-full w-full flex-col gap-2 p-2 md:flex-row">
          <div className="min-h-0 min-w-0 flex-1">
            <Tile trackRef={screens[0]!} />
          </div>
          <div className="flex h-[112px] flex-none gap-2 overflow-auto md:h-auto md:w-[220px] md:flex-col">
            {[...screens.slice(1), ...cameras].map((t) => (
              <div key={keyOf(t)} className="aspect-video w-[168px] flex-none md:w-full">
                <Tile trackRef={t} />
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div
          className="grid h-full w-full gap-2 p-2"
          style={{
            gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
            gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
          }}
        >
          {cameras.map((t) => (
            <Tile key={keyOf(t)} trackRef={t} />
          ))}
        </div>
      )}
      {cameras.length <= 1 && !screens.length ? (
        <p
          className="pointer-events-none absolute inset-x-0 top-4 mx-auto w-fit rounded-full bg-black/55 px-3 py-1.5 text-[13px] text-white"
          data-testid="call-alone"
        >
          {alone}
        </p>
      ) : null}
    </div>
  );
}

function Tile({ trackRef }: { trackRef: TrackReferenceOrPlaceholder }) {
  const p = trackRef.participant;
  const name = p.name || 'Guest';
  const screen = trackRef.source === Track.Source.ScreenShare;
  const speaking = useIsSpeaking(p);
  const micOff = useIsMuted({ participant: p, source: Track.Source.Microphone });
  const videoOff = useIsMuted(trackRef);
  const hand = useParticipantAttribute(VIDEO_CALL_ATTRIBUTES.hand, { participant: p }) === 'up';
  const label = screen ? `${name}’s screen` : p.isLocal ? `${name} (you)` : name;
  return (
    <div
      className={cn(
        'relative h-full min-h-0 w-full overflow-hidden rounded-card bg-[#20252e] transition-shadow',
        speaking && !screen && 'shadow-[0_0_0_3px_#3ccf7a]',
      )}
      data-testid={screen ? 'call-screen' : 'call-tile'}
      data-name={name}
      data-video={isTrackReference(trackRef) && !videoOff ? 'on' : 'off'}
    >
      {isTrackReference(trackRef) && !videoOff ? (
        <VideoTrack
          trackRef={trackRef}
          className={cn(
            'h-full w-full',
            screen ? 'object-contain' : 'object-cover',
            p.isLocal && !screen && '-scale-x-100',
          )}
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center">
          <Avatar name={name} seed={p.identity} size="lg" />
        </div>
      )}
      <span className="absolute bottom-2 left-2 flex max-w-[calc(100%-16px)] items-center gap-1 rounded-full bg-black/55 px-2 py-0.5 text-[12px] text-white">
        {micOff && !screen ? (
          <MicOff size={12} aria-label="Microphone off" className="flex-none" />
        ) : null}
        <span className="truncate">{label}</span>
      </span>
      {hand && !screen ? (
        <span
          className="absolute right-2 top-2 inline-flex h-8 w-8 items-center justify-center rounded-full bg-[#f0a93b] text-[#191d25]"
          aria-label={`${name} has their hand up`}
          data-testid="call-hand"
        >
          <Hand size={16} />
        </span>
      ) : null}
    </div>
  );
}
