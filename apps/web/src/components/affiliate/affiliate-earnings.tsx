/**
 * What an affiliate has earned, waiting and ready (20261027014200): the same four figures on their own page and on
 * theirs under Admin → Affiliates.
 */
import { AFFILIATE_EARNINGS_WORDS as W, money } from '@hfos/core';
import type { Ok } from '@/lib/api/types';

type Earnings = Ok<'/v1/queries/platform.affiliate'>['earnings'];

export function AffiliateEarningsTiles({ earnings: e }: { earnings: Earnings }) {
  const tiles = [
    { label: W.earned, value: e.earnedCents },
    { label: W.waiting, value: e.waitingCents },
    { label: W.ready, value: e.readyCents },
    { label: W.paid, value: e.paidCents },
  ];
  return (
    <div>
      <dl className="grid grid-cols-2 gap-2.5 sm:grid-cols-4" data-testid="affiliate-earnings">
        {tiles.map((t) => (
          <div key={t.label} className="rounded-card border border-border bg-card px-3 py-2.5">
            <dt className="text-xs leading-tight text-text-3">{t.label}</dt>
            <dd className="mt-0.5 text-lg font-semibold tabular-nums">{money(t.value)}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-2 text-[12.5px] leading-relaxed text-text-3">{W.help}</p>
    </div>
  );
}
