/**
 * Run now (docs/outreach.md, decision 129): the jobs a person can ask their computer to do, from a small menu on each
 * page that has any instead of a card for each, and every one of them on Settings → Your computer, by network, beside
 * what was asked of it lately. Only jobs that need nothing typed or ticked: most run on their own each day (decisions
 * 32, 95 and 123), so the menu is for doing one now. The ones that need something stay where it's picked: a group
 * search's words, the requests ticked to cancel, a person to research, a bio to put in.
 *
 * Browser-safe and pure.
 */
import { askableOn, type AskKind } from './asks';
import type { Platform } from './networks';

/** Each page's jobs, in its menu's order. */
export const RUN_NOW_ON = {
  people: ['requests', 'friends', 'checks', 'chats'],
  find: ['groups', 'members', 'group_checks', 'join', 'posts'],
} as const satisfies Record<string, readonly AskKind[]>;
export type RunNowPage = keyof typeof RUN_NOW_ON;

/** Every job Your computer lists: the pages', then reading the person's profile and checking the network. */
export const RUN_NOW_ALL: readonly AskKind[] = [
  ...RUN_NOW_ON.people,
  ...RUN_NOW_ON.find,
  'profile_read',
  'checkup',
];

/** Of some jobs, those a network can be asked. */
export const runNowOn = (kinds: readonly AskKind[], platform: Platform): AskKind[] =>
  kinds.filter((kind) => askableOn(platform, kind));

export const RUN_NOW_WORDS = {
  button: 'Run now',
  /** At the top of a page's menu. */
  menuAbout: 'Most of these run on their own each day. Ask your computer for one now.',
  /** Your computer's list. */
  allTitle: 'Run now',
  allAbout:
    'Every job your computer can do for you, on each network. Most run on their own each day; ask for one and it starts on your computer.',
  /** A page's menu, with every job on Your computer. */
  seeAll: 'Every job, on Your computer',
} as const;
