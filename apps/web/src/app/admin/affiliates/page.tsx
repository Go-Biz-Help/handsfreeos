import { AffiliatesPage } from '@/components/admin/affiliates-page';
import { apiServer, unwrapPage } from '@/lib/api/server';

/**
 * HandsFreeOS's own affiliate program (20261027014000): the share everyone earns, the applications waiting and every
 * affiliate. Read in one query, so the counts and the rows are from the same instant.
 */
export default async function AdminAffiliatesPage() {
  const { api } = await apiServer();
  const program = unwrapPage(await api.POST('/v1/queries/platform.affiliates', { body: {} }));
  return <AffiliatesPage program={program} />;
}
