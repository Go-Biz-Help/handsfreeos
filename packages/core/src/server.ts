/**
 * Server-side entry: the command kernel, every command and query, and the registry the API mounts.
 * Browser code imports '@hfos/core' instead (schemas, permissions, errors only).
 */
export * from './index';
export * from './kernel/index';
export * from './commands/index';
export * from './queries/index';
export * from './crm/matching';
export * from './auth/token';
export * from './messaging/store';
export * from './messaging/phone-account';
// Reads a wallet in the caller's transaction, so it needs a database client and cannot live in the
// browser-safe `./money` barrel beside the rest of the money code.
export * from './money/wallet-gate';
export * from './calendar/load';
export * from './calendar/deposit-load';
export * from './calendar/booking';
export * from './calendar/reminders';
export * from './workflows/load';
export * from './forms/load';
export * from './workflows/template-update';
export * from './knowledge/search';
export * from './ai-team/load';
export * from './funnels/load';
export * from './funnels/follow';
export * from './ai-setup/load';
export * from './onboarding/load';
export * from './onboarding-setup/load';
export * from './ai-team/reach';
export * from './messaging/handling';
export * from './attention/load';
export * from './automations/maintenance-load';
export * from './automations/pipeline-load';
export { mondayOf } from './attention/load-service';
export { loadConnections } from './attention/load-health';
export * from './campaigns/audience';
export * from './campaigns/postal-address';
export * from './attention/items';
export * from './attention/auto-plan';
export * from './attention/hints';
// Add-ons, server side: defining their operations and composing them with core's (docs/addon-architecture.md).
export * from './addons/server';
export * from './addons/modules';
export * from './addons/ai';
export * from './addons/teammate';
export * from './addons/roadmap-load';
export { loadActiveAddons, loadOverrides } from './addons/load';
// Search everything, server side: running a search, its budgets, the searchers' shape, and an error's SQLSTATE alone
// (search/server).
export {
  MIN_STATEMENT_MS,
  runSearch,
  runSearchEverything,
  runSearchKind,
  SEARCH_BUDGETS,
  SearchFailed,
  SearchStopped,
  sqlStateOf,
  type FoundGroup,
  type KindSearcher,
  type RunOptions,
  type SearchDb,
  type SearchPlan,
} from './search/server/run';
export { SEARCHERS } from './search/server/kinds/index';
// Add-ons answering a search: the catalogue tests' check, and the add-ons that answer.
export {
  ADDON_COUNT_CAP,
  addonSearchIssues,
  CONTRIBUTOR_MS,
  searchContributors,
  type SearchContributor,
} from './search/server/addons';
import { ADDON_SERVER_MODULES } from './addons/modules';
import { composeOperations } from './addons/server';
import { commands } from './commands/index';
import { bindRegistry, createRegistry } from './kernel/registry';
import { queries } from './queries/index';

/** Core's operations, then every add-on's, in the catalogue's order: what the API mounts and everything looks up. */
const operations = composeOperations({ commands, queries }, ADDON_SERVER_MODULES);
export const registry = createRegistry(operations.commands, operations.queries);
bindRegistry(registry);
