import {
  estimateStanding,
  ESTIMATE_WORDS,
  headlineFigures,
  INVOICE_WORDS,
  invoiceDueLabel,
  listState,
  money,
  PAYMENT_METHOD_LABELS,
  PAYMENT_PROVIDER_LABELS,
  PAYMENT_STATUS_WORDS,
  planPriceLabel,
  purposeLabel,
  REFUND_WORDS,
  SUBSCRIPTION_WORDS,
  dayLabel,
  type EstimateState,
  type InvoiceState,
  type MoneySummaryFacts,
  type PaymentMethod,
} from '@hfos/core';
import * as React from 'react';
import { Pressable, View } from 'react-native';

import { ChevronRight, CloudUpload } from '@/components/icons';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';
import type { PaymentRow, PhoneEstimate, PhoneInvoice, SubscriptionRow } from '@/money/use-money';

/**
 * Money's rows and its three figures, as the canvas draws them at phone width: the number, the state, the customer,
 * what it is for, when it is due and how much — every word core's, so the phone and the web agree.
 */

/** How loudly each state reads. The words themselves are core's. */
const INVOICE_TONE: Readonly<Record<string, 'accent' | 'ok' | 'gray' | 'danger' | 'pending'>> = {
  draft: 'gray',
  sent: 'accent',
  viewed: 'accent',
  partly_paid: 'pending',
  paying: 'pending',
  paid: 'ok',
  partly_refunded: 'ok',
  refunded: 'gray',
  overdue: 'danger',
  void: 'gray',
};

const ESTIMATE_TONE: Readonly<Record<string, 'accent' | 'ok' | 'gray' | 'danger' | 'pending'>> = {
  draft: 'gray',
  sent: 'accent',
  viewed: 'accent',
  accepted: 'ok',
  declined: 'danger',
  expired: 'gray',
  void: 'gray',
};

export function StateBadge({
  state,
  kind,
  testID,
}: {
  state: string;
  kind: 'invoice' | 'estimate' | 'payment' | 'subscription' | 'refund';
  testID?: string;
}) {
  const word =
    kind === 'invoice'
      ? (INVOICE_WORDS[state as InvoiceState] ?? state)
      : kind === 'estimate'
        ? (ESTIMATE_WORDS[state as EstimateState] ?? state)
        : kind === 'payment'
          ? (PAYMENT_STATUS_WORDS[state as keyof typeof PAYMENT_STATUS_WORDS] ?? state)
          : kind === 'subscription'
            ? (SUBSCRIPTION_WORDS[state] ?? state)
            : (REFUND_WORDS[state] ?? state);
  const tone =
    kind === 'estimate'
      ? (ESTIMATE_TONE[state] ?? 'gray')
      : kind === 'invoice'
        ? (INVOICE_TONE[state] ?? 'gray')
        : state === 'succeeded' || state === 'active'
          ? 'ok'
          : state === 'failed' || state === 'past_due'
            ? 'danger'
            : state === 'processing' || state === 'pending'
              ? 'pending'
              : 'gray';
  return (
    <Badge variant={tone} testID={testID}>
      <Text>{word}</Text>
    </Badge>
  );
}

/** The three figures over the lists: only ever shown to someone who sees the whole business. */
export function HeadlineStrip({
  summary,
  timeZone,
}: {
  summary: MoneySummaryFacts;
  timeZone: string;
}) {
  return (
    <View className="flex-row gap-px overflow-hidden rounded-card border border-border bg-border">
      {headlineFigures(summary, timeZone).map((f) => (
        <View key={f.key} className="flex-1 gap-0.5 bg-card px-3 py-3" testID={`money-${f.key}`}>
          <Text
            className={cn(
              'text-lg font-semibold leading-[22px]',
              f.tone === 'bad' && 'text-danger-text',
              f.tone === 'good' && 'text-success-text',
            )}
            testID={`money-${f.key}-value`}
            numberOfLines={1}
            adjustsFontSizeToFit
          >
            {f.value}
          </Text>
          <Text className="text-[12px] text-text-2">{f.label}</Text>
        </View>
      ))}
    </View>
  );
}

