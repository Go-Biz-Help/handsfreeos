import { DEFAULT_FORM_DESIGN, linkRefOf } from '@hfos/core';
import type { Metadata } from 'next';
import { permanentRedirect } from 'next/navigation';
import { BookingFlow } from '@/components/booking/booking-flow';
import { EmbeddedBooking } from '@/components/booking/embedded';
import { BookingOff, Byline, PublicFrame } from '@/components/booking/public-shell';
import { EmbedHeight } from '@/components/forms/embed-height';
import { FormLookFrame } from '@/components/forms/form-look';
import { getCalendarPage, getSite, pageData } from '@/lib/api/public-booking';
import { requestOrigin } from '@/lib/hosting/request-origin';
import { brandLook } from '@/lib/look';
import { cn } from '@/lib/utils';

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
 * (a maintenance reminder's link), when the calendar offers it. `?ref=` is kept on the booking for whoever's link it
 * was (a Social Outreach demo link, docs/outreach.md decision 24).
 *
 * `?embed=1` is the calendar on the business's own website (its Booking link → On your website): no header of ours
 * and no full-height page, it says how tall it is so /embed/v1/book.js fits the box to it, and it's always light, as
 * a form on a website is. Only the sites the calendar lists may show it (lib/booking/frame.ts). Without it, the page
 * sits under the business's name and phone.
 *
 * A calendar with a design (its Design section, the same choices as a form's Design tab) wears it on both: the whole
 * page on its own, and the box on a website, see-through there unless the design picks a background. Without one,
 * the business's colour, as before, and the brand kit's font and corners once it has them (Settings → Workspace).
 */
export default async function CalendarBookingPage({ params, searchParams }: Props) {
  const { site, calendar } = await params;
  const query = (await searchParams) ?? {};
  const wanted = typeof query['service'] === 'string' ? query['service'] : null;
  const ref = linkRefOf(query['ref']);
  const embedded = query['embed'] === '1';
  // The site's name and phone for the header, asked at the same time; an embedded page has no header.
  const [page, siteData] = await Promise.all([
    pageData(getCalendarPage(site, calendar)),
    embedded ? null : requestOrigin().then((origin) => pageData(getSite(site, origin))),
  ]);
  if (page.canonical.site !== site || page.canonical.calendar !== calendar) {
    const keep = new URLSearchParams();
    if (wanted) keep.set('service', wanted);
    if (ref) keep.set('ref', ref);
    // A snippet pasted before the calendar's link changed keeps showing it embedded.
    if (embedded) keep.set('embed', '1');
    const search = keep.size ? `?${keep}` : '';
    permanentRedirect(`/book/${page.canonical.site}/${page.canonical.calendar}${search}`);
  }
  const content =
    page.state === 'off' || !page.booking ? (
      <BookingOff business={page.business} />
    ) : (
      <BookingFlow
        page={page}
        site={page.canonical.site}
        calendarSlug={page.canonical.calendar}
        initialServiceId={wanted}
        linkRef={ref}
      />
    );
  const kit = page.business.look ?? null;
  // A calendar without a design of its own wears the brand kit's font and corners, once the kit has them.
  const design = page.calendar.design ?? (kit?.font || kit?.corners ? DEFAULT_FORM_DESIGN : null);
  const businessColor = kit?.color ?? null;
  if (!embedded) {
    const frame = (
      <PublicFrame
        business={siteData?.business ?? page.business}
        footer={<Byline />}
        designed={!!design}
      >
        {content}
      </PublicFrame>
    );
    // The header has the logo already, so the design's own logo isn't shown again here.
    return design ? (
      <FormLookFrame design={design} businessColor={businessColor} kit={kit}>
        {frame}
      </FormLookFrame>
    ) : (
      frame
    );
  }
  const look = brandLook(page.business.look?.color);
  const box = design ? (
    <FormLookFrame
      design={design}
      businessColor={businessColor}
      kit={kit}
      logo={page.business.look?.logo ?? null}
      embedded
    >
      <div
        className="flex flex-col rounded-card bg-[var(--form-surface)] text-text"
        data-testid="booking-embed"
      >
        {content}
        <footer className="px-4 pb-4 pt-1">
          <Byline />
        </footer>
      </div>
    </FormLookFrame>
  ) : (
    <div
      className={cn('flex flex-col rounded-card bg-bg text-text', look.className)}
      style={look.style}
      data-testid="booking-embed"
    >
      {content}
      <footer className="px-4 pb-4 pt-1">
        <Byline />
      </footer>
    </div>
  );
  return (
    <>
      {/* Light whatever the visitor's device prefers: a frame in another colour scheme than the site around it gets
          a solid backdrop from the browser, and the business's site is the one deciding how the page looks. */}
      <script
        dangerouslySetInnerHTML={{
          __html: "document.documentElement.setAttribute('data-theme','light')",
        }}
      />
      <style>{'html,body{background:transparent!important;color-scheme:light!important}'}</style>
      <EmbeddedBooking>
        <EmbedHeight>{box}</EmbedHeight>
      </EmbeddedBooking>
    </>
  );
}
