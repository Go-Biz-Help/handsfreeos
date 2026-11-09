'use client';
import {
  BILLING_WORDS as W,
  FOUNDING_PLAN_WORDS as F,
  planCardExpiry,
  planCardName,
  type SettingKey,
} from '@hfos/core';
import { CreditCard } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition, type ReactNode } from 'react';
import { toast } from 'sonner';
import { goAddCard, OwedPanel, usePlanCardReturn } from '@/components/billing/billing-bits';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { Ok } from '@/lib/api/types';
import { cn } from '@/lib/utils';
import { SETTING_TARGET, SettingAnchor, settingAttrs } from './setting-anchor';

type Billing = Ok<'/v1/queries/billing.get'>;
type BillingCard = Billing['cards'][number];
type Quote = Ok<'/v1/queries/billing.pay_day_quote'>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** A day as the words read it: noon UTC, so no time zone moves it a day. */
const noon = (day: string) => `${day}T12:00:00Z`;

function Section({
  title,
  description,
  action,
  children,
  testId,
  setting,
  tone,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
  testId?: string;
  setting?: SettingKey;
  tone?: 'danger';
}) {
  return (
    <Card
      className={cn('px-[22px] py-5', tone === 'danger' && 'border-danger/40')}
      data-testid={testId}
      {...settingAttrs(setting)}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2
            className={cn(
              'text-lg font-semibold leading-[1.3] tracking-[-0.005em]',
              tone === 'danger' && 'text-danger-text',
            )}
          >
            {title}
          </h2>
          {description ? (
            <p className="mt-1 max-w-[460px] text-[13px] text-text-2">{description}</p>
          ) : null}
        </div>
        {action}
      </div>
      {children}
    </Card>
  );
}

/**
 * The plan's half of Settings → Billing & Usage (20261027023600, the owner's calls of 2026-11-08: 5a one list of cards,
 * 6b all on this page): a payment that didn't go through on top, with its ways out; then the plan, its next payment
 * with Change date, and stopping it renewing. Nothing at all for a business with no plan paid by card. The cards are
 * `CardsSection`, further down the page, because they pay the balance too.
 */
export function PlanSections({ workspaceId, billing }: { workspaceId: string; billing: Billing }) {
  const router = useRouter();
  if (!billing.billed) return null;
  return (
    <>
      {billing.owed ? (
        <Section title={W.owedTitle} tone="danger" testId="billing-owed-card">
          <div className="mt-3">
            <OwedPanel
              workspaceId={workspaceId}
              owed={billing.owed}
              from="usage"
              hasCards={billing.cards.length > 0}
              onPaid={() => router.refresh()}
            />
          </div>
        </Section>
      ) : null}
      <PlanSection workspaceId={workspaceId} billing={billing} />
    </>
  );
}

/**
 * The plan: what it costs, its next payment and its date with Change date, and stopping it renewing. Keeps the
 * `founding` id, which older emails link to.
 */
