'use client';
/**
 * What the listing feed brings, wherever a home from the MLS is shown (round five; boards 64–68), the portal's too:
 * where it came from, its photo, and the MLS's notice (every listing shown carries its MLS's words, as its rules ask).
 */
import { cn, relativeTime } from '@/lib/utils';
import type { Home } from './types';

export type MlsListing = NonNullable<Home['mls']>;

/** "3 bd · 2 ba · 1,640 sq ft" */
export function roomsLine(f: {
  readonly beds?: number | null;
  readonly baths?: number | null;
  readonly sqft?: number | null;
}): string {
  return [
    f.beds != null ? `${f.beds} bd` : null,
    f.baths != null ? `${f.baths} ba` : null,
    f.sqft != null ? `${f.sqft.toLocaleString('en-US')} sq ft` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** "From the MLS (Unlock MLS, through Repliers) · 4 minutes ago" */
export const mlsFromWords = (mls: Pick<MlsListing, 'sourceWords' | 'checkedAt'>) =>
  `${mls.sourceWords} · ${relativeTime(mls.checkedAt)}`;

/** The MLS's own words, shown under anything from it: its logo, whose listing it is, and its notice. */
export function MlsNotice({
  notice,
  courtesy,
  logoUrl,
  className,
}: {
  notice: string | null;
  courtesy: string | null;
  logoUrl?: string | null;
  className?: string;
}) {
  if (!notice && !courtesy) return null;
  return (
    <div
      className={cn('flex items-start gap-2.5 text-[11.5px] leading-snug text-text-3', className)}
      data-testid="mls-notice"
    >
      {logoUrl ? (
        // The MLS's own logo, from where it serves it.
        <img src={logoUrl} alt="" className="mt-0.5 h-5 w-auto flex-none" />
      ) : null}
      <p>{[courtesy, notice].filter(Boolean).join(' ')}</p>
    </div>
  );
}

/** A photo from the MLS, as its supplier serves it; a plain frame when there's none. */
export function MlsPhoto({
  url,
  className,
  alt = '',
}: {
  url: string | null | undefined;
  className?: string;
  alt?: string;
}) {
  if (!url) return <div className={cn('bg-card-2', className)} aria-hidden />;
  return <img src={url} alt={alt} className={cn('object-cover', className)} loading="lazy" />;
}
