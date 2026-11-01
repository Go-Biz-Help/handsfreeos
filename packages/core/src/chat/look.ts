/**
 * A website chat's look and placement as one shape, read from its stored columns: what Forms → Website chats
 * shows, what the worker sends the chat window and the loader, and what the loader writes into its styles. Each
 * reads anything unexpected as the default, so a chat always draws.
 */
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
