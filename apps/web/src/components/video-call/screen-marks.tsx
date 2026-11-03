'use client';
/**
 * Marks on a shared screen (docs/video-calls.md, "Marks on a shared screen"): pointing and drawing over the shared
 * picture, for everyone in the call. The board and the rules are core's (`meetings/screen-marks.ts`); this file draws
 * them and sends this page's own.
 *
 * - `MarksProvider` listens on the marks topic once for the whole call and keeps the board. A mark counts only from a
 *   person who may mark (anyone in a meeting; in a webinar, someone the room lets share a screen) on a screen whose
 *   owner hasn't turned marks off.
 * - `ScreenMarks` sits over a shared screen's tile. It draws what's on that screen and, on the big tile, gives whoever
 *   may mark **Point** and **Draw**, or gives the person sharing a way to turn marks off for their screen.
 * - **Sending**: the pointer goes lossy and at most 20 times a second, the newest place winning; presses and lines go
 *   reliably, a line a stretch at a time. What this page sends shows on it at once.
 * - **The person sharing** is usually looking at what they share, not the call. While their call tab is hidden, its
 *   title says who is pointing, until they come back to it.
 */
import {
  MARK_FADE_OUT_MS,
  MARK_POINTS_PER_MESSAGE,
  MARK_SEND_EVERY_MS,
  MarksStore,
  SCREEN_MARK_WORDS,
  VIDEO_CALL_MARKS_ATTRIBUTE,
  VIDEO_CALL_MARKS_TOPIC,
  fitIn,
  markFrom,
  toFraction,
  writeMark,
  type MarkMessage,
  type Rect,
  type ScreenMarksView,
  type VideoCallFormat,
} from '@hfos/core';
import {
  useDataChannel,
  useParticipantAttribute,
  useRoomContext,
  type TrackReference,
} from '@livekit/components-react';
import { RoomEvent, Track, type Participant, type TrackPublication } from 'livekit-client';
import { Highlighter, MousePointer2, PenLine } from 'lucide-react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type PointerEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

interface Marks {
  readonly store: MarksStore;
  /** This page may mark others' screens. */
  readonly canMark: boolean;
  /** Shows one of this page's marks here, at once. */
  readonly show: (m: MarkMessage) => void;
  /** Sends one to everyone else. */
  readonly post: (m: MarkMessage) => void;
}

const MarksContext = createContext<Marks | null>(null);

/** While the person sharing is away from the call tab, its title says who is pointing at their screen. */
function useTitleNudge(): (name: string) => void {
  const kept = useRef<string | null>(null);
  useEffect(() => {
    const back = () => {
      if (document.hidden || kept.current === null) return;
      document.title = kept.current;
      kept.current = null;
    };
    document.addEventListener('visibilitychange', back);
    return () => {
      document.removeEventListener('visibilitychange', back);
      back();
    };
  }, []);
  return useCallback((name: string) => {
    if (typeof document === 'undefined' || !document.hidden) return;
    kept.current ??= document.title;
    document.title = SCREEN_MARK_WORDS.pointing(name);
  }, []);
}

export function MarksProvider({
  format,
  canMark,
  children,
}: {
  format: VideoCallFormat;
  canMark: boolean;
  children: ReactNode;
}) {
  const room = useRoomContext();
  const [store] = useState(() => new MarksStore());
  const nudge = useTitleNudge();

  const ownerOf = (identity: string): Participant | undefined =>
    identity === room.localParticipant.identity
      ? room.localParticipant
      : room.getParticipantByIdentity(identity);

  const { send: sendData } = useDataChannel(VIDEO_CALL_MARKS_TOPIC, (msg) => {
    // Who may mark comes from the room's own permissions on the sender, not what their page says about itself.
    const m = markFrom(msg.payload, msg.from, format, ownerOf);
    if (!m || !msg.from) return;
    const name = msg.from.name || 'Guest';
    store.apply({ identity: msg.from.identity, name }, m);
    if (m.on === room.localParticipant.identity && m.k !== 'gone') nudge(name);
  });

  // Someone leaving takes their pointer; a screen that stops takes its marks.
  useEffect(() => {
    const left = (p: Participant) => store.leave(p.identity);
    const unshared = (pub: TrackPublication, p: Participant) => {
      if (pub.source === Track.Source.ScreenShare) store.clear(p.identity);
    };
    room.on(RoomEvent.ParticipantDisconnected, left);
    room.on(RoomEvent.TrackUnpublished, unshared);
    room.on(RoomEvent.LocalTrackUnpublished, unshared);
    return () => {
      room.off(RoomEvent.ParticipantDisconnected, left);
      room.off(RoomEvent.TrackUnpublished, unshared);
      room.off(RoomEvent.LocalTrackUnpublished, unshared);
      store.stop();
    };
  }, [room, store]);

  const show = useCallback(
    (m: MarkMessage) => {
      const me = room.localParticipant;
      store.apply({ identity: me.identity, name: me.name || 'You' }, m);
    },
    [room, store],
  );
  const post = useCallback(
    (m: MarkMessage) =>
      void sendData(writeMark(m), { reliable: m.k !== 'point' }).catch(() => undefined),
    [sendData],
  );

  return (
    <MarksContext.Provider value={{ store, canMark, show, post }}>{children}</MarksContext.Provider>
  );
}

