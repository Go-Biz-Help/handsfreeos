'use client';

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';

/**
 * Line 2 of the home page's headline, after "The AI Business OS", in the owner's order (2026-11-18). Each one is a reason it
 * works for you, said in the fewest words. The first is the one in the HTML, so it is what search engines and
 * screen readers get: keep the one that sums it up best first.
 */
export const headlinePhrases = [
  'that never misses a lead',
  'that follows up for you',
  'that gets you paid',
  'that gives you time back',
  'that replaces your other software',
  'that pays for itself',
] as const;

/** In milliseconds. The owner's approved preview: a 0.8s reveal, about 2s to read it, a quicker 0.6s erase. */
const timing = {
  /** The first phrase is already there when the page opens, so it gets a little longer before it goes. */
  firstHold: 2800,
  reveal: 800,
  hold: 2000,
  erase: 600,
  /** Empty for a moment between phrases, so the next one reads as new rather than as a correction. */
  gap: 220,
  /** Reduced motion: no sweep, just a quick fade from one phrase to the next. */
  fade: 240,
} as const;

/** Ease in and out (a cubic, the same curve as `cubic-bezier(0.65, 0, 0.35, 1)`): it sets off and arrives gently. */
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
/** The line is only there while it moves: it fades in as it sets off and out as it arrives. */
const lineOpacity = (t: number) => (t < 0.1 ? t / 0.1 : t > 0.84 ? (1 - t) / 0.16 : 1);
/**
 * A clip that shows the phrase up to `right` from its left edge. It reaches a little past the glyphs above, below
 * and to the left, so no descender or overhang is cut.
 */
const clipTo = (right: string) => `inset(-0.3em ${right} -0.3em -0.3em)`;
const hidden = clipTo('100%');

/**
 * How far the words reach. A phrase on two lines fills its box's width, but its longest line may stop well short of
 * the right edge, and the line should arrive where the words end rather than sweep on over nothing.
 */
function wordsWidth(words: HTMLElement) {
  const left = words.getBoundingClientRect().left;
  const range = document.createRange();
  range.selectNodeContents(words);
  let right = left;
  for (const rect of range.getClientRects()) right = Math.max(right, rect.right);
  return Math.ceil(right - left);
}
/** Where each sparkle leaves the line (down it), how far it drifts behind and up or down, and when it goes. */
const sparkles = [
  { y: '14%', dx: '14px', dy: '-9px', delay: '0ms' },
  { y: '32%', dx: '22px', dy: '6px', delay: '260ms' },
  { y: '50%', dx: '11px', dy: '-5px', delay: '120ms' },
  { y: '64%', dx: '26px', dy: '10px', delay: '420ms' },
  { y: '80%', dx: '17px', dy: '-7px', delay: '340ms' },
  { y: '92%', dx: '9px', dy: '8px', delay: '540ms' },
] as const;

type Phase = 'hold' | 'erase' | 'reveal';

/**
 * The rotating half of the home page's `<h1>`: a thin, shiny blue line sweeps left to right writing the phrase
 * as it passes, it holds, then the line sweeps back right to left rubbing it out, and the next one is written.
 *
 * The page renders the first phrase as plain text, so the HTML is one sentence: "… that never misses a lead". While
 * another phrase is up, screen readers still hear that sentence and the moving copy is hidden from them, so the
 * heading never reads differently twice and never holds the phrase twice for a search engine to see. The phrase sits
 * in a box two lines tall at every width, so the button below never moves. It waits while the hero is off screen or the tab is hidden, and with reduced motion it fades
 * from phrase to phrase with no line.
 */
