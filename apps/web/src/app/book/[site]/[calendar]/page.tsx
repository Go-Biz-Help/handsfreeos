import type { Metadata } from 'next';
import { permanentRedirect } from 'next/navigation';
import { BookingFlow } from '@/components/booking/booking-flow';
import { BookingOff } from '@/components/booking/public-shell';
import { getCalendarPage, pageData } from '@/lib/api/public-booking';

type Props = {
  params: Promise<{ site: string; calendar: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { site, calendar } = await params;
  const page = await pageData(getCalendarPage(site, calendar));
  return { title: { absolute: `${page.calendar.name} · ${page.business.name}` } };
}

/**
 * One calendar's booking page; old names redirect to the current one. `?service=<id>` starts on that service
 * (a maintenance reminder's link), when the calendar offers it.
 */
export default async function CalendarBookingPage({ params, searchParams }: Props) {
  const { site, calendar } = await params;
  const query = (await searchParams) ?? {};
  const wanted = typeof query['service'] === 'string' ? query['service'] : null;
  const page = await pageData(getCalendarPage(site, calendar));
  if (page.canonical.site !== site || page.canonical.calendar !== calendar)
    permanentRedirect(
      `/book/${page.canonical.site}/${page.canonical.calendar}${wanted ? `?service=${encodeURIComponent(wanted)}` : ''}`,
    );
  if (page.state === 'off' || !page.booking) return <BookingOff business={page.business} />;
  return (
    <BookingFlow
      page={page}
      site={page.canonical.site}
      calendarSlug={page.canonical.calendar}
      initialServiceId={wanted}
    />
  );
}