/** The marks over one shared screen; nothing outside a call that has them. */
export function ScreenMarks({ trackRef, tools }: { trackRef: TrackReference; tools: boolean }) {
  const marks = useContext(MarksContext);
  return marks ? <Overlay marks={marks} trackRef={trackRef} tools={tools} /> : null;
}

type Tool = 'point' | 'draw';

/** Where the shared picture sits in its tile, kept up to date as the tile or the picture changes size. */
function usePicture(box: RefObject<HTMLDivElement | null>, sid: string): Rect | null {
  const [pic, setPic] = useState<Rect | null>(null);
  useEffect(() => {
    const video = box.current?.parentElement?.querySelector('video');
    if (!video) return;
    const measure = () =>
      setPic(
        fitIn(
          { width: video.clientWidth, height: video.clientHeight },
          { width: video.videoWidth, height: video.videoHeight },
        ),
      );
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(video);
    video.addEventListener('loadedmetadata', measure);
    video.addEventListener('resize', measure);
    return () => {
      watch.disconnect();
      video.removeEventListener('loadedmetadata', measure);
      video.removeEventListener('resize', measure);
    };
  }, [box, sid]);
  return pic;
}

function Overlay({
  marks,
  trackRef,
  tools,
}: {
  marks: Marks;
  trackRef: TrackReference;
  tools: boolean;
}) {
  const owner = trackRef.participant;
  const on = owner.identity;
  const mine = owner.isLocal;
  const off = useParticipantAttribute(VIDEO_CALL_MARKS_ATTRIBUTE, { participant: owner }) === 'off';
  useSyncExternalStore(marks.store.subscribe, marks.store.getVersion, marks.store.getVersion);
  const view = marks.store.view(on);
  const box = useRef<HTMLDivElement>(null);
  const pic = usePicture(box, trackRef.publication.trackSid);
  const [tool, setTool] = useState<Tool | null>(null);
  const stop = useCallback(() => setTool(null), []);
  // Marks turned off: what's on the screen goes at once.
  useEffect(() => {
    if (off) marks.store.clear(on);
  }, [off, on, marks.store]);
  const canMark = marks.canMark && !mine && !off;
  const active = canMark ? tool : null;

  return (
    <div ref={box} className="pointer-events-none absolute inset-0" data-testid="call-marks">
      {pic ? (
        <Picture pic={pic} view={view} on={on} tool={active} marks={marks} onStop={stop} />
      ) : null}
      {tools && canMark ? <Tools tool={active} onTool={setTool} /> : null}
      {tools && mine ? <MineToggle off={off} owner={owner} /> : null}
      {tools && !mine && off ? (
        <span
          className="absolute right-2 top-2 rounded-full bg-black/55 px-2.5 py-1 text-[12px] text-white"
          title={SCREEN_MARK_WORDS.marksOffFor(owner.name || 'Guest')}
          data-testid="call-marks-off"
        >
          {SCREEN_MARK_WORDS.marksOff}
        </span>
      ) : null}
    </div>
  );
}

/** Sends a pointer at most every `MARK_SEND_EVERY_MS`, the newest place winning; the last one always goes. */
function usePointerSender(post: (m: MarkMessage) => void) {
  const last = useRef(0);
  const pending = useRef<MarkMessage | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return useCallback(
    (m: MarkMessage) => {
      pending.current = m;
      const wait = MARK_SEND_EVERY_MS - (Date.now() - last.current);
      if (wait <= 0) {
        last.current = Date.now();
        post(m);
        pending.current = null;
        return;
      }
      timer.current ??= setTimeout(() => {
        timer.current = null;
        const next = pending.current;
        pending.current = null;
        if (next) {
          last.current = Date.now();
          post(next);
        }
      }, wait);
    },
    [post],
  );
}