function PlanSection({ workspaceId, billing }: { workspaceId: string; billing: Billing }) {
  const router = useRouter();
  const [changing, setChanging] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const change = billing.payDayChange;
  const until = billing.trialEndsAt ?? billing.paidThrough;
  const setRenewing = (renewing: boolean) =>
    start(async () => {
      setError(null);
      try {
        unwrap(
          await apiBrowser().POST('/v1/commands/founding.set_renewing', {
            body: { workspaceId, renewing },
          }),
        );
        setStopping(false);
        router.refresh();
      } catch (e) {
        setError(errorMessage(e));
      }
    });
  return (
    <Card id="founding" className={cn('px-[22px] py-5', SETTING_TARGET)} data-testid="billing-plan">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold leading-[1.3] tracking-[-0.005em]">
            {billing.offerName ?? F.title}
          </h2>
          <p className="mt-1 max-w-[460px] text-[13px] text-text-2">
            {F.price(billing.priceCents, billing.plan)}
          </p>
        </div>
        {billing.renewing ? (
          <Button
            variant="ghost"
            onClick={() => setStopping(true)}
            disabled={busy}
            data-testid="billing-stop"
          >
            {F.stop}
          </Button>
        ) : (
          <Button
            variant="secondary"
            onClick={() => setRenewing(true)}
            disabled={busy}
            data-testid="billing-keep"
          >
            {F.keep}
          </Button>
        )}
      </div>
      <SettingAnchor
        setting="usage.pay_day"
        className="mt-4 flex flex-wrap items-center justify-between gap-3"
      >
        <div className="flex min-w-0 flex-col gap-1 text-[13px]">
          {billing.paidThrough ? (
            <p data-testid="billing-next-payment">
              {billing.trialEndsAt
                ? billing.renewing
                  ? F.trial(billing.trialEndsAt, billing.nextChargeCents)
                  : F.trialStopped(billing.trialEndsAt)
                : billing.renewing
                  ? W.payDayLine(billing.paidThrough, billing.nextChargeCents)
                  : F.stopped(billing.paidThrough)}
            </p>
          ) : null}
          {billing.payDayCreditCents > 0 && billing.renewing ? (
            <p className="text-text-2">{W.payDayCredit(billing.payDayCreditCents)}</p>
          ) : null}
          {change?.problem ? (
            <p className="text-danger-text" data-testid="billing-pay-day-problem">
              {W.payDayFailed(change.problem)}
            </p>
          ) : change?.to ? (
            <p className="text-text-2">{W.payDayCharging}</p>
          ) : null}
          <p className="text-text-3">{billing.renewing ? W.renewingBlurb : W.stoppedBlurb}</p>
        </div>
        {billing.payDayBounds ? (
          <Button
            variant="secondary"
            onClick={() => setChanging(true)}
            data-testid="billing-change-date"
          >
            {W.payDayChange}
          </Button>
        ) : null}
      </SettingAnchor>
      {error && !stopping ? <p className="mt-2 text-[13px] text-danger-text">{error}</p> : null}
      {billing.payDayBounds ? (
        <PayDayDialog
          workspaceId={workspaceId}
          billing={billing}
          bounds={billing.payDayBounds}
          open={changing}
          onClose={() => setChanging(false)}
        />
      ) : null}
      <Dialog open={stopping} onOpenChange={(o) => (o ? null : setStopping(false))}>
        <DialogContent
          title={F.stopTitle}
          description={until ? F.stopDescription(until) : undefined}
        >
          {error ? <p className="mt-3 text-[13px] text-danger-text">{error}</p> : null}
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setStopping(false)}>
              {F.cancel}
            </Button>
            <Button
              onClick={() => setRenewing(false)}
              disabled={busy}
              data-testid="billing-stop-confirm"
            >
              {busy ? F.stopping : F.stopConfirm}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

/**
 * Picking a new payment date: what it costs (later, paid now) or saves (earlier, off the next payment) is asked of
 * the server for the day picked, before anybody presses, and the button says it.
 */
function PayDayDialog({
  workspaceId,
  billing,
  bounds,
  open,
  onClose,
}: {
  workspaceId: string;
  billing: Billing;
  bounds: { earliest: string; latest: string };
  open: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const [day, setDay] = useState('');
  const [quote, setQuote] = useState<Quote | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();

  const pick = (value: string) => {
    setDay(value);
    setQuote(null);
    setError(null);
    if (!value) return;
    start(async () => {
      try {
        setQuote(
          unwrap(
            await apiBrowser().POST('/v1/queries/billing.pay_day_quote', {
              body: { workspaceId, day: value },
            }),
          ),
        );
      } catch (e) {
        setError(errorMessage(e));
      }
    });
  };

  const confirm = () =>
    start(async () => {
      setError(null);
      try {
        const out = unwrap(
          await apiBrowser().POST('/v1/commands/billing.change_pay_day', {
            body: { workspaceId, day },
          }),
        );
        if (out.outcome === 'charging') {
          // The worker charges the days added; the date moves once it's paid.
          for (let i = 0; i < 15; i++) {
            await sleep(2000);
            const now = unwrap(
              await apiBrowser().POST('/v1/queries/billing.get', { body: { workspaceId } }),
            );
            if (now.payDayChange?.problem) {
              setError(W.payDayFailed(now.payDayChange.problem));
              router.refresh();
              return;
            }
            if (!now.payDayChange?.to) break;
          }
        }
        toast.success(W.payDayMoved(out.newPaidThrough));
        onClose();
        setDay('');
        setQuote(null);
        router.refresh();
      } catch (e) {
        setError(errorMessage(e));
      }
    });

  const words =
    quote && !quote.refusal && quote.newPaidThrough
      ? quote.kind === 'later'
        ? W.payDayLater(quote.days, quote.cents, quote.newPaidThrough)
        : quote.kind === 'earlier'
          ? W.payDayEarlier(quote.days, quote.cents, quote.newPaidThrough, quote.nextChargeCents)
          : null
      : null;
  const canConfirm = !!quote && !quote.refusal && quote.kind !== 'same';

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? null : onClose())}>
      <DialogContent
        title={W.payDayTitle}
        description={
          billing.paidThrough
            ? W.payDayLine(billing.paidThrough, billing.nextChargeCents)
            : undefined
        }
      >
        <div className="mt-4">
          <Field
            label={W.payDayPick}
            htmlFor="pay-day"
            hint={W.payDayLimits(noon(bounds.earliest), noon(bounds.latest))}
          >
            <Input
              id="pay-day"
              type="date"
              min={bounds.earliest}
              max={bounds.latest}
              value={day}
              onChange={(e) => pick(e.target.value)}
              data-testid="billing-pay-day"
            />
          </Field>
        </div>
        {words ? (
          <p className="mt-3 text-[13px]" data-testid="billing-pay-day-quote">
            {words}
          </p>
        ) : null}
        {quote?.refusalMessage ? (
          <p className="mt-3 text-[13px] text-danger-text">{quote.refusalMessage}</p>
        ) : null}
        {error ? <p className="mt-3 text-[13px] text-danger-text">{error}</p> : null}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {F.cancel}
          </Button>
          <Button
            onClick={confirm}
            disabled={busy || !canConfirm}
            data-testid="billing-pay-day-confirm"
          >
            {busy && quote
              ? quote.kind === 'later'
                ? W.payDayCharging
                : W.payDayConfirmEarlier
              : quote?.kind === 'later'
                ? W.payDayConfirmLater(quote.cents)
                : W.payDayConfirmEarlier}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The business's cards (the owner's 5a): one list pays the plan and tops up the balance. The default first, then the
 * backups in the order they're tried. Adding one is Stripe's own page, and coming back from it is handled here, for
 * the owed card's Add a card and pay too.
 */
