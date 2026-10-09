/**
 * Social Outreach, server side: its commands and queries (docs/outreach.md). Each is an ordinary kernel operation
 * stamped with the add-on, so it's refused, for every kind of actor, while the add-on is off, and everything it does
 * is its own in history. The business logic lives here: never in its screens, never in the extension.
 */
import type { AddonServerModule } from '../server';
import { outreachAddon } from './manifest';
import { activityCommands, activityQueries } from './ops/activity';
import { chatCommands, chatQueries } from './ops/chats';
import { downloadCommands } from './ops/download';
import { friendCommands, friendQueries } from './ops/friends';
import { groupCommands, groupQueries } from './ops/groups';
import { playbookCommands, playbookQueries } from './ops/playbooks';
import { saveCommands, saveQueries } from './ops/saves';
import { tidyCommands, tidyQueries } from './ops/tidy';
import { postCommands } from './ops/posts';
import { todayQueries } from './ops/today';

export const outreachAddonServer: AddonServerModule = {
  manifest: outreachAddon,
  commands: [
    ...playbookCommands,
    ...saveCommands,
    ...activityCommands,
    ...friendCommands,
    ...downloadCommands,
    ...chatCommands,
    ...groupCommands,
    ...tidyCommands,
    ...postCommands,
  ],
  queries: [
    ...playbookQueries,
    ...saveQueries,
    ...activityQueries,
    ...friendQueries,
    ...chatQueries,
    ...groupQueries,
    ...todayQueries,
    ...tidyQueries,
  ],
};
