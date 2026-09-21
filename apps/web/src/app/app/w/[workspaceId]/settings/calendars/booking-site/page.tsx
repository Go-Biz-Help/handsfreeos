import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { BookingSiteForm } from '@/components/calendars/booking-site-form';
import { CalendarsSubnav } from '@/components/calendars/subnav';
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
  const [site, brandedOrigin] = await Promise.all([
    api.POST('/v1/queries/booking_site.get', { body: { workspaceId } }).then(unwrapPage),
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
      {/* The domain itself is set up under Workspace, because it carries the forms and the payment
          links as well. Said here anyway: this is the page people are on when they first want it. */}
      <p className="mt-4 max-w-[820px] text-[13px] text-text-2">
        Want this on your own address, like{' '}
        <span className="font-mono">booking.yourbusiness.com</span>? Set it up under{' '}
        <Link
          href={`/app/w/${workspaceId}/settings/workspace`}
          className="text-accent-text underline underline-offset-2"
        >
          Settings → Workspace
        </Link>
        . The same domain carries your forms, estimates and payment links too.
      </p>
    </>
  );
}
