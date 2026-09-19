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
export * from './calendar/load';
export * from './calendar/deposit-load';
export * from './calendar/booking';
export * from './calendar/reminders';
export * from './workflows/load';
export * from './forms/load';
export * from './workflows/template-update';
export * from './knowledge/search';
export * from './ai-team/load';
export * from './ai-team/reach';
export * from './messaging/handling';
export * from './attention/load';
export * from './attention/items';
export * from './attention/auto-plan';
export * from './attention/hints';
import { commands } from './commands/index';
import { createRegistry } from './kernel/registry';
import { queries } from './queries/index';

export const registry = createRegistry(commands, queries);
