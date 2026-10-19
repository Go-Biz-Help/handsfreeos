'use client';
/**
 * Paying your partners, under Settings → Partners (HANDSFREEOS_PARTNERS_IMPLEMENTATION_PLAN.md, stage 3): the card
 * partner payouts are charged to, the next payout as it stands (who it would pay, who waits and why, and what it
 * would charge with Stripe's fees), and each month's payout with its statement. Everything comes from
 * `partner.payouts`; a month's statement is `partner.payout_get`, read when it's opened.
 *
 * The card goes on through Stripe's own page, which the worker opens and reads back (`/v1/partners/payout-card`), as
 * the usage balance's card does; taking it off is `partner.payout_forget_card`. Both are for whoever manages money.
 * Until HandsFreeOS opens payouts for the business, the section only says so.
 */
import {
  formatDate,
  formatDateOnly,
  money,
  payoutLineWords,
  PAYOUT_WORDS as P,
  taxFormYears,
  type PayoutStatus,
} from '@hfos/core';
import { Banknote, ChevronDown, ChevronRight } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Section } from '@/components/partners/settings-page';
import { SetRow } from '@/components/settings/set-row';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { PartnerPayoutGetOut, PartnerPayoutRow, PartnerPayoutsOut } from '@/lib/api/types';
import { partnerPayoutCard } from '@/lib/api/worker';
import { cn } from '@/lib/utils';

const STATUS_TONE: Record<PayoutStatus, BadgeVariant> = {
  charging: 'pending',
  paying: 'accent',
  paid: 'ok',
  failed: 'danger',
};

type Totals = PartnerPayoutsOut['next']['totals'];

/**
 * What the partners are owed, then each of Stripe's fees on its own line, then what the card is charged. The 1099s'
 * fee shows only on a payout that carries it.
 */
function TotalsTable({ totals, testId }: { totals: Totals; testId?: string }) {
  const rows: [string, number][] = [
    [P.totals.owed, totals.owedCents],
    [P.totals.accountFees, totals.accountFeesCents],
    [P.totals.payoutFees, totals.payoutFeesCents],
    ...(totals.taxFormsCents
      ? [[P.totals.taxForms, totals.taxFormsCents] as [string, number]]
      : []),
    [P.totals.cardFee, totals.cardFeeCents],
  ];
  return (
    <dl className="mt-3 flex flex-col gap-1.5 text-[13px]" data-testid={testId}>
      {rows.map(([label, cents]) => (
        <div key={label} className="flex items-baseline justify-between gap-3">
          <dt className="text-text-2">{label}</dt>
          <dd className="tabular-nums">{money(cents)}</dd>
        </div>
      ))}
      <div className="flex items-baseline justify-between gap-3 border-t border-border pt-1.5 font-semibold">
        <dt>{P.totals.charge}</dt>
        <dd className="tabular-nums">{money(totals.chargeCents)}</dd>
      </div>
    </dl>
  );
}

