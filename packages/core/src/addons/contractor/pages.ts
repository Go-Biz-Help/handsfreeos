/**
 * Contractor Operations' pages in the side menu, which pop out of its one row (docs/contractor.md).
 *
 * Browser-safe and pure, with no imports: the manifest reads it, and every signed-in page loads the manifest. The
 * rest of its words are in ./words.ts, which hands these on.
 */
export const CONTRACTOR_PAGES = {
  jobs: 'Jobs',
  dispatch: 'Dispatch',
  estimates: 'Estimates',
  costs: 'Item costs',
  profit: 'Profit',
  gear: 'Settings',
} as const;
