'use client';
import { WIZARD_WORDS } from '@hfos/core';
import { CalendarDays, Check } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, type ComponentProps } from 'react';
import { toast } from 'sonner';
import { BookingSiteForm } from '@/components/calendars/booking-site-form';
import { ServicesPage } from '@/components/calendars/services-page';
import { Button, ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';

/**
 * The wizard's calendar step (board 5): the services customers book, one calendar that takes them, and the booking
 * page, each the screen Settings → Calendars already has. Not the calendar builder: the wizard makes a service
 * calendar with every service on it and turns it on, and the builder is there for anything more.
 *
 * The booking page can be there already and off: publishing a form (the texting opt-in's "Set this up for me")
 * names the business's public pages without opening them for booking. Making the booking calendar turns it on,
 * and so does "Turn it on" when the calendar was made some other way; otherwise the step never finished.
 */
export function CalendarSetup({
  workspaceId,
  calendar,
  services,
  site,
}: {
  workspaceId: string;
  /** The calendar customers can book, or the first one there is. */
  calendar: { id: string; name: string; bookable: boolean } | null;
  services: ComponentProps<typeof ServicesPage>;
  site: ComponentProps<typeof BookingSiteForm>;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const ids = services.services.filter((s) => !s.archivedAt).map((s) => s.id);
  const off = site.site && !site.site.enabled ? site.site : null;

  /** The booking page as it is, switched on. */
  const turnOnPage = async (page: NonNullable<typeof off>) =>
    unwrap(
      await apiBrowser().POST('/v1/commands/booking_site.update', {
        body: { workspaceId, name: page.name, slug: page.slug, intro: page.intro, enabled: true },
      }),
    );

  async function make() {
    setBusy(true);
    try {
      const made = unwrap(
        await apiBrowser().POST('/v1/commands/calendar.create', {
          body: {
            workspaceId,
            name: WIZARD_WORDS.calendarName,
            preset: 'service',
            services: ids,
          },
        }),
      );
      unwrap(
        await apiBrowser().POST('/v1/commands/calendar.set_status', {
          body: { workspaceId, calendarId: made.calendarId, status: 'active' },
        }),
      );
      if (off) await turnOnPage(off);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
      router.refresh();
    }
  }

  async function turnOn(page: NonNullable<typeof off>) {
    setBusy(true);
    try {
      await turnOnPage(page);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
      router.refresh();
    }
  }

  return (
    <>
      <ServicesPage {...services} />
      {calendar?.bookable ? (
        <div
          className="flex items-center gap-2.5 rounded-menu bg-success-soft px-4 py-3 text-[13.5px] text-success-text"
          data-testid="setup-calendar-made"
        >
          <Check className="h-4 w-4 flex-none" strokeWidth={2} />
          {WIZARD_WORDS.calendarMade(calendar.name)}
        </div>
      ) : calendar ? (
        <Card className="flex flex-wrap items-center gap-3 p-5" data-testid="setup-calendar-draft">
          <p className="min-w-0 flex-1 text-[13.5px]">
            {WIZARD_WORDS.calendarDraft(calendar.name)}
          </p>
          <ButtonLink
            href={`/app/w/${workspaceId}/settings/calendars/${calendar.id}`}
            variant="secondary"
          >
            {WIZARD_WORDS.calendarOpen}
          </ButtonLink>
        </Card>
      ) : (
        <Card className="flex flex-wrap items-center gap-3 p-5">
          <div className="min-w-0 flex-1">
            <div className="font-medium">{WIZARD_WORDS.calendarMake}</div>
            <p className="text-[13px] text-text-2">
              {ids.length ? WIZARD_WORDS.calendarMakeDetail : WIZARD_WORDS.calendarNeedsService}
            </p>
          </div>
          <Button
            loading={busy}
            disabled={!ids.length}
            onClick={() => void make()}
            data-testid="setup-calendar-make"
          >
            {WIZARD_WORDS.calendarMake}
          </Button>
        </Card>
      )}
      {calendar?.bookable && off ? (
        <Card className="flex flex-wrap items-center gap-3 p-5" data-testid="setup-booking-off">
          <p className="min-w-0 flex-1 text-[13.5px]">{WIZARD_WORDS.bookingOff}</p>
          <Button loading={busy} onClick={() => void turnOn(off)} data-testid="setup-booking-on">
            {WIZARD_WORDS.bookingTurnOn}
          </Button>
        </Card>
      ) : null}
      {/* Keyed on the switch: the form keeps what's typed, so a page turned on above starts again from on. */}
      <BookingSiteForm key={String(site.site?.enabled ?? 'new')} {...site} />
      <div className="flex flex-wrap items-center gap-3 rounded-menu border border-border bg-card px-4 py-3.5">
        <CalendarDays className="h-4 w-4 flex-none text-text-3" strokeWidth={1.75} />
        <div className="min-w-0 flex-1">
          <div className="font-medium">{WIZARD_WORDS.busyTimes}</div>
          <p className="text-[13px] text-text-2">{WIZARD_WORDS.busyTimesDetail}</p>
        </div>
        <ButtonLink href={`/app/w/${workspaceId}/settings/my-calendar`} variant="secondary">
          {WIZARD_WORDS.busyTimesLink}
        </ButtonLink>
      </div>
    </>
  );
}
