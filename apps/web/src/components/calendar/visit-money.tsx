'use client';
/**
 * The money on one visit, inside the appointment sheet.
 *
 * Two things it exists to say, in the order they matter:
 *
 * 1. **A time held while a customer pays its deposit is not a booking.** It is a real appointment on a real
 *    slot for up to fifteen minutes, and without this it reads to staff exactly like a confirmed one —
 *    somebody rings to confirm a visit nobody has paid for, or works around a slot that is about to free
 *    itself. So it says so first, in words, with the moment the hold runs out.
 * 2. **Once the deposit is paid**, the same block says what was paid, when, and what is left for after the
 *    visit — the same three figures the customer was shown on the booking page, so the two agree.
 *
 * Everything comes from `money.for_record`, which already carries the member rule: a member staffed on this
 * visit sees its deposit and its invoice, and one who isn't sees an empty answer and so no block at all.
 */
import { money } from '@hfos/core';
import { Clock, FileText } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { apiBrowser, unwrap } from '@/lib/api/client';
import type { AppointmentDetail, InvoiceSummary, MoneyForRecordOut } from '@/lib/api/types';
import { dateOf, fmtAt, fmtDateLong } from '@/lib/calendar/time';
import { useLiveVersion } from '@/lib/realtime/live-provider';
import type { Hold } from './appt';
import { holdWords } from './appt';

/** The deposit a booking raised: its own invoice, linked to the seat, marked as coming from the booking page. */
const depositOf = (invoices: readonly InvoiceSummary[]): InvoiceSummary | null =>
  invoices.find((i) => i.origin === 'booking' && i.status !== 'void') ?? null;

/** The bill for the job itself: anything on this visit that isn't the deposit that booked it. */
const jobInvoiceOf = (invoices: readonly InvoiceSummary[]): InvoiceSummary | null =>
  invoices.find((i) => i.origin !== 'booking' && i.status !== 'void') ?? null;

export interface VisitMoney {
  readonly invoices: readonly InvoiceSummary[];
  readonly deposit: InvoiceSummary | null;
  readonly jobInvoice: InvoiceSummary | null;
  readonly balanceCents: number;
  readonly collectedCents: number;
}

/**
 * What this visit's money comes to, reloaded whenever an invoice or a payment moves. A refusal is treated as
 * "nothing to show": a member who may not see this visit's money gets no block, never an error in its place.
 */
export function useVisitMoney(
  workspaceId: string,
  appointmentId: string | null,
): VisitMoney | null {
  const version = useLiveVersion(['invoice', 'payment', 'refund']);
  const [found, setFound] = useState<MoneyForRecordOut | null>(null);
  const load = useCallback(async () => {
    if (!appointmentId) return;
    try {
      setFound(
        unwrap(
          await apiBrowser().POST('/v1/queries/money.for_record', {
            body: { workspaceId, recordType: 'appointment', recordId: appointmentId },
          }),
        ),
      );
    } catch {
      setFound(null);
    }
  }, [workspaceId, appointmentId]);
  useEffect(() => {
    void load();
  }, [load, version]);
  if (!found) return null;
  return {
    invoices: found.invoices,
    deposit: depositOf(found.invoices),
    jobInvoice: jobInvoiceOf(found.invoices),
    balanceCents: found.balanceCents,
    collectedCents: found.collectedCents,
  };
}

/** What is left for the invoice after the visit: the price of the visit less the deposit already taken. */
export function dueAfterCents(priceCents: number | null, deposit: InvoiceSummary | null): number {
  if (!priceCents || !deposit) return 0;
  return Math.max(0, priceCents - deposit.totals.totalCents);
}

/**
 * Bill this visit: a draft invoice for the job, linked to the same seat the deposit is, **with the deposit
 * already taken off**. A paid deposit makes it a balance rather than a fresh bill, and the line says so in
 * words, so the customer reads one story across the two documents rather than being asked for the price
 * twice. It opens as a draft — nothing goes out until someone sends it.
 */
export async function invoiceThisVisit(
  workspaceId: string,
  appt: AppointmentDetail,
  seat: { id: string; personId: string },
  deposit: InvoiceSummary | null,
  timeZone: string,
): Promise<string> {
  const what = appt.service?.name ?? appt.title;
  const paid = deposit && deposit.status !== 'draft' ? deposit.totals.totalCents : 0;
  const after = paid ? dueAfterCents(appt.priceCents, deposit) : (appt.priceCents ?? 0);
  const out = unwrap(
    await apiBrowser().POST('/v1/commands/invoice.create', {
      body: {
        workspaceId,
        personId: seat.personId,
        leadId: appt.leadId,
        attendeeId: seat.id,
        purpose: paid ? 'balance' : 'standard',
        origin: 'staff',
        title: what,
        lines: [
          {
            name: what,
            description: paid
              ? `${fmtDateLong(dateOf(appt.startsAt, timeZone))}. Less the ${money(paid)} deposit already paid${deposit?.number ? ` on ${deposit.number}` : ''}.`
              : fmtDateLong(dateOf(appt.startsAt, timeZone)),
            quantity: 1,
            unitLabel: 'each',
            unitPriceCents: after,
            taxable: true,
          },
        ],
      },
    }),
  );
  return out.invoiceId;
}

