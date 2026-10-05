'use client';
/**
 * Pieces the listing's pages draw the same way (round three): the home's facts on one line, a photo signed for
 * showing, and how the list price came to be what it is. Words come from core, so the portal, the phone and the
 * Assistant say the same thing.
 */
import { fmtMonthDay, localDayOf as dateOf, money } from '@hfos/core';
import { HOME_TYPES, type HomeType } from '@hfos/core/addons/realestate/homes';
import { Image as ImageIcon } from 'lucide-react';
import { Fragment, useEffect, useState } from 'react';
import type { FileItem } from '@/lib/api/types';
import { supabaseBrowser } from '@/lib/supabase/client';
import { cn } from '@/lib/utils';
import type { ListingView, Prices } from './types';

const thisYear = () => new Date().getFullYear();
const n = (x: number) => x.toLocaleString('en-US');

/** "4 beds · 3 baths · 2,340 sq ft · built 2004 · HOA $45 a month": what's confirmed, in the board's words. */
export function listingFactsLine(facts: ListingView['facts']): string {
  return [
    facts.property_type ? HOME_TYPES[facts.property_type as HomeType] : null,
    facts.beds !== undefined ? `${facts.beds} ${facts.beds === 1 ? 'bed' : 'beds'}` : null,
    facts.baths !== undefined ? `${facts.baths} ${facts.baths === 1 ? 'bath' : 'baths'}` : null,
    facts.sqft !== undefined ? `${n(facts.sqft)} sq ft` : null,
    facts.year_built !== undefined ? `built ${facts.year_built}` : null,
    facts.lot_sqft !== undefined ? `${n(facts.lot_sqft)} sq ft lot` : null,
    facts.garage_spaces ? `${facts.garage_spaces}-car garage` : null,
    facts.hoa_monthly_cents ? `HOA ${money(facts.hoa_monthly_cents)} a month` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** The newest change to the price that's in use: "was $549,000 · lowered Oct 30, signed off by Maria". */
export function priceWas(prices: Prices, timeZone: string): string | null {
  const last = prices.history.find((p) => p.state === 'applied');
  if (!last || !last.appliedAt) return null;
  const how = last.toCents < last.fromCents ? 'lowered' : 'raised';
  const day = fmtMonthDay(dateOf(last.appliedAt, timeZone), thisYear());
  const by =
    last.how === 'portal' && last.signedBy
      ? `signed off by ${last.signedBy}`
      : last.how === 'let_through'
        ? 'without the portal sign-off'
        : null;
  return [`was ${money(last.fromCents)}`, `${how} ${day}${by ? `, ${by}` : ''}`].join(' · ');
}

/** A listing photo from the deal's files, signed from the person's own session (row security decides). */
export function SignedPhoto({
  file,
  alt,
  className,
  label,
}: {
  file: FileItem | undefined;
  alt: string;
  className?: string;
  /** What the empty frame says: "Front", "No photos yet". */
  label?: string;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const bucket = file?.bucket;
  const objectPath = file?.objectPath;
  useEffect(() => {
    if (!bucket || !objectPath) return;
    let cancelled = false;
    void supabaseBrowser()
      .storage.from(bucket)
      .createSignedUrl(objectPath, 600)
      .then(({ data }) => {
        if (!cancelled && data) setUrl(data.signedUrl);
      });
    return () => {
      cancelled = true;
    };
  }, [bucket, objectPath]);
  if (file && url)
    return <img src={url} alt={alt} className={cn('w-full object-cover', className)} />;
  return (
    <div
      className={cn(
        'flex w-full items-center justify-center gap-1.5 bg-gradient-to-br from-card-3 to-card-2 text-text-3',
        className,
      )}
    >
      <ImageIcon className="h-5 w-5" strokeWidth={1.5} />
      {label ? <span className="text-xs font-semibold">{label}</span> : null}
    </div>
  );
}

/** The words, with each flagged phrase marked (a description, a social post). */
export function Marked({ words, phrases }: { words: string; phrases: readonly string[] }) {
  const found = phrases.filter((p) => p && words.toLowerCase().includes(p.toLowerCase()));
  if (!found.length) return <>{words}</>;
  const pattern = new RegExp(
    `(${found.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`,
    'gi',
  );
  return (
    <>
      {words.split(pattern).map((part, i) =>
        found.some((p) => p.toLowerCase() === part.toLowerCase()) ? (
          <mark key={i} className="rounded-[3px] bg-warning-soft px-0.5 text-text">
            {part}
          </mark>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        ),
      )}
    </>
  );
}
