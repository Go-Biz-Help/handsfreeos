import { ATTENTION_WORDS } from '@hfos/core';

import type { HomeChange } from './build';

/**
 * Home's words that only the phone says: a change made here that waits for signal, or that HandsFreeOS refused. Every
 * other word on Home is core's (`packages/core/src/attention/home-words.ts`), the same as the web's.
 */
export const HOME_PHONE_WORDS = {
  /** Over the list: this phone's changes to Home that haven't gone yet. */
  waitingTitle: (n: number) =>
    n === 1 ? '1 change waiting to send' : `${n} changes waiting to send`,
  undo: ATTENTION_WORDS.undo,
  dismissNote: 'OK',
  /** A Call button with no signal. */
  callsNeedSignal: 'Calls need signal. Let HandsFreeOS Handle still works.',
  /** The Let HandsFreeOS Handle sheet with no signal. */
  previewNeedsSignal:
    'Showing exactly what HandsFreeOS would send needs signal. It still does it once this phone is back online.',
  choicesNeedSignal:
    'Choosing what HandsFreeOS does needs signal. Try again when you’re back online.',
  goesWhenOnline: 'Goes as soon as HandsFreeOS can be reached.',
  handingOnline: 'HandsFreeOS takes this on as soon as it can be reached.',
  /** The toast for a change made with no signal. */
  queued: (done: string) => `${done} It goes as soon as HandsFreeOS can be reached.`,
} as const;

const ACTION: Readonly<Record<HomeChange['name'], string>> = {
  'attention.snooze': 'Snooze',
  'attention.dismiss': 'Dismiss',
  'attention.assign': 'Assign',
  'attention.let_handle': 'Let HandsFreeOS Handle',
  'attention.cancel_auto': 'Cancel',
  'attention.restore': 'Undo',
};

/** "Snooze didn’t go through: That item isn’t there anymore." */
export function refusedLine(change: HomeChange): string {
  const why = change.row.reason?.trim();
  return `${ACTION[change.name]} didn’t go through${why ? `: ${why}` : '.'}`;
}

/** "Snooze · Maria Lopez", for the list of changes waiting on Home. */
export function waitingLine(change: HomeChange, title: string | null): string {
  return title ? `${ACTION[change.name]} · ${title}` : ACTION[change.name];
}
