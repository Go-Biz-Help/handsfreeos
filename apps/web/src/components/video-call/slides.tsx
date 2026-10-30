'use client';
/**
 * A live poll's slides in a HandsFreeOS video call (HANDSFREEOS_WEBINARS_IMPLEMENTATION_PLAN.md, part 4).
 *
 * - **Everyone sees the slide that's up**, as the worker tells the room on the slides topic. Only the server's word
 *   counts: the same topic from a person is ignored. The next slide's picture is fetched ahead.
 * - **The team turns them** (`video_call.slide`): the bar over the stage, the Live poll panel, and the arrow keys (and
 *   Page Up and Page Down, which presentation clickers send) while no box has the typing cursor. A slide whose
 *   picture this page already has shows at once, before the room is told; a refusal puts the last one back.
 */
import {
  SLIDE_WORDS,
  VIDEO_CALL_SLIDES_TOPIC,
  readSlideMessage,
  slideAfter,
  type SlideMessage,
} from '@hfos/core';
import { useDataChannel } from '@livekit/components-react';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import type { StageSlide } from './call-stage';
import { toast } from './toast';
import type { TeamSide } from './types';

export interface Slides {
  /** The slide on the stage, with its picture; null while the slides aren't up. */
  readonly stage: StageSlide | null;
  /** The slide showing, counted from 1, and how many there are (0 before the room said). */
  readonly slide: number | null;
  readonly of: number;
  /** For the team: shows a slide, or takes the slides down (null). */
  readonly go: (slide: number | null) => void;
}

const typing = (el: EventTarget | null) => {
  const t = el as HTMLElement | null;
  return !!t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName));
};

const KEY_STEPS: Readonly<Record<string, 'next' | 'previous' | 'first' | 'last'>> = {
  ArrowRight: 'next',
  PageDown: 'next',
  ArrowLeft: 'previous',
  PageUp: 'previous',
  Home: 'first',
  End: 'last',
};

export function useSlides(team: TeamSide | null): Slides {
  const [shown, setShown] = useState<SlideMessage | null>(null);
  // Every slide's picture this page was given, so turning back to one shows it at once.
  const pictures = useRef(new Map<number, string>());
  // The slide last asked for, until the room catches up: quick presses count from it.
  const [wanted, setWanted] = useState<number | null | undefined>(undefined);

  useDataChannel(VIDEO_CALL_SLIDES_TOPIC, (msg) => {
    if (msg.from) return;
    const m = readSlideMessage(msg.payload);
    if (!m) return;
    if (m.slide && m.picture) pictures.current.set(m.slide, m.picture);
    if (m.slide && m.next) pictures.current.set(m.slide + 1, m.next);
    setWanted((w) => (w === m.slide ? undefined : w));
    setShown((now) => (now && now.at > m.at ? now : m));
  });

  // The next slide's picture, fetched ahead.
  useEffect(() => {
    if (!shown?.next) return;
    const img = new Image();
    img.src = shown.next;
  }, [shown?.next]);

  const slide = wanted !== undefined ? wanted : (shown?.slide ?? null);
  const of = shown?.of ?? 0;

  const go = useCallback(
    (to: number | null) => {
      if (!team) return;
      const before = shown;
      setWanted(to);
      // Shown at once when this page has its picture; the room's word follows.
      setShown((now) => {
        if (!now) return now;
        if (to === null) return { ...now, slide: null, picture: null, next: null };
        const picture = pictures.current.get(to);
        return picture
          ? { ...now, slide: to, picture, next: pictures.current.get(to + 1) ?? null }
          : now;
      });
      void apiBrowser()
        .POST('/v1/commands/video_call.slide', {
          body: { workspaceId: team.workspaceId, callId: team.callId, slide: to },
        })
        .then(unwrap)
        .catch((e: unknown) => {
          setWanted(undefined);
          setShown(before);
          toast.error(errorMessage(e));
        });
    },
    [team, shown],
  );

  // The team's keys, while the slides are up.
  useEffect(() => {
    if (!team || slide === null || !of) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
      const step = KEY_STEPS[e.key];
      const to = step ? slideAfter(slide, of, step) : null;
      if (!to) return;
      e.preventDefault();
      go(to);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [team, slide, of, go]);

  const stage =
    shown?.slide && shown.picture ? { n: shown.slide, of: shown.of, picture: shown.picture } : null;
  return { stage, slide, of, go };
}

/** The team's buttons over the stage while the slides are up: back, which slide, on, and take them down. */
export function SlideBar({ slides }: { slides: Slides }) {
  if (slides.slide === null || !slides.of) return null;
  const back = slideAfter(slides.slide, slides.of, 'previous');
  const on = slideAfter(slides.slide, slides.of, 'next');
  const button =
    'inline-flex h-8 w-8 items-center justify-center rounded-full text-white hover:bg-white/15 disabled:opacity-40 disabled:hover:bg-transparent';
  return (
    <div
      className="absolute left-3 top-3 z-20 flex items-center gap-1 rounded-full bg-black/70 px-1.5 py-1"
      role="toolbar"
      aria-label={SLIDE_WORDS.slides}
      title={SLIDE_WORDS.keys}
      data-testid="call-slide-bar"
    >
      <button
        type="button"
        className={button}
        aria-label={SLIDE_WORDS.previous}
        disabled={!back}
        onClick={() => back && slides.go(back)}
        data-testid="call-slide-previous"
      >
        <ChevronLeft size={18} />
      </button>
      <span
        className="min-w-[96px] text-center text-[12.5px] text-white"
        data-testid="call-slide-count"
      >
        {SLIDE_WORDS.of(slides.slide, slides.of)}
      </span>
      <button
        type="button"
        className={button}
        aria-label={SLIDE_WORDS.next}
        disabled={!on}
        onClick={() => on && slides.go(on)}
        data-testid="call-slide-next"
      >
        <ChevronRight size={18} />
      </button>
      <button
        type="button"
        className={button}
        aria-label={SLIDE_WORDS.stop}
        onClick={() => slides.go(null)}
        data-testid="call-slide-stop"
      >
        <X size={16} />
      </button>
    </div>
  );
}
