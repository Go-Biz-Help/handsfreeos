import {
  dayLabel,
  invoiceStanding,
  money,
  MONEY_LINK_WHAT_IT_DOES,
  paidWording,
  PAYMENT_METHOD_LABELS,
  refundedWording,
  type PaymentMethod,
} from '@hfos/core';
import { useLocalSearchParams } from 'expo-router';
import * as React from 'react';
import { Share, View } from 'react-native';

import { HandCoins, Link2, Send } from '@/components/icons';
import { DocumentLines, totalsOf } from '@/components/money/document';
import { StateBadge } from '@/components/money/money-rows';
import { RecordCashSheet } from '@/components/money/record-cash';
import { SendSheet } from '@/components/money/send-sheet';
import { useBusiness } from '@/components/shell/business-context';
import { Screen } from '@/components/shell/screen';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { useNetwork } from '@/lib/network';
import { openWeb } from '@/lib/open-web';
import { moneyLink, sendInvoice } from '@/money/actions';
import { useInvoice, useMoneyNow, useMoneyRole, useMoneyZone } from '@/money/use-money';

/**
 * **One invoice** (the canvas's "Bayou Bistro's invoice"): what is owed, what state it is in, its lines and totals,
 * and what has happened to it — read from the phone's copy, so it is all there at the door with no signal.
 *
 * **Record cash or a check comes first**, because that is what happens at the door. It works with no signal. Sending
 * the document and sending the customer their payment link are under it: sending reaches the customer (fresh for 30
 * minutes), and only the worker can mint a link, so that one needs signal.
 *
 * Editing an invoice is the web's in M10.
 */
