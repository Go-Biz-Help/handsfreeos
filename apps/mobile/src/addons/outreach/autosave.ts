import * as React from 'react';

/**
 * A settings form that saves as each change is made, with no Save button (Chris, 2026-10-16): a tap saves at once, a
 * stepper or typing after a short pause. One save goes at a time; a change made meanwhile goes in the next save, from
 * the latest value. Saved, the screen's copy of what's kept moves on; refused, the form goes back to what's kept and the
 * line says why in the server's words. A change saved somewhere else (the web, an owner) starts the form again from it,
 * only when nothing of its own waits or is saving. The person's settings and the business's both use it. `hold` keeps a
 * change from saving while the form isn't whole yet (Only these countries with none picked), as the web's does: it
 * saves with the change that makes it whole.
 */

/** How long a stepper or typing waits after the last change before it saves. */
export const SAVE_PAUSE_MS = 800;

/** Where the saving stands, for the line that says so. */
export type SaveState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'saving' }
  /** `words` in place of Saved: a network's switch says what it did. */
  | { readonly kind: 'saved'; readonly words: string | null }
  | { readonly kind: 'failed'; readonly words: string };

export interface ChangeOptions {
  /** A stepper or typing: saves once the changes stop for a moment. */
  readonly later?: boolean;
  /** What the line says once this change is saved, in place of Saved. */
  readonly said?: string;
}

/** A change to a form, made on its latest value. */
export type Edit<T> = (change: (value: T) => T, options?: ChangeOptions) => void;

export interface Autosave<T> {
  /** What's kept, with the changes not saved yet on top. */
  readonly value: T;
  readonly state: SaveState;
  readonly change: Edit<T>;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * `kept` is the server's answer, asked again after each save; `save` saves a whole value and gives the problem's words,
 * or null once it's saved. `onState` hears where the saving stands each time it moves, for a line drawn elsewhere.
 * `hold` says when a value can't be saved yet: it waits, saying nothing, and the form says why beside what's missing.
 */
export function useAutosave<T>(
  kept: T,
  save: (value: T) => Promise<string | null>,
  onState?: (state: SaveState) => void,
  hold?: (value: T) => boolean,
): Autosave<T> {
  const [value, setValue] = React.useState(kept);
  const [state, setState] = React.useState<SaveState>({ kind: 'idle' });
  const latest = React.useRef(kept);
  // The screen's copy of what's kept: the last save, or the last answer.
  const saved = React.useRef(kept);
  const saving = React.useRef(false);
  // A change made while a save was going: it goes next.
  const again = React.useRef(false);
  const pause = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const said = React.useRef<string | null>(null);
  // A change that can't be saved yet, waiting for the one that makes the form whole.
  const held = React.useRef(false);
  const send = React.useRef(save);
  send.current = save;
  const holds = React.useRef(hold);
  holds.current = hold;
  const tell = React.useRef(onState);
  tell.current = onState;
  React.useEffect(() => tell.current?.(state), [state]);

  const run = React.useCallback(async () => {
    if (pause.current) clearTimeout(pause.current);
    pause.current = null;
    if (saving.current) {
      again.current = true;
      return;
    }
    if (holds.current?.(latest.current) === true) {
      held.current = true;
      return;
    }
    held.current = false;
    saving.current = true;
    const sent = latest.current;
    const words = said.current;
    setState({ kind: 'saving' });
    let problem: string | null;
    try {
      problem = await send.current(sent);
    } catch (e) {
      problem = e instanceof Error ? e.message : String(e);
    }
    saving.current = false;
    if (problem) {
      // Back to what's kept, a change made meanwhile with it, and why.
      again.current = false;
      held.current = false;
      if (pause.current) clearTimeout(pause.current);
      pause.current = null;
      latest.current = saved.current;
      setValue(saved.current);
      setState({ kind: 'failed', words: problem });
      return;
    }
    saved.current = sent;
    // A change made meanwhile goes next, unless it can't be saved yet: what went is saved, and it waits.
    if (again.current && holds.current?.(latest.current) !== true) {
      again.current = false;
      void run();
      return;
    }
    again.current = false;
    if (holds.current?.(latest.current) === true) held.current = true;
    if (!pause.current) setState({ kind: 'saved', words });
  }, []);

  const change = React.useCallback<Edit<T>>(
    (edit, options) => {
      latest.current = edit(latest.current);
      setValue(latest.current);
      said.current = options?.said ?? null;
      if (pause.current) clearTimeout(pause.current);
      pause.current = null;
      if (holds.current?.(latest.current) === true) {
        // Not whole yet: nothing goes, and the line stays as it was.
        held.current = true;
        return;
      }
      held.current = false;
      setState({ kind: 'saving' });
      if (options?.later) pause.current = setTimeout(() => void run(), SAVE_PAUSE_MS);
      else void run();
    },
    [run],
  );

  // Asked again with what's kept. Saved somewhere else: the form starts again from it, unless a change of its own
  // waits or is saving, which then goes on top. Read through its key, so an answer with the same settings is no news.
  const keptKey = JSON.stringify(kept);
  React.useEffect(() => {
    if (same(kept, saved.current)) return;
    saved.current = kept;
    if (saving.current || pause.current || again.current || held.current) return;
    latest.current = kept;
    setValue(kept);
  }, [keptKey]);

  // Leaving the screen within a stepper's pause still saves it.
  React.useEffect(
    () => () => {
      if (pause.current) void run();
    },
    [run],
  );

  return { value, state, change };
}
