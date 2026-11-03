/**
 * Marks on a shared screen in a HandsFreeOS video call (docs/video-calls.md, "Marks on a shared screen"): someone
 * watching points at what's shared, their pointer showing to everyone as a bright dot with their name and a ripple
 * where they press, or draws on it, a line that fades a few seconds after they stop, like a laser pointer.
 *
 * - **Not kept.** Like reactions, marks travel between the people in the call on their own data topic and go with it.
 * - **Where on the screen** is a fraction of the shared picture, 0 to 1 across and down, so a mark lands on the same
 *   spot whatever size each person's window is. `fitIn` finds where the picture sits in its tile.
 * - **Who may mark**: anyone in a meeting; in a webinar, only someone LiveKit lets share a screen (the team), read
 *   from the room's own permissions on them, never from what a page says about itself.
 * - **The person sharing can turn marks off** for their screen: `hfos.marks` = `off` on them.
 * - **One board for both apps**: `MarksBoard` keeps what each screen shows, so the web and the phone draw the same.
 */
import { z } from 'zod';
import { isPersonIdentity, type VideoCallFormat } from './video-calls';

/** The data topic marks travel on, between the people in the call. */
export const VIDEO_CALL_MARKS_TOPIC = 'hfos.marks';
/** On the person sharing: `off` when they turned marks off for their screen. */
export const VIDEO_CALL_MARKS_ATTRIBUTE = 'hfos.marks';

/** A line stays this long after its last point, then fades out over `MARK_FADE_OUT_MS`. */
export const MARK_FADE_MS = 3000;
export const MARK_FADE_OUT_MS = 600;
/** A pointer that hasn't moved for this long goes, as if it had left. */
export const MARK_POINTER_IDLE_MS = 10_000;
/** A press's ripple lasts this long. */
export const MARK_PRESS_MS = 700;
/** How often a page sends its pointer, or the newest stretch of a line: 20 times a second at most. */
export const MARK_SEND_EVERY_MS = 50;

/** Points in one message (a page sends at most this many at a time), and in one line. */
export const MARK_POINTS_PER_MESSAGE = 64;
const POINTS_PER_LINE = 1500;
/** What one screen keeps at once, oldest first to go. */
const LINES_PER_SCREEN = 40;
const PRESSES_PER_SCREEN = 24;

const fraction = z.number().min(0).max(1);
/** Whose screen the mark is on: their identity in the room. */
const screen = z.string().min(1).max(64);

/** One mark as it travels. */
export const MarkMessage = z.discriminatedUnion('k', [
  /** Where their pointer is now. */
  z.object({ k: z.literal('point'), on: screen, x: fraction, y: fraction }),
  /** A press: a ripple there. */
  z.object({ k: z.literal('press'), on: screen, x: fraction, y: fraction }),
  /** The next stretch of a line: points as x, y, x, y… added to the line with that id. */
  z.object({
    k: z.literal('line'),
    on: screen,
    id: z.string().min(1).max(24),
    pts: z
      .array(fraction)
      .min(2)
      .max(MARK_POINTS_PER_MESSAGE * 2)
      .refine((p) => p.length % 2 === 0),
  }),
  /** Their pointer left the screen. */
  z.object({ k: z.literal('gone'), on: screen }),
]);
export type MarkMessage = z.infer<typeof MarkMessage>;

