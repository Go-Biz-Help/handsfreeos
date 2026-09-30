/**
 * Real Estate Agent, server side: its commands and queries (docs/addon-architecture.md). Each is an ordinary kernel operation
 * stamped with the add-on, so it's refused, for every kind of actor, while the add-on is off, and everything it does
 * is its own in history. The business logic lives here: never in its screens, never in a prompt.
 */
import { z } from 'zod';
import { defineAddonQuery, type AddonServerModule } from '../server';
import { realestateAddon } from './manifest';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

/** An example to start from: what the add-on says about itself here. Replace it with its real operations. */
const overview = defineAddonQuery(realestateAddon, {
  name: 'realestate.overview',
  description: 'What Real Estate Agent is, and which version runs here.',
  input: z.object({ workspaceId: z.uuid() }),
  output: z.object({ name: z.string(), version: z.string() }),
  permission: 'realestate.use',
  scope: inWorkspace,
  // Offered to the AI behind tool search, only while the add-on is on and the person holds the permission.
  ai: {
    tool: 'realestate_overview',
    description: 'Say what Real Estate Agent is and which version runs here.',
  },
  handler: async () => ({ name: realestateAddon.name, version: realestateAddon.version }),
});

export const realestateAddonServer: AddonServerModule = {
  manifest: realestateAddon,
  commands: [],
  queries: [overview],
};
