'use client';

/**
 * Getting paid (20261027014400): an affiliate setting up their bank on Stripe's own form, their Stripe page once
 * they have, and their payouts, the same list staff read under Admin → Affiliates. On the way back from Stripe the
 * account is read from Stripe at once (`?payouts=back`); a link that ran out asks for a fresh one (`?payouts=again`).
 * Either mark comes off the address, so a refresh asks nothing twice.
 */
import { AFFILIATE_PAYOUT_WORDS as W, money, payoutMonthWords } from '@hfos/core';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { errorMessage } from '@/lib/api/client';
import type { Ok } from '@/lib/api/types';
import { affiliatePayouts } from '@/lib/api/worker';

type Affiliate = NonNullable<Ok<'/v1/queries/affiliate.mine'>['affiliate']>;
type Payout = Affiliate['payouts'][number];

const day = (iso: string): string =>
  new Date(iso).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

export function AffiliateGettingPaid({
  affiliate: a,
  payoutsOn,
}: {
  affiliate: Affiliate;
  /** Staff have payouts on. Until then, they can set up their bank and what they're owed keeps. */
  payoutsOn: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<'start' | 'stripe' | 'check' | null>(null);
  const go = async (action: 'start' | 'stripe') => {
    setBusy(action);
    try {
      window.location.assign((await affiliatePayouts(action)).url);
    } catch (e) {
      toast.error(errorMessage(e));
      setBusy(null);
    }
  };
  const returned = useRef(false);
  useEffect(() => {
    const mark = new URLSearchParams(window.location.search).get('payouts');
    if (!mark || returned.current) return;
    returned.current = true;
    window.history.replaceState(null, '', window.location.pathname);
    if (mark === 'again') {
      void go('start');
      return;
    }
    setBusy('check');
    affiliatePayouts('check')
      .then(
        (out) => {
          if (out.ready) toast.success(W.back);
          else toast.info(W.notYet);
          router.refresh();
        },
        (e: unknown) => toast.error(errorMessage(e)),
      )
      .finally(() => setBusy(null));
    // Once, on the way back.
  }, []);

  const state = a.bank.state;
  return (
    <div className="mt-7" data-testid="affiliate-getting-paid">
      <h2 className="text-sm font-semibold">{W.section}</h2>
      <p className="mt-1 text-[14px] text-text-2">{W.intro}</p>
      {payoutsOn ? null : (
        <p
          className="mt-3 rounded-menu bg-card-2 px-3.5 py-3 text-[13.5px] text-text-2"
          data-testid="affiliate-payouts-not-on"
        >
          {W.notOn}
        </p>
      )}
      <div className="mt-3 rounded-menu border border-border p-3.5">
        <p
          className={`text-[14px] ${
            state === 'ready'
              ? 'font-medium text-success-text'
              : state === 'stopped'
                ? 'text-warning-text'
                : 'text-text-2'
          }`}
          data-testid="affiliate-bank"
          data-state={state}
        >
          {W.bank[state]}
          {a.bank.test ? <span className="font-normal text-text-3"> · {W.test}</span> : null}
        </p>
        <Button
          className="mt-3"
          size="sm"
          variant={state === 'ready' ? 'secondary' : 'primary'}
          loading={busy !== null}
          disabled={busy !== null}
          onClick={() => void go(state === 'ready' ? 'stripe' : 'start')}
          data-testid="affiliate-bank-action"
        >
          {busy === 'check' ? W.checking : busy ? W.opening : W.action[state]}
        </Button>
        {state === 'none' ? <p className="mt-2 text-[12.5px] text-text-3">{W.usOnly}</p> : null}
      </div>
      <h3 className="mt-5 text-[13px] font-semibold">{W.payouts}</h3>
      <AffiliatePayoutList payouts={a.payouts} />
    </div>
  );
}

/** Each payout, newest first: how much, for which month, and where it stands. */
export function AffiliatePayoutList({
  payouts,
  staff = false,
}: {
  payouts: readonly Payout[];
  /** Read by staff: a held one says so, rather than telling them to open Stripe. */
  staff?: boolean;
}) {
  if (!payouts.length) return <p className="mt-1 text-[14px] text-text-2">{W.none}</p>;
  return (
    <ul className="mt-1 divide-y divide-border" data-testid="affiliate-payouts">
      {payouts.map((p) => (
        <li key={p.payoutId} className="flex items-start justify-between gap-3 py-2">
          <div className="min-w-0">
            <p className="text-[14px] font-medium">
              {payoutMonthWords(p.month)}
              {p.test ? <span className="font-normal text-text-3"> · {W.test}</span> : null}
            </p>
            <p className="text-[12.5px] text-text-2">
              {p.status === 'paid' && p.paidAt
                ? W.sentOn(day(p.paidAt))
                : p.status === 'held' && !staff
                  ? W.heldLine
                  : W.status[p.status]}
            </p>
          </div>
          <span className="shrink-0 text-[14px] font-semibold tabular-nums">
            {money(p.amountCents)}
          </span>
        </li>
      ))}
    </ul>
  );
}
