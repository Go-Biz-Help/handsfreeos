import type { Metadata } from 'next';
import { permanentRedirect } from 'next/navigation';
import { BookingFlow } from '@/components/booking/booking-flow';
import { BookingOff } from '@/components/booking/public-shell';
import { getCalendarPage, pageData } from '@/lib/api/public-booking';

type Props = { params: Promise<{ site: string; calendar: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { site, calendar } = await params;
  const page = await pageData(getCalendarPage(site, calendar));
  return { title: { absolute: `${page.calendar.name} · ${page.business.name}` } };
}

/** One calendar's booking page; old names redirect to the current one. */
export default async function CalendarBookingPage({ params }: Props) {
  const { site, calendar } = await params;
  const page = await pageData(getCalendarPage(site, calendar));
  if (page.canonical.site !== site || page.canonical.calendar !== calendar)
    permanentRedirect(`/book/${page.canonical.site}/${page.canonical.calendar}`);
  if (page.state === 'off' || !page.booking) return <BookingOff business={page.business} />;
  return (
    <BookingFlow page={page} site={page.canonical.site} calendarSlug={page.canonical.calendar} />
  );
}
