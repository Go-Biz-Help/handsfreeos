/**
 * How many changes made on this phone haven't reached HandsFreeOS, from the queue of changes (`src/changes`): the
 * strip, the Sign out? sheet and the rule that keeps a person's copy at sign-out all read it.
 */
export { useNeedsYouCount, useWaitingCount } from '@/changes/hooks';

/** "4 changes", "1 change". */
export function changesWord(n: number): string {
  return `${n} ${n === 1 ? 'change' : 'changes'}`;
}