export function PayoutsSection({
  workspaceId,
  payouts,
  canManageMoney,
}: {
  workspaceId: string;
  payouts: PartnerPayoutsOut;
  /** `money.manage`: only they put a card on or take it off. */
  canManageMoney: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<'card' | 'remove' | null>(null);
  const [removing, setRemoving] = useState(false);

  async function act(which: 'card' | 'remove', run: () => Promise<void>) {
    setBusy(which);
    try {
      await run();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  /** Phase one: Stripe's own page, whose address the worker builds and sends them back from. */
  const addCard = () =>
    act('card', async () => {
      const started = await partnerPayoutCard({ workspaceId });
      if (started.stage === 'started') window.location.assign(started.hostedUrl);
    });

  const removeCard = () =>
    act('remove', async () => {
      unwrap(
        await apiBrowser().POST('/v1/commands/partner.payout_forget_card', {
          body: { workspaceId },
        }),
      );
      setRemoving(false);
      toast.success(P.card.removed);
      router.refresh();
    });

  /**
   * Phase two: back from Stripe's page. The session on the address is only a name for what happened (the worker
   * reads the card off Stripe itself), and it comes off the address either way, so a refresh saves nothing twice.
   */
  const returned = useRef(false);
  useEffect(() => {
    const mark = new URLSearchParams(window.location.search).get('card');
    if (!mark || returned.current) return;
    returned.current = true;
    window.history.replaceState(null, '', window.location.pathname);
    if (mark === 'cancelled') {
      toast.info(P.card.cancelled);
      return;
    }
    void (async () => {
      setBusy('card');
      try {
        const answer = await partnerPayoutCard({ workspaceId, sessionRef: mark });
        if (answer.stage === 'saved' && answer.card) toast.success(P.card.saved(answer.card.last4));
        else toast.info(P.card.cancelled);
        router.refresh();
      } catch (e) {
        toast.error(errorMessage(e));
      } finally {
        setBusy(null);
      }
    })();
  }, [router, workspaceId]);

  if (!payouts.open)
    return (
      <Section title={P.title} description={P.notOpen} icon={Banknote} testId="partner-payouts" />
    );

  const card = payouts.card;
  return (
    <Section title={P.title} description={P.about} icon={Banknote} testId="partner-payouts">
      <div className="mt-3">
        <SetRow
          first
          center
          title={P.card.title}
          description={
            card ? (
              <span data-testid="partner-payouts-card">
                {P.card.ends(card.brand, card.last4)}
                {card.expiryMonth && card.expiryYear
                  ? ` · ${P.card.expires(card.expiryMonth, card.expiryYear)}`
                  : ''}
              </span>
            ) : (
              <span className="text-warning-text" data-testid="partner-payouts-card">
                {P.card.none}
              </span>
            )
          }
        >
          {canManageMoney ? (
            <div className="flex flex-none gap-2">
              <Button
                variant={card ? 'secondary' : 'primary'}
                size="sm"
                loading={busy === 'card'}
                onClick={() => void addCard()}
                data-testid="partner-payouts-add-card"
              >
                {card ? P.card.change : P.card.add}
              </Button>
              {card ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setRemoving(true)}
                  data-testid="partner-payouts-remove-card"
                >
                  {P.card.remove}
                </Button>
              ) : null}
            </div>
          ) : null}
        </SetRow>
        {canManageMoney ? null : <p className="text-[12.5px] text-text-3">{P.card.needsMoney}</p>}
      </div>

      <NextPayout next={payouts.next} />
      <History workspaceId={workspaceId} payouts={payouts.payouts} />

      <Dialog open={removing} onOpenChange={(o) => !o && setRemoving(false)}>
        <DialogContent title={P.card.removeTitle} description={P.card.removeBody}>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setRemoving(false)}>
              {P.card.removeKeep}
            </Button>
            <Button
              variant="danger"
              loading={busy === 'remove'}
              onClick={() => void removeCard()}
              data-testid="partner-payouts-remove-confirm"
            >
              {P.card.remove}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </Section>
  );
}

function NextPayout({ next }: { next: PartnerPayoutsOut['next'] }) {
  return (
    <div className="mt-4 border-t border-border pt-4" data-testid="partner-payouts-next">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-[14px] font-semibold">{P.next.title}</h3>
        <span className="text-[13px] text-text-2">
          {next.soon ? P.next.soon : P.next.on(formatDateOnly(next.month))}
        </span>
      </div>
      {next.lines.length ? (
        <>
          <ul className="mt-2 divide-y divide-border">
            {next.lines.map((l) => (
              <li
                key={l.partnerId}
                className="flex items-baseline justify-between gap-3 py-1.5 text-[13.5px]"
                data-testid="partner-payouts-next-line"
              >
                <span className="min-w-0 truncate">{l.name}</span>
                <span className="tabular-nums">{money(l.amountCents)}</span>
              </li>
            ))}
          </ul>
          <TotalsTable totals={next.totals} testId="partner-payouts-next-totals" />
          {next.taxForms.length ? (
            <p
              className="mt-2 text-[12.5px] text-text-2"
              data-testid="partner-payouts-next-tax-forms"
            >
              {P.taxForms.next(next.taxForms.length, taxFormYears(next.taxForms))}
            </p>
          ) : null}
        </>
      ) : (
        <p className="mt-2 text-[13px] text-text-2">{P.next.none}</p>
      )}
      {next.waiting.length ? (
        <ul className="mt-3 flex flex-col gap-1.5" data-testid="partner-payouts-waiting">
          {next.waiting.map((w) => (
            <li key={w.partnerId} className="text-[12.5px] text-text-2">
              <span className="font-medium text-text">{w.name}</span>:{' '}
              {w.why === 'below_smallest'
                ? P.next.belowSmallest(money(w.owedCents))
                : `${money(w.owedCents)}. ${P.next.noBank}`}
            </li>
          ))}
        </ul>
      ) : null}
      <p className="mt-3 text-[12px] text-text-3">{P.next.about}</p>
    </div>
  );
}

