'use client';
import {
  acceptedWording,
  dayLabel,
  declinedWording,
  expiryPhrase,
  invoiceStanding,
  invoiceVoidBlock,
  money,
  PAYMENT_METHOD_LABELS,
  paidWording,
  refundedWording,
  whenLabel,
  type PaymentMethod,
} from '@hfos/core';
import { Ban, Check, Eye, FileText, HandCoins, RotateCcw, Send, Undo2 } from 'lucide-react';
import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import type {
  EstimateDetail,
  EstimateGetOut,
  InvoiceDetail,
  InvoiceGetOut,
  PaymentConnectionRow,
  PaymentRow,
} from '@/lib/api/types';
import { useLiveRefresh } from '@/lib/realtime/live-provider';
import { cn } from '@/lib/utils';
import {
  CashPaymentDialog,
  ConvertDialog,
  MarkAcceptedDialog,
  RefundDialog,
  VoidDialog,
} from './document-actions';
import { CopyLinkButton } from './copy-link';
import { DocumentView } from './document-view';
import { listState } from './list-bits';
import { MoneyCrumbs } from './subnav';
import { StatusBadge } from './status-badge';
import { TotalRow } from './totals';

interface Event {
  readonly icon: ReactNode;
  readonly text: string;
  readonly at: string | null;
  readonly tone?: 'good' | 'bad';
}