/** A line being drawn: its id, and the points not yet sent. */
interface Drawing {
  readonly id: string;
  pts: number[];
  timer: ReturnType<typeof setTimeout> | null;
}

function Picture({
  pic,
  view,
  on,
  tool,
  marks,
  onStop,
}: {
  pic: Rect;
  view: ScreenMarksView;
  on: string;
  tool: Tool | null;
  marks: Marks;
  onStop: () => void;
}) {
  const { show, post } = marks;
  const el = useRef<HTMLDivElement>(null);
  const pointer = usePointerSender(post);
  const send = useCallback(
    (m: MarkMessage) => {
      show(m);
      post(m);
    },
    [show, post],
  );
  const shown = useRef(false);
  const drawing = useRef<Drawing | null>(null);

  // Esc stops marking.
  useEffect(() => {
    if (!tool) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onStop();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [tool, onStop]);

  // Stopping, or the screen going, takes this page's pointer away for everyone.
  const sendNow = useRef(send);
  useEffect(() => {
    sendNow.current = send;
  });
  useEffect(
    () => () => {
      if (shown.current) sendNow.current({ k: 'gone', on });
      shown.current = false;
    },
    [tool, on],
  );

  const spot = (e: PointerEvent) => {
    const r = el.current?.getBoundingClientRect();
    return r
      ? toFraction(
          { left: r.left, top: r.top, width: r.width, height: r.height },
          { x: e.clientX, y: e.clientY },
        )
      : null;
  };

  const flush = () => {
    const d = drawing.current;
    if (!d) return;
    if (d.timer) clearTimeout(d.timer);
    d.timer = null;
    // Each point shows here as it's drawn; the stretch goes to everyone else as one message.
    for (let i = 0; i < d.pts.length; i += MARK_POINTS_PER_MESSAGE * 2) {
      const pts = d.pts.slice(i, i + MARK_POINTS_PER_MESSAGE * 2);
      if (pts.length >= 2) post({ k: 'line', on, id: d.id, pts });
    }
    d.pts = [];
  };

  const down = (e: PointerEvent<HTMLDivElement>) => {
    const at = spot(e);
    if (!tool || !at) return;
    e.preventDefault();
    if (tool === 'point') {
      send({ k: 'press', on, ...at });
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    const id = Math.random().toString(36).slice(2, 10);
    drawing.current = { id, pts: [at.x, at.y], timer: null };
    show({ k: 'line', on, id, pts: [at.x, at.y] });
    flush();
  };

  const move = (e: PointerEvent<HTMLDivElement>) => {
    const at = spot(e);
    if (!tool || !at) return;
    if (tool === 'point') {
      shown.current = true;
      show({ k: 'point', on, ...at });
      pointer({ k: 'point', on, ...at });
      return;
    }
    const d = drawing.current;
    if (!d) return;
    d.pts.push(at.x, at.y);
    show({ k: 'line', on, id: d.id, pts: [at.x, at.y] });
    if (d.pts.length >= MARK_POINTS_PER_MESSAGE * 2) flush();
    else d.timer ??= setTimeout(flush, MARK_SEND_EVERY_MS);
  };

  const up = () => {
    flush();
    drawing.current = null;
  };

  const leave = () => {
    if (tool === 'point' && shown.current) send({ k: 'gone', on });
    shown.current = false;
  };

  return (
    <div
      ref={el}
      className={cn(
        'absolute touch-none select-none',
        tool ? 'pointer-events-auto' : 'pointer-events-none',
        tool === 'point' && 'cursor-none',
        tool === 'draw' && 'cursor-crosshair',
      )}
      style={{ left: pic.left, top: pic.top, width: pic.width, height: pic.height }}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onPointerLeave={leave}
      data-testid="call-marks-picture"
      data-tool={tool ?? ''}
    >
      <svg
        className="absolute inset-0 h-full w-full overflow-visible"
        viewBox="0 0 1 1"
        preserveAspectRatio="none"
        aria-hidden
      >
        {view.lines.map((l) => {
          const pts = l.pts.length === 2 ? [...l.pts, ...l.pts] : l.pts;
          const points = pts.reduce(
            (s, n, i) => (i % 2 ? `${s},${n}` : `${s}${i ? ' ' : ''}${n}`),
            '',
          );
          return (
            <g
              key={l.id}
              style={{
                opacity: l.fading ? 0 : 1,
                transition: `opacity ${MARK_FADE_OUT_MS}ms ease-out`,
              }}
              data-testid="call-mark-line"
            >
              <polyline
                points={points}
                fill="none"
                stroke="rgba(0,0,0,0.35)"
                strokeWidth={8}
                strokeLinecap="round"
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
              />
              <polyline
                points={points}
                fill="none"
                stroke={l.color}
                strokeWidth={4}
                strokeLinecap="round"
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
              />
            </g>
          );
        })}
      </svg>
      {view.presses.map((p) => (
        <span
          key={p.id}
          className="call-mark-press absolute h-10 w-10 rounded-full border-[3px]"
          style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%`, borderColor: p.color }}
          data-testid="call-mark-press"
          aria-hidden
        />
      ))}
      {view.pointers.map((p) => (
        <span
          key={p.who}
          className="absolute"
          style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%` }}
        >
          <span
            className="absolute h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white"
            role="img"
            aria-label={SCREEN_MARK_WORDS.pointerOf(p.name)}
            data-testid="call-mark-pointer"
            data-name={p.name}
            style={{
              background: p.color,
              boxShadow: `0 0 0 6px ${p.color}55, 0 1px 4px rgba(0,0,0,.5)`,
            }}
          />
          <span
            className="absolute left-3 top-2 whitespace-nowrap rounded-full border-2 bg-[#191d25]/90 px-2 py-0.5 text-[11.5px] font-medium text-white shadow"
            style={{ borderColor: p.color }}
          >
            {p.name}
          </span>
        </span>
      ))}
    </div>
  );
}

