import { useLocalSearchParams } from 'expo-router';

import { ToursScreen } from '@/addons/realestate/tours';

/**
 * Tours in the field (board 83): the tours, a stop with `?stop=<id>`, the feedback after with `?feedback=<tour id>`;
 * `?plan=1&home=<id>` opens Plan a tour from a home.
 */
export default function ToursRoute() {
  const { dealId, stop, feedback, plan, home } = useLocalSearchParams<{
    dealId: string;
    stop?: string;
    feedback?: string;
    plan?: string;
    home?: string;
  }>();
  return (
    <ToursScreen
      dealId={dealId}
      stopId={stop || undefined}
      feedbackTourId={feedback || undefined}
      plan={!!plan}
      homeId={home || undefined}
    />
  );
}
