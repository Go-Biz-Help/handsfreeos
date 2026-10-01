/**
 * Real Estate Agent, server side: its commands and queries (docs/addon-architecture.md). Each is an ordinary kernel
 * operation stamped with the add-on, so it's refused, for every kind of actor, while the add-on is off, and
 * everything it does is its own in history. The business logic lives in `ops/`: never in its screens, never in a
 * prompt.
 */
import type { AddonServerModule } from '../server';
import { realestateAddon } from './manifest';
import { clientUpdateCommands, clientUpdateQueries } from './ops/client-updates';
import { dealLifeCommands } from './ops/deals';
import { documentCommands } from './ops/documents';
import { dutyQueries } from './ops/duty-queries';
import { dutyCommands } from './ops/duties';
import { editorCommands, editorQueries } from './ops/editor';
import { healthCommands, healthQueries } from './ops/health';
import { homeCommands, homeQueries } from './ops/homes';
import { memoryCommands, memoryQueries } from './ops/memory';
import { tourCommands, tourQueries } from './ops/tours';
import { dealPeopleCommands } from './ops/people';
import { realestateQueries } from './ops/queries';
import { termCommands } from './ops/terms';

export const realestateAddonServer: AddonServerModule = {
  manifest: realestateAddon,
  commands: [
    ...dealLifeCommands,
    ...dealPeopleCommands,
    ...termCommands,
    ...dutyCommands,
    ...documentCommands,
    ...healthCommands,
    ...editorCommands,
    ...clientUpdateCommands,
    ...homeCommands,
    ...memoryCommands,
    ...tourCommands,
  ],
  queries: [
    ...realestateQueries,
    ...dutyQueries,
    ...healthQueries,
    ...editorQueries,
    ...clientUpdateQueries,
    ...homeQueries,
    ...memoryQueries,
    ...tourQueries,
  ],
};
