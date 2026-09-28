import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { AddonPicksAdmin } from '@/components/admin/addon-picks-admin';
import { apiServer, unwrap } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Add-on votes' };

/**
 * Voting on what's next (0109), the team's side: weeks that closed with nothing voted for or a tie, waiting for a
 * pick; what's coming soon; every planned add-on by votes; and how the last weeks closed. For staff who manage
 * add-ons (`platform.addons.manage`); anyone else gets the not-found page.
 */
export default async function AdminAddonVotesPage() {
  const { api } = await apiServer();
  const me = unwrap(await api.POST('/v1/queries/platform.me', { body: {} }));
  if (!me.staff?.permissions.includes('platform.addons.manage')) notFound();
  const overview = unwrap(await api.POST('/v1/queries/addon_pick.overview', { body: {} }));
  return <AddonPicksAdmin overview={overview} />;
}
