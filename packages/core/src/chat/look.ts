/**
 * A website chat's look and placement as one shape, read from its stored columns: what Forms → Website chats
 * shows, what the worker sends the chat window and the loader, and what the loader writes into its styles. Each
 * reads anything unexpected as the default, so a chat always draws.
 */
import { isFontName } from '../look/fonts';
import { PictureRef } from '../look/pictures';
import { readableTextOn } from './origins';

export type ChatCorner = 'right' | 'left';
export type ChatDesktopButton = 'label' | 'icon';
export type ChatMobileButton = 'label' | 'icon' | 'hidden';
export type ChatWhenAway = 'away_form' | 'chat';

/** Where the button sits, on computers and on phones (screens up to 480 pixels wide). */
export interface ChatPlacement {
  readonly desktop: {
    readonly position: ChatCorner;
    /** Pixels higher than its usual spot. */
    readonly lift: number;
    readonly button: ChatDesktopButton;
  };
  readonly mobile: {
    readonly position: ChatCorner;
    /** Picked on its own, rather than following the computer's corner. */
    readonly ownPosition: boolean;
    readonly lift: number;
    readonly button: ChatMobileButton;
  };
}

/** The most pixels a button is lifted. */
export const CHAT_LIFT_LIMIT = 300;
const HEX = /^#[0-9a-f]{6}$/i;

const corner = (v: unknown): ChatCorner => (v === 'left' ? 'left' : 'right');
const liftOf = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v)
    ? Math.max(0, Math.min(CHAT_LIFT_LIMIT, Math.round(v)))
    : 0;

/** The placement from a widget's columns (or the worker's answer, which uses the same names). */
export function chatPlacementOf(w: {
  readonly position?: unknown;
  readonly mobilePosition?: unknown;
  readonly desktopLift?: unknown;
  readonly mobileLift?: unknown;
  readonly desktopButton?: unknown;
  readonly mobileButton?: unknown;
}): ChatPlacement {
  const desktop = corner(w.position);
  const own = w.mobilePosition === 'left' || w.mobilePosition === 'right';
  return {
    desktop: {
      position: desktop,
      lift: liftOf(w.desktopLift),
      button: w.desktopButton === 'icon' ? 'icon' : 'label',
    },
    mobile: {
      position: own ? corner(w.mobilePosition) : desktop,
      ownPosition: own,
      lift: liftOf(w.mobileLift),
      button: w.mobileButton === 'icon' || w.mobileButton === 'hidden' ? w.mobileButton : 'label',
    },
  };
}

/** A colour as the chat keeps it (#2d69d8, lower case), or null. */
export const chatColorOf = (v: unknown): string | null =>
  typeof v === 'string' && HEX.test(v) ? v.toLowerCase() : null;

/** The chat's colours: the button's, the top bar's, and the words on each (the picked one, or whichever reads). */
export function chatColorsOf(w: {
  readonly accentColor: string;
  readonly textColor?: unknown;
  readonly headerColor?: unknown;
}): {
  readonly accent: string;
  readonly accentText: string;
  readonly header: string;
  readonly headerText: string;
} {
  const accent = chatColorOf(w.accentColor) ?? '#2d69d8';
  const header = chatColorOf(w.headerColor) ?? accent;
  const text = chatColorOf(w.textColor);
  return {
    accent,
    accentText: text ?? readableTextOn(accent),
    header,
    headerText: text ?? readableTextOn(header),
  };
}

export const chatWhenAwayOf = (v: unknown): ChatWhenAway => (v === 'chat' ? 'chat' : 'away_form');

// ---------- its design (design tools, part 4) ----------

/** The chat's corners, as forms have them. */
export const CHAT_CORNERS = ['square', 'slight', 'round'] as const;
export type ChatCorners = (typeof CHAT_CORNERS)[number];
export const chatCornersOf = (v: unknown): ChatCorners | null =>
  v === 'square' || v === 'slight' || v === 'round' ? v : null;

