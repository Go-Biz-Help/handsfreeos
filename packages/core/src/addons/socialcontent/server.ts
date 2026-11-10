/**
 * AI Social Media Content Creator, server side: its commands and queries (docs/socialcontent.md,
 * docs/addon-architecture.md). Each is an ordinary kernel operation stamped with the add-on, so it's refused, for
 * every kind of actor, while the add-on is off, and everything it does is its own in history. The business logic
 * lives here and in ./standouts.ts: never in its screens, never in a prompt.
 */
import type { AddonServerModule } from '../server';
import { socialcontentAddon } from './manifest';
import { contentCommands, contentQueries } from './ops/content';
import { notesCommands, notesQueries } from './ops/notes';
import { POSTING_EXTENSION, postingCommands } from './ops/posting';
import { EXTENSION, readingCommands } from './ops/reading';
import { researchCommands, researchQueries } from './ops/research';
import { workerCommands } from './ops/worker';

export const socialcontentAddonServer: AddonServerModule = {
  manifest: socialcontentAddon,
  commands: [
    ...researchCommands,
    ...notesCommands,
    ...contentCommands,
    ...postingCommands,
    ...readingCommands,
    ...workerCommands,
  ],
  queries: [...researchQueries, ...notesQueries, ...contentQueries],
  notForTheAssistant: {
    'socialcontent.work.next': EXTENSION,
    'socialcontent.work.finish': EXTENSION,
    'socialcontent.work.progress': EXTENSION,
    'socialcontent.creators.found': EXTENSION,
    'socialcontent.creator.read': EXTENSION,
    'socialcontent.posts.save': EXTENSION,
    'socialcontent.post.next': POSTING_EXTENSION,
    'socialcontent.post.went': POSTING_EXTENSION,
  },
};
