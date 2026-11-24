/**
 * A move to another page, from the click to the page being there, for the bar along the top that says the click was
 * heard (components/shell/navigation-progress.tsx). The router says when a move starts and, by writing the address
 * into the browser's history, when it has landed (../instrumentation-client.ts), so a link, a button that moves on,
 * Back, and a move that ends where it began are all told the same way. A page drawn again in place is not a move.
 *
 * Nothing shows for a move that lands at once, as most do. One still on its way after `SHOW_AFTER_MS` shows the bar;
 * when it lands the bar runs to the end and goes, over `LAND_MS`. A page that sends the person on (the add-on's own
 * address, an old link) lands and starts again in the same breath, so the bar waits `SETTLE_MS` before it runs to the
 * end, and the two legs read as one move. One that never lands (a link that turned out to be a download) stops showing
 * after `GIVE_UP_MS`.
 */
export type NavigationBar = 'off' | 'moving' | 'landing';

export const SHOW_AFTER_MS = 150;
export const SETTLE_MS = 50;
export const LAND_MS = 300;
export const GIVE_UP_MS = 20_000;

type Phase = 'idle' | 'waiting' | 'moving' | 'settling' | 'landing';

let phase: Phase = 'idle';
/** How many moves have started: a landing counts only for the newest. */
let moves = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

const barOf = (p: Phase): NavigationBar =>
  p === 'moving' || p === 'settling' ? 'moving' : p === 'landing' ? 'landing' : 'off';

function set(next: Phase): void {
  if (timer !== null) clearTimeout(timer);
  timer =
    next === 'waiting'
      ? setTimeout(() => set('moving'), SHOW_AFTER_MS)
      : next === 'moving'
        ? setTimeout(() => set('landing'), GIVE_UP_MS)
        : next === 'settling'
          ? setTimeout(() => set('landing'), SETTLE_MS)
          : next === 'landing'
            ? setTimeout(() => set('idle'), LAND_MS)
            : null;
  const shown = barOf(phase);
  phase = next;
  if (barOf(next) !== shown) for (const listener of listeners) listener();
}

/** A move to another page has started. One already showing keeps its bar: a second click, or a page that sends on. */
export function navigationStarted(): void {
  moves += 1;
  if (phase === 'settling') set('moving');
  else if (phase !== 'moving') set('waiting');
}

/** The newest move so far, to say which one a landing is of (`navigationLanded`). */
export const navigationMove = (): number => moves;

/**
 * The page is there. `move` is the newest move as the page landed: when another has started since (a page that sent
 * the person on the moment it landed), this landing is not the end, and the bar stays for that one.
 */
export function navigationLanded(move: number): void {
  if (move !== moves) return;
  if (phase === 'waiting') set('idle');
  else if (phase === 'moving') set('settling');
}

export function subscribeNavigation(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export const navigationBar = (): NavigationBar => barOf(phase);
