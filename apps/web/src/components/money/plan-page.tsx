'use client';
/**
 * One maintenance plan a customer is on (design/m9 Plans): what it bills and when, the cycles it has run with
 * their invoices, a cycle that failed and why, and the card paying for it.
 *
 * **A plan is a promise that bills itself**, so this page says what each provider will and will not do *before*
 * a button is pressed rather than after:
 * - Square has no immediate cancel. Its API ends a plan at the end of the period already paid for, so the
 *   button says so and the customer keeps what they have paid for.
 * - A plan whose account was disconnected **keeps billing at the provider**. Nothing here can stop it, because
 *   the tokens were destroyed on purpose — so it reads as unmanaged, with the two ways out.
 * - Square plans are card-only.
 *
 * The card is never held here. The customer puts it on their own page (`/p/<token>`, components/money/
 * public-plan.tsx) in the provider's own fields, and the provider keeps the number and runs its own card
 * updater — which is what keeps HandsFreeOS in the lightest PCI bracket. So a plan starts **waiting on the
 * customer**, this page says so and who the link went to, and "Ask for a new card" sends the same link again
 * when a card expires, rather than leaving the business to make a phone call.
 */
import { dayLabel, localInstant, money, whenLabel } from '@hfos/core';
import {
  AlertTriangle,
  Ban,
  CreditCard,
  Mail,
  MessageSquare,
  Pause,
  Play,
  RefreshCw,
  Repeat,
  Unplug,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogClose, DialogContent } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Select } from '@/components/ui/input';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { PaymentConnectionRow, PaymentListRow, SubscriptionRow } from '@/lib/api/types';
import { useLiveRefresh } from '@/lib/realtime/live-provider';
import { cn } from '@/lib/utils';
import { CopyLinkButton } from './copy-link';
import { listState } from './list-bits';
import { connectionLabel, providerTruths } from './plan-start';
import { planPriceLabel } from './plans-list';
import { StatusBadge } from './status-badge';
import { MoneyCrumbs } from './subnav';

export interface PlanCycle {
  id: string;
  number: string | null;
  status: string;
  /** What the invoice reads as: a cycle refunded in full is stored as paid but reads "Refunded". */
  state: string;
  totalCents: number;
  balanceCents: number;
  dueOn: string | null;
  createdAt: string;
}

const PROVIDER_NAME: Readonly<Record<string, string>> = { stripe: 'Stripe', square: 'Square' };
const providerName = (p: string | null) => (p ? (PROVIDER_NAME[p] ?? p) : 'the provider');
/** What the provider's own billing engine is called, as the canvas names it. */
const engineName = (p: string | null) =>
  p === 'square' ? 'Square Subscriptions' : p === 'stripe' ? 'Stripe Billing' : 'the provider';

/** "the 22nd, every month", "the 14th, every March". */
function billsOnWording(sub: SubscriptionRow): string {
  const anchor = sub.currentPeriodStart ?? sub.startedOn ?? sub.nextBillingOn;
  if (!anchor) return 'Set when the first cycle runs';
  const day = Number(anchor.slice(8, 10));
  const nth = `the ${day}${ordinal(day)}`;
  if (sub.interval === 'year')
    return `${nth} of ${monthName(Number(anchor.slice(5, 7)))}, every ${sub.intervalCount === 1 ? 'year' : `${sub.intervalCount} years`}`;
  const every =
    sub.interval === 'quarter'
      ? `every ${sub.intervalCount === 1 ? 'quarter' : `${sub.intervalCount} quarters`}`
      : `every ${sub.intervalCount === 1 ? 'month' : `${sub.intervalCount} months`}`;
  return `${nth}, ${every}`;
}
const ordinal = (n: number) =>
  n % 100 >= 11 && n % 100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
const monthName = (m: number) =>
  [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ][Math.max(0, Math.min(11, m - 1))]!;