/**
 * How round each part is drawn: the button on the site, the window, its buttons and boxes, its cards, the message
 * bubbles (and the corner by the sender), and the box people type in.
 */
export interface ChatRadii {
  readonly launcher: string;
  readonly window: string;
  readonly control: string;
  readonly card: string;
  readonly bubble: string;
  readonly tail: string;
  readonly composer: string;
}

/** The look every chat had before it could pick: a round button and soft corners. Nothing picked draws this. */
export const CHAT_USUAL_RADII: ChatRadii = {
  launcher: '99px',
  window: '16px',
  control: '8px',
  card: '14px',
  bubble: '16px',
  tail: '5px',
  composer: '22px',
};

export const CHAT_RADII: Readonly<Record<ChatCorners, ChatRadii>> = {
  square: {
    launcher: '0px',
    window: '0px',
    control: '0px',
    card: '0px',
    bubble: '0px',
    tail: '0px',
    composer: '0px',
  },
  slight: {
    launcher: '12px',
    window: '12px',
    control: '8px',
    card: '10px',
    bubble: '10px',
    tail: '4px',
    composer: '10px',
  },
  round: {
    launcher: '99px',
    window: '20px',
    control: '22px',
    card: '20px',
    bubble: '20px',
    tail: '6px',
    composer: '22px',
  },
};

/** The radii a chat is drawn with: its corners', or the usual look when neither it nor the brand kit has any. */
export const chatRadiiOf = (corners: ChatCorners | null): ChatRadii =>
  corners ? CHAT_RADII[corners] : CHAT_USUAL_RADII;

/** A Google font's name as the chat keeps it, or null. */
export const chatFontOf = (v: unknown): string | null => (isFontName(v) ? v : null);

/** The face in the top bar as the chat keeps it (a picture from Your pictures), or null. */
export function chatFaceOf(v: unknown): PictureRef | null {
  const r = PictureRef.safeParse(v);
  return r.success ? r.data : null;
}

/** The greeting bubble: its words at most this long, shown after this many seconds on the page. */
export const CHAT_BUBBLE_MAX = 120;
export const CHAT_BUBBLE_AFTER_DEFAULT = 8;
export const CHAT_BUBBLE_AFTER_MIN = 1;
export const CHAT_BUBBLE_AFTER_MAX = 120;

/** Seconds as the bubble keeps them: whole, between 1 and 120, else the usual 8. */
export const chatBubbleAfterOf = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v)
    ? Math.max(CHAT_BUBBLE_AFTER_MIN, Math.min(CHAT_BUBBLE_AFTER_MAX, Math.round(v)))
    : CHAT_BUBBLE_AFTER_DEFAULT;

/** The greeting bubble from a widget's columns (or the worker's answer): null when it has none. */
export function chatBubbleOf(w: {
  readonly bubble?: unknown;
  readonly bubbleAfter?: unknown;
}): { readonly text: string; readonly after: number } | null {
  const text = typeof w.bubble === 'string' ? w.bubble.trim().slice(0, CHAT_BUBBLE_MAX) : '';
  return text ? { text, after: chatBubbleAfterOf(w.bubbleAfter) } : null;
}

/** What's said about the chat's design, the same on the web and the phone. */
export const CHAT_DESIGN_WORDS = {
  font: 'Font',
  fontHint: 'The chat’s words and its button. Your brand kit’s unless you pick one.',
  corners: 'Corners',
  useKit: 'Use your brand kit’s',
  bubble: 'Greeting bubble',
  bubbleHint:
    'Pops up beside the button to start more chats. Visitors who close it don’t see it again that visit.',
  bubblePlaceholder: 'Need a quote? I can help.',
  bubbleAfter: 'Show it after',
  face: 'A face in the top bar',
  faceHint:
    'A photo of you, your AI teammate or your team, instead of your logo. Feels like a person.',
  match: 'Match my website',
  matchHint: 'Takes the colours, font and corners from your website.',
} as const;
