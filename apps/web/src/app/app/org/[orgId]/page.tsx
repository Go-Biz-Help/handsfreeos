import { redirect } from 'next/navigation';
import { agencyHref } from '@/lib/agency/org';

/** The agency area opens on its templates. */
export default async function AgencyIndexPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  redirect(agencyHref(orgId, 'templates'));
}
