/**
 * AI Sales Coach, server side: its commands and queries (docs/salescoach.md, docs/addon-architecture.md). Each is an
 * ordinary kernel operation stamped with the add-on, so it's refused, for every kind of actor, while the add-on is
 * off, and everything it does is its own in history. The business logic lives here and in ./coach.ts: never in its
 * screens, never in a prompt.
 */
import type { AddonServerModule } from '../server';
import { salescoachAddon } from './manifest';
import { callCommands, callQueries } from './ops/calls';
import { playbookCommands, playbookQueries } from './ops/playbooks';

export const salescoachAddonServer: AddonServerModule = {
  manifest: salescoachAddon,
  commands: [...playbookCommands, ...callCommands],
  queries: [...playbookQueries, ...callQueries],
};
