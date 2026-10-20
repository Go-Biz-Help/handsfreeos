/**
 * Every kind's searcher, in kind order. `test/search/kinds.unit.test.ts` checks each has exactly one entry in core's
 * `SEARCH_KINDS`, which holds its gate, and that every kind the server searches has a searcher here.
 */
import type { KindSearcher } from '../run';
import { binSearcher } from './bin';
import { closeSearcher } from './close';
import { companiesSearcher } from './companies';
import { contactsSearcher } from './contacts';
import { knowledgeSearcher } from './knowledge';
import { leadsSearcher } from './leads';
import { moneySearcher } from './money';
import { recordsSearcher } from './records';

export const SEARCHERS: readonly KindSearcher[] = [
  contactsSearcher,
  companiesSearcher,
  leadsSearcher,
  moneySearcher,
  knowledgeSearcher,
  recordsSearcher,
  binSearcher,
  closeSearcher,
];
