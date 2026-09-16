/**
 * An invoice nobody paid: past its due day in the business's time zone, with money still owed. It opens
 * `money.invoiceOverdueDays` after that (one day of grace by default) and clears when the balance does.
 *
 * **A bank transfer settling is not late.** A payment in `processing` takes days to arrive, so while one is on
 * its way the invoice is paying, not overdue — chasing someone who has already paid is worse than waiting.
 *
 * Ask-first only, like the estimate: money never chases itself. Its value is the balance owed, counted once in
 * "$ affected" under its own money key, so it never folds into the lead's value.
 */
import { chip, sinceChip } from '../chips';
import { balanceCents } from '../../money/totals';
import { invoiceIsOpen, overdueFrom, type InvoiceStatus } from '../../money/status';
import { owedWording } from '../../money/words';
import type { BusinessFacts, ValueFacts } from '../facts';
import { fingerprintOf } from '../fingerprint';
import type { AttentionSettings } from '../settings';
import { DAY, defineDetector, detection, type Assessment } from './define';

export interface InvoiceOverdueFacts {
  /** For the time zone: a due day ends where the business is, not in UTC. */
  readonly business: BusinessFacts;
  readonly invoice: {
    readonly id: string;
    readonly status: InvoiceStatus;
    /** The day it's due, as a local date (`2026-09-25`); null when it has none. */
    readonly dueDate: string | null;
    readonly totalCents: number;
    readonly paidCents: number;
    readonly refundedCents: number;
    /** When the customer first opened it; null when they haven't. */
    readonly viewedAt: string | null;
    readonly assigneeUserId: string | null;
  };
  /** A payment is on its way (a bank transfer settling). */
  readonly hasProcessingPayment: boolean;
}

function assess(f: InvoiceOverdueFacts, settings: AttentionSettings, now: number): Assessment {
  const inv = f.invoice;
  if (!invoiceIsOpen(inv.status) || !inv.dueDate) return null;
  if (f.hasProcessingPayment) return null;
  const owed = balanceCents(inv.totalCents, inv.paidCents, inv.refundedCents);
  if (owed <= 0 || owed < settings.money.minBalanceCents) return null;
  const late = overdueFrom(inv.dueDate, f.business.timeZone);
  const opens = late + settings.money.invoiceOverdueDays * DAY;
  if (now < opens) return { wakeAt: opens };
  const value: ValueFacts = {
    value: owed,
    valueIsEstimate: false,
    moneyKey: `invoice:${inv.id}`,
  };
  return detection({
    fingerprint: fingerprintOf('invoice_overdue', {
      invoice: inv.id,
      due: inv.dueDate,
      owed,
    }),
    since: late,
    urgentFrom: null,
    dueAt: late,
    value,
    probability: 0.9,
    confidence: 0.9,
    reasons: [
      chip('amount', owedWording(owed)),
      sinceChip('overdue', late, now),
      ...(inv.viewedAt ? [] : [chip('not_viewed', 'not opened yet')]),
    ],
    assignee: inv.assigneeUserId,
    recheckAt: null,
  });
}

export const { detect, wakeAt } = defineDetector<InvoiceOverdueFacts>('invoice_overdue', assess);
