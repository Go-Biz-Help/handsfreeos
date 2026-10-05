/**
 * Social Outreach, server side: its commands and queries (docs/outreach.md). Each is an ordinary kernel operation
 * stamped with the add-on, so it's refused, for every kind of actor, while the add-on is off, and everything it does
 * is its own in history. The business logic lives here: never in its screens, never in the extension.
 */
import type { AddonServerModule } from '../server';
import { outreachAddon } from './manifest';
import { playbookCommands, playbookQueries } from './ops/playbooks';
import { saveCommands, saveQueries } from './ops/saves';

export const outreachAddonServer: AddonServerModule = {
  manifest: outreachAddon,
  commands: [...playbookCommands, ...saveCommands],
  queries: [...playbookQueries, ...saveQueries],
};