export default function Invoice() {
  const { invoiceId } = useLocalSearchParams<{ invoiceId: string }>();
  const { business } = useBusiness();
  // Recording a payment, sending it and copying its link are billing (money.bill, 0105).
  const { bill: manage } = useMoneyRole();
  const timeZone = useMoneyZone();
  const now = useMoneyNow();
  const { invoice, lines, payments, refunds, loading } = useInvoice(invoiceId);
  const { online } = useNetwork();
  const [recording, setRecording] = React.useState(false);
  const [sending, setSending] = React.useState(false);
  const [link, setLink] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  if (!invoice)
    return (
      <Screen title="Invoice" leading="back" testID="invoice">
        <Card className="p-6">
          <Text className="text-center text-text-2">
            {loading ? 'Loading…' : 'This invoice isn’t on this phone.'}
          </Text>
        </Card>
      </Screen>
    );

  const owes = invoice.balanceCents > 0 && invoice.status !== 'void' && invoice.status !== 'draft';
  const standing = invoiceStanding(
    {
      status: invoice.status,
      state: invoice.state,
      dueOn: invoice.due_on,
      voidedAt: invoice.voided_at,
      amountRefundedCents: invoice.refundedCents,
    },
    now,
    timeZone,
  );

  /**
   * The customer's own payment link, from the worker (only it holds the signing key). It needs signal, so with none it
   * says so rather than queueing something that could never run.
   *
   * The link is shown first and sent second, on purpose: the phone's share sheet is another app's screen over this
   * one, and opening it straight away leaves nobody sure what was copied. From the sheet, Send it hands the link to
   * Messages, Mail or Copy — whichever the person wants.
   */
  const paymentLink = async () => {
    setBusy(true);
    try {
      setLink(await moneyLink({ workspaceId: business.id, kind: 'invoice', id: invoiceId }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'That didn’t work.');
    }
    setBusy(false);
  };

  return (
    <Screen
      title={invoice.number ?? 'Invoice'}
      subtitle={invoice.person_name}
      leading="back"
      testID="invoice"
    >
      <Card className="px-3.5 py-3.5">
        <Text className="text-[12.5px] text-text-3">
          {owes ? 'Amount due' : invoice.status === 'paid' ? 'Paid' : 'Total'}
        </Text>
        <Text className="mt-0.5 text-[28px] font-semibold leading-8" testID="invoice-amount">
          {money(owes ? invoice.balanceCents : invoice.totalCents)}
        </Text>
        <View className="mt-2 flex-row flex-wrap items-center gap-2">
          <StateBadge state={invoice.state} kind="invoice" testID="invoice-state" />
          <Text className="text-[12.5px] text-text-3" testID="invoice-standing">
            {[invoice.number, standing, invoice.terms].filter(Boolean).join(' · ')}
          </Text>
        </View>
        {invoice.pending && invoice.pending.state !== 'sent' ? (
          <Text className="mt-2 text-[12.5px] text-text-2" testID="invoice-waiting">
            {invoice.pending.name === 'invoice.record_cash_payment'
              ? 'Recorded on this phone. It reaches HandsFreeOS when you have signal.'
              : 'Waiting on this phone to reach HandsFreeOS.'}
          </Text>
        ) : null}
      </Card>

      {manage ? (
        <View className="gap-2">
          {owes ? (
            <Button icon={HandCoins} onPress={() => setRecording(true)} testID="record-cash-open">
              Record cash or a check
            </Button>
          ) : null}
          {invoice.status !== 'draft' && invoice.status !== 'void' ? (
            <Button
              variant="secondary"
              icon={Link2}
              loading={busy}
              onPress={() => void paymentLink()}
              testID="invoice-copy-link"
            >
              {online ? 'Send a payment link' : 'Send a payment link — needs signal'}
            </Button>
          ) : null}
          <Button
            variant="secondary"
            icon={Send}
            onPress={() => setSending(true)}
            testID="invoice-send-open"
          >
            {invoice.sent_at ? 'Send it again' : 'Send'}
          </Button>
        </View>
      ) : null}

      <DocumentLines
        lines={lines}
        totals={totalsOf(invoice)}
        taxed={(invoice.tax_rate_bp ?? 0) > 0}
        moneyOn={{
          paidCents: invoice.paidCents,
          balanceCents: invoice.balanceCents,
          refundedCents: invoice.refundedCents,
        }}
      />

      <Card className="px-3.5 py-3">
        <Text className="mb-1 text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3">
          What has happened
        </Text>
        {payments.map((p) => (
          <Text key={p.id} className="py-1 text-[13px]" testID={`invoice-payment-${p.id}`}>
            {p.status === 'succeeded'
              ? paidWording(
                  p.amount_cents,
                  p.method as PaymentMethod,
                  p.received_at ?? p.created_at ?? new Date().toISOString(),
                  timeZone,
                )
              : `${money(p.amount_cents)} ${PAYMENT_METHOD_LABELS[p.method as PaymentMethod] ?? p.method} · ${p.status}`}
          </Text>
        ))}
        {refunds.map((r) => (
          <Text key={r.id} className="py-1 text-[13px] text-text-2">
            {refundedWording(r.amount_cents, r.refunded_at ?? new Date().toISOString(), timeZone)}
          </Text>
        ))}
        {invoice.sent_at ? (
          <Text className="py-1 text-[13px] text-text-2">
            {`Sent ${dayLabel(Date.parse(invoice.sent_at), timeZone)}`}
          </Text>
        ) : null}
        {invoice.created_at ? (
          <Text className="py-1 text-[13px] text-text-2">
            {`Written ${dayLabel(Date.parse(invoice.created_at), timeZone)}`}
          </Text>
        ) : null}
      </Card>

      {invoice.notes ? (
        <Card className="px-3.5 py-3">
          <Text className="mb-1 text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3">
            Notes
          </Text>
          <Text className="text-[13.5px] leading-[1.45]">{invoice.notes}</Text>
        </Card>
      ) : null}

      {manage ? (
        <Button
          variant="ghost"
          onPress={() => void openWeb(`/app/w/${business.id}/money/invoices/${invoiceId}`)}
          testID="invoice-open-web"
        >
          Open this invoice on the web
        </Button>
      ) : null}

      <RecordCashSheet
        open={recording}
        onClose={() => setRecording(false)}
        invoiceId={invoiceId}
        balanceCents={invoice.balanceCents}
      />

      <SendSheet
        open={sending}
        onClose={() => setSending(false)}
        who={invoice.person_name}
        email={invoice.person_email}
        phone={invoice.person_phone}
        onSend={async (channels) => {
          await sendInvoice({ workspaceId: business.id, invoiceId, channels });
          // Not "sent": sending reaches a customer, so it waits its turn like any change and HandsFreeOS may still
          // refuse it (a partly paid invoice can't be sent again). Changes on this phone says how it ended.
          toast.show(`Sending to ${invoice.person_name}.`);
          setSending(false);
        }}
      />

      <Sheet
        open={link !== null}
        onClose={() => setLink(null)}
        title="The customer’s payment link"
        description={MONEY_LINK_WHAT_IT_DOES.invoice}
        testID="invoice-link"
      >
        <Text
          className="rounded-menu bg-card-2 px-3 py-2.5 text-[12.5px] text-text-2"
          selectable
          testID="invoice-link-url"
        >
          {link ?? ''}
        </Text>
        <Button
          className="mt-3"
          onPress={() => void Share.share({ message: link ?? '', url: link ?? '' })}
          testID="invoice-link-share"
        >
          Send it
        </Button>
        <Button variant="ghost" className="mt-2" onPress={() => setLink(null)}>
          Done
        </Button>
      </Sheet>
    </Screen>
  );
}