function toolClass(on: boolean) {
  return cn(
    'inline-flex h-8 w-8 items-center justify-center rounded-full text-white transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-white/60',
    on ? 'bg-accent' : 'hover:bg-white/15',
  );
}

/** Point and Draw, on someone else's screen. */
function Tools({ tool, onTool }: { tool: Tool | null; onTool: (t: Tool | null) => void }) {
  const pick = (t: Tool) => onTool(tool === t ? null : t);
  return (
    <div
      className="pointer-events-auto absolute right-2 top-2 flex items-center gap-0.5 rounded-full bg-black/60 p-1"
      role="toolbar"
      aria-label={SCREEN_MARK_WORDS.tools}
      data-testid="call-mark-tools"
    >
      <button
        type="button"
        className={toolClass(tool === 'point')}
        aria-pressed={tool === 'point'}
        aria-label={tool === 'point' ? SCREEN_MARK_WORDS.stop : SCREEN_MARK_WORDS.point}
        title={tool === 'point' ? SCREEN_MARK_WORDS.stop : SCREEN_MARK_WORDS.pointHint}
        onClick={() => pick('point')}
        data-testid="call-mark-point"
      >
        <MousePointer2 size={16} />
      </button>
      <button
        type="button"
        className={toolClass(tool === 'draw')}
        aria-pressed={tool === 'draw'}
        aria-label={tool === 'draw' ? SCREEN_MARK_WORDS.stop : SCREEN_MARK_WORDS.draw}
        title={tool === 'draw' ? SCREEN_MARK_WORDS.stop : SCREEN_MARK_WORDS.drawHint}
        onClick={() => pick('draw')}
        data-testid="call-mark-draw"
      >
        <PenLine size={16} />
      </button>
    </div>
  );
}

/** On the person's own shared screen: marks on or off. */
function MineToggle({ off, owner }: { off: boolean; owner: Participant }) {
  const room = useRoomContext();
  const [busy, setBusy] = useState(false);
  const flip = async () => {
    if (busy || !owner.isLocal) return;
    setBusy(true);
    try {
      await room.localParticipant.setAttributes({ [VIDEO_CALL_MARKS_ATTRIBUTE]: off ? '' : 'off' });
    } catch {
      toast.error('That didn’t change. Try again in a moment.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      type="button"
      className="pointer-events-auto absolute right-2 top-2 inline-flex items-center gap-1.5 rounded-full bg-black/60 px-2.5 py-1 text-[12px] text-white hover:bg-black/75 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-white/60"
      aria-pressed={!off}
      aria-label={off ? SCREEN_MARK_WORDS.letMark : SCREEN_MARK_WORDS.stopMarks}
      title={off ? SCREEN_MARK_WORDS.marksOffHint : SCREEN_MARK_WORDS.marksOnHint}
      onClick={() => void flip()}
      disabled={busy}
      data-testid="call-marks-toggle"
    >
      <Highlighter size={13} aria-hidden />
      {off ? SCREEN_MARK_WORDS.marksOffShort : SCREEN_MARK_WORDS.marksOnShort}
    </button>
  );
}
