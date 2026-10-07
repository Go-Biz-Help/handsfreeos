'use client';
/**
 * The line at the bottom of a booking site's pages: "Made with HandsFreeOS" under the simple page itself, and
 * "Booking by HandsFreeOS" on the pages its calendars are booked on.
 */
import { BUSINESS_PAGE_WORDS } from '@hfos/core';
import { useSelectedLayoutSegment } from 'next/navigation';
import { Byline } from './public-shell';

export function SiteByline({ page }: { page: boolean }) {
  const below = useSelectedLayoutSegment();
  return <Byline words={page && below === null ? BUSINESS_PAGE_WORDS.byline : undefined} />;
}