/** The sentence under the figures, which the canvas puts in one line. */
export function HeadlineNote({
  summary,
  timeZone,
}: {
  summary: MoneySummaryFacts;
  timeZone: string;
}) {
  const [outstanding, , collected] = headlineFigures(summary, timeZone);
  return (
    <Text className="px-1 text-xs leading-[1.45] text-text-3" testID="money-headline-note">
      {`${outstanding!.sub}. Collected ${collected!.sub}.`}
    </Text>
  );
}

function Row({
  onPress,
  testID,
  label,
  children,
}: {
  onPress: () => void;
  testID: string;
  /** What an iPhone reads out: a row is one thing there, so everything on it goes in the label. */
  label: string;
  children: React.ReactNode;
}) {
  return (
    <Pressable
      role="button"
      accessibilityLabel={label}
      onPress={onPress}
      testID={testID}
      className="min-h-16 flex-row items-center gap-3 border-b border-border bg-card px-3.5 py-3 active:bg-card-2"
    >
      <View className="min-w-0 flex-1 gap-1">{children}</View>
      <Icon as={ChevronRight} className="size-4 flex-none text-text-3" />
    </Pressable>
  );
}

/** Waiting on this phone: the change was made here and HandsFreeOS hasn't heard yet. */
function WaitingChip() {
  return (
    <View
      className="flex-row items-center gap-1 rounded-full bg-card-2 px-2 py-0.5"
      testID="money-waiting"
    >
      <Icon as={CloudUpload} className="size-3 text-text-3" />
      <Text className="text-[11.5px] text-text-3">Waiting to send</Text>
    </View>
  );
}

export function InvoiceRowView({
  invoice,
  now,
  timeZone,
  onPress,
}: {
  invoice: PhoneInvoice;
  now: number;
  timeZone: string;
  onPress: (invoice: PhoneInvoice) => void;
}) {
  const purpose = purposeLabel(invoice.purpose);
  const due = invoiceDueLabel(
    {
      status: invoice.status,
      state: invoice.state,
      dueOn: invoice.due_on,
      paidAt: invoice.paid_at,
      voidedAt: invoice.voided_at,
    },
    now,
    timeZone,
  );
  return (
    <Row
      onPress={() => onPress(invoice)}
      testID={`invoice-row-${invoice.number ?? invoice.id}`}
      label={[
        invoice.number,
        INVOICE_WORDS[invoice.state] ?? invoice.state,
        purpose,
        invoice.person_name,
        invoice.title,
        due,
        money(invoice.totalCents),
      ]
        .filter(Boolean)
        .join(' · ')}
    >
      <View className="flex-row items-center gap-2">
        <Text className="font-mono text-[12.5px] text-text-2">{invoice.number ?? '—'}</Text>
        <StateBadge state={invoice.state} kind="invoice" testID="invoice-state" />
        {purpose ? (
          <Badge variant="gray">
            <Text>{purpose}</Text>
          </Badge>
        ) : null}
        {invoice.pending && invoice.pending.state !== 'sent' ? <WaitingChip /> : null}
      </View>
      <View className="flex-row items-center gap-2">
        <Avatar name={invoice.person_name} seed={invoice.person_id ?? invoice.id} size="sm" />
        <Text className="min-w-0 flex-1 text-[15px] font-medium" numberOfLines={1}>
          {invoice.person_name}
        </Text>
        <Text className="text-[15px] font-semibold">{money(invoice.totalCents)}</Text>
      </View>
      <View className="flex-row items-center justify-between gap-3">
        <Text className="min-w-0 flex-1 text-[13px] text-text-2" numberOfLines={1}>
          {invoice.title ?? '—'}
        </Text>
        <Text className="text-[12.5px] text-text-3">{due}</Text>
      </View>
    </Row>
  );
}

