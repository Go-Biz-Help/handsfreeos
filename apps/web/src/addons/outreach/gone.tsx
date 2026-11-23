/**
 * A row whose press ended it goes at once, before the page has drawn again (speed audit, Nov 2026; ./use-act.ts's
 * `gone`). The row draws `Gone` in place of itself, and its list item, which has `GONE_ROW`, hides on seeing it: no
 * state is handed up, so any part of a row can end it. The redraw has the last word, as `useAct` says.
 */
export const GONE_ROW = 'has-[[data-gone]]:hidden';

export function Gone() {
  return <span hidden data-gone="" />;
}
