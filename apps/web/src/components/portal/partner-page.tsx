'use client';
/**
 * A partner's own page in the business's portal (HANDSFREEOS_PARTNERS_IMPLEMENTATION_PLAN.md, stage 2c): the terms to
 * accept first, then their link to share, what they've earned, and the clients they sent by first name and last
 * initial. Everything comes from `portal.partner`; accepting is `portal.partner_accept_terms`.
 */
import {
  formatDate,
  money,
  PARTNER_PAGE_WORDS as W,
  rateWords,
  type PartnerEarnings,
} from '@hfos/core';
import { Check, Copy } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
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
  } | null;
}

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
  const totals: [string, number][] = [
    [W.earnings.earned, p.earnings.earnedCents],
    [W.earnings.waiting, p.earnings.waitingCents],
    [W.earnings.payable, p.earnings.payableCents],
  ];
  // A dispute's hold shows only while one is open.
  if (p.earnings.heldCents) totals.push([W.earnings.held, p.earnings.heldCents]);
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
