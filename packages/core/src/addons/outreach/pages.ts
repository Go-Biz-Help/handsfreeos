/**
 * Social Outreach's pages (docs/outreach.md, decisions 127 to 129): one for each thing the person comes to do, in this
 * order, in the side menu's pop-out on the web (the manifest's `ui.nav`) and on the add-on's first screen on the phone,
 * so the two read the same. Set up is first while anything's left to set up (decision 129), and gone once it's all
 * done; Needs you comes next, as what waits on the person; Settings is the gear's.
 *
 * Browser-safe and pure, with no imports: the manifest reads it.
 */

/** The pages, in the menu's order. `gear` is Settings: a page key of `settings` would put it in Settings search. */
export const OUTREACH_PAGE_KEYS = [
  'setup',
  'needs-you',
  'today',
  'people',
  'find',
  'results',
  'playbooks',
  'gear',
] as const;
export type OutreachPage = (typeof OUTREACH_PAGE_KEYS)[number];

/** Each page's name, in the menu and at the top of the page. */
export const OUTREACH_PAGES: Readonly<Record<OutreachPage, string>> = {
  setup: 'Set up',
  'needs-you': 'Needs you',
  today: 'Today',
  people: 'People',
  find: 'Find people',
  results: 'Results',
  playbooks: 'Playbooks',
  gear: 'Settings',
};

/** A line on what each page is for: under its name on the phone's first screen, and under its title on the web. */
export const OUTREACH_PAGE_ABOUT: Readonly<Record<OutreachPage, string>> = {
  setup: 'Get it ready to run: the setup, and each network’s Get ready.',
  'needs-you':
    'Messages and comments to OK, replies handed to you, and steps your computer couldn’t do.',
  today: 'What your computer is doing on each network, and the plan for today.',
  people: 'Everyone you’re reaching, one list with a view for each kind.',
  find: 'Where new people come from: groups, searches, events, followers and more.',
  results: 'What came of it: friends made, chats and calls booked.',
  playbooks: 'Who you’re looking for, and how you sound.',
  gear: 'You, each network, your computer, and your team for owners.',
};

/** Each page's address under the add-on's own (`/a/outreach/<path>`), as the web has it. */
export const OUTREACH_PAGE_PATHS: Readonly<Record<OutreachPage, string>> = {
  // Not `setup`: that's the setup itself, a step at a time (outreachSetupPath), which this page opens.
  setup: 'set-up',
  'needs-you': 'needs-you',
  today: 'today',
  people: 'people',
  find: 'find',
  results: 'results',
  playbooks: 'playbooks',
  gear: 'settings',
};