const Line = ({ label, value, testId }: { label: string; value: string; testId?: string }) => (
  <div className="flex items-baseline justify-between gap-3 py-[3px] text-[13px]">
    <span className="text-text-2">{label}</span>
    <span className="font-medium tabular-nums" data-testid={testId}>
      {value}
    </span>
  </div>
);

function InvoiceLink({
  workspaceId,
  invoice,
  label,
}: {
  workspaceId: string;
  invoice: InvoiceSummary;
  label: string;
}) {
  return (
    <Link
      href={`/app/w/${workspaceId}/money/invoices/${invoice.id}`}
      className="mt-1 inline-flex items-center gap-1.5 text-[12.5px] font-medium text-accent-text hover:underline"
    >
      <FileText className="h-3.5 w-3.5" strokeWidth={1.5} />
      {label}
      {invoice.number ? ` · ${invoice.number}` : ''}
    </Link>
  );
}

/**
 * The block itself. Held comes first and loudest; then the deposit as it stands; then the bill for the job.
 * Renders nothing at all when this visit has no money on it and nothing is being held.
 */
export function VisitMoneyBlock({
  workspaceId,
  appt,
  hold,
  found,
  timeZone,
  customerName,
}: {
  workspaceId: string;
  appt: AppointmentDetail;
  /** Set while this time is only held for a deposit. */
  hold: Hold | null;
  found: VisitMoney | null;
  timeZone: string;
  /** The first name of whoever is paying, for the sentence about them. */
  customerName: string;
}) {
  const deposit = found?.deposit ?? null;
  const job = found?.jobInvoice ?? null;
  if (!hold && !deposit && !job) return null;

  const asked = deposit?.totals.totalCents ?? 0;
  const paidDeposit = deposit ? deposit.amountPaidCents : 0;
  // A bank transfer takes a day or two to land: the deposit is in, and the money is still on its way.
  const settling = !!deposit && deposit.state === 'paying' && paidDeposit === 0;
  const after = dueAfterCents(appt.priceCents, deposit);
  const paidAt = deposit?.paidAt ?? null;

  return (
    <div className="mt-3.5" data-testid="visit-money">
      <div className="mb-0.5 text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3">
        {hold ? 'Not booked yet' : 'Deposit'}
      </div>

      {hold ? (
        <div
          className="flex flex-col gap-1.5 rounded-[10px] bg-warning-soft px-3 py-2.5 text-warning-text"
          data-testid="visit-held"
          data-minutes-left={hold.minutesLeft}
        >
          <span className="flex items-center gap-2">
            <Clock className="h-3.5 w-3.5 flex-none" strokeWidth={1.75} aria-hidden />
            <span className="text-[13px] font-semibold">{holdWords(hold, timeZone)}</span>
          </span>
          <span className="text-[12.5px]">
            {asked
              ? `${customerName} is on the payment page now, paying ${money(asked)} to book this time. `
              : `${customerName} is on the payment page now, paying the deposit that books this time. `}
            Nothing has been charged and nobody has been told the time is theirs. Don’t call to
            confirm it — if the deposit doesn’t land, the slot goes back on its own.
          </span>
        </div>
      ) : deposit ? (
        <div
          className="rounded-[10px] border border-border bg-card-2 px-3 py-2.5"
          data-testid="visit-deposit"
          data-state={deposit.state}
        >
          <div className="mb-1 flex items-center gap-2">
            <Badge variant={settling ? 'pending' : 'ok'}>
              {settling ? 'Deposit on its way' : 'Deposit paid'}
            </Badge>
            <span className="min-w-0 flex-1 truncate text-[12.5px] text-text-3">
              {settling
                ? 'A bank transfer takes a day or two to land.'
                : paidAt
                  ? `Paid ${fmtDateLong(dateOf(paidAt, timeZone))} · ${fmtAt(paidAt, timeZone)}`
                  : 'Paid at booking.'}
            </span>
          </div>
          <Line
            label={settling ? 'On its way' : 'Paid'}
            value={money(settling ? asked : paidDeposit)}
            testId="visit-deposit-paid"
          />
          {after > 0 ? (
            <Line
              label="Left to pay after the visit"
              value={money(after)}
              testId="visit-deposit-after"
            />
          ) : null}
          <InvoiceLink workspaceId={workspaceId} invoice={deposit} label="Deposit invoice" />
        </div>
      ) : null}

      {job ? (
        <div
          className="mt-2 rounded-[10px] border border-border bg-card px-3 py-2.5"
          data-testid="visit-invoice"
          data-state={job.state}
        >
          <div className="mb-1 flex items-center gap-2">
            <span className="text-[13px] font-semibold">This visit’s invoice</span>
            <span className="min-w-0 flex-1 truncate text-[12.5px] text-text-3">
              {job.title ?? appt.title}
            </span>
          </div>
          <Line label="Invoiced" value={money(job.totals.totalCents)} testId="visit-invoiced" />
          {job.amountPaidCents > 0 ? (
            <Line label="Paid" value={money(job.amountPaidCents)} testId="visit-invoice-paid" />
          ) : null}
          <Line
            label={job.balanceCents > 0 ? 'Still owed' : 'Nothing owed'}
            value={money(job.balanceCents)}
            testId="visit-invoice-balance"
          />
          <InvoiceLink workspaceId={workspaceId} invoice={job} label="Open the invoice" />
        </div>
      ) : null}
    </div>
  );
}