/** A mark as it arrived, or null for anything that isn't one. */
export function readMark(payload: Uint8Array | string): MarkMessage | null {
  try {
    const text = typeof payload === 'string' ? payload : new TextDecoder().decode(payload);
    const parsed = MarkMessage.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

const round = (n: number) => Math.round(Math.min(1, Math.max(0, n)) * 10_000) / 10_000;

/** A mark ready to send: its places rounded, so a message stays small. */
export function writeMark(m: MarkMessage): Uint8Array {
  const out: MarkMessage =
    m.k === 'line'
      ? { ...m, pts: m.pts.map(round) }
      : m.k === 'gone'
        ? m
        : { ...m, x: round(m.x), y: round(m.y) };
  return new TextEncoder().encode(JSON.stringify(out));
}

export interface Size {
  readonly width: number;
  readonly height: number;
}
export interface Rect extends Size {
  readonly left: number;
  readonly top: number;
}

/** Where a picture sits in a box it's fitted into whole (object-fit: contain), or null before it has a size. */
export function fitIn(box: Size, picture: Size): Rect | null {
  if (box.width <= 0 || box.height <= 0 || picture.width <= 0 || picture.height <= 0) return null;
  const scale = Math.min(box.width / picture.width, box.height / picture.height);
  const width = picture.width * scale;
  const height = picture.height * scale;
  return { left: (box.width - width) / 2, top: (box.height - height) / 2, width, height };
}

/** A spot in the box as a fraction of the picture in it, or null when it's off the picture. */
export function toFraction(
  picture: Rect,
  at: { readonly x: number; readonly y: number },
): { x: number; y: number } | null {
  const x = (at.x - picture.left) / picture.width;
  const y = (at.y - picture.top) / picture.height;
  return x < 0 || x > 1 || y < 0 || y > 1 ? null : { x, y };
}

/** LiveKit's permissions on someone, as the room gives them. */
interface RoomPermission {
  readonly canPublish: boolean;
  readonly canPublishSources: readonly number[];
}

/** LiveKit's number for a shared screen among the sources someone may send. */
const LIVEKIT_SCREEN_SHARE = 3;

/**
 * Whether LiveKit lets someone share a screen, from the permissions the room gives them (no list is everything).
 * The worker signs these, so a page can't claim them.
 */
export function mayShareScreen(permission: RoomPermission | undefined): boolean {
  if (!permission?.canPublish) return false;
  return (
    permission.canPublishSources.length === 0 ||
    permission.canPublishSources.includes(LIVEKIT_SCREEN_SHARE)
  );
}

/** Who may mark a shared screen: anyone in a meeting; in a webinar, only someone who may share one (the team). */
export const mayMark = (p: { readonly format: VideoCallFormat; readonly shareScreen: boolean }) =>
  p.format === 'meeting' || p.shareScreen;

/** Whether the person sharing turned marks off for their screen. */
export const marksOff = (attrs: Readonly<Record<string, string>> | undefined): boolean =>
  attrs?.[VIDEO_CALL_MARKS_ATTRIBUTE] === 'off';

/**
 * A mark that arrived, if it counts: from a person (never the listener), who may mark in this call, on the screen of
 * someone in it who hasn't turned marks off. Null for anything else.
 */
export function markFrom(
  payload: Uint8Array | string,
  from:
    { readonly identity: string; readonly permissions?: RoomPermission | undefined } | undefined,
  format: VideoCallFormat,
  ownerOf: (
    identity: string,
  ) => { readonly attributes: Readonly<Record<string, string>> } | undefined,
): MarkMessage | null {
  if (!from || !isPersonIdentity(from.identity)) return null;
  if (!mayMark({ format, shareScreen: mayShareScreen(from.permissions) })) return null;
  const m = readMark(payload);
  if (!m) return null;
  const owner = ownerOf(m.on);
  return owner && !marksOff(owner.attributes) ? m : null;
}

/** Bright colours that show on most screens, one for each person marking. */
export const MARK_COLORS = [
  '#ff3b6b',
  '#ffb020',
  '#22c55e',
  '#3ea8ff',
  '#b06cff',
  '#ff7a1a',
] as const;

/** Someone's colour: the same on every page for the same person. */
export function markColorOf(identity: string): string {
  let h = 0;
  for (let i = 0; i < identity.length; i++) h = (h * 31 + identity.charCodeAt(i)) >>> 0;
  return MARK_COLORS[h % MARK_COLORS.length]!;
}

/** Who sent a mark: their identity in the room and the name shown. */
export interface Marker {
  readonly identity: string;
  readonly name: string;
}

/** What one screen shows now. */
export interface ScreenMarksView {
  readonly pointers: readonly {
    readonly who: string;
    readonly name: string;
    readonly color: string;
    readonly x: number;
    readonly y: number;
  }[];
  readonly presses: readonly {
    readonly id: string;
    readonly color: string;
    readonly x: number;
    readonly y: number;
  }[];
  readonly lines: readonly {
    readonly id: string;
    readonly color: string;
    /** x, y, x, y…, each a fraction of the picture. */
    readonly pts: readonly number[];
    /** Past `MARK_FADE_MS`: on its way out. */
    readonly fading: boolean;
  }[];
}

const NOTHING: ScreenMarksView = { pointers: [], presses: [], lines: [] };

interface Board {
  pointers: Map<string, { name: string; x: number; y: number; at: number }>;
  presses: { id: string; who: string; x: number; y: number; at: number }[];
  lines: Map<string, { who: string; pts: number[]; at: number }>;
}

/**
 * What every shared screen in the call shows: each person's pointer, their presses and their lines, kept only for as
 * long as they show. A page applies what arrives (and what it sends, as it sends it) and draws `view`.
 */
export class MarksBoard {
  private screens = new Map<string, Board>();
  private count = 0;

  private boardOf(on: string): Board {
    let b = this.screens.get(on);
    if (!b) {
      b = { pointers: new Map(), presses: [], lines: new Map() };
      this.screens.set(on, b);
    }
    return b;
  }

  /** A mark from someone. */
  apply(from: Marker, m: MarkMessage, now: number): void {
    const b = this.boardOf(m.on);
    const who = from.identity;
    switch (m.k) {
      case 'point':
        b.pointers.set(who, { name: from.name, x: m.x, y: m.y, at: now });
        return;
      case 'gone':
        b.pointers.delete(who);
        return;
      case 'press':
        b.presses.push({ id: `${who}:${++this.count}`, who, x: m.x, y: m.y, at: now });
        if (b.presses.length > PRESSES_PER_SCREEN) b.presses.shift();
        return;
      case 'line': {
        const key = `${who}:${m.id}`;
        const line = b.lines.get(key);
        if (line) {
          if (line.pts.length / 2 < POINTS_PER_LINE) line.pts.push(...m.pts);
          line.at = now;
          return;
        }
        b.lines.set(key, { who, pts: [...m.pts], at: now });
        if (b.lines.size > LINES_PER_SCREEN) b.lines.delete(b.lines.keys().next().value!);
        return;
      }
    }
  }

  /** Someone left the call: their pointer goes from every screen. */
  leave(identity: string): void {
    for (const b of this.screens.values()) b.pointers.delete(identity);
  }

  /** A screen stopped being shared, or turned marks off: everything on it goes. */
  clear(on: string): void {
    this.screens.delete(on);
  }

  /** Drops what no longer shows. True when anything went. */
  prune(now: number): boolean {
    let changed = false;
    for (const [on, b] of this.screens) {
      for (const [who, p] of b.pointers)
        if (now - p.at >= MARK_POINTER_IDLE_MS) changed = b.pointers.delete(who) || changed;
      const before = b.presses.length;
      b.presses = b.presses.filter((p) => now - p.at < MARK_PRESS_MS);
      changed ||= b.presses.length !== before;
      for (const [id, l] of b.lines)
        if (now - l.at >= MARK_FADE_MS + MARK_FADE_OUT_MS) changed = b.lines.delete(id) || changed;
      if (!b.pointers.size && !b.presses.length && !b.lines.size) this.screens.delete(on);
    }
    return changed;
  }

  /** The next moment something changes on its own (a line starting to fade, or anything going), or null. */
  nextChange(now: number): number | null {
    let next = Infinity;
    for (const b of this.screens.values()) {
      for (const p of b.pointers.values()) next = Math.min(next, p.at + MARK_POINTER_IDLE_MS);
      for (const p of b.presses) next = Math.min(next, p.at + MARK_PRESS_MS);
      for (const l of b.lines.values())
        next = Math.min(
          next,
          now < l.at + MARK_FADE_MS ? l.at + MARK_FADE_MS : l.at + MARK_FADE_MS + MARK_FADE_OUT_MS,
        );
    }
    return next === Infinity ? null : next;
  }

  /** What a screen shows now. */
  view(on: string, now: number): ScreenMarksView {
    const b = this.screens.get(on);
    if (!b) return NOTHING;
    return {
      pointers: [...b.pointers]
        .filter(([, p]) => now - p.at < MARK_POINTER_IDLE_MS)
        .map(([who, p]) => ({ who, name: p.name, color: markColorOf(who), x: p.x, y: p.y })),
      presses: b.presses
        .filter((p) => now - p.at < MARK_PRESS_MS)
        .map((p) => ({ id: p.id, color: markColorOf(p.who), x: p.x, y: p.y })),
      lines: [...b.lines]
        .filter(([, l]) => now - l.at < MARK_FADE_MS + MARK_FADE_OUT_MS)
        .map(([id, l]) => ({
          id,
          color: markColorOf(l.who),
          pts: l.pts,
          fading: now - l.at >= MARK_FADE_MS,
        })),
    };
  }
}

/**
 * The board for a call's page: each screen's overlay subscribes to it, and it prunes itself as marks fade, so a page
 * only draws. `version` changes with every change, for React's `useSyncExternalStore`.
 */
export class MarksStore {
  readonly board = new MarksBoard();
  private listeners = new Set<() => void>();
  private version = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  apply(from: Marker, m: MarkMessage): void {
    this.board.apply(from, m, Date.now());
    this.changed();
  }
  leave(identity: string): void {
    this.board.leave(identity);
    this.changed();
  }
  clear(on: string): void {
    this.board.clear(on);
    this.changed();
  }
  /** What a screen shows now. */
  view(on: string): ScreenMarksView {
    return this.board.view(on, Date.now());
  }
  /** The call's page is going: no more timers. */
  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };
  getVersion = (): number => this.version;

  private changed(): void {
    this.version++;
    for (const fn of this.listeners) fn();
    this.stop();
    const now = Date.now();
    const next = this.board.nextChange(now);
    if (next !== null)
      this.timer = setTimeout(
        () => {
          this.board.prune(Date.now());
          this.changed();
        },
        Math.max(16, next - now + 1),
      );
  }
}

export const SCREEN_MARK_WORDS = {
  point: 'Point',
  pointHint: 'Point at this screen. Everyone sees your pointer, and a ripple where you click.',
  draw: 'Draw',
  drawHint: 'Draw on this screen to circle something. It fades after a few seconds.',
  stop: 'Stop marking (Esc)',
  tools: 'Mark this screen',
  /** The person sharing. */
  letMark: 'Let people mark my screen',
  marksOnHint:
    'People watching can point and draw on your screen. They show here and in their call.',
  stopMarks: 'Turn marks off',
  marksOffHint: 'Nobody can point or draw on your screen.',
  marksOnShort: 'Marks on',
  marksOffShort: 'Marks off',
  marksOff: 'Marks are off',
  marksOffFor: (name: string) => `${name} turned marks off for their screen.`,
  /** The tab's title while the person sharing is somewhere else. */
  pointing: (name: string) => `${name} is pointing at your screen`,
  pointerOf: (name: string) => `${name}’s pointer`,
} as const;
