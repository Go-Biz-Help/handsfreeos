'use client';
/**
 * Everyone on camera in a HandsFreeOS video call (docs/video-calls.md): a grid that fits the window, or a shared
 * screen big with everyone's camera beside it. Someone with their camera off shows as their initials. The AI's
 * listener (part 2) is in the room but never on the stage.
 *
 * A webinar (HANDSFREEOS_WEBINARS_IMPLEMENTATION_PLAN.md) is laid out around the presenter: a shared screen big when
 * there is one, else whoever on stage spoke last (the first of the team to start with). The rest of the team and
 * anyone on stage sit beside it. Attendees' cameras, when this page may see them, are a strip underneath, 12 at most.
 *
 * The poll's slides (part 4), while the team shows them, take the big place in either: everyone's cameras, and any
 * shared screen, sit beside them.
 */
import {
  SLIDE_WORDS,
  VIDEO_CALL_ATTRIBUTES,
  WEBINAR_WORDS,
  isPersonIdentity,
  roomRightsOf,
  type AttendeeVideo,
} from '@hfos/core';
import {
  isTrackReference,
  useIsMuted,
  useIsSpeaking,
  useParticipantAttribute,
  useSpeakingParticipants,
  useTracks,
  VideoTrack,
  type TrackReferenceOrPlaceholder,
} from '@livekit/components-react';
import { Track, type Participant } from 'livekit-client';
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

/** A webinar's stage, as this page shows it. */
export interface WebinarView {
  /** Attendees' cameras: whether they may be on, and who sees them. */
  readonly attendeeVideo: AttendeeVideo;
  /** This page is the team's, which sees attendees' cameras whenever they're allowed. */
  readonly team: boolean;
}

/** At most this many attendees' cameras show at once, in the strip under the presenter. */
const AUDIENCE_SHOWN = 12;

/** The slide showing on the stage (part 4): which, of how many, and its picture. */
export interface StageSlide {
  readonly n: number;
  readonly of: number;
  readonly picture: string;
}

export function CallStage({
  alone,
  webinar,
  slide = null,
}: {
  alone: string;
  webinar?: WebinarView | null;
  slide?: StageSlide | null;
}) {
  return webinar ? (
    <WebinarStage view={webinar} slide={slide} />
  ) : (
    <MeetingStage alone={alone} slide={slide} />
  );
}

/** The slide, as big as the stage lets it be, never cropped. */
function SlideTile({ slide }: { slide: StageSlide }) {
  const [loaded, setLoaded] = useState<string | null>(null);
  return (
    <div
      className="relative h-full min-h-0 w-full overflow-hidden rounded-card bg-[#20252e]"
      data-testid="call-slide"
      data-slide={slide.n}
    >
      {/* A signed link that works for a few hours: nothing for an image optimizer to keep. */}
      <img
        src={slide.picture}
        alt={SLIDE_WORDS.of(slide.n, slide.of)}
        className="h-full w-full object-contain"
        onLoad={() => setLoaded(slide.picture)}
      />
      {loaded !== slide.picture ? (
        <span className="absolute inset-0 flex items-center justify-center text-[13px] text-text-2">
          {SLIDE_WORDS.loading}
        </span>
      ) : null}
      <span className="absolute bottom-2 right-2 rounded-full bg-black/55 px-2 py-0.5 text-[12px] text-white">
        {SLIDE_WORDS.of(slide.n, slide.of)}
      </span>
    </div>
  );
}

