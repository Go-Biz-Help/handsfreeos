/** Add the booking to Google, Outlook or Apple Calendar (the last one opens the .ics file). */
import { CalendarPlus } from 'lucide-react';
import { buttonClassName } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export interface CalendarEntry {
  readonly title: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly where: string | null;
  readonly details: string;
  /** The .ics file for this booking. */
  readonly icsUrl: string;
}

const utc = (iso: string) =>
  new Date(iso)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');

export function calendarLinks(e: CalendarEntry): {
  google: string;
  outlook: string;
  apple: string;
} {
  const google = new URLSearchParams({
    action: 'TEMPLATE',
    text: e.title,
    dates: `${utc(e.startsAt)}/${utc(e.endsAt)}`,
    details: e.details,
    location: e.where ?? '',
  });
  const outlook = new URLSearchParams({
    path: '/calendar/action/compose',
    rru: 'addevent',
    subject: e.title,
    startdt: new Date(e.startsAt).toISOString(),
    enddt: new Date(e.endsAt).toISOString(),
    body: e.details,
    location: e.where ?? '',
  });
  return {
    google: `https://calendar.google.com/calendar/render?${google}`,
    outlook: `https://outlook.live.com/calendar/0/deeplink/compose?${outlook}`,
    apple: e.icsUrl,
  };
}

export function AddToCalendar({ entry, className }: { entry: CalendarEntry; className?: string }) {
  const links = calendarLinks(entry);
  const button = buttonClassName({
    variant: 'secondary',
    size: 'sm',
    className: 'h-11 flex-1 md:h-9',
  });
  const items = [
    { label: 'Google', href: links.google, external: true },
    { label: 'Outlook', href: links.outlook, external: true },
    { label: 'Apple', href: links.apple, external: false },
  ];
  return (
    <div className={cn('flex gap-2', className)}>
      {items.map((i) => (
        <a
          key={i.label}
          href={i.href}
          className={button}
          {...(i.external
            ? { target: '_blank', rel: 'noopener noreferrer' }
            : { rel: 'noreferrer' })}
          aria-label={`Add to ${i.label} Calendar`}
        >
          <CalendarPlus size={15} aria-hidden />
          <span>{i.label}</span>
        </a>
      ))}
    </div>
  );
}
