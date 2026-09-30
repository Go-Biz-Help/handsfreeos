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
      <BookingSiteForm {...site} />
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
