import {
  ESTIMATE_WORDS,
  INVOICE_WORDS,
  PAYMENT_STATUS_WORDS,
  type EstimateState,
  type InvoiceState,
  type PaymentStatus,
} from '@hfos/core';
import {
  AlertTriangle,
  Ban,
  Check,
  CircleDollarSign,
  Clock,
  Eye,
  Hourglass,
  Pause,
  Send,
  Undo2,
  X,
} from 'lucide-react';
import type { ComponentType } from 'react';
import { cn } from '@/lib/utils';

/**
 * The look of every money state, straight from the canvas: a draft is quiet, a sent document takes the accent,
 * money on its way is amber, money in is green, and late is red. A voided document is struck through. Money
 * given back wears the refund's own arrow: green while some of it is still in, quiet once all of it went back.
 */
export type StatusLook = 'draft' | 'sent' | 'waiting' | 'paid' | 'late' | 'void' | 'quiet';

const LOOKS: Readonly<Record<StatusLook, string>> = {
  draft: 'bg-card-2 text-text-3',
  sent: 'bg-accent-soft text-accent-text',
  waiting: 'bg-warning-soft text-warning-text',
  paid: 'bg-success-soft text-success-text',
  late: 'bg-danger-soft text-danger-text',
  void: 'bg-card-2 text-text-3 line-through',
  quiet: 'bg-card-2 text-text-2',
};

type Icon = ComponentType<{ className?: string; strokeWidth?: number }>;

interface Face {
  readonly look: StatusLook;
  readonly icon: Icon | null;
}

const ESTIMATE_FACES: Readonly<Record<EstimateState, Face>> = {
  draft: { look: 'draft', icon: null },
  sent: { look: 'sent', icon: Send },
  viewed: { look: 'sent', icon: Eye },
  accepted: { look: 'paid', icon: Check },
  declined: { look: 'quiet', icon: X },
  expired: { look: 'quiet', icon: Hourglass },
  void: { look: 'void', icon: null },
};

const INVOICE_FACES: Readonly<Record<InvoiceState, Face>> = {
  draft: { look: 'draft', icon: null },
  sent: { look: 'sent', icon: Send },
  viewed: { look: 'sent', icon: Eye },
  partly_paid: { look: 'waiting', icon: CircleDollarSign },
  paying: { look: 'waiting', icon: Clock },
  paid: { look: 'paid', icon: Check },
  partly_refunded: { look: 'paid', icon: Undo2 },
  refunded: { look: 'quiet', icon: Undo2 },
  overdue: { look: 'late', icon: AlertTriangle },
  void: { look: 'void', icon: null },
};

const PAYMENT_FACES: Readonly<Record<PaymentStatus, Face>> = {
  requires_payment: { look: 'quiet', icon: null },
  processing: { look: 'waiting', icon: Clock },
  succeeded: { look: 'paid', icon: Check },
  failed: { look: 'late', icon: AlertTriangle },
};

/** Plans: the words and the looks the plan list and the plan page share. */
const SUBSCRIPTION_FACES: Readonly<Record<string, Face & { word: string }>> = {
  draft: { look: 'draft', icon: null, word: 'Draft' },
  active: { look: 'paid', icon: Check, word: 'Billing' },
  past_due: { look: 'late', icon: AlertTriangle, word: 'Payment failed' },
  paused: { look: 'quiet', icon: Pause, word: 'Paused' },
  cancelled: { look: 'void', icon: null, word: 'Cancelled' },
  unmanaged: { look: 'waiting', icon: Ban, word: 'Not managed here' },
};

const REFUND_FACES: Readonly<Record<string, Face & { word: string }>> = {
  pending: { look: 'waiting', icon: Clock, word: 'Refunding' },
  succeeded: { look: 'quiet', icon: Check, word: 'Refunded' },
  failed: { look: 'late', icon: AlertTriangle, word: 'Refund failed' },
};

const UNKNOWN: Face = { look: 'quiet', icon: null };

function faceOf(
  kind: 'estimate' | 'invoice' | 'payment' | 'subscription' | 'refund',
  state: string,
): Face & { word: string } {
  if (kind === 'estimate') {
    const face = ESTIMATE_FACES[state as EstimateState] ?? UNKNOWN;
    return { ...face, word: ESTIMATE_WORDS[state as EstimateState] ?? state };
  }
  if (kind === 'invoice') {
    const face = INVOICE_FACES[state as InvoiceState] ?? UNKNOWN;
    return { ...face, word: INVOICE_WORDS[state as InvoiceState] ?? state };
  }
  if (kind === 'payment') {
    const face = PAYMENT_FACES[state as PaymentStatus] ?? UNKNOWN;
    return { ...face, word: PAYMENT_STATUS_WORDS[state as PaymentStatus] ?? state };
  }
  if (kind === 'subscription') return SUBSCRIPTION_FACES[state] ?? { ...UNKNOWN, word: state };
  return REFUND_FACES[state] ?? { ...UNKNOWN, word: state };
}

/**
 * What a document, payment, plan or refund reads as right now. `state` is the query's own `state` field, which
 * already folds in "Opened", "Paying" and "Overdue" — the words come from core so a screen, an email and the
 * customer's page never disagree.
 */
export function StatusBadge({
  kind,
  state,
  className,
  testId,
}: {
  kind: 'estimate' | 'invoice' | 'payment' | 'subscription' | 'refund';
  state: string;
  className?: string;
  testId?: string;
}) {
  const { look, icon: Icon, word } = faceOf(kind, state);
  return (
    <span
      data-testid={testId}
      data-state={state}
      className={cn(
        'inline-flex h-[22px] items-center gap-1.5 whitespace-nowrap rounded-control px-2 text-xs font-semibold',
        LOOKS[look],
        className,
      )}
    >
      {Icon ? <Icon className="h-3 w-3" strokeWidth={1.75} /> : null}
      {word}
    </span>
  );
}