export function RotatingHeadline() {
  const [{ index, phase }, setStep] = useState<{ index: number; phase: Phase }>({
    index: 0,
    phase: 'hold',
  });
  const [started, setStarted] = useState(false);
  const [watched, setWatched] = useState(false);
  const [rounds, setRounds] = useState(0);
  const box = useRef<HTMLSpanElement>(null);
  const text = useRef<HTMLSpanElement>(null);
  const sweep = useRef<HTMLSpanElement>(null);
  const line = useRef<HTMLSpanElement>(null);

  // Only while somebody can see it: the hero on screen and the tab in front.
  useEffect(() => {
    setStarted(true);
    const el = box.current;
    if (!el) return;
    let onScreen = true;
    const update = () => setWatched(onScreen && document.visibilityState === 'visible');
    const observer = new IntersectionObserver(([entry]) => {
      onScreen = entry?.isIntersecting ?? true;
      update();
    });
    observer.observe(el);
    document.addEventListener('visibilitychange', update);
    update();
    return () => {
      observer.disconnect();
      document.removeEventListener('visibilitychange', update);
    };
  }, []);

  // Holding: wait long enough to read it, then rub it out.
  useEffect(() => {
    if (!started || !watched || phase !== 'hold') return;
    const wait = index === 0 && rounds === 0 ? timing.firstHold : timing.hold;
    const timer = window.setTimeout(() => setStep({ index, phase: 'erase' }), wait);
    return () => window.clearTimeout(timer);
  }, [started, watched, phase, index, rounds]);

  // Erasing and revealing. A layout effect, so a new phrase is hidden before the frame that would show it.
  useLayoutEffect(() => {
    if (phase === 'hold') return;
    const words = text.current;
    const mover = sweep.current;
    const glow = line.current;
    if (!words || !mover || !glow) return;
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const erasing = phase === 'erase';
    let fade: Animation | undefined;
    let frame = 0;
    let gap = 0;
    let done = false;

    const finish = () => {
      if (done) return;
      delete mover.dataset.on;
      glow.style.opacity = '';
      if (erasing) {
        // Gone: keep it gone (the next phrase arrives hidden), wait a beat, then write the next one.
        if (still) words.style.opacity = '0';
        else words.style.clipPath = hidden;
        gap = window.setTimeout(() => {
          const next = (index + 1) % headlinePhrases.length;
          if (next === 0) setRounds((n) => n + 1);
          setStep({ index: next, phase: 'reveal' });
        }, timing.gap);
      } else {
        words.style.opacity = '';
        words.style.clipPath = '';
        setStep({ index, phase: 'hold' });
      }
      fade?.cancel();
    };

    if (still) {
      fade = words.animate([{ opacity: erasing ? 1 : 0 }, { opacity: erasing ? 0 : 1 }], {
        duration: timing.fade,
        easing: 'ease',
        fill: 'forwards',
      });
      void fade.finished.then(finish, () => {});
    } else {
      // The clip's edge and the line are moved together, in the same frame, by the same number: the line is always
      // the edge. (Left to the browser, the line's move runs off the main thread and gets a frame ahead of the clip.)
      const duration = erasing ? timing.erase : timing.reveal;
      const reach = wordsWidth(words);
      const width = words.getBoundingClientRect().width;
      const draw = (t: number) => {
        const shown = reach * (erasing ? 1 - ease(t) : ease(t));
        words.style.clipPath = clipTo(`${width - shown}px`);
        mover.style.transform = `translateX(${shown}px)`;
        glow.style.opacity = String(lineOpacity(t));
      };
      mover.style.setProperty('--dir', erasing ? '-1' : '1');
      mover.dataset.on = '';
      draw(0);
      const start = performance.now();
      const tick = (now: number) => {
        if (done) return;
        const t = Math.min(1, (now - start) / duration);
        draw(t);
        if (t < 1) frame = requestAnimationFrame(tick);
        else finish();
      };
      frame = requestAnimationFrame(tick);
    }

    return () => {
      done = true;
      cancelAnimationFrame(frame);
      window.clearTimeout(gap);
    };
  }, [phase, index]);

  const moved = index !== 0;

  return (
    <span ref={box} className="headline-rotor text-accent-text block">
      {/* While the first phrase is up, it is the heading's text. Once another is, this copy speaks for it. */}
      {moved && <span className="sr-only">{headlinePhrases[0]}</span>}
      <span className="headline-phrase" aria-hidden={moved || undefined}>
        <span ref={text} className="block">
          {headlinePhrases[index]}
        </span>
        <span ref={sweep} className="headline-sweep" aria-hidden="true">
          <span ref={line} className="headline-sweep-line">
            {sparkles.map((sparkle) => (
              <span
                key={sparkle.y}
                className="headline-sparkle"
                style={
                  {
                    '--y': sparkle.y,
                    '--dx': sparkle.dx,
                    '--dy': sparkle.dy,
                    '--delay': sparkle.delay,
                  } as CSSProperties
                }
              />
            ))}
          </span>
        </span>
      </span>
    </span>
  );
}
