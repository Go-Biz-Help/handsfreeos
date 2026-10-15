import { SalescoachLiveScreen } from '@/addons/salescoach/live';

/**
 * AI Sales Coach's page: the live call. Its other tabs (`?view=calls`, `playbooks`) stay on the web, which the
 * manifest's `ui.phone` says, so a link to one opens there.
 */
export default function SalescoachRoute() {
  return <SalescoachLiveScreen />;
}
