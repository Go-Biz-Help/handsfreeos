/**
 * AI Social Media Content Creator, server side: its commands and queries (docs/socialcontent.md,
 * docs/addon-architecture.md). Each is an ordinary kernel operation stamped with the add-on, so it's refused, for
 * every kind of actor, while the add-on is off, and everything it does is its own in history. The business logic
 * lives here and in ./standouts.ts: never in its screens, never in a prompt.
 */
import type { AddonServerModule } from '../server';
import { socialcontentAddon } from './manifest';
import { EXTENSION, readingCommands } from './ops/reading';
import { researchCommands, researchQueries } from './ops/research';
import { workerCommands } from './ops/worker';

export const socialcontentAddonServer: AddonServerModule = {
  manifest: socialcontentAddon,
  commands: [...researchCommands, ...readingCommands, ...workerCommands],
  queries: [...researchQueries],
  notForTheAssistant: {
    'socialcontent.work.next': EXTENSION,
    'socialcontent.work.finish': EXTENSION,
    'socialcontent.creators.found': EXTENSION,
    'socialcontent.creator.read': EXTENSION,
    'socialcontent.posts.save': EXTENSION,
  },
};
