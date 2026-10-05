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
import { cmaCommands, cmaQueries } from './ops/cma';
import { offerCommands, offerQueries } from './ops/offers';
import { financingCommands, financingQueries } from './ops/financing';
import { inspectionCommands, inspectionQueries } from './ops/inspections';
import { clientTaskCommands, clientTaskQueries } from './ops/client-tasks';
import { portalCommands, portalQueries } from './ops/portal';
import { listingCommands, listingQueries } from './ops/listing';
import { descriptionCommands } from './ops/description';
import { marketingCommands, marketingQueries } from './ops/marketing';
import { publicCommands, publicQueries } from './ops/public';
import { openHouseCommands, openHouseQueries } from './ops/open-houses';
import { offerCompareCommands, offerCompareQueries } from './ops/offer-compare';
import { priceCommands, priceQueries } from './ops/price';
import { matchingCommands, matchingQueries } from './ops/matching';
import { sellerPortalCommands, sellerPortalQueries } from './ops/seller-portal';
import { dealPeopleCommands } from './ops/people';
import { realestateQueries } from './ops/queries';
import { termCommands } from './ops/terms';
import { contractCommands, contractQueries } from './ops/contract';
import { contingencyCommands, contingencyQueries } from './ops/contingencies';
import { waitCommands } from './ops/waits';
import { coordinateQueries } from './ops/coordinate';
import { esignCommands, esignQueries } from './ops/esign';
import { feedCommands } from './ops/feed';
import { showingCommands, showingQueries } from './ops/showings';
import { vendorCommands, vendorQueries } from './ops/vendors';
import { connectionQueries } from './ops/connections';
import { searchCommands, searchQueries } from './ops/searches';
import { fieldCommands, fieldQueries } from './ops/field';
import { exportCommands, exportQueries } from './ops/export';

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
    ...cmaCommands,
    ...offerCommands,
    ...financingCommands,
    ...inspectionCommands,
    ...clientTaskCommands,
    ...portalCommands,
    // Round three: the listing.
    ...listingCommands,
    ...descriptionCommands,
    ...marketingCommands,
    ...publicCommands,
    ...openHouseCommands,
    ...offerCompareCommands,
    ...priceCommands,
    ...matchingCommands,
    ...sellerPortalCommands,
    // Round four: coordinator and risk.
    ...contractCommands,
    ...contingencyCommands,
    ...waitCommands,
    // Round five: listing data from the feed, and buyers' saved searches on it.
    ...feedCommands,
    ...esignCommands,
    ...showingCommands,
    ...vendorCommands,
    ...searchCommands,
    ...fieldCommands,
    ...exportCommands,
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
    ...cmaQueries,
    ...offerQueries,
    ...financingQueries,
    ...inspectionQueries,
    ...clientTaskQueries,
    ...portalQueries,
    ...listingQueries,
    ...marketingQueries,
    ...publicQueries,
    ...openHouseQueries,
    ...offerCompareQueries,
    ...priceQueries,
    ...matchingQueries,
    ...sellerPortalQueries,
    ...contractQueries,
    ...esignQueries,
    ...showingQueries,
    ...vendorQueries,
    ...connectionQueries,
    ...contingencyQueries,
    ...coordinateQueries,
    ...searchQueries,
    ...fieldQueries,
    ...exportQueries,
  ],
};
