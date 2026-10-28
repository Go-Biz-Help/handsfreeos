'use client';
/**
 * A partner's own page in the business's portal (HANDSFREEOS_PARTNERS_IMPLEMENTATION_PLAN.md, stages 2c and 3): the
 * terms to accept first, then their link to share, what they've earned, getting paid through Stripe, and the clients
 * they sent by first name and last initial. Everything comes from `portal.partner`; accepting is
 * `portal.partner_accept_terms`, and setting up their bank goes through the worker (`usePortal().partnerPayouts`).
 */
import {
  earningsTotals,
  formatDate,
  money,
  PARTNER_PAGE_WORDS as W,
  PAYOUT_COUNTRIES,
  PAYOUT_WORDS,
  payoutMonthWords,
  rateWords,
  type PartnerEarnings,
} from '@hfos/core';
import { Check, Copy } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { errorMessage } from '@/lib/api/errors';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { usePortal, usePortalAct, usePortalQuery } from './context';
import { PortalCardHead } from './ui';

interface PortalPartnerClient {
  readonly referralId: string;
  readonly name: string | null;
  readonly how: 'link' | 'by_hand';
  readonly referredAt: string;
  readonly firstPaidAt: string | null;
  readonly monthsEndAt: string | null;
  readonly earnedCents: number;
}
interface PortalPartner {
  readonly partner: {
    readonly status: 'active' | 'paused' | 'ended';
    readonly rateBp: number;
    readonly since: string;
    readonly linkPath: string | null;
    readonly terms: {
      readonly text: string;
      readonly version: number;
      readonly accepted: boolean;
      readonly acceptedAt: string | null;
    };
    readonly earnings: PartnerEarnings;
    readonly clients: readonly PortalPartnerClient[];
    readonly payouts: {
      readonly open: boolean;
      readonly smallestPayoutCents: number;
      readonly account: {
        readonly ready: boolean;
        readonly detailsSubmitted: boolean;
        readonly needsMore: boolean;
        readonly country: string;
      } | null;
      readonly lines: readonly {
        readonly lineId: string;
        readonly month: string;
        readonly amountCents: number;
        readonly status: 'pending' | 'paid' | 'held';
        readonly paidAt: string | null;
        readonly livemode: boolean;
      }[];
    };
  } | null;
}

const G = PAYOUT_WORDS.portal;

/** A date on their own clock, with its year when it isn't this one: a client's 12 months end next year. */
const day = (at: string) => formatDate(at);