function History({
  workspaceId,
  payouts,
}: {
  workspaceId: string;
  payouts: readonly PartnerPayoutRow[];
}) {
  return (
    <div className="mt-4 border-t border-border pt-4" data-testid="partner-payouts-history">
      <h3 className="text-[14px] font-semibold">{P.history.title}</h3>
      {payouts.length ? (
        <ul className="mt-2 divide-y divide-border">
          {payouts.map((p) => (
            <PayoutRow key={p.payoutId} workspaceId={workspaceId} payout={p} />
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-[13px] text-text-2">{P.history.empty}</p>
      )}
    </div>
  );
}

/** What a month's status says beyond its badge: when the card is tried again, or why it wasn't charged. */
function statusLine(p: PartnerPayoutRow): string | null {
  if (p.status === 'charging' && p.nextTryAt && p.failureMessage)
    return P.statusLine.retry(formatDate(p.nextTryAt), p.failureMessage);
  if (p.status === 'failed') return P.statusLine.failed(p.failureMessage ?? P.declined);
  if (p.status === 'paying') return P.statusLine.paying;
  return null;
}

function PayoutRow({ workspaceId, payout: p }: { workspaceId: string; payout: PartnerPayoutRow }) {
  const [open, setOpen] = useState(false);
  const [statement, setStatement] = useState<PartnerPayoutGetOut | null>(null);
  const line = statusLine(p);

  async function toggle() {
    setOpen((o) => !o);
    if (statement) return;
    try {
      setStatement(
        unwrap(
          await apiBrowser().POST('/v1/queries/partner.payout_get', {
            body: { workspaceId, payoutId: p.payoutId },
          }),
        ),
      );
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  return (
    <li className="py-2.5" data-testid="partner-payout">
      <button
        type="button"
        onClick={() => void toggle()}
        className="flex w-full items-center gap-2 text-left"
        aria-expanded={open}
      >
        {open ? (
          <ChevronDown className="h-4 w-4 flex-none text-text-3" strokeWidth={1.75} />
        ) : (
          <ChevronRight className="h-4 w-4 flex-none text-text-3" strokeWidth={1.75} />
        )}
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-[14px] font-medium">{P.history.month(p.month)}</span>
            <Badge variant={STATUS_TONE[p.status]}>{P.status[p.status]}</Badge>
            {p.livemode ? null : <Badge variant="gray">{P.history.test}</Badge>}
          </span>
          <span className="block text-[12.5px] text-text-2">
            {P.history.pays(p.partners)}
            {p.card ? ` · ${P.card.ends(p.card.brand, p.card.last4)}` : ''}
          </span>
        </span>
        <span className="text-[14px] font-semibold tabular-nums">
          {money(p.totals.chargeCents)}
        </span>
      </button>
      {line ? (
        <p
          className={cn(
            'mt-1 pl-6 text-[12.5px]',
            p.status === 'paying' ? 'text-text-2' : 'text-warning-text',
          )}
        >
          {line}
        </p>
      ) : null}
      {open ? (
        <div className="mt-2 pl-6" data-testid="partner-payout-statement">
          {statement ? (
            <>
              <ul className="divide-y divide-border">
                {statement.lines.map((l) => (
                  <li key={l.lineId} className="flex items-start justify-between gap-3 py-1.5">
                    <div className="min-w-0">
                      <p className="truncate text-[13.5px]">{l.name}</p>
                      <p
                        className={cn(
                          'text-[12px]',
                          l.status === 'held' ? 'text-warning-text' : 'text-text-3',
                        )}
                      >
                        {payoutLineWords(l, formatDate)}
                      </p>
                    </div>
                    <span className="text-[13.5px] tabular-nums">{money(l.amountCents)}</span>
                  </li>
                ))}
              </ul>
              {statement.taxForms.length ? (
                <div className="mt-3" data-testid="partner-payout-tax-forms">
                  <p className="text-[13px] font-medium">
                    {P.taxForms.title(taxFormYears(statement.taxForms))}
                  </p>
                  <p className="text-[12px] text-text-3">{P.taxForms.about}</p>
                  <ul className="mt-1 divide-y divide-border">
                    {statement.taxForms.map((f, i) => (
                      <li
                        key={`${f.taxYear}-${i}`}
                        className="flex items-start justify-between gap-3 py-1.5"
                      >
                        <div className="min-w-0">
                          <p className="truncate text-[13.5px]">{f.name}</p>
                          <p className="text-[12px] text-text-3">
                            {P.taxForms.paid(money(f.paidCents), f.taxYear)}
                          </p>
                        </div>
                        <span className="text-[13.5px] tabular-nums">{money(f.feeCents)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              <TotalsTable totals={p.totals} />
            </>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
