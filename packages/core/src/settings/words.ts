/**
 * What settings search says, on the web's Settings menu and the phone's Settings alike
 * (HANDSFREEOS_SEARCH_IMPLEMENTATION_PLAN.md, "Words in core"). Browser-safe.
 */

const quoted = (q: string) => `“${q}”`;
const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export const SETTINGS_SEARCH_WORDS = {
  /** The box's placeholder and label. */
  box: 'Search settings',
  clear: 'Clear the search',
  /** Under the box while it holds a search: back to the whole menu. */
  showEvery: 'Show every setting',
  /** A setting the phone lists but only the web changes. */
  opensOnWeb: 'Opens on the web',
  /** An add-on's switch, which lives on the Add-ons page. */
  opensAddOns: 'Opens the Add-ons page',
  noMatch: (q: string) => `No settings match ${quoted(q)}.`,
  noMatchHelp: 'Try another word, like “hours”, “email” or “payments”.',
} as const;

/**
 * "3 settings on 2 pages" over the menu's results; "1 page" when only pages matched by their names, and every setting
 * under an add-on's own name counts that add-on as one page.
 */
export function settingsFound(settings: number, pages: number): string {
  if (settings === 0) return count(pages, 'page', 'pages');
  return `${count(settings, 'setting', 'settings')} on ${count(pages, 'page', 'pages')}`;
}
