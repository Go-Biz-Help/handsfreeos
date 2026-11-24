/**
 * The page drawn again for live changes, one at a time (./live-provider.tsx). Each screen that listens
 * (`useLiveRefresh`) used to draw the page again by itself, so on a page that takes a while, or while a lot is
 * happening (a campaign going out), one began before the one ahead had ended, each asking the API for everything the
 * page shows. Here they stand in one line: whoever asks while the page is being drawn waits, and it is drawn once
 * more for all of them, `REDRAW_GAP_MS` after it lands. Screens that ask in the same breath (`REDRAW_LEAD_MS`) share
 * one, and so does a screen that waited longer than another to ask about the same change: a change is heard only once
 * it is saved, so a page that began to be drawn after a screen last heard one already has it.
 *
 * A screen that has gone takes back what it asked for, so a page is never drawn again for the one before it. A page
 * that never says it landed is let go after `REDRAW_GIVE_UP_MS`, so live changes can't stop for good.
 */
export const REDRAW_LEAD_MS = 20;
export const REDRAW_GAP_MS = 2_000;
export const REDRAW_GIVE_UP_MS = 30_000;

/** What a listening screen is given. */
export interface Redraws {
  /** `who` (the screen's own token) wants the page drawn again, for changes it last heard at `heard`. */
  ask(who: object, heard: number): void;
  /** `who` has gone: what it asked for is no longer wanted. */
  forget(who: object): void;
}

export interface RedrawLine extends Redraws {
  /** Who draws the page: how to start it, or null once nobody can. */
  drawWith(start: (() => void) | null): void;
  /** The page that was being drawn is there. */
  landed(): void;
}

export function redrawLine(): RedrawLine {
  const wanted = new Set<object>();
  let start: (() => void) | null = null;
  let drawing = false;
  /** When the newest one began. */
  let began = 0;
  /** The next may not start before this: the last landing and the gap. */
  let notBefore = 0;
  /** Waiting to start the next one, or to give up on the one being drawn. */
  let timer: ReturnType<typeof setTimeout> | null = null;

  function plan(): void {
    if (drawing || timer !== null || wanted.size === 0 || !start) return;
    timer = setTimeout(draw, Math.max(REDRAW_LEAD_MS, notBefore - Date.now()));
  }

  function draw(): void {
    timer = null;
    if (wanted.size === 0 || !start) return;
    wanted.clear();
    drawing = true;
    began = Date.now();
    timer = setTimeout(landed, REDRAW_GIVE_UP_MS);
    start();
  }

  function landed(): void {
    if (!drawing) return;
    drawing = false;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    notBefore = Date.now() + REDRAW_GAP_MS;
    plan();
  }

  return {
    ask(who, heard) {
      if (heard < began) return;
      wanted.add(who);
      plan();
    },
    forget(who) {
      wanted.delete(who);
    },
    drawWith(next) {
      start = next;
      if (next) {
        plan();
        return;
      }
      if (timer !== null) clearTimeout(timer);
      timer = null;
      drawing = false;
    },
    landed,
  };
}
