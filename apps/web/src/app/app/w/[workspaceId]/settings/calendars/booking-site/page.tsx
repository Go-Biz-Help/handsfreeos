import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { BookingSiteForm } from '@/components/calendars/booking-site-form';
import { CalendarsSubnav } from '@/components/calendars/subnav';
import { BrandedDomainCard } from '@/components/settings/branded-domain-card';
import { SettingsNav } from '@/components/settings/settings-nav';
import { PageHeader } from '@/components/shell/page-header';
import { apiServer, unwrapPage } from '@/lib/api/server';
import { brandedOriginFor } from '@/lib/hosting/branded-origin';

export const metadata: Metadata = { title: 'Booking site' };

export default async function BookingSiteSettingsPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const { api } = await apiServer();
  const got = unwrapPage(await api.POST('/v1/queries/workspace.get', { body: { workspaceId } }));
  if (got.workspace.role !== 'owner' && got.workspace.role !== 'admin') notFound();
  const [site, branded, brandedOrigin] = await Promise.all([
    api.POST('/v1/queries/booking_site.get', { body: { workspaceId } }).then(unwrapPage),
    api.POST('/v1/queries/branded_domain.get', { body: { workspaceId } }).then(unwrapPage),
    brandedOriginFor(api, workspaceId),
  ]);
  return (
    <>
      <PageHeader title="Settings" description="Your account, and how this workspace is set up." />
      <SettingsNav workspaceId={workspaceId} canManage />
      <CalendarsSubnav workspaceId={workspaceId} />
      <BookingSiteForm
        workspaceId={workspaceId}
        site={site.site}
        workspaceName={got.workspace.name}
        brandedOrigin={brandedOrigin}
      />
      <div className="mt-4">
        <BrandedDomainCard workspaceId={workspaceId} domain={branded.domain} canManage />
      </div>
    </>
  );
}
