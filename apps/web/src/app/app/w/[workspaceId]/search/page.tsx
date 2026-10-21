import { SEARCH_WORDS } from '@hfos/core';
import type { Metadata } from 'next';
import { SearchPage } from '@/components/search/search-page';

export const metadata: Metadata = { title: SEARCH_WORDS.page };

/**
 * The Search page, `/search#q=…&kind=…` (HANDSFREEOS_SEARCH_IMPLEMENTATION_PLAN.md, decision 37): only the frame comes
 * from here. What's typed lives after `#`, which a browser never sends, so this reads no `searchParams` and asks the
 * API for nothing: the page asks for the results from the browser, and takes what it knows about the business (its
 * name, clock and settings, for the Settings group) from the layout's `SearchProvider`.
 */
export default function SearchRoute() {
  return <SearchPage />;
}
