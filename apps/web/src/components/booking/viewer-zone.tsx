'use client';
/**
 * The zone the public pages tell times in: the viewer's own. The owner's pick 4a (2026-11-03): a visitor whose device
 * is in another zone than the calendar sees times in theirs, "Times in Pacific Time · Change", and can switch. And
 * their answer for what customers see: "always show in the viewer's timezone but if it doesn't know it it defaults to
 * the one set by the business".
 *
 * The page is drawn on the server in the calendar's zone, and moves to the device's once it runs in the browser, so
 * the first paint and the server's agree. The booking page sends the zone it showed with the booking, and the
 * customer's texts and emails then use it too (`appointment_attendees.timezone`).
 */
import { canonicalTimeZone, sameZone, zonePickLabel } from '@hfos/core';
import { Globe } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ZoneOptions } from '@/components/calendar/zone-field';

/** The device's zone, when the browser says one HandsFreeOS knows. */
function deviceZone(): string | null {
  try {
    return canonicalTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
  } catch {
    return null;
  }
}

/** The zone to show times in: the calendar's at first, then the device's. The setter is the Change pick's. */
export function useViewerZone(pageZone: string): readonly [string, (zone: string) => void] {
  const [zone, setZone] = useState(pageZone);
  useEffect(() => {
    const device = deviceZone();
    setZone(device && !sameZone(device, pageZone) ? device : pageZone);
  }, [pageZone]);
  return [zone, setZone] as const;
}

/** A zone's name on the page: the server's own words for the calendar's zone, "Pacific Time" for another. */
export const zoneWords = (zone: string, pageZone: string, pageLabel: string): string =>
  sameZone(zone, pageZone) ? pageLabel : zonePickLabel(zone);

/** "Times in Pacific Time · Change", the Change opening a pick of every zone. */
export function TimesIn({
  zone,
  pageZone,
  pageLabel,
  onZone,
}: {
  zone: string;
  /** The calendar's zone, which the server named as `pageLabel`. */
  pageZone: string;
  pageLabel: string;
  /** Left out where the zone can't be changed. */
  onZone?: (zone: string) => void;
}) {
  const [picking, setPicking] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs text-text-3" data-testid="times-in">
      <Globe size={14} aria-hidden />
      <span>Times in {zoneWords(zone, pageZone, pageLabel)}</span>
      {onZone && !picking ? (
        <>
          <span aria-hidden>·</span>
          <button
            type="button"
            onClick={() => setPicking(true)}
            className="font-medium text-accent-text underline-offset-2 hover:underline"
            data-testid="times-in-change"
          >
            Change
          </button>
        </>
      ) : null}
      {onZone && picking ? (
        <select
          aria-label="Time zone"
          autoFocus
          value={zone}
          onChange={(e) => {
            onZone(e.target.value);
            setPicking(false);
          }}
          onBlur={() => setPicking(false)}
          className="h-8 max-w-full rounded-control border border-border-strong bg-card px-2 text-[13px] text-text"
          data-testid="times-in-zone"
        >
          <ZoneOptions calendarZone={pageZone} value={zone} />
        </select>
      ) : null}
    </div>
  );
}

/** "Times in Pacific Time" on a page that lists no times itself (a site's list of calendars), in the viewer's zone. */
export function ViewerTimesIn({ pageZone, pageLabel }: { pageZone: string; pageLabel: string }) {
  const [zone] = useViewerZone(pageZone);
  return <TimesIn zone={zone} pageZone={pageZone} pageLabel={pageLabel} />;
}
