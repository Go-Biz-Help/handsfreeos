'use client';
import { Plus } from 'lucide-react';
import { ButtonLink } from '@/components/ui/button';
import { Segmented } from '@/components/ui/segmented';
import type { AttentionScope } from '@/lib/api/types';
import { formatMoney } from '@/lib/format';
import { useMatches } from '@/lib/use-media';

/**
 * The top of Home: "$X affected", "9 need attention · 2 urgent · 3 handled today", and Mine / Everyone. On a phone
 * it's a band across the top, with the switch full width under the numbers.
 */
export function AttentionHeader({
  greeting,
  dateLabel,
  affectedCents,
  total,
  urgent,
  handledToday,
  scope,
  onScope,
  newLeadHref,
}: {
  /** "Good morning, Dale". */
  greeting: string;
  /** "Tue, Sep 22". */
  dateLabel: string;
  affectedCents: number;
  total: number;
  urgent: number;
  handledToday: number;
  scope: AttentionScope;
  onScope: (scope: AttentionScope) => void;
  newLeadHref: string;
}) {
  const phone = useMatches('(max-width: 767px)');
  const nothing = total === 0;
  // With no real dollars behind the items (typical values are left out), the count is the headline instead.
  const countFirst = !nothing && affectedCents === 0;
  const need = total === 1 ? 'needs attention' : 'need attention';
  return (
    <header
      data-testid="attention-header"
      className="-mx-4 -mt-4 mb-3.5 flex flex-col gap-0.5 border-b border-border bg-card px-4 pb-3 pt-3.5 md:mx-0 md:mt-0 md:mb-[18px] md:flex-row md:items-end md:justify-between md:gap-4 md:border-0 md:bg-transparent md:p-0"
    >
      <div className="min-w-0">
        <p className="mb-0.5 text-[13px] text-text-3">
          {greeting} · {dateLabel}
        </p>
        <h1
          data-testid="attention-affected"
          title={
            nothing || countFirst
              ? undefined
              : 'Lead values, each counted once. Estimates aren’t counted.'
          }
          className="text-[26px] font-semibold leading-[1.2] tracking-[-0.015em] tabular-nums"
        >
          {nothing ? (
            'Nothing needs you right now'
          ) : countFirst ? (
            <>
              {total}{' '}
              <span className="text-xl font-medium tracking-[-0.005em] text-text-2">{need}</span>
            </>
          ) : (
            <>
              {formatMoney(affectedCents)}{' '}
              <span className="text-xl font-medium tracking-[-0.005em] text-text-2">affected</span>
            </>
          )}
        </h1>
        <p data-testid="attention-counts" className="mt-0.5 text-[13.5px] text-text-2 md:text-sm">
          {countFirst ? null : (
            <>
              <b className="font-semibold text-text">{total}</b> {need} ·{' '}
            </>
          )}
          {urgent ? (
            <>
              <span className="font-semibold text-danger-text">{urgent} urgent</span> ·{' '}
            </>
          ) : null}
          {handledToday} handled today
        </p>
      </div>
      <div className="mt-2.5 flex items-center gap-2.5 md:mt-0">
        <Segmented
          value={scope}
          onChange={onScope}
          fill={phone}
          size={phone ? 'lg' : 'md'}
          className={phone ? 'w-full' : undefined}
          ariaLabel="Whose items"
          options={[
            { value: 'mine', label: 'Mine', testId: 'scope-mine' },
            { value: 'everyone', label: 'Everyone', testId: 'scope-everyone' },
          ]}
        />
        <ButtonLink
          href={newLeadHref}
          variant="secondary"
          size="sm"
          className="hidden md:inline-flex"
        >
          <Plus className="h-4 w-4" strokeWidth={1.75} />
          New lead
        </ButtonLink>
      </div>
    </header>
  );
}
