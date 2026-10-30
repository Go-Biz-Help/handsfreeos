/**
 * Social Outreach's pages (docs/outreach.md, decisions 127 and 128): one for each thing the person comes to do, in this order,
 * in the side menu's pop-out on the web (the manifest's `ui.nav`) and on the add-on's first screen on the phone, so
 * the two read the same. Needs you comes first after Set up, as what waits on the person; Settings is the gear's.
 *
 * Browser-safe and pure, with no imports: the manifest reads it.
 */

/** The pages, in the menu's order. `gear` is Settings: a page key of `settings` would put it in Settings search. */
export const OUTREACH_PAGE_KEYS = [
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
  'needs-you':
    'Messages and comments to OK, replies handed to you, and steps your computer couldn’t do.',
  today: 'What your computer is doing on each network, and the plan for today.',
  people: 'Everyone you’re reaching, one list with a view for each kind.',
  find: 'Where new people come from: groups, searches, events, followers and more.',
  results: 'What came of it: friends made, chats and calls booked.',
  playbooks: 'Who you’re looking for, and how you sound.',
  gear: 'Your settings, each network’s, your computer and your team’s.',
};

/** Each page's address under the add-on's own (`/a/outreach/<path>`), as the web has it. */
export const OUTREACH_PAGE_PATHS: Readonly<Record<OutreachPage, string>> = {
  'needs-you': 'needs-you',
  today: 'today',
  people: 'people',
  find: 'find',
  results: 'results',
  playbooks: 'playbooks',
  gear: 'settings',
};
