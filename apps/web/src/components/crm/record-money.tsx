'use client';
/**
 * Money where people already work: on a customer's record, on a lead, and beside a conversation in the inbox.
 *
 * Nothing new is worked out here. Every figure is `money.for_record`'s, which already carries the rule about
 * who may see what — a member sees the documents on the jobs they are on and the leads they own, and one who
 * is on neither gets an empty answer. So an empty answer means **render nothing**: a member who may not see a
 * customer's money should find no card at all, not an empty one, and never an error where one would be.
 */
import { money } from '@hfos/core';
import { ArrowRight, FilePlus2, Receipt } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { StatusBadge } from '@/components/money/status-badge';
import { Badge } from '@/components/ui/badge';
import { ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { apiBrowser, unwrap } from '@/lib/api/client';
import type {
  EstimateSummary,
  InvoiceSummary,
  PaymentListRow,
  SubscriptionRow,
} from '@/lib/api/types';
import { dateOf, fmtDateLong } from '@/lib/calendar/time';
import { useLiveVersion } from '@/lib/realtime/live-provider';

export interface RecordMoney {
  readonly estimates: readonly EstimateSummary[];
  readonly invoices: readonly InvoiceSummary[];
  readonly subscriptions: readonly SubscriptionRow[];
  readonly payments: readonly PaymentListRow[];
  /** What their live invoices still come to. */
  readonly balanceCents: number;
  readonly collectedCents: number;
  readonly quotedCents: number;
  /** Nothing to show at all: no documents, no payments. */
  readonly empty: boolean;
}

/**
 * This record's money, reloaded whenever a document or a payment moves. A refusal reads as nothing to show,
 * never as an error: whoever is reading simply doesn't have this customer's money on their screen.
 */
export function useRecordMoney(
  workspaceId: string,
  recordType: 'person' | 'lead',
  recordId: string | null,
  opts: { readonly payments?: boolean } = {},
): RecordMoney | null {
  const version = useLiveVersion(['invoice', 'payment', 'estimate', 'subscription']);
  const wantPayments = opts.payments ?? false;
  const [found, setFound] = useState<RecordMoney | null>(null);
  const load = useCallback(async () => {
    if (!recordId) return;
    const api = apiBrowser();
    try {
      const got = unwrap(
        await api.POST('/v1/queries/money.for_record', {
          body: { workspaceId, recordType, recordId },
        }),
      );
      // A member's own payments come with the invoices they can see; the same rule, one query further on.
      const payments =
        wantPayments && recordType === 'person'
          ? await api
              .POST('/v1/queries/payment.list', {
                body: { workspaceId, personId: recordId, succeededOnly: true, limit: 25 },
              })
              .then((r) => unwrap(r).payments)
              .catch(() => [])
          : [];
      setFound({
        ...got,
        payments,
        empty:
          !got.estimates.length &&
          !got.invoices.length &&
          !got.subscriptions.length &&
          !payments.length,
      });
    } catch {
      setFound(null);
    }
  }, [workspaceId, recordType, recordId, wantPayments]);
  useEffect(() => {
    void load();
  }, [load, version]);
  return found;
}

/** "Owes $2,551.88" beside a customer's name. Nothing at all when they owe nothing. */
export function OwesBadge({ found }: { found: RecordMoney | null }) {
  if (!found || found.balanceCents <= 0) return null;
  return (
    <Badge variant="pending" data-testid="record-owes">
      Owes {money(found.balanceCents)}
    </Badge>
  );
}

const Row = ({
  href,
  left,
  right,
  sub,
  badge,
  testId,
}: {
  href: string;
  left: string;
  right: string;
  sub: string;
  badge: React.ReactNode;
  testId: string;
}) => (
  <Link
    href={href}
    className="flex items-center gap-3 border-t border-border px-1 py-2.5 first:border-t-0 hover:bg-card-2"
    data-testid={testId}
  >
    <span className="flex min-w-0 flex-1 flex-col">
      <span className="truncate text-[13px] font-medium">{left}</span>
      <span className="truncate text-xs text-text-3">{sub}</span>
    </span>
    {badge}
    <span className="whitespace-nowrap text-[13px] font-medium tabular-nums">{right}</span>
  </Link>
);

const docSub = (d: { number: string | null; createdAt: string }, timeZone: string): string =>
  [d.number, fmtDateLong(dateOf(d.createdAt, timeZone))].filter(Boolean).join(' · ');

/** One heading with a count, so a long list still reads as three short ones. */
const Head = ({ children, count }: { children: string; count: number }) => (
  <div className="mb-0.5 mt-4 flex items-baseline gap-2 first:mt-0">
    <h4 className="text-[13px] font-semibold">{children}</h4>
    <span className="text-xs text-text-3">{count}</span>
  </div>
);

/**
 * The Money tab on a customer's record: what they owe, then what has been quoted, billed and paid, and the
 * plan they are on if there is one.
 */
export function RecordMoneyTab({
  workspaceId,
  personId,
  personName,
  found,
  canManage,
  timeZone,
}: {
  workspaceId: string;
  personId: string;
  personName: string;
  found: RecordMoney | null;
  canManage: boolean;
  timeZone: string;
}) {
  const base = `/app/w/${workspaceId}/money`;
  if (!found)
    return (
      <Card className="px-4 py-4 md:px-[18px]" data-testid="record-money">
        <p className="py-6 text-center text-[13px] text-text-2">Loading…</p>
      </Card>
    );
  return (
    <Card className="px-4 py-4 md:px-[18px]" data-testid="record-money">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <div className="text-[22px] font-semibold tracking-tight" data-testid="record-owed">
            {found.balanceCents > 0 ? money(found.balanceCents) : 'Nothing owed'}
          </div>
          <p className="text-[13px] text-text-2">
            {found.balanceCents > 0
              ? `${personName} has ${found.invoices.filter((i) => i.balanceCents > 0).length === 1 ? 'an invoice' : 'invoices'} still to pay.`
              : found.collectedCents > 0
                ? `${money(found.collectedCents)} paid in all. Nothing outstanding.`
                : 'Nothing has been billed yet.'}
          </p>
        </div>
        {canManage ? (
          <div className="flex gap-2">
            <ButtonLink
              href={`${base}/estimates/new?person=${personId}`}
              size="sm"
              data-testid="record-new-estimate"
            >
              <FilePlus2 className="h-3.5 w-3.5" strokeWidth={1.5} />
              New estimate
            </ButtonLink>
            <ButtonLink
              href={`${base}/invoices/new?person=${personId}`}
              size="sm"
              data-testid="record-new-invoice"
            >
              <Receipt className="h-3.5 w-3.5" strokeWidth={1.5} />
              New invoice
            </ButtonLink>
          </div>
        ) : null}
      </div>

      {found.empty ? (
        <div className="mt-4 rounded-card border border-dashed border-border-strong px-4 py-6 text-center">
          <div className="text-[15px] font-semibold">Nothing billed to {personName} yet</div>
          <p className="mx-auto mt-1 max-w-[42ch] text-[13px] text-text-2">
            {canManage
              ? 'Quote a job with an estimate, or bill one straight away with an invoice. Whatever they pay shows up here.'
              : 'Estimates and invoices on the jobs you work show up here.'}
          </p>
        </div>
      ) : null}

      {found.subscriptions.length ? (
        <div className="mt-4">
          <Head count={found.subscriptions.length}>On a plan</Head>
          {found.subscriptions.map((s) => (
            <Row
              key={s.id}
              testId="record-plan"
              href={`${base}/plans/${s.id}`}
              left={s.planName}
              sub={
                s.nextBillingOn
                  ? `Next bill ${fmtDateLong(s.nextBillingOn)}`
                  : (s.cancelReason ?? 'Not billing')
              }
              right={money(s.priceCents)}
              badge={<StatusBadge kind="subscription" state={s.status} />}
            />
          ))}
        </div>
      ) : null}

      {found.estimates.length ? (
        <div className="mt-4">
          <Head count={found.estimates.length}>Estimates</Head>
          {found.estimates.map((e) => (
            <Row
              key={e.id}
              testId="record-estimate"
              href={`${base}/estimates/${e.id}`}
              left={e.title ?? 'Estimate'}
              sub={docSub(e, timeZone)}
              right={money(e.totals.totalCents)}
              badge={<StatusBadge kind="estimate" state={e.state} />}
            />
          ))}
        </div>
      ) : null}

      {found.invoices.length ? (
        <div className="mt-4">
          <Head count={found.invoices.length}>Invoices</Head>
          {found.invoices.map((i) => (
            <Row
              key={i.id}
              testId="record-invoice"
              href={`${base}/invoices/${i.id}`}
              left={i.title ?? 'Invoice'}
              sub={
                i.balanceCents > 0
                  ? `${docSub(i, timeZone)} · ${money(i.balanceCents)} still owed`
                  : docSub(i, timeZone)
              }
              right={money(i.totals.totalCents)}
              badge={<StatusBadge kind="invoice" state={i.state} />}
            />
          ))}
        </div>
      ) : null}

      {found.payments.length ? (
        <div className="mt-4">
          <Head count={found.payments.length}>Payments</Head>
          {found.payments.map((p) => (
            <Row
              key={p.id}
              testId="record-payment"
              href={`${base}/invoices/${p.invoiceId}`}
              left={p.invoiceNumber ?? 'Payment'}
              sub={[
                p.receivedAt ? fmtDateLong(dateOf(p.receivedAt, timeZone)) : null,
                p.cardBrand && p.cardLast4
                  ? `${p.cardBrand} •••• ${p.cardLast4}`
                  : p.method === 'ach'
                    ? 'Bank transfer'
                    : p.method,
              ]
                .filter(Boolean)
                .join(' · ')}
              right={money(p.amountCents)}
              badge={<StatusBadge kind="payment" state={p.status} />}
            />
          ))}
        </div>
      ) : null}
    </Card>
  );
}

/**
 * The Money card on a lead: what has been quoted or billed against this job, and a way to quote it. The
 * estimate opens with the customer and the lead already filled in, so nobody types either twice.
 */
export function LeadMoneyCard({
  workspaceId,
  leadId,
  personId,
  found,
  canManage,
  timeZone,
}: {
  workspaceId: string;
  leadId: string;
  personId: string | null;
  found: RecordMoney | null;
  canManage: boolean;
  timeZone: string;
}) {
  const base = `/app/w/${workspaceId}/money`;
  // A member who may not see this lead's money gets no card, not an empty one.
  if (!found || (found.empty && !canManage)) return null;
  const newEstimate = `${base}/estimates/new?lead=${leadId}${personId ? `&person=${personId}` : ''}`;
  return (
    <Card className="px-4 pb-3 pt-4 md:px-[18px]" data-testid="lead-money">
      <div className="mb-1 flex items-center justify-between gap-3">
        <h3 className="text-[15px] font-semibold">Money</h3>
        {canManage ? (
          <ButtonLink href={newEstimate} variant="ghost" size="sm" data-testid="lead-new-estimate">
            <FilePlus2 className="h-4 w-4" strokeWidth={1.5} />
            New estimate
          </ButtonLink>
        ) : null}
      </div>
      {found.empty ? (
        <p className="border-t border-border py-3 text-[13px] text-text-2">
          Nothing quoted for this job yet. An estimate here opens with the customer and this lead
          already on it.
        </p>
      ) : (
        <div className="border-t border-border pt-1">
          {found.estimates.map((e) => (
            <Row
              key={e.id}
              testId="lead-estimate"
              href={`${base}/estimates/${e.id}`}
              left={e.title ?? 'Estimate'}
              sub={docSub(e, timeZone)}
              right={money(e.totals.totalCents)}
              badge={<StatusBadge kind="estimate" state={e.state} />}
            />
          ))}
          {found.invoices.map((i) => (
            <Row
              key={i.id}
              testId="lead-invoice"
              href={`${base}/invoices/${i.id}`}
              left={i.title ?? 'Invoice'}
              sub={
                i.balanceCents > 0
                  ? `${docSub(i, timeZone)} · ${money(i.balanceCents)} still owed`
                  : docSub(i, timeZone)
              }
              right={money(i.totals.totalCents)}
              badge={<StatusBadge kind="invoice" state={i.state} />}
            />
          ))}
        </div>
      )}
    </Card>
  );
}

/**
 * What this customer owes, beside the conversation. Nothing at all when they owe nothing — the panel is for
 * what would change how you answer, and a settled account wouldn't.
 */
export function InboxOwed({
  workspaceId,
  personId,
  found,
}: {
  workspaceId: string;
  personId: string;
  found: RecordMoney | null;
}) {
  if (!found || found.balanceCents <= 0) return null;
  const owed = found.invoices.filter((i) => i.balanceCents > 0);
  const late = owed.filter((i) => i.state === 'overdue');
  return (
    <div className="flex flex-col gap-1.5" data-testid="context-owed">
      <span className="text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3">
        Owes
      </span>
      <div className="flex items-center gap-2">
        <span className="text-[17px] font-semibold tabular-nums">{money(found.balanceCents)}</span>
        {late.length ? <StatusBadge kind="invoice" state="overdue" /> : null}
      </div>
      <span className="text-xs text-text-3">
        {owed.length === 1 ? 'One invoice' : `${owed.length} invoices`} still to pay
        {late.length ? `, ${late.length === 1 ? 'one' : late.length} past due` : ''}.
      </span>
      <Link
        href={`/app/w/${workspaceId}/customers/people/${personId}?tab=money`}
        className="inline-flex items-center gap-1 text-[12.5px] font-medium text-accent-text hover:underline"
      >
        See their money
        <ArrowRight className="h-3.5 w-3.5" strokeWidth={1.5} />
      </Link>
    </div>
  );
}
