import { AffiliateDetail } from '@/components/admin/affiliate-detail';
import { apiServer, unwrapPage } from '@/lib/api/server';

/** One affiliate (20261027014000): where they stand, their share and link, the businesses they sent and their clicks. */
export default async function AdminAffiliatePage({
  params,
}: {
  params: Promise<{ affiliateId: string }>;
}) {
  const { affiliateId } = await params;
  const { api } = await apiServer();
  const page = unwrapPage(
    await api.POST('/v1/queries/platform.affiliate', { body: { affiliateId } }),
  );
  return <AffiliateDetail page={page} />;
}