function MeetingStage({ alone, slide }: { alone: string; slide: StageSlide | null }) {
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
      {screens.length || slide ? (
        <div className="flex h-full w-full flex-col gap-2 p-2 md:flex-row">
          <div className="min-h-0 min-w-0 flex-1">
            {slide ? <SlideTile slide={slide} /> : <Tile trackRef={screens[0]!} />}
          </div>
          <div className="flex h-[112px] flex-none gap-2 overflow-auto md:h-auto md:w-[220px] md:flex-col">
            {[...(slide ? screens : screens.slice(1)), ...cameras].map((t) => (
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
      {cameras.length <= 1 && !screens.length && !slide ? (
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

/** On stage: the team, and anyone they brought up. */
const presents = (p: Participant) => {
  const r = roomRightsOf(p.attributes);
  return r.kind === 'team' || r.onStage;
};

/** Whoever on stage spoke last, kept while they're quiet; null until someone on stage has spoken. */
function useLastSpeaker(stage: readonly string[]): string | null {
  const speaking = useSpeakingParticipants();
  const loud = speaking.find((p) => stage.includes(p.identity))?.identity ?? null;
  const [last, setLast] = useState<string | null>(null);
  useEffect(() => {
    if (loud) setLast(loud);
  }, [loud]);
  return last && stage.includes(last) ? last : null;
}

function WebinarStage({ view, slide }: { view: WebinarView; slide: StageSlide | null }) {
  const tracks = useTracks(
    [
      { source: Track.Source.Camera, withPlaceholder: true },
      { source: Track.Source.ScreenShare, withPlaceholder: false },
    ],
    { onlySubscribed: false },
  ).filter((t) => isPersonIdentity(t.participant.identity));
  const screens = tracks.filter(
    (t) => t.source === Track.Source.ScreenShare && isTrackReference(t),
  );
  const stage = tracks.filter((t) => t.source === Track.Source.Camera && presents(t.participant));
  const speaker = useLastSpeaker(stage.map((t) => t.participant.identity));
  // The slides take the big place while they're up; everyone on stage, and any shared screen, sits beside them.
  const big = slide
    ? null
    : (screens[0] ??
      stage.find((t) => t.participant.identity === speaker) ??
      stage.find((t) => roomRightsOf(t.participant.attributes).kind === 'team') ??
      stage[0] ??
      null);
  const beside = [...(slide ? screens : screens.slice(1)), ...stage].filter((t) => t !== big);
  const seen = view.team ? view.attendeeVideo !== 'off' : view.attendeeVideo === 'everyone';
  // Only cameras that are on; their own shows to them whoever else may see it.
  const audience = tracks
    .filter(
      (t) =>
        t.source === Track.Source.Camera &&
        !presents(t.participant) &&
        (seen || t.participant.isLocal) &&
        isTrackReference(t) &&
        !t.publication.isMuted,
    )
    .sort((a, b) => Number(b.participant.isLocal) - Number(a.participant.isLocal))
    .slice(0, AUDIENCE_SHOWN);

  return (
    <div className="flex h-full min-h-0 w-full flex-col gap-2 p-2" data-testid="call-stage">
      <div className="flex min-h-0 flex-1 flex-col gap-2 md:flex-row">
        <div className="min-h-0 min-w-0 flex-1" data-testid="call-presenter">
          {slide ? (
            <SlideTile slide={slide} />
          ) : big ? (
            <Tile trackRef={big} />
          ) : (
            <div className="flex h-full items-center justify-center rounded-card bg-[#20252e] px-6 text-center text-[13.5px] text-text-2">
              {WEBINAR_WORDS.waitingFor}
            </div>
          )}
        </div>
        {beside.length ? (
          <div className="flex h-[112px] flex-none gap-2 overflow-auto md:h-auto md:w-[220px] md:flex-col">
            {beside.map((t) => (
              <div key={keyOf(t)} className="aspect-video w-[168px] flex-none md:w-full">
                <Tile trackRef={t} />
              </div>
            ))}
          </div>
        ) : null}
      </div>
      {audience.length ? (
        <div
          className="flex h-[88px] flex-none gap-2 overflow-x-auto md:h-[104px]"
          aria-label={WEBINAR_WORDS.audience}
          data-testid="call-audience"
        >
          {audience.map((t) => (
            <div key={keyOf(t)} className="aspect-video h-full flex-none">
              <Tile trackRef={t} />
            </div>
          ))}
        </div>
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
