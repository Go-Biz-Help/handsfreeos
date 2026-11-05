import type { PhoneDemo } from './state';
import type { PhoneDemoScene } from './world';

/**
 * Play on its own (src/demo): the phone's player hides completely and plays each step once its voiceover has had time
 * to be said, so a screen recording shows only the app. A step played from the scene's notification (Approve on the
 * lock screen, or a tap on the alert) still waits for the presenter to press it there.
 */

/** A moment after starting, so the first step doesn't land as the player disappears. */
export const AUTO_LEAD_MS = 3000;

/** How long a voiceover takes to say, at about 2.4 words a second with a breath after it: never under 3 seconds. */
export function sayingMs(voiceover: string): number {
  const words = voiceover.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(3000, Math.round((words / 2.4) * 1000) + 1000);
}

/** What the player does next on its own. */
export type AutoNext =
  /** Plays the next step in this long. */
  | { readonly kind: 'play'; readonly inMs: number }
  /** Waits for the presenter to press the scene's notification, which plays the step. */
  | { readonly kind: 'press' }
  /** The scene is over: the player comes back once the last voiceover has been said. */
  | { readonly kind: 'end'; readonly inMs: number };

export function autoNext(
  demo: PhoneDemo,
  scene: PhoneDemoScene,
  startedAt: number,
  now: number,
): AutoNext {
  const done = demo.steps.length;
  const next = scene.steps[done];
  const last = done > 0 ? scene.steps[done - 1] : undefined;
  // From when the last step played, so time spent unlocking the phone after a press counts toward its voiceover.
  const saidBy = last ? demo.startedAt + (demo.steps[done - 1] ?? 0) + sayingMs(last.voiceover) : 0;
  const inMs = Math.max(0, saidBy - now, startedAt + AUTO_LEAD_MS - now);
  if (!next) return { kind: 'end', inMs };
  if (next.press) return { kind: 'press' };
  return { kind: 'play', inMs };
}
