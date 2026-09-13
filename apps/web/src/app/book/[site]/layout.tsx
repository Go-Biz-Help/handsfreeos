import type { ReactNode } from 'react';
import { PublicFrame } from '@/components/booking/public-shell';
import { getSite, pageData } from '@/lib/api/public-booking';

/** The business's name and phone on top of every page of its booking site. */
export default async function BookingSiteLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ site: string }>;
}) {
  const { site } = await params;
  const data = await pageData(getSite(site));
  return <PublicFrame business={data.business}>{children}</PublicFrame>;
}
