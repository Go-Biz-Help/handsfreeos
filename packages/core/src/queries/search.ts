/**
 * Search everything (HANDSFREEOS_SEARCH_IMPLEMENTATION_PLAN.md): `search.everything` for the box and the Search page,
 * `search.kind` for one kind at a time. Look-ups for people only, never the AI: nothing typed is stored, and neither
 * writes anything.
 *
 * Both are wrapped whole in one more catch, past every statement's own (`step`, search/server/run.ts): an error that
 * isn't one of ours is thrown again with only its SQLSTATE, since a database error carries the statement's
 * parameters, and so what was typed, into any log it reaches; and a statement stopped for time outside a kind is
 * `search_took_too_long`, which a client retries.
 */
import { HfosError } from '../errors';
import { defineQuery } from '../kernel/define';
import {
  SearchEverythingInput,
  SearchEverythingOutput,
  SearchKindInput,
  SearchKindOutput,
} from '../schemas/search';
import {
  scrubbed,
  SearchFailed,
  SearchStopped,
  runSearchEverything,
  runSearchKind,
  sqlStateOf,
} from '../search/server/run';
import { SEARCH_WORDS } from '../search/words';

/** Whatever got past a step, made safe to log. */
async function guarded<T>(name: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof HfosError || e instanceof SearchFailed) throw e;
    if (e instanceof SearchStopped || sqlStateOf(e) === '57014')
      throw HfosError.rule('search_took_too_long', 503, SEARCH_WORDS.tookTooLong);
    throw scrubbed(name, e);
  }
}

export const searchEverything = defineQuery({
  name: 'search.everything',
  description:
    'Search everything in the business the person may see, a few results of each kind, best first: contacts, companies, leads, money, knowledge, the business’s own kinds of records, and the Deleted bin.',
  input: SearchEverythingInput,
  output: SearchEverythingOutput,
  permission: 'workspace.read',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  handler: (ctx, input) => guarded('everything', () => runSearchEverything(ctx, input)),
});

export const searchKind = defineQuery({
  name: 'search.kind',
  description:
    'One kind of search result at a time, 50 to a page: best match, most recent or by name, with leads and clients counted for contacts and contacts who share a phone or an email.',
  input: SearchKindInput,
  output: SearchKindOutput,
  permission: 'workspace.read',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  handler: (ctx, input) => guarded('kind', () => runSearchKind(ctx, input)),
});