export function PortalPartnerPage() {
  const { home, op } = usePortal();
  const { data, error, reload } = usePortalQuery<PortalPartner>('portal.partner');
  const { busy, act } = usePortalAct(reload);
  const [copied, setCopied] = useState(false);
  const business = home.business.name;
  if (error) return <p className="text-[14px] text-text-2">{error}</p>;
  if (!data) return null;
  const p = data.partner;
  if (!p)
    return (
      <p className="text-[14px] text-text-2" data-testid="portal-partner-none">
        This page isn’t in your portal any more. Ask {business} about it.
      </p>
    );
  const link = p.linkPath ? `${window.location.origin}${p.linkPath}` : null;
  const needsTerms = p.terms.version > 0 && !p.terms.accepted;
  const copy = async () => {
    if (!link) return;
    await navigator.clipboard.writeText(link);
    setCopied(true);
    toast.success(W.link.copied);
    setTimeout(() => setCopied(false), 2_000);
  };
  // A dispute's hold, what's on its way and what's been paid show only while there's some.
  const totals = earningsTotals(p.earnings, W.earnings);
  return (
    <div className="space-y-4" data-testid="portal-partner">
      <div className="space-y-1">
        <h1 className="text-[24px] font-semibold">{W.title}</h1>
        <p className="text-[14px] text-text-2">{W.share(rateWords(p.rateBp))}</p>
        {p.status !== 'active' ? (
          <p className="text-[14px] text-text-2" data-testid="portal-partner-status">
            {W.status[p.status](business)}
          </p>
        ) : null}
      </div>

      {p.terms.version > 0 ? (
        <Card className="p-4" data-testid="portal-partner-terms">
          <PortalCardHead>{W.terms.title}</PortalCardHead>
          {needsTerms ? (
            <p className="mb-2 text-[14px] font-semibold">
              {p.terms.acceptedAt ? W.terms.changed(business) : W.terms.first}
            </p>
          ) : null}
          <p className="max-h-72 overflow-y-auto whitespace-pre-wrap text-[14px]">{p.terms.text}</p>
          {needsTerms ? (
            <Button
              className="mt-3 w-full"
              disabled={busy === 'terms'}
              onClick={() =>
                act(
                  'terms',
                  () => op('portal.partner_accept_terms', { termsVersion: p.terms.version }),
                  W.terms.done,
                )
              }
            >
              {W.terms.accept}
            </Button>
          ) : p.terms.acceptedAt ? (
            <p className="mt-2 text-[13px] text-text-2">
              {W.terms.accepted(day(p.terms.acceptedAt))}
            </p>
          ) : null}
        </Card>
      ) : null}

      {!needsTerms && p.status !== 'ended' ? (
        <Card className="p-4" data-testid="portal-partner-link">
          <PortalCardHead>{W.link.title}</PortalCardHead>
          {link ? (
            <>
              <p className="mb-2 text-[14px] text-text-2">{W.link.about}</p>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded-md bg-card-2 px-2 py-1.5 text-[13px]">
                  {link}
                </code>
                <Button size="sm" variant="secondary" onClick={copy} aria-label={W.link.copy}>
                  {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                </Button>
              </div>
            </>
          ) : (
            <p className="text-[14px] text-text-2">{W.link.none(business)}</p>
          )}
        </Card>
      ) : null}

      <Card className="p-4" data-testid="portal-partner-earnings">
        <PortalCardHead>{W.earnings.title}</PortalCardHead>
        <dl className="grid grid-cols-2 gap-3">
          {totals.map(([label, cents]) => (
            <div key={label}>
              <dt className="text-[12px] text-text-2">{label}</dt>
              <dd className="text-[18px] font-semibold tabular-nums">{money(cents)}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-3 text-[13px] text-text-2">{W.earnings.about}</p>
      </Card>

      {p.payouts.open || p.payouts.lines.length ? (
        <GettingPaid business={business} payouts={p.payouts} onChecked={reload} />
      ) : null}

      <Card className="p-4" data-testid="portal-partner-clients">
        <PortalCardHead>{W.clients.title}</PortalCardHead>
        {p.clients.length ? (
          <ul className="divide-y divide-border">
            {p.clients.map((c) => (
              <li key={c.referralId} className="flex items-start justify-between gap-3 py-2">
                <div className="min-w-0">
                  <p className="truncate text-[14px] font-medium">{c.name ?? W.clients.deleted}</p>
                  <p className="text-[12px] text-text-2">
                    {c.how === 'link' ? W.clients.viaLink : W.clients.byHand} · {day(c.referredAt)}
                  </p>
                  <p className="text-[12px] text-text-2">
                    {c.monthsEndAt ? W.clients.until(day(c.monthsEndAt)) : W.clients.notYet}
                  </p>
                </div>
                <span className="shrink-0 text-[14px] font-semibold tabular-nums">
                  {money(c.earnedCents)}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[14px] text-text-2">{W.clients.empty}</p>
        )}
      </Card>
    </div>
  );
}

/**
 * Getting paid (stage 3): setting up their bank on Stripe's own form, Stripe's page once they have, and what they've
 * been paid. On the way back from Stripe the account is read from Stripe at once (`?payouts=back`); a link that ran
 * out asks for a fresh one (`?payouts=again`). Either mark comes off the address, so a refresh asks nothing twice.
 */
function GettingPaid({
  business,
  payouts,
  onChecked,
}: {
  business: string;
  payouts: NonNullable<PortalPartner['partner']>['payouts'];
  onChecked: () => void;
}) {
  const { partnerPayouts } = usePortal();
  const [busy, setBusy] = useState<'start' | 'stripe' | null>(null);
  // Where their bank is: asked until Stripe's form is done, since an account can't move country after (decision 118).
  const [country, setCountry] = useState(payouts.account?.country ?? 'US');
  const go = async (action: 'start' | 'stripe', where?: string) => {
    setBusy(action);
    try {
      const out = await partnerPayouts(action, where);
      if (out.url) window.location.assign(out.url);
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
    void partnerPayouts('check').then(
      (out) => {
        if (!out.ready) toast.info(G.back);
        onChecked();
      },
      (e: unknown) => toast.error(errorMessage(e)),
    );
    // Once, on the way back.
  }, []);
  const a = payouts.account;
  return (
    <Card className="p-4" data-testid="portal-partner-payouts">
      <PortalCardHead>{G.title}</PortalCardHead>
      {payouts.open ? (
        <>
          <p className="text-[14px] text-text-2">{G.about(business)}</p>
          {a?.ready ? (
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
              <p className="text-[14px] font-medium text-success-text">{G.ready}</p>
              <Button
                size="sm"
                variant="secondary"
                disabled={busy !== null}
                onClick={() => void go('stripe')}
                data-testid="portal-partner-stripe"
              >
                {G.openStripe}
              </Button>
            </div>
          ) : (
            <div className="mt-3 space-y-2">
              {a?.detailsSubmitted ? null : (
                <div className="space-y-1">
                  <label htmlFor="portal-partner-country" className="text-[13px] font-medium">
                    {G.country}
                  </label>
                  <select
                    id="portal-partner-country"
                    value={country}
                    onChange={(e) => setCountry(e.target.value)}
                    disabled={busy !== null}
                    data-testid="portal-partner-country"
                    className="h-10 w-full rounded-control border border-border bg-card px-2 text-[14px]"
                  >
                    {Object.entries(PAYOUT_COUNTRIES).map(([code, name]) => (
                      <option key={code} value={code}>
                        {name}
                      </option>
                    ))}
                  </select>
                  <p className="text-[12px] text-text-2">
                    {G.countryHint(business)}
                    {country === 'US' ? null : ` ${G.abroad}`}
                  </p>
                </div>
              )}
              <p className="text-[13px] text-text-2">{a ? G.finishHint : G.setUpHint(country)}</p>
              <Button
                className="w-full"
                disabled={busy !== null}
                onClick={() => void go('start', a?.detailsSubmitted ? undefined : country)}
                data-testid="portal-partner-set-up"
              >
                {a ? G.finish : G.setUp}
              </Button>
            </div>
          )}
          <p className="mt-3 text-[13px] text-text-2">
            {G.smallest(money(payouts.smallestPayoutCents))}
          </p>
        </>
      ) : null}
      {payouts.lines.length ? (
        <>
          <p className="mt-4 text-[13px] font-semibold">{G.history}</p>
          <ul className="divide-y divide-border" data-testid="portal-partner-payout-lines">
            {payouts.lines.map((l) => (
              <li key={l.lineId} className="flex items-start justify-between gap-3 py-2">
                <div className="min-w-0">
                  <p className="text-[14px] font-medium">
                    {payoutMonthWords(l.month)}
                    {l.livemode ? null : (
                      <span className="font-normal text-text-3"> · {G.test}</span>
                    )}
                  </p>
                  <p className="text-[12px] text-text-2">
                    {l.status === 'paid' && l.paidAt
                      ? G.lineStatus.paid(day(l.paidAt))
                      : l.status === 'held'
                        ? G.lineStatus.held
                        : G.lineStatus.pending}
                  </p>
                </div>
                <span className="shrink-0 text-[14px] font-semibold tabular-nums">
                  {money(l.amountCents)}
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </Card>
  );
}
