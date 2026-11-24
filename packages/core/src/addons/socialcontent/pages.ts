/**
 * AI Social Media Content Creator's pages, which pop out of its one row in the side menu (docs/socialcontent.md).
 *
 * Browser-safe and pure, with no imports: the manifest reads it, and every signed-in page loads the manifest. The
 * rest of its words are in ./words.ts, which hands these on.
 */
export const SOCIALCONTENT_PAGES = {
  creators: 'Creators',
  standouts: 'Standouts',
  playbook: 'Playbook',
  ideas: 'Ideas',
  calendar: 'Calendar',
  // Not `settings`: that key would put the page in Settings search, which opens it on the web.
  gear: 'Settings',
} as const;