export function EstimateRowView({
  estimate,
  now,
  timeZone,
  onPress,
}: {
  estimate: PhoneEstimate;
  now: number;
  timeZone: string;
  onPress: (estimate: PhoneEstimate) => void;
}) {
  return (
    <Row
      onPress={() => onPress(estimate)}
      testID={`estimate-row-${estimate.number ?? estimate.id}`}
      label={[
        estimate.number ?? 'Draft',
        ESTIMATE_WORDS[estimate.state] ?? estimate.state,
        estimate.person_name,
        money(estimate.total_cents ?? 0),
      ]
        .filter(Boolean)
        .join(' · ')}
    >
      <View className="flex-row items-center gap-2">
        <Text className="font-mono text-[12.5px] text-text-2">{estimate.number ?? 'Draft'}</Text>
        <StateBadge state={listState(estimate.state)} kind="estimate" />
      </View>
      <View className="flex-row items-center gap-2">
        <Avatar name={estimate.person_name} seed={estimate.person_id ?? estimate.id} size="sm" />
        <Text className="min-w-0 flex-1 text-[15px] font-medium" numberOfLines={1}>
          {estimate.person_name}
        </Text>
        <Text className="text-[15px] font-semibold">{money(estimate.total_cents ?? 0)}</Text>
      </View>
      <Text className="text-[12.5px] text-text-3" numberOfLines={1}>
        {estimateStanding(
          {
            voidedAt: estimate.voided_at,
            acceptedAt: estimate.accepted_at,
            declinedAt: estimate.declined_at,
            sentAt: estimate.sent_at,
            firstViewedAt: estimate.first_viewed_at,
            createdAt: estimate.created_at,
            expiresOn: estimate.expires_on,
          },
          now,
          timeZone,
        )}
      </Text>
    </Row>
  );
}

export function PaymentRowView({
  payment,
  timeZone,
  onPress,
}: {
  payment: PaymentRow;
  timeZone: string;
  onPress: (payment: PaymentRow) => void;
}) {
  const how = [
    PAYMENT_METHOD_LABELS[payment.method as PaymentMethod] ?? payment.method,
    payment.provider ? (PAYMENT_PROVIDER_LABELS[payment.provider] ?? payment.provider) : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const when = payment.received_at ?? payment.created_at;
  return (
    <Row
      onPress={() => onPress(payment)}
      testID={`payment-row-${payment.id}`}
      label={[payment.person_name, how, money(payment.amount_cents)].filter(Boolean).join(' · ')}
    >
      <View className="flex-row items-center gap-2">
        <Text className="min-w-0 flex-1 text-[15px] font-medium" numberOfLines={1}>
          {payment.person_name ?? '—'}
        </Text>
        <Text className="text-[15px] font-semibold">{money(payment.amount_cents)}</Text>
      </View>
      <View className="flex-row items-center gap-2">
        <StateBadge state={payment.status} kind="payment" />
        <Text className="min-w-0 flex-1 text-[12.5px] text-text-3" numberOfLines={1}>
          {[how, payment.invoice_number, when ? dayLabel(Date.parse(when), timeZone) : null]
            .filter(Boolean)
            .join(' · ')}
        </Text>
      </View>
      {payment.refunded_cents > 0 ? (
        <Text className="text-[12.5px] text-text-3">
          {`${money(payment.refunded_cents)} refunded`}
        </Text>
      ) : null}
    </Row>
  );
}

export function PlanRowView({
  plan,
  timeZone,
  onPress,
}: {
  plan: SubscriptionRow;
  timeZone: string;
  onPress: (plan: SubscriptionRow) => void;
}) {
  return (
    <Row
      onPress={() => onPress(plan)}
      testID={`plan-row-${plan.id}`}
      label={[plan.person_name, plan.plan_name, SUBSCRIPTION_WORDS[plan.status] ?? plan.status]
        .filter(Boolean)
        .join(' · ')}
    >
      <View className="flex-row items-center gap-2">
        <Text className="min-w-0 flex-1 text-[15px] font-medium" numberOfLines={1}>
          {plan.person_name}
        </Text>
        <Text className="text-[15px] font-semibold">
          {planPriceLabel(plan.price_cents, plan.interval, plan.interval_count)}
        </Text>
      </View>
      <View className="flex-row items-center gap-2">
        <StateBadge state={plan.status} kind="subscription" />
        <Text className="min-w-0 flex-1 text-[12.5px] text-text-3" numberOfLines={1}>
          {[
            plan.plan_name,
            plan.next_billing_on
              ? `Next charge ${dayLabel(Date.parse(`${plan.next_billing_on}T12:00:00Z`), timeZone)}`
              : 'No next bill yet',
          ]
            .filter(Boolean)
            .join(' · ')}
        </Text>
      </View>
    </Row>
  );
}