function Activity({ events, timeZone }: { events: readonly Event[]; timeZone: string }) {
  return (
    <Card className="px-5 pb-4 pt-4" data-testid="document-activity">
      <h2 className="mb-1 text-base font-semibold tracking-tight">What has happened</h2>
      <ul>
        {events.map((e, i) => (
          <li
            key={`${e.text}-${i}`}
            className="flex items-start gap-2.5 border-t border-border py-2.5 text-[13.5px] first:border-t-0"
          >
            <span
              className={cn(
                'mt-px flex h-6 w-6 flex-none items-center justify-center rounded-full bg-card-2 text-text-2',
                e.tone === 'good' && 'bg-success-soft text-success-text',
                e.tone === 'bad' && 'bg-danger-soft text-danger-text',
              )}
            >
              {e.icon}
            </span>
            <span className="min-w-0 flex-1">{e.text}</span>
            {e.at ? (
              <span className="flex-none whitespace-nowrap text-xs text-text-3">
                {whenLabel(Date.parse(e.at), timeZone)}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Header({
  workspaceId,
  kind,
  number,
  state,
  person,
  title,
  sub,
  actions,
}: {
  workspaceId: string;
  kind: 'estimate' | 'invoice';
  number: string | null;
  state: string;
  person: { id: string; fullName: string };
  title: string | null;
  sub: string;
  actions: ReactNode;
}) {
  return (
    <>
      <MoneyCrumbs
        workspaceId={workspaceId}
        tab={kind === 'estimate' ? 'estimates' : 'invoices'}
        current={number ?? 'Draft'}
      />
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="text-[22px] font-semibold leading-tight tracking-[-0.01em] md:text-2xl">
              {number ?? (kind === 'estimate' ? 'Estimate' : 'Invoice')}
            </h1>
            <StatusBadge kind={kind} state={state} testId="document-status" />
          </div>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-[13px] text-text-2">
            <Link
              href={`/app/w/${workspaceId}/customers/people/${person.id}`}
              className="flex items-center gap-1.5 font-medium text-text hover:underline"
            >
              <Avatar name={person.fullName} seed={person.id} size="sm" />
              {person.fullName}
            </Link>
            {title ? <span>· {title}</span> : null}
            <span>· {sub}</span>
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 max-md:w-full">{actions}</div>
      </div>
    </>
  );
}

/** An estimate that has gone out: what it says, what the customer did, and what to do next. */
export function EstimateDocument({
  workspaceId,
  data,
  canManage,
  connections,
  timeZone,
  now,
}: {
  workspaceId: string;
  data: EstimateGetOut;
  canManage: boolean;
  connections: readonly PaymentConnectionRow[];
  timeZone: string;
  now: number;
}) {
  // The invoices raised from it read as what their money says, so a payment or a refund landing counts too.
  useLiveRefresh(['estimate', 'invoice', 'payment', 'refund']);
  const est: EstimateDetail = data.estimate;
  const [converting, setConverting] = useState(false);
  const [accepting, setAccepting] = useState(false);
  const [voiding, setVoiding] = useState(false);
  const open = est.status === 'sent';
  const answerable = canManage && (est.status === 'sent' || est.status === 'accepted');

  const events: Event[] = [
    {
      icon: <FileText className="h-3.5 w-3.5" strokeWidth={1.5} />,
      text: 'Written',
      at: est.createdAt,
    },
    ...(est.sentAt
      ? [
          {
            icon: <Send className="h-3.5 w-3.5" strokeWidth={1.5} />,
            text: `Sent to ${est.person.fullName}`,
            at: est.sentAt,
          },
        ]
      : []),
    ...(est.firstViewedAt
      ? [
          {
            icon: <Eye className="h-3.5 w-3.5" strokeWidth={1.5} />,
            text: 'They opened it',
            at: est.firstViewedAt,
          },
        ]
      : []),
    ...(est.acceptedAt
      ? [
          {
            icon: <Check className="h-3.5 w-3.5" strokeWidth={1.75} />,
            text: `${acceptedWording(est.acceptedName ?? est.person.fullName, est.acceptedAt, timeZone)}${
              est.acceptedVia === 'staff' ? ' · taken by phone' : ' · on their own page'
            }`,
            at: null,
            tone: 'good' as const,
          },
        ]
      : []),
    ...(est.declinedAt
      ? [
          {
            icon: <Ban className="h-3.5 w-3.5" strokeWidth={1.5} />,
            text: `${declinedWording(est.person.fullName, est.declinedAt, timeZone)}${
              est.declinedReason ? ` — “${est.declinedReason}”` : ''
            }`,
            at: null,
            tone: 'bad' as const,
          },
        ]
      : []),
    ...(est.voidedAt
      ? [
          {
            icon: <Ban className="h-3.5 w-3.5" strokeWidth={1.5} />,
            text: `Voided${est.voidReason ? ` — ${est.voidReason}` : ''}`,
            at: est.voidedAt,
          },
        ]
      : []),
  ];

  return (
    <>
      <Header
        workspaceId={workspaceId}
        kind="estimate"
        number={est.number}
        state={est.state}
        person={est.person}
        title={est.title}
        sub={
          est.sentAt
            ? `Sent ${dayLabel(Date.parse(est.sentAt), timeZone)} · ${expiryPhrase(est.expiresOn, now, timeZone)}`
            : 'Not sent'
        }
        actions={
          <>
            {answerable ? (
              <Button
                onClick={() => setConverting(true)}
                data-testid="estimate-convert"
                className="max-md:h-11 max-md:flex-1"
              >
                <FileText className="h-4 w-4" strokeWidth={1.5} />
                Turn into an invoice
              </Button>
            ) : null}
            {canManage && open ? (
              <Button
                variant="secondary"
                onClick={() => setAccepting(true)}
                data-testid="estimate-accepted"
                className="max-md:h-11 max-md:flex-1"
              >
                <Check className="h-4 w-4" strokeWidth={1.75} />
                They said yes
              </Button>
            ) : null}
            {/* The page they were sent stays theirs to open once answered, so the link is offered until it's voided. */}
            {canManage && est.sentAt && !est.voidedAt ? (
              <CopyLinkButton
                workspaceId={workspaceId}
                kind="estimate"
                id={est.id}
                version={est.linkVersion}
                className="max-md:h-11 max-md:flex-1"
              />
            ) : null}
            {canManage && !est.voidedAt ? (
              <Button
                variant="ghost"
                className="max-md:h-11"
                onClick={() => setVoiding(true)}
                data-testid="document-void"
              >
                Void
              </Button>
            ) : null}
          </>
        }
      />

      <div className="grid grid-cols-1 items-start gap-5 min-[1360px]:grid-cols-[minmax(0,1fr)_340px]">
        <DocumentView
          lines={est.lines}
          totals={est.totals}
          notes={est.notes}
          aside={
            est.depositCents > 0 ? (
              <>
                <TotalRow
                  label="Deposit asked for up front"
                  value={money(est.depositCents)}
                  testId="estimate-deposit"
                />
                <TotalRow
                  label="Balance when the work is done"
                  value={money(Math.max(0, est.totals.totalCents - est.depositCents))}
                />
              </>
            ) : null
          }
        />
        <div className="flex flex-col gap-4">
          <Activity events={events} timeZone={timeZone} />
          {data.invoices.length ? (
            <Card className="px-5 pb-4 pt-4" data-testid="estimate-invoices">
              <h2 className="mb-1 text-base font-semibold tracking-tight">Invoices from this</h2>
              <ul>
                {data.invoices.map((inv) => (
                  <li
                    key={inv.id}
                    className="flex items-center gap-2.5 border-t border-border py-2.5 text-[13.5px] first:border-t-0"
                  >
                    <Link
                      href={`/app/w/${workspaceId}/money/invoices/${inv.id}`}
                      className="font-mono text-[12.5px] text-accent-text hover:underline"
                    >
                      {inv.number ?? 'Draft'}
                    </Link>
                    {/* Worked out, as the Invoices list does: stored, a refunded invoice is still "paid". */}
                    <StatusBadge
                      kind="invoice"
                      state={listState(inv.state)}
                      testId="estimate-invoice-status"
                    />
                    <span className="flex-1" />
                    <span className="tabular-nums">{money(inv.totalCents)}</span>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
        </div>
      </div>

      <ConvertDialog
        open={converting}
        onOpenChange={setConverting}
        workspaceId={workspaceId}
        estimateId={est.id}
        depositCents={est.depositCents}
        connections={connections}
      />
      <MarkAcceptedDialog
        open={accepting}
        onOpenChange={setAccepting}
        workspaceId={workspaceId}
        estimateId={est.id}
        personName={est.person.fullName}
      />
      <VoidDialog
        open={voiding}
        onOpenChange={setVoiding}
        kind="estimate"
        workspaceId={workspaceId}
        documentId={est.id}
      />
    </>
  );
}

/**
 * The line beside an invoice's customer: when it is due while something is owed, and otherwise how it ended.
 * A refund never reopens an invoice, so a refunded one says what went back rather than a due date.
 */
const invoiceSub = (inv: InvoiceDetail, now: number, timeZone: string): string =>
  invoiceStanding(inv, now, timeZone);

/** An invoice that has gone out: what is owed, what has been paid, and what can still be given back. */
export function InvoiceDocument({
  workspaceId,
  data,
  canManage,
  timeZone,
  now,
}: {
  workspaceId: string;
  data: InvoiceGetOut;
  canManage: boolean;
  timeZone: string;
  now: number;
}) {
  // A refund lands as its own event, and the invoice has to say so when it does.
  useLiveRefresh(['invoice', 'payment', 'refund']);
  const inv: InvoiceDetail = data.invoice;
  const [paying, setPaying] = useState(false);
  const [voiding, setVoiding] = useState(false);
  const [refunding, setRefunding] = useState<PaymentRow | null>(null);
  const owes = inv.balanceCents > 0 && !inv.voidedAt;
  /**
   * Money that moved is never voided away: once everything paid has gone back (and nothing is still arriving or
   * going back) it can be, which is how a business bills again. The command asks the same question.
   */
  const voidable =
    !inv.voidedAt &&
    invoiceVoidBlock({
      paidCents: inv.amountPaidCents,
      refundedCents: inv.amountRefundedCents,
      hasProcessingPayment: data.payments.some((p) => p.status === 'processing'),
      hasPendingRefund: data.refunds.some((r) => r.status === 'pending'),
    }) === null;

  const events: Event[] = [
    {
      icon: <FileText className="h-3.5 w-3.5" strokeWidth={1.5} />,
      text: 'Raised',
      at: inv.createdAt,
    },
    ...(inv.sentAt
      ? [
          {
            icon: <Send className="h-3.5 w-3.5" strokeWidth={1.5} />,
            text: `Sent to ${inv.person.fullName}`,
            at: inv.sentAt,
          },
        ]
      : []),
    ...(inv.firstViewedAt
      ? [
          {
            icon: <Eye className="h-3.5 w-3.5" strokeWidth={1.5} />,
            text: 'They opened it',
            at: inv.firstViewedAt,
          },
        ]
      : []),
    ...data.payments.map((p) => ({
      icon: <HandCoins className="h-3.5 w-3.5" strokeWidth={1.5} />,
      text:
        p.status === 'succeeded'
          ? paidWording(
              p.amountCents,
              p.method as PaymentMethod,
              p.receivedAt ?? p.createdAt,
              timeZone,
            )
          : p.status === 'processing'
            ? `${money(p.amountCents)} on its way by ${PAYMENT_METHOD_LABELS[p.method as PaymentMethod].toLowerCase()}`
            : `${money(p.amountCents)} ${p.status === 'failed' ? 'failed' : 'not paid yet'}`,
      at: null,
      tone:
        p.status === 'succeeded'
          ? ('good' as const)
          : p.status === 'failed'
            ? ('bad' as const)
            : undefined,
    })),
    ...data.refunds.map((r) => ({
      icon: <Undo2 className="h-3.5 w-3.5" strokeWidth={1.5} />,
      text:
        r.status === 'succeeded' && r.refundedAt
          ? refundedWording(r.amountCents, r.refundedAt, timeZone)
          : `${money(r.amountCents)} refund ${r.status === 'failed' ? 'failed' : 'on its way back'}`,
      at: null,
      tone: r.status === 'failed' ? ('bad' as const) : undefined,
    })),
    ...(inv.voidedAt
      ? [
          {
            icon: <Ban className="h-3.5 w-3.5" strokeWidth={1.5} />,
            text: `Voided${inv.voidReason ? ` — ${inv.voidReason}` : ''}`,
            at: inv.voidedAt,
          },
        ]
      : []),
  ];

  return (
    <>
      <Header
        workspaceId={workspaceId}
        kind="invoice"
        number={inv.number}
        state={inv.state}
        person={inv.person}
        title={inv.title}
        sub={invoiceSub(inv, now, timeZone)}
        actions={
          <>
            {canManage && owes ? (
              <Button
                onClick={() => setPaying(true)}
                data-testid="invoice-record-payment"
                className="max-md:h-11 max-md:flex-1"
              >
                <HandCoins className="h-4 w-4" strokeWidth={1.5} />
                Record a payment
              </Button>
            ) : null}
            {/* Paid or not, the page they were sent is theirs: the receipt lives there too. */}
            {canManage && inv.sentAt && !inv.voidedAt ? (
              <CopyLinkButton
                workspaceId={workspaceId}
                kind="invoice"
                id={inv.id}
                version={inv.linkVersion}
                className="max-md:h-11 max-md:flex-1"
              />
            ) : null}
            {canManage && voidable ? (
              <Button
                variant="ghost"
                className="max-md:h-11"
                onClick={() => setVoiding(true)}
                data-testid="document-void"
              >
                Void
              </Button>
            ) : null}
          </>
        }
      />

      <div className="grid grid-cols-1 items-start gap-5 min-[1360px]:grid-cols-[minmax(0,1fr)_340px]">
        <DocumentView
          lines={inv.lines}
          totals={inv.totals}
          notes={inv.notes}
          paidCents={inv.amountPaidCents}
          refundedCents={inv.amountRefundedCents}
          balanceCents={inv.balanceCents}
          paidLabel="Paid"
        />
        <div className="flex flex-col gap-4">
          <Activity events={events} timeZone={timeZone} />
          {data.payments.length ? (
            <Card className="px-5 pb-4 pt-4" data-testid="invoice-payments">
              <h2 className="mb-1 text-base font-semibold tracking-tight">Payments</h2>
              <ul>
                {data.payments.map((p) => {
                  const left = p.amountCents - p.refundedCents;
                  return (
                    <li
                      key={p.id}
                      className="flex flex-wrap items-center gap-2.5 border-t border-border py-2.5 text-[13.5px] first:border-t-0"
                      data-testid={`invoice-payment-${p.id}`}
                    >
                      <span className="font-semibold tabular-nums">{money(p.amountCents)}</span>
                      <span className="text-text-2">
                        {PAYMENT_METHOD_LABELS[p.method as PaymentMethod]}
                      </span>
                      <StatusBadge kind="payment" state={p.status} />
                      <span className="flex-1" />
                      {canManage && p.status === 'succeeded' && left > 0 ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setRefunding(p)}
                          data-testid="payment-refund"
                        >
                          <RotateCcw className="h-3.5 w-3.5" strokeWidth={1.5} />
                          Refund
                        </Button>
                      ) : null}
                      {p.refundedCents > 0 ? (
                        <span className="text-xs text-text-3">
                          {money(p.refundedCents)} refunded
                        </span>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </Card>
          ) : null}
        </div>
      </div>

      {/* Keyed, so each dialog starts from the figure it is about rather than the one it first saw. */}
      <CashPaymentDialog
        key={`cash-${inv.balanceCents}`}
        open={paying}
        onOpenChange={setPaying}
        workspaceId={workspaceId}
        invoiceId={inv.id}
        balanceCents={inv.balanceCents}
      />
      <RefundDialog
        key={`refund-${refunding?.id ?? 'none'}-${refunding?.refundedCents ?? 0}`}
        open={refunding !== null}
        onOpenChange={(next) => !next && setRefunding(null)}
        workspaceId={workspaceId}
        payment={refunding}
      />
      <VoidDialog
        open={voiding}
        onOpenChange={setVoiding}
        kind="invoice"
        workspaceId={workspaceId}
        documentId={inv.id}
      />
    </>
  );
}