const onDay = (date: string | null, timeZone: string) =>
  date ? dayLabel(localInstant(date, '12:00', timeZone), timeZone) : null;

/** The line under the status badge: what this plan is doing right now, in one sentence. */
function standingOf(sub: SubscriptionRow, timeZone: string): string {
  switch (sub.status) {
    case 'draft':
      if (!sub.hasCard)
        return `Waiting on ${sub.person.fullName.split(' ')[0]} to put a card on it. Nothing is billed until they do.`;
      return sub.connectionId
        ? `Being set up at ${providerName(sub.provider)}. It starts billing once they have it.`
        : 'Not billing yet — it has no account to bill through.';
    case 'active':
      return sub.nextBillingOn
        ? `Next charge ${onDay(sub.nextBillingOn, timeZone)}`
        : 'Billing at the provider';
    case 'past_due':
      return `The card was refused${sub.failedCycles > 1 ? ` ${sub.failedCycles} times` : ''}. ${providerName(sub.provider)} keeps retrying it.`;
    case 'paused':
      return sub.pausedAt
        ? `Paused since ${whenLabel(Date.parse(sub.pausedAt), timeZone)}. Nothing is being charged.`
        : 'Paused. Nothing is being charged.';
    case 'cancelled':
      return `Ended${sub.endedOn ? ` ${onDay(sub.endedOn, timeZone)}` : ''}${sub.cancelReason ? ` — ${sub.cancelReason}` : ''}`;
    case 'unmanaged':
      return 'Still billing at the provider, and no longer managed here.';
    default:
      return '';
  }
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 border-t border-border py-2.5 text-[13px] first:border-t-0">
      <span className="flex-none text-text-3">{label}</span>
      <span className="min-w-0 text-right">{children}</span>
    </div>
  );
}

function Note({ tone, children }: { tone: 'quiet' | 'warning'; children: ReactNode }) {
  return (
    <p
      className={cn(
        'mt-2.5 rounded-menu px-3 py-2.5 text-xs leading-[1.5]',
        tone === 'warning' ? 'bg-warning-soft text-warning-text' : 'bg-card-2 text-text-2',
      )}
    >
      {children}
    </p>
  );
}

