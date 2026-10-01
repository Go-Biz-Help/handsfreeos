/**
 * Pieces the buyer's pages draw the same way (round two): a page's crumb back to its deal, a home's facts on one
 * line, how it fits, and who on the deal said what. Words come from core, so the portal, the phone and the
 * Assistant say the same thing.
 */
import { HOME_TYPES, type HomeType } from '@hfos/core/addons/realestate/homes';
import { fmtMonthDay, money } from '@hfos/core';
import { Check, Minus, X } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { dealHref } from './bits';
import type { BuyerProfile, Home } from './types';

/** "Nguyen purchase / Homes", back to the deal. */
export function DealCrumb({
  workspaceId,
  dealId,
  dealName,
  here,
  middle,
}: {
  workspaceId: string;
  dealId: string;
  dealName: string;
  here: string;
  /** A page between the deal and this one: "Offers". */
  middle?: { readonly label: string; readonly path: string };
}) {
  return (
    <div className="mb-3.5 flex min-w-0 items-center gap-1.5 text-[13px]">
      <Link
        href={dealHref(workspaceId, dealId)}
        className="truncate text-accent-text hover:underline"
      >
        {dealName}
      </Link>
      <span className="text-text-3">/</span>
      {middle ? (
        <>
          <Link
            href={dealHref(workspaceId, dealId, middle.path)}
            className="text-accent-text hover:underline"
          >
            {middle.label}
          </Link>
          <span className="text-text-3">/</span>
        </>
      ) : null}
      <span className="truncate text-text-2">{here}</span>
    </div>
  );
}

const n = (x: number) => x.toLocaleString('en-US');

/** "$409,000 · 3 bd · 2 ba · 1,780 sq ft": what's known, in that order. */
export function homeFactsLine(facts: Home['facts']): string {
  return [
    facts.price_cents !== undefined ? money(facts.price_cents) : null,
    facts.beds !== undefined ? `${facts.beds} bd` : null,
    facts.baths !== undefined ? `${facts.baths} ba` : null,
    facts.sqft !== undefined ? `${n(facts.sqft)} sq ft` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** The street part of an address: "418 Maple Ave". */
export const street = (address: string) => address.split(',')[0]!.trim() || address;

/** First names joined: "Linh", "Linh and Tuan", "Linh, Tuan and Mai". */
export function firstNames(names: readonly string[]): string {
  const first = names.map((x) => x.split(' ')[0]!);
  if (first.length <= 1) return first[0] ?? '';
  return `${first.slice(0, -1).join(', ')} and ${first.at(-1)}`;
}

/** How a home fits what the buyer wants, a line each: met, missed, or not known yet. */
export function FitList({ fit, className }: { fit: Home['fit']; className?: string }) {
  if (!fit.lines.length)
    return <span className="text-[12.5px] text-text-3">Nothing to check yet</span>;
  return (
    <ul className={cn('space-y-0.5 text-[12.5px]', className)}>
      {fit.lines.map((l) => (
        <li
          key={l.key}
          className={cn(
            'flex items-center gap-1',
            l.met === true && 'text-success-text',
            l.met === false && 'text-danger-text',
            l.met === null && 'text-text-3',
          )}
        >
          {l.met === true ? (
            <Check className="h-3.5 w-3.5 flex-none" strokeWidth={2} />
          ) : l.met === false ? (
            <X className="h-3.5 w-3.5 flex-none" strokeWidth={2} />
          ) : (
            <Minus className="h-3.5 w-3.5 flex-none" strokeWidth={2} />
          )}
          {l.words}
        </li>
      ))}
    </ul>
  );
}

/** What the buyer wants, as label and value lines; only what's filled in. */
export function profileLines(
  p: BuyerProfile | null,
  extraMustHaves: readonly string[] = [],
): { label: string; value: ReactNode }[] {
  const lines: { label: string; value: ReactNode }[] = [];
  if (!p) {
    if (extraMustHaves.length)
      lines.push({ label: 'Must have', value: extraMustHaves.join(' · ') });
    return lines;
  }
  if (p.budgetMinCents !== null || p.budgetMaxCents !== null)
    lines.push({
      label: 'Budget',
      value:
        p.budgetMinCents !== null && p.budgetMaxCents !== null
          ? `${money(p.budgetMinCents)}–${money(p.budgetMaxCents)}`
          : p.budgetMaxCents !== null
            ? `Up to ${money(p.budgetMaxCents)}`
            : `From ${money(p.budgetMinCents!)}`,
    });
  const atLeast = [
    p.bedsMin !== null ? `${p.bedsMin} beds` : null,
    p.bathsMin !== null ? `${p.bathsMin} baths` : null,
    p.sqftMin !== null ? `${n(p.sqftMin)} sq ft` : null,
  ].filter(Boolean);
  if (atLeast.length) lines.push({ label: 'At least', value: atLeast.join(' · ') });
  if (p.homeTypes.length)
    lines.push({
      label: 'Type',
      value: p.homeTypes.map((t) => HOME_TYPES[t as HomeType] ?? t).join(', '),
    });
  if (p.areas.length) lines.push({ label: 'Areas', value: p.areas.join(', ') });
  const must = [...p.mustHaves, ...extraMustHaves.filter((m) => !p.mustHaves.includes(m))];
  if (must.length) lines.push({ label: 'Must have', value: must.join(' · ') });
  if (p.dealBreakers.length)
    lines.push({ label: 'Deal-breakers', value: p.dealBreakers.join(' · ') });
  if (p.moveBy)
    lines.push({ label: 'Move by', value: fmtMonthDay(p.moveBy, new Date().getFullYear()) });
  return lines;
}