export function CardsSection({ workspaceId, billing }: { workspaceId: string; billing: Billing }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [removing, setRemoving] = useState<BillingCard | null>(null);
  const returning = usePlanCardReturn({ workspaceId, from: 'usage' });

  const add = () =>
    start(async () => {
      try {
        await goAddCard({ workspaceId, from: 'usage' });
      } catch (e) {
        toast.error(errorMessage(e));
      }
    });

  const makeDefault = (card: BillingCard) =>
    start(async () => {
      try {
        unwrap(
          await apiBrowser().POST('/v1/commands/billing.set_default_card', {
            body: { workspaceId, cardId: card.id },
          }),
        );
        router.refresh();
      } catch (e) {
        toast.error(errorMessage(e));
      }
    });

  const remove = (card: BillingCard) =>
    start(async () => {
      try {
        unwrap(
          await apiBrowser().POST('/v1/commands/billing.remove_card', {
            body: { workspaceId, cardId: card.id },
          }),
        );
        setRemoving(null);
        router.refresh();
      } catch (e) {
        toast.error(errorMessage(e));
      }
    });

  // The default comes off only as the business's one card, with no paid plan renewing on it (the server says so too).
  const lastRemovable = billing.cards.length === 1 && !(billing.billed && billing.renewing);
  let backup = 0;
  return (
    <Section
      title={W.cardsTitle}
      description={W.cardsBlurb}
      setting="usage.card"
      testId="billing-cards"
      action={
        <Button onClick={add} disabled={busy || returning} data-testid="billing-add-card">
          {busy || returning ? W.addingCard : W.addCard}
        </Button>
      }
    >
      {billing.cards.length === 0 ? (
        <p className="mt-4 text-[13px] text-text-2">
          {billing.billed && billing.renewing ? W.noCardsPlan : W.noCards}
        </p>
      ) : (
        <ul className="mt-4 flex flex-col">
          {billing.cards.map((card) => {
            if (!card.isDefault) backup++;
            const expiry = planCardExpiry(card);
            return (
              <li
                key={card.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-border py-3 first:border-t-0"
                data-testid="billing-card"
              >
                <CreditCard className="h-4 w-4 shrink-0 text-text-3" strokeWidth={1.75} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2 text-[13px] font-medium">
                    {planCardName(card)}
                    <Badge variant={card.isDefault ? 'accent' : 'gray'}>
                      {card.isDefault ? W.defaultBadge : W.backupBadge(backup)}
                    </Badge>
                  </div>
                  {expiry ? <div className="text-xs text-text-3">{expiry}</div> : null}
                  {card.lastDeclinedAt ? (
                    <div className="text-xs text-danger-text">
                      {W.declined(card.lastDeclinedAt, card.lastDecline)}
                    </div>
                  ) : null}
                </div>
                {card.isDefault && !lastRemovable ? null : (
                  <div className="flex gap-1.5">
                    {card.isDefault ? null : (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => makeDefault(card)}
                        disabled={busy}
                        data-testid="billing-card-default"
                      >
                        {W.makeDefault}
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setRemoving(card)}
                      disabled={busy}
                      data-testid="billing-card-remove"
                    >
                      {W.remove}
                    </Button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <Dialog open={removing !== null} onOpenChange={(o) => (o ? null : setRemoving(null))}>
        {removing ? (
          <DialogContent
            title={W.removeTitle(planCardName(removing))}
            description={removing.isDefault ? W.removeLastBody : W.removeBody}
          >
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setRemoving(null)}>
                {F.cancel}
              </Button>
              <Button
                variant="danger"
                onClick={() => remove(removing)}
                disabled={busy}
                data-testid="billing-card-remove-confirm"
              >
                {W.removeConfirm}
              </Button>
            </div>
          </DialogContent>
        ) : null}
      </Dialog>
    </Section>
  );
}
