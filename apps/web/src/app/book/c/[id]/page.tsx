import { permanentRedirect } from 'next/navigation';
import { getCalendarPage, pageData } from '@/lib/api/public-booking';

/** /book/c/<calendar id> works forever: it sends customers to the calendar's current address. */
export default async function PermanentCalendarLink({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const page = await pageData(getCalendarPage('c', id));
  permanentRedirect(`/book/${page.canonical.site}/${page.canonical.calendar}`);
}
