import type { ReactNode } from 'react';
import { PublicFrame } from '@/components/booking/public-shell';
import { SiteByline } from '@/components/booking/site-byline';
import { getSite, pageData } from '@/lib/api/public-booking';
import { requestOrigin } from '@/lib/hosting/request-origin';

/** The business's name and phone on top of every page of its booking site. */
export default async function BookingSiteLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ site: string }>;
}) {
  const { site } = await params;
  // The same request as the page's, so it's asked for once.
  const data = await pageData(getSite(site, await requestOrigin()));
  return (
    <PublicFrame business={data.business} footer={<SiteByline page={!!data.page} />}>
      {children}
    </PublicFrame>
  );
}
