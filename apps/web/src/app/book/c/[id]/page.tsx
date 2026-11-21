import { linkRefOf } from '@hfos/core';
import { permanentRedirect } from 'next/navigation';
import { getCalendarPage, pageData } from '@/lib/api/public-booking';

/**
 * /book/c/<calendar id> works forever: it sends customers to the calendar's current address, with the link's
 * `?service=`, `?ref=` (a Social Outreach demo link's) and `?embed=1` (the calendar on the business's own site) kept.
 */
export default async function PermanentCalendarLink({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const query = (await searchParams) ?? {};
  const keep = new URLSearchParams();
  if (typeof query['service'] === 'string') keep.set('service', query['service']);
  const ref = linkRefOf(query['ref']);
  if (ref) keep.set('ref', ref);
  // The calendar on the business's own site (its embed) stays embedded at its current address.
  if (query['embed'] === '1') keep.set('embed', '1');
  const page = await pageData(getCalendarPage('c', id));
  permanentRedirect(
    `/book/${page.canonical.site}/${page.canonical.calendar}${keep.size ? `?${keep}` : ''}`,
  );
}
