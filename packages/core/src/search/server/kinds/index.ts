/**
 * Every kind's searcher, in kind order. `test/search/kinds.unit.test.ts` checks each has exactly one entry in core's
 * `SEARCH_KINDS`, which holds its gate, and that every kind the server searches has a searcher here.
 */
import type { KindSearcher } from '../run';
import { binSearcher } from './bin';
import { calendarSearcher } from './calendar';
import { closeSearcher } from './close';
import { companiesSearcher } from './companies';
import { contactsSearcher } from './contacts';
import { filesSearcher } from './files';
import { formsSearcher } from './forms';
import { knowledgeSearcher } from './knowledge';
import { leadsSearcher } from './leads';
import { messagesSearcher, spamSearcher } from './messages';
import { moneySearcher } from './money';
import { notesSearcher } from './notes';
import { recordsSearcher } from './records';
import { tasksSearcher } from './tasks';

export const SEARCHERS: readonly KindSearcher[] = [
  contactsSearcher,
  companiesSearcher,
  leadsSearcher,
  moneySearcher,
  messagesSearcher,
  calendarSearcher,
  tasksSearcher,
  notesSearcher,
  filesSearcher,
  formsSearcher,
  knowledgeSearcher,
  recordsSearcher,
  spamSearcher,
  binSearcher,
  closeSearcher,
];