export function PlanPage({
  workspaceId,
  subscription,
  cycles,
  connections,
  cardPayment,
  canBill,
  timeZone,
}: {
  workspaceId: string;
  subscription: SubscriptionRow;
  cycles: readonly PlanCycle[];
  connections: readonly PaymentConnectionRow[];
  /** The newest card payment a cycle took, for the card that is paying for it. */
  cardPayment: PaymentListRow | null;
  /** Ask for a card, pause, start again, cancel or move it: whoever bills (0103). */
  canBill: boolean;
  timeZone: string;
}) {
  useLiveRefresh(['subscription', 'invoice', 'payment', 'refund']);
  const router = useRouter();
  const sub = subscription;
  const account = connections.find((c) => c.id === sub.connectionId) ?? null;
  const [busy, setBusy] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [moving, setMoving] = useState(false);
  const square = (sub.provider ?? account?.provider) === 'square';
  const billing = sub.status === 'active' || sub.status === 'past_due';
  /** A plan cannot bill anybody until the customer has put a card on their own page. */
  const waitingOnCard = sub.status === 'draft' && !sub.hasCard;
  // Connected, and theirs to bill into (0102) — or the account the plan already uses.
  const usable = connections.filter(
    (c) => c.status === 'active' && (c.usableByMe || c.id === sub.connectionId),
  );
  const canMove = sub.status === 'draft' || sub.status === 'unmanaged';

  async function run(key: string, fn: () => Promise<void>) {
    setBusy(key);
    try {
      await fn();
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  /** Asks the customer for a card, by email or by text. The same link either way, and asking again re-sends it. */
  const askFor = (channel: 'sms' | 'email') => () =>
    void run(`ask-${channel}`, async () => {
      unwrap(
        await apiBrowser().POST('/v1/commands/subscription.request_card', {
          body: { workspaceId, subscriptionId: sub.id, channels: [channel] },
        }),
      );
      toast.success(
        channel === 'email'
          ? `Emailed ${sub.person.fullName} the link.`
          : `Texted ${sub.person.fullName} the link.`,
      );
    });

  const act = (command: 'pause' | 'resume', said: string) => () =>
    void run(command, async () => {
      unwrap(
        await apiBrowser().POST(
          `/v1/commands/subscription.${command}` as '/v1/commands/subscription.pause',
          {
            body: { workspaceId, subscriptionId: sub.id },
          },
        ),
      );
      toast.success(said);
    });

  const cancel = () =>
    void run('cancel', async () => {
      unwrap(
        await apiBrowser().POST('/v1/commands/subscription.cancel', {
          body: { workspaceId, subscriptionId: sub.id },
        }),
      );
      setCancelling(false);
      toast.success(
        square
          ? 'Cancelled. Square bills the period they are in one more time, and then it stops.'
          : 'Cancelled. Nothing else will be billed.',
      );
    });

  // Counted by what each invoice reads as, so a cycle whose money all went back isn't counted as paid.
  const paid = cycles.filter((c) => c.state === 'paid' || c.state === 'partly_refunded').length;
  const refunded = cycles.filter((c) => c.state === 'refunded').length;
  /**
   * The card the plan actually bills, as the customer put it on their own page. Failing that (a plan set up
   * before this page existed), the card the newest cycle was charged.
   */
  const planCard =
    sub.cardBrand && sub.cardLast4
      ? { brand: sub.cardBrand, last4: sub.cardLast4 }
      : cardPayment?.cardBrand && cardPayment.cardLast4
        ? { brand: cardPayment.cardBrand, last4: cardPayment.cardLast4 }
        : null;

  return (
    <>
      <MoneyCrumbs workspaceId={workspaceId} tab="plans" current={sub.planName} />
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="text-[22px] font-semibold leading-tight tracking-[-0.01em] md:text-2xl">
              {planPriceLabel(sub.priceCents, sub.interval, sub.intervalCount)}
            </h1>
            <StatusBadge kind="subscription" state={sub.status} testId="plan-status" />
          </div>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-[13px] text-text-2">
            <Link
              href={`/app/w/${workspaceId}/customers/people/${sub.person.id}`}
              className="flex items-center gap-1.5 font-medium text-text hover:underline"
            >
              <Avatar name={sub.person.fullName} seed={sub.person.id} size="sm" />
              {sub.person.fullName}
            </Link>
            <span>· {sub.planName}</span>
            {sub.startedOn ? <span>· since {onDay(sub.startedOn, timeZone)}</span> : null}
          </p>
          <p className="mt-1 text-[13px] text-text-2" data-testid="plan-standing">
            {standingOf(sub, timeZone)}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 max-md:w-full">
          {canBill && (billing || sub.status === 'paused') && sub.hasCard ? (
            <>
              <Button
                variant="secondary"
                className="max-md:h-11 max-md:flex-1"
                loading={busy === 'ask-email'}
                disabled={!sub.person.email && !sub.person.phone}
                onClick={askFor(sub.person.email ? 'email' : 'sms')}
                data-testid="plan-change-card"
              >
                <CreditCard className="h-4 w-4" strokeWidth={1.5} />
                Ask for a new card
              </Button>
              {/* The page they change the card on, for whatever else the business talks to them through. */}
              <CopyLinkButton
                workspaceId={workspaceId}
                kind="plan"
                id={sub.id}
                className="max-md:h-11 max-md:flex-1"
              />
            </>
          ) : null}
          {canBill && billing ? (
            <Button
              variant="secondary"
              className="max-md:h-11 max-md:flex-1"
              loading={busy === 'pause'}
              onClick={act('pause', 'Paused. Nothing is charged until you start it again.')}
              data-testid="plan-pause"
            >
              <Pause className="h-4 w-4" strokeWidth={1.5} />
              Pause
            </Button>
          ) : null}
          {canBill && sub.status === 'paused' ? (
            <Button
              className="max-md:h-11 max-md:flex-1"
              loading={busy === 'resume'}
              onClick={act('resume', 'Billing again from the next cycle.')}
              data-testid="plan-resume"
            >
              <Play className="h-4 w-4" strokeWidth={1.5} />
              Start it again
            </Button>
          ) : null}
          {canBill && sub.status !== 'cancelled' ? (
            <Button
              variant="ghost"
              className="max-md:h-11"
              onClick={() => setCancelling(true)}
              data-testid="plan-cancel"
            >
              {square ? 'Cancel at the end of the period' : 'Cancel the plan'}
            </Button>
          ) : null}
        </div>
      </div>

      {waitingOnCard ? (
        <Card className="mb-4 px-5 py-4" data-testid="plan-awaiting-card">
          <h2 className="flex items-center gap-2 text-[15px] font-semibold tracking-tight">
            <CreditCard className="h-4 w-4 text-text-3" strokeWidth={1.5} />
            Waiting on {sub.person.fullName} to add a card
          </h2>
          <p className="mt-1.5 text-[13px] leading-[1.5] text-text-2">
            Neither {providerName(sub.provider ?? account?.provider ?? null)} nor anyone else will
            bill a customer they have no card for, so nothing happens until they put one on their
            own page. Send them the link and the plan starts itself the moment they do.
            {sub.cardRequestedAt ? (
              <>
                {' '}
                <span className="text-text-3" data-testid="plan-asked-at">
                  Last asked {whenLabel(Date.parse(sub.cardRequestedAt), timeZone)}.
                </span>
              </>
            ) : null}
          </p>
          <p className="mt-1.5 text-xs text-text-3" data-testid="plan-asking-who">
            It goes to{' '}
            {sub.person.email ??
              sub.person.phone ??
              'nobody — they have no email or mobile on file'}
            .
          </p>
          {canBill ? (
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                size="sm"
                loading={busy === 'ask-email'}
                disabled={!sub.person.email}
                onClick={askFor('email')}
                data-testid="plan-ask-email"
              >
                <Mail className="h-3.5 w-3.5" strokeWidth={1.5} />
                Email them the link
              </Button>
              <Button
                variant="secondary"
                size="sm"
                loading={busy === 'ask-sms'}
                disabled={!sub.person.phone}
                onClick={askFor('sms')}
                data-testid="plan-ask-sms"
              >
                <MessageSquare className="h-3.5 w-3.5" strokeWidth={1.5} />
                Text it instead
              </Button>
              {/* The same link, for wherever else the business talks to them. */}
              <CopyLinkButton
                workspaceId={workspaceId}
                kind="plan"
                id={sub.id}
                variant="secondary"
                size="sm"
              />
            </div>
          ) : null}
        </Card>
      ) : null}

      {sub.status === 'unmanaged' ? (
        <Card className="mb-4 border-warning-border px-5 py-4" data-testid="plan-unmanaged">
          <h2 className="flex items-center gap-2 text-[15px] font-semibold tracking-tight">
            <Unplug className="h-4 w-4 text-warning-text" strokeWidth={1.5} />
            This plan is still billing at {providerName(sub.provider)}
          </h2>
          <p className="mt-1.5 text-[13px] leading-[1.5] text-text-2">
            The account it bills through was disconnected, so HandsFreeOS can no longer pause it,
            cancel it or record its cycles — but {providerName(sub.provider)} keeps charging{' '}
            {sub.person.fullName.split(' ')[0]} every {sub.interval}.{' '}
            {sub.lastError ? <span className="text-text-3">{sub.lastError}</span> : null}
          </p>
          <ul className="mt-2 flex list-disc flex-col gap-1 pl-4 text-[13px] text-text-2">
            <li>
              Reconnect that account in Settings → Payments and point this plan back at it, and it
              carries on here as before.
            </li>
            <li>
              Or cancel it inside {providerName(sub.provider)}, then cancel it here to close the
              record.
            </li>
          </ul>
        </Card>
      ) : null}

      {sub.status === 'past_due' ? (
        <Card className="mb-4 border-danger-border px-5 py-4" data-testid="plan-failed">
          <h2 className="flex items-center gap-2 text-[15px] font-semibold tracking-tight">
            <AlertTriangle className="h-4 w-4 text-danger-text" strokeWidth={1.5} />
            The last charge failed
          </h2>
          <p className="mt-1.5 text-[13px] leading-[1.5] text-text-2">
            {sub.lastError ?? 'The card on this plan was refused when the provider billed it.'}{' '}
            {engineName(sub.provider)} retries on its own schedule and asks the bank for an updated
            card;{' '}
            {sub.failedCycles === 1
              ? 'one cycle has failed so far'
              : `${sub.failedCycles} cycles in a row have failed`}
            . {sub.person.fullName.split(' ')[0]} has been told their payment did not go through.
          </p>
        </Card>
      ) : null}

      <div className="grid grid-cols-1 items-start gap-5 min-[1360px]:grid-cols-[340px_minmax(0,1fr)]">
        <Card className="px-5 pb-4 pt-4" data-testid="plan-schedule">
          <h2 className="mb-1 text-base font-semibold tracking-tight">The schedule</h2>
          <Row label="Bills on">{billsOnWording(sub)}</Row>
          <Row label="Next charge">
            {sub.status === 'paused'
              ? 'Nothing while it is paused'
              : sub.status === 'cancelled'
                ? 'Nothing — it has ended'
                : (onDay(sub.nextBillingOn, timeZone) ?? 'When the provider sets it')}
          </Row>
          <Row label="Paid into">
            {account ? (
              <span className="flex flex-col items-end">
                <Link
                  href={`/app/w/${workspaceId}/settings/payments`}
                  className="font-medium hover:underline"
                  data-testid="plan-account"
                >
                  {connectionLabel(account)}
                </Link>
                {account.status !== 'active' ? (
                  <span className="text-xs text-danger-text">That account needs reconnecting.</span>
                ) : null}
              </span>
            ) : (
              <span className="text-text-3">No account — it cannot bill</span>
            )}
          </Row>
          <Row label="Card on file">
            {planCard ? (
              <span className="flex flex-col items-end" data-testid="plan-card">
                <span className="flex items-center gap-1.5">
                  <CreditCard className="h-3.5 w-3.5 text-text-3" strokeWidth={1.5} />
                  {planCard.brand} •••• {planCard.last4}
                </span>
                {sub.cardExpiryMonth && sub.cardExpiryYear ? (
                  <span className="text-xs text-text-3">
                    Expires {String(sub.cardExpiryMonth).padStart(2, '0')} /{' '}
                    {String(sub.cardExpiryYear).slice(-2)}
                  </span>
                ) : null}
              </span>
            ) : sub.hasCard ? (
              <span className="text-text-3" data-testid="plan-card">
                Held by {providerName(sub.provider ?? account?.provider ?? null)}
              </span>
            ) : (
              <span className="text-text-3" data-testid="plan-card">
                None yet — they have not added one
              </span>
            )}
          </Row>
          <Row label="Charged by">
            <span className="flex flex-col items-end" data-testid="plan-engine">
              {engineName(sub.provider ?? account?.provider ?? null)}
              <span className="text-xs text-text-3">
                {sub.externalSubscriptionId ?? 'Not set up there yet'}
              </span>
            </span>
          </Row>
          {sub.includes.length ? (
            <Row label="What it includes">
              <span className="text-text-2">{sub.includes.join(', ')}</span>
            </Row>
          ) : null}
          <Note tone="quiet">
            The card never touches HandsFreeOS:{' '}
            {providerName(sub.provider ?? account?.provider ?? null)} holds the number and keeps it
            working when it expires.{' '}
            {providerTruths(sub.provider ?? account?.provider ?? null)[0] ?? ''}
          </Note>
          {canBill && canMove ? (
            <Button
              variant="secondary"
              size="sm"
              className="mt-3"
              onClick={() => setMoving(true)}
              data-testid="plan-change-account"
            >
              <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.5} />
              Change the account
            </Button>
          ) : null}
          {canBill && !canMove && sub.status !== 'cancelled' ? (
            <p className="mt-3 text-xs leading-[1.45] text-text-3" data-testid="plan-move-note">
              A plan lives inside one account at the provider, so this one cannot be moved. Cancel
              it and start a new one on the other account.
            </p>
          ) : null}
        </Card>

        <Card className="overflow-hidden" data-testid="plan-cycles">
          <div className="flex items-center justify-between gap-3 px-5 pb-3 pt-4">
            <h2 className="text-base font-semibold tracking-tight">What it has billed</h2>
            <span className="text-xs text-text-3">
              {cycles.length === 0
                ? 'Nothing yet'
                : `${cycles.length} ${cycles.length === 1 ? 'invoice' : 'invoices'} · ${paid} paid${
                    refunded ? ` · ${refunded} refunded` : ''
                  }`}
            </span>
          </div>
          {cycles.length === 0 ? (
            <p className="border-t border-border px-5 py-4 text-[13px] text-text-3">
              Nothing has been billed yet. The first cycle raises an invoice here, and the receipt
              goes to {sub.person.fullName.split(' ')[0]} on its own.
            </p>
          ) : (
            <ul>
              {cycles.map((c) => (
                <li key={c.id} className="border-t border-border">
                  <Link
                    href={`/app/w/${workspaceId}/money/invoices/${c.id}`}
                    className="flex items-center gap-3 px-5 py-2.5 text-[13px] hover:bg-card-2 max-md:min-h-12 max-md:gap-2.5"
                    data-testid={`plan-cycle-${c.number ?? c.id}`}
                  >
                    <Repeat
                      className="h-3.5 w-3.5 flex-none text-text-3 max-md:hidden"
                      strokeWidth={1.5}
                    />
                    <span className="w-[110px] flex-none text-text-3 max-md:hidden">
                      {whenLabel(Date.parse(c.createdAt), timeZone)}
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate font-medium">{c.number ?? 'Draft invoice'}</span>
                      <span className="truncate text-xs text-text-3 md:hidden">
                        {whenLabel(Date.parse(c.createdAt), timeZone)}
                      </span>
                    </span>
                    <StatusBadge
                      kind="invoice"
                      state={listState(c.state)}
                      testId="plan-cycle-status"
                    />
                    <span className="w-[90px] flex-none text-right tabular-nums max-md:w-auto">
                      {money(c.totalCents)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          <div className="border-t border-border px-5 py-3">
            <Note tone={sub.status === 'cancelled' ? 'quiet' : 'warning'}>
              {sub.status === 'cancelled' ? (
                <>
                  This plan has ended. What it billed stays on the ledger, and{' '}
                  {sub.person.fullName.split(' ')[0]} keeps the visits they have already paid for.
                </>
              ) : square ? (
                <>
                  Pausing stops the charges and keeps {sub.person.fullName.split(' ')[0]} on the
                  plan. Cancelling at Square ends it at the end of the period they have already paid
                  for — they are billed once more, and they keep the visits they are owed.
                </>
              ) : (
                <>
                  Pausing stops the charges and keeps {sub.person.fullName.split(' ')[0]} on the
                  plan. Cancelling ends it now; what has already been billed stays on the ledger,
                  and they keep the visits they are owed.
                </>
              )}
            </Note>
          </div>
        </Card>
      </div>

      <Dialog open={cancelling} onOpenChange={setCancelling}>
        <DialogContent
          title={square ? 'Cancel at the end of the period' : 'Cancel this plan'}
          description={
            square
              ? `Square has no immediate cancel. ${sub.person.fullName} is billed once more for the period they are in, and then it stops.`
              : `${sub.person.fullName} will not be billed again. What has already been billed stays on the ledger.`
          }
        >
          <div className="mt-4 text-[13px] text-text-2" data-testid="plan-cancel-dialog">
            <p>
              {sub.status === 'unmanaged'
                ? `This plan is billing at ${providerName(sub.provider)} with an account that is disconnected, so cancelling here only closes the record. Cancel it at ${providerName(sub.provider)} as well, or nobody stops the charges.`
                : `${sub.person.fullName} keeps the visits they have already paid for.`}
            </p>
          </div>
          <div className="mt-5 flex justify-end gap-2">
            <DialogClose asChild>
              <Button variant="secondary">Keep it running</Button>
            </DialogClose>
            <Button
              variant="danger"
              loading={busy === 'cancel'}
              onClick={cancel}
              data-testid="plan-cancel-confirm"
            >
              <Ban className="h-4 w-4" strokeWidth={1.5} />
              {square ? 'Cancel at period end' : 'Cancel the plan'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <ChangeAccountDialog
        open={moving}
        onOpenChange={setMoving}
        workspaceId={workspaceId}
        subscription={sub}
        connections={usable}
      />
    </>
  );
}

/**
 * Which account a plan bills through. Only offered before the provider holds it, or after the account it was
 * billing through went away — the command refuses the rest, because a live plan lives inside one account there.
 */
function ChangeAccountDialog({
  open,
  onOpenChange,
  workspaceId,
  subscription,
  connections,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  subscription: SubscriptionRow;
  connections: readonly PaymentConnectionRow[];
}) {
  const router = useRouter();
  const [connectionId, setConnectionId] = useState(subscription.connectionId ?? '');
  const [busy, setBusy] = useState(false);
  const unmanaged = subscription.status === 'unmanaged';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Which account bills this plan"
        description={
          unmanaged
            ? 'Point it back at the account it is billing through, and HandsFreeOS follows it again from the next cycle.'
            : 'The plan has not been set up at a provider yet, so it can still be billed anywhere.'
        }
      >
        <div className="mt-4" data-testid="plan-account-dialog">
          <Field label="Paid into" htmlFor="plan-move-connection">
            <Select
              id="plan-move-connection"
              value={connectionId}
              data-testid="plan-move-connection"
              onChange={(e) => setConnectionId(e.target.value)}
            >
              <option value="">No account</option>
              {connections.map((c) => (
                <option key={c.id} value={c.id}>
                  {connectionLabel(c)}
                  {c.isDefault ? ' (default)' : ''}
                </option>
              ))}
            </Select>
          </Field>
          {providerTruths(connections.find((c) => c.id === connectionId)?.provider ?? null).map(
            (line) => (
              <p key={line} className="mt-2 text-xs leading-[1.45] text-text-3">
                {line}
              </p>
            ),
          )}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <DialogClose asChild>
            <Button variant="secondary">Leave it</Button>
          </DialogClose>
          <Button
            loading={busy}
            data-testid="plan-account-confirm"
            onClick={() =>
              void (async () => {
                setBusy(true);
                try {
                  unwrap(
                    await apiBrowser().POST('/v1/commands/subscription.set_connection', {
                      body: {
                        workspaceId,
                        subscriptionId: subscription.id,
                        connectionId: connectionId || null,
                      },
                    }),
                  );
                  onOpenChange(false);
                  toast.success('Saved.');
                  router.refresh();
                } catch (e) {
                  toast.error(errorMessage(e));
                } finally {
                  setBusy(false);
                }
              })()
            }
          >
            Save
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
