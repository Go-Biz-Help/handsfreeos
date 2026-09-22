import { FoundingPage } from '@/components/admin/founding-page';
import { apiServer, unwrapPage } from '@/lib/api/server';

/**
 * The founding offers (0091): the caps, the queue and who holds a seat.
 *
 * Everything on it is read in one query so the numbers on the offer cards and the rows beneath them are
 * from the same instant. Two queries would let the page show twenty-four seats out above a list of
 * twenty-five, which is exactly the sort of thing that makes somebody stop trusting the page.
 */
export default async function AdminFoundingPage() {
  const { api } = await apiServer();
  const queue = unwrapPage(
    await api.POST('/v1/queries/platform.founding', { body: { limit: 100 } }),
  );
  return <FoundingPage queue={queue} />;
}
