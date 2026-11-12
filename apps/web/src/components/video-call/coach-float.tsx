'use client';
/**
 * The coach over a HandsFreeOS video call, for the team (docs/video-calls.md, "The coach in the call"): what add-ons
 * show beside the video (./call-coach.tsx) in a box that floats over it. It starts top middle, right under the
 * camera, so reading it looks like looking at the customer (the owner's picks, 12 Nov 2026). The person drags it
 * anywhere, drags its corner to make it wider or taller, makes its words bigger or smaller (A− and A+), hides it,
 * or pops it out into a window of its own that stays on top of every other one (Document Picture-in-Picture:
 * Chrome and Edge on a computer). Where it is and how big are kept on this computer. With nothing to show, nothing.
 */
import {
  CALL_COACH_TEXT_SIZES,
  CALL_COACH_TEXT_SIZE_START,
  VIDEO_CALL_WORDS,
  callCoachTextStep,
} from '@hfos/core';
import {
  AArrowDown,
  AArrowUp,
  ChevronDown,
  ChevronUp,
  GripHorizontal,
  PictureInPicture2,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';
import { toast } from './toast';

const W = VIDEO_CALL_WORDS.coach;

/** Where the box is and how it looks, kept on this computer. `left: null` is centred; `height: null` fits its cards. */
export interface CoachPlace {
  readonly left: number | null;
  readonly top: number;
  readonly width: number;
  readonly height: number | null;
  /** A place in CALL_COACH_TEXT_SIZES. */
  readonly size: number;
  readonly hidden: boolean;
}

const KEPT = 'hfos.call.coach';
/** Its gap from the edges of the video. */
const EDGE = 8;
const MIN_WIDTH = 260;
const MIN_HEIGHT = 120;
export const COACH_PLACE_START: CoachPlace = {
  left: null,
  top: EDGE,
  width: 520,
  height: null,
  size: CALL_COACH_TEXT_SIZE_START,
  hidden: false,
};

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** What was kept, as a place: anything missing or broken is the start's. */
export function readCoachPlace(text: string | null): CoachPlace {
  try {
    const k = JSON.parse(text ?? 'null') as Record<string, unknown> | null;
    if (!k || typeof k !== 'object') return COACH_PLACE_START;
    const S = COACH_PLACE_START;
    return {
      left: num(k.left),
      top: num(k.top) ?? S.top,
      width: Math.max(MIN_WIDTH, num(k.width) ?? S.width),
      height: num(k.height) === null ? null : Math.max(MIN_HEIGHT, num(k.height)!),
      size: callCoachTextStep(k.size),
      hidden: k.hidden === true,
    };
  } catch {
    return COACH_PLACE_START;
  }
}

/** The box inside the video's area (`w` by `h`): kept on it whatever the window's size now. */
export function fitCoach(p: CoachPlace, w: number, h: number) {
  const room = Math.max(0, w - 2 * EDGE);
  const width = Math.min(Math.max(p.width, MIN_WIDTH), room);
  const free = Math.max(0, w - EDGE - width);
  const left =
    p.left === null ? Math.round((w - width) / 2) : Math.min(Math.max(p.left, EDGE), free);
  const top = Math.min(Math.max(p.top, EDGE), Math.max(EDGE, h - 48));
  const below = Math.max(MIN_HEIGHT, h - top - EDGE);
  const height = p.height === null ? null : Math.min(Math.max(p.height, MIN_HEIGHT), below);
  // Fitting its cards, it grows as far as the bottom of the video before it scrolls: every word shows.
  const maxHeight = height ?? below;
  return { left, top, width, height, maxHeight };
}

interface DocumentPictureInPicture {
  requestWindow(options?: { width?: number; height?: number }): Promise<Window>;
}

/** Chrome and Edge on a computer can keep a window of the page's own on top of every other one. */
const pictureInPicture = (): DocumentPictureInPicture | undefined =>
  typeof window === 'undefined'
    ? undefined
    : (window as unknown as { documentPictureInPicture?: DocumentPictureInPicture })
        .documentPictureInPicture;

/** The page's look, in the window it pops out into. */
function copyLook(from: Document, to: Document) {
  for (const sheet of Array.from(from.styleSheets)) {
    try {
      const style = to.createElement('style');
      style.textContent = Array.from(sheet.cssRules, (r) => r.cssText).join('\n');
      to.head.appendChild(style);
    } catch {
      // A sheet from another site can't be read, only linked.
      if (!sheet.href) continue;
      const link = to.createElement('link');
      link.rel = 'stylesheet';
      link.href = sheet.href;
      to.head.appendChild(link);
    }
  }
  to.documentElement.className = from.documentElement.className;
  to.documentElement.setAttribute('data-theme', 'dark');
  to.body.className = cn(from.body.className, 'm-0 bg-[#0b0e13] text-text');
}

function ToolButton({
  label,
  onClick,
  disabled,
  children,
  testId,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
  testId: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      // Its presses neither move the box nor, pressed twice quickly, put it back.
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      className="inline-flex h-7 w-7 flex-none items-center justify-center rounded-control text-text-2 hover:bg-card-2 hover:text-text disabled:opacity-40 disabled:hover:bg-transparent"
      data-testid={testId}
    >
      {children}
    </button>
  );
}

/** A− and A+. */
function SizeButtons({ size, onSize }: { size: number; onSize: (step: number) => void }) {
  return (
    <>
      <ToolButton
        label={W.smaller}
        disabled={size <= 0}
        onClick={() => onSize(size - 1)}
        testId="call-coach-smaller"
      >
        <AArrowDown size={16} aria-hidden />
      </ToolButton>
      <ToolButton
        label={W.bigger}
        disabled={size >= CALL_COACH_TEXT_SIZES.length - 1}
        onClick={() => onSize(size + 1)}
        testId="call-coach-bigger"
      >
        <AArrowUp size={16} aria-hidden />
      </ToolButton>
    </>
  );
}

export function CoachFloat({ children }: { children: ReactNode }) {
  const area = useRef<HTMLDivElement>(null);
  const boxEl = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<CoachPlace>(COACH_PLACE_START);
  const [areaSize, setAreaSize] = useState<{ w: number; h: number } | null>(null);
  const [empty, setEmpty] = useState(true);
  const [popped, setPopped] = useState<Window | null>(null);
  const [canPop, setCanPop] = useState(false);
  const moving = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const sizing = useRef<{ x: number; y: number; width: number; height: number } | null>(null);

  // What this computer kept, once the page is in the browser.
  useEffect(() => {
    try {
      setPlace(readCoachPlace(localStorage.getItem(KEPT)));
    } catch {
      // Storage turned off: it starts under the camera each time.
    }
    setCanPop(!!pictureInPicture());
  }, []);
  const keep = useCallback((p: CoachPlace) => {
    setPlace(p);
    try {
      localStorage.setItem(KEPT, JSON.stringify(p));
    } catch {
      // Kept for this call only.
    }
  }, []);

  // The video's area, as the window or the panels beside it change it.
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    const measure = () => setAreaSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const seen = new ResizeObserver(measure);
    seen.observe(el);
    return () => seen.disconnect();
  }, []);

  // Nothing to show (no coached call, or no add-on here): no box either.
  useLayoutEffect(() => {
    const el = body.current;
    if (!el) return;
    const check = () => setEmpty(el.childElementCount === 0);
    check();
    const seen = new MutationObserver(check);
    seen.observe(el, { childList: true });
    return () => seen.disconnect();
  }, [popped]);

  // Leaving the call closes its window.
  useEffect(() => () => popped?.close(), [popped]);

  const fit = areaSize ? fitCoach(place, areaSize.w, areaSize.h) : null;

  const startMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!fit || e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    moving.current = { x: e.clientX, y: e.clientY, left: fit.left, top: fit.top };
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const m = moving.current;
    if (!m) return;
    setPlace((p) => ({ ...p, left: m.left + e.clientX - m.x, top: m.top + e.clientY - m.y }));
  };
  const endMove = () => {
    const m = moving.current;
    if (!m || !fit) return;
    moving.current = null;
    // A press that didn't move it leaves it centred, if it was.
    if (m.left === fit.left && m.top === fit.top) return;
    keep({ ...place, left: fit.left, top: fit.top });
  };
  const nudge = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (!fit) return;
    const step = e.shiftKey ? 64 : 16;
    const by: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const d = by[e.key];
    if (!d) return;
    e.preventDefault();
    const next = { ...place, left: fit.left + d[0], top: fit.top + d[1] };
    const again = fitCoach(next, areaSize!.w, areaSize!.h);
    keep({ ...next, left: again.left, top: again.top });
  };
  const putBack = () => keep({ ...COACH_PLACE_START, size: place.size, hidden: place.hidden });

  const startSize = (e: PointerEvent<HTMLDivElement>) => {
    if (!fit || e.button !== 0) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    const box = boxEl.current!.getBoundingClientRect();
    sizing.current = { x: e.clientX, y: e.clientY, width: box.width, height: box.height };
  };
  const size = (e: PointerEvent<HTMLDivElement>) => {
    const s = sizing.current;
    if (!s || !fit) return;
    setPlace((p) => ({
      ...p,
      // Its left edge stays where it is while its right one follows the pointer.
      left: fit.left,
      width: s.width + e.clientX - s.x,
      height: s.height + e.clientY - s.y,
    }));
  };
  const endSize = () => {
    if (!sizing.current || !fit) return;
    sizing.current = null;
    keep({ ...place, left: fit.left, width: fit.width, height: fit.height });
  };

  const setSize = (step: number) => keep({ ...place, size: callCoachTextStep(step) });
  const zoom = CALL_COACH_TEXT_SIZES[place.size];

  const popOut = async () => {
    const pip = pictureInPicture();
    if (!pip) return;
    try {
      const box = boxEl.current?.getBoundingClientRect();
      const win = await pip.requestWindow({
        width: Math.round(Math.max(box?.width ?? 0, 360)),
        height: Math.round(Math.max(box?.height ?? 0, 280)),
      });
      copyLook(document, win.document);
      win.document.title = W.label;
      win.addEventListener('pagehide', () => setPopped(null), { once: true });
      setPopped(win);
      toast(W.poppedOutTip, { duration: 8000 });
    } catch {
      toast.error(W.popOutFailed);
    }
  };

  return (
    <div ref={area} className="pointer-events-none absolute inset-0 z-20 overflow-hidden">
      {popped ? (
        <>
          {createPortal(
            <div className="flex h-dvh flex-col" data-testid="call-coach-window">
              <div className="flex flex-none items-center gap-1 border-b border-border px-2 py-1">
                <span className="flex-1 text-[12.5px] font-medium text-text-2">{W.label}</span>
                <SizeButtons size={place.size} onSize={setSize} />
                <button
                  type="button"
                  onClick={() => popped.close()}
                  className="ml-1 rounded-control px-2 py-1 text-[12.5px] font-medium text-accent-text hover:bg-card-2"
                >
                  {W.backIn}
                </button>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-2">
                <div className="peer empty:hidden" style={{ zoom }}>
                  {children}
                </div>
                <p className="hidden p-4 text-center text-[13px] text-text-2 peer-empty:block">
                  {W.waiting}
                </p>
              </div>
            </div>,
            popped.document.body,
          )}
          <div
            className="pointer-events-auto absolute left-1/2 top-2 flex -translate-x-1/2 items-center gap-2 rounded-full border border-border bg-card/95 py-1 pl-3 pr-1 text-[12.5px] text-text-2 shadow-3"
            data-testid="call-coach-popped"
          >
            <PictureInPicture2 size={14} aria-hidden />
            {W.poppedOut}
            <button
              type="button"
              onClick={() => popped.close()}
              className="rounded-full px-2.5 py-1 font-medium text-accent-text hover:bg-card-2"
            >
              {W.backIn}
            </button>
          </div>
        </>
      ) : (
        <div
          ref={boxEl}
          className={cn(
            'pointer-events-auto absolute flex flex-col overflow-hidden rounded-card border border-border bg-card/95 shadow-3 backdrop-blur-sm',
            (empty || !fit) && 'invisible',
          )}
          style={
            fit
              ? {
                  left: fit.left,
                  top: fit.top,
                  width: fit.width,
                  height: place.hidden ? undefined : (fit.height ?? undefined),
                  maxHeight: fit.maxHeight,
                }
              : undefined
          }
          data-testid="call-coach"
          data-size={place.size}
        >
          {/* The whole bar moves it, past its buttons; the grip also moves it from the keyboard. */}
          <div
            onPointerDown={startMove}
            onPointerMove={move}
            onPointerUp={endMove}
            onPointerCancel={endMove}
            onDoubleClick={putBack}
            className="flex flex-none cursor-grab touch-none select-none items-center gap-1 border-b border-border px-1.5 py-0.5 active:cursor-grabbing"
            data-testid="call-coach-bar"
          >
            <button
              type="button"
              aria-label={W.move}
              title={W.move}
              onKeyDown={nudge}
              className="flex min-w-0 flex-1 cursor-grab items-center gap-1.5 rounded-control px-0.5 py-1 text-left active:cursor-grabbing"
              data-testid="call-coach-move"
            >
              <GripHorizontal size={16} className="flex-none text-text-3" aria-hidden />
              <span className="text-[12px] text-text-3">{W.label}</span>
            </button>
            <SizeButtons size={place.size} onSize={setSize} />
            {canPop ? (
              <ToolButton label={W.popOut} onClick={() => void popOut()} testId="call-coach-pop">
                <PictureInPicture2 size={15} aria-hidden />
              </ToolButton>
            ) : null}
            <ToolButton
              label={place.hidden ? W.show : W.hide}
              onClick={() => keep({ ...place, hidden: !place.hidden })}
              testId="call-coach-hide"
            >
              {place.hidden ? (
                <ChevronDown size={16} aria-hidden />
              ) : (
                <ChevronUp size={16} aria-hidden />
              )}
            </ToolButton>
          </div>
          <div className={cn('min-h-0 flex-1 overflow-y-auto', place.hidden && 'hidden')}>
            <div ref={body} style={{ zoom }}>
              {children}
            </div>
          </div>
          {place.hidden ? null : (
            <div
              aria-label={W.resize}
              title={W.resize}
              onPointerDown={startSize}
              onPointerMove={size}
              onPointerUp={endSize}
              onPointerCancel={endSize}
              className="absolute bottom-0 right-0 h-4 w-4 cursor-nwse-resize touch-none"
              data-testid="call-coach-resize"
            >
              <svg viewBox="0 0 16 16" className="h-4 w-4 text-text-3" aria-hidden>
                <path d="M14 6 6 14M14 10l-4 4" stroke="currentColor" strokeWidth="1.5" />
              </svg>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
