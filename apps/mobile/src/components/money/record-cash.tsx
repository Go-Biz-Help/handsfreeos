import {
  addDays,
  HOW_MUCH_LABEL,
  HOW_PAID_LABEL,
  localDateOf,
  MARK_PAID_TITLE,
  markPaidNote,
  overBalanceProblem,
  PAID_ON_LABEL,
  PAID_THROUGH_HINT,
  PAID_THROUGH_LABEL,
  parseMoney,
  PAYMENT_METHOD_LABELS,
  PAYMENT_NOTE_HINT,
  PAYMENT_NOTE_LABEL,
  RECEIPT_LABEL,
  RECORD_CASH_TITLE,
  recordCashNote,
  recordedToast,
  type ManualPaymentMethod,
} from '@hfos/core';
import * as React from 'react';
import { View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Sheet } from '@/components/ui/sheet';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { useBusiness } from '@/components/shell/business-context';
import { recordCash } from '@/money/actions';
import { useMoneyZone } from '@/money/use-money';

/** "Card" on the phone's four-way choice; the full "Card (other machine)" is too wide for it. */
const METHOD_CHOICES: readonly { value: ManualPaymentMethod; label: string }[] = [
  { value: 'cash', label: PAYMENT_METHOD_LABELS.cash },
  { value: 'check', label: PAYMENT_METHOD_LABELS.check },
  { value: 'card_outside', label: 'Card' },
  { value: 'other', label: PAYMENT_METHOD_LABELS.other },
];

/**
 * **Record cash or a check** (the canvas's sheet). It comes first on an unpaid invoice on a phone, because that is
 * what happens at the door: Elena hands over check 4127 and it is written down there and then. A card taken on the
 * business's own machine (Chase QuickAccept) is the third choice, with where it went through beside it.
 *
 * On a draft it is **Mark paid**: HandsFreeOS gives the invoice its number when the change arrives, and nobody is sent
 * the invoice.
 *
 * It works with no signal — `invoice.record_cash_payment` is an `anytime` change — so the invoice shows the money the
 * moment it is pressed and the change reaches HandsFreeOS when the phone does. The sheet says exactly that, so nobody
 * presses it twice. Today or yesterday is enough at the door; an earlier day is the web's.
 */
export function RecordCashSheet({
  open,
  onClose,
  invoiceId,
  balanceCents,
  markPaid = false,
}: {
  open: boolean;
  onClose: () => void;
  invoiceId: string;
  balanceCents: number;
  markPaid?: boolean;
}) {
  const { business } = useBusiness();
  const timeZone = useMoneyZone();
  // Plain digits, not "$1,313.83": the field opens a decimal pad, which can't type a dollar sign or a comma. What is
  // owed is said in words above it, and `parseMoney` reads either.
  const owed = (balanceCents / 100).toFixed(2);
  const [amount, setAmount] = React.useState(owed);
  const [method, setMethod] = React.useState<ManualPaymentMethod>('cash');
  const [paidThrough, setPaidThrough] = React.useState('');
  const [note, setNote] = React.useState('');
  const [day, setDay] = React.useState<'today' | 'yesterday'>('today');
  const [receipt, setReceipt] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  /**
   * Remounts the boxes each time the sheet opens, which is what puts the amount back to what is owed. The boxes are
   * uncontrolled (`defaultValue`, not `value`) on purpose: a controlled box that re-renders on every keystroke
   * scrambles fast typing on Android, which is how the on-device flow first read "20341273" for "20".
   */
  const [round, setRound] = React.useState(0);
  React.useEffect(() => {
    if (!open) return;
    setAmount(owed);
    setMethod('cash');
    setPaidThrough('');
    setNote('');
    setDay('today');
    setReceipt(true);
    setBusy(false);
    setRound((n) => n + 1);
  }, [open, owed]);

  const cents = parseMoney(amount);
  const problem =
    cents === null
      ? 'That isn’t an amount.'
      : cents <= 0
        ? 'How much was paid?'
        : cents > balanceCents
          ? overBalanceProblem(balanceCents)
          : null;

  const record = async () => {
    if (problem || cents === null) return;
    setBusy(true);
    try {
      await recordCash({
        workspaceId: business.id,
        invoiceId,
        amountCents: cents,
        method,
        paidThrough: paidThrough || null,
        note: note || null,
        // Today is the moment it's pressed, which is what an offline change keeps anyway.
        paidOn: day === 'yesterday' ? addDays(localDateOf(Date.now(), timeZone), -1) : null,
        receipt,
      });
      toast.show(recordedToast(cents));
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'That didn’t work.');
      setBusy(false);
    }
  };

  const heading = (words: string) => (
    <Text className="mb-1.5 text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3">
      {words}
    </Text>
  );

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={markPaid ? MARK_PAID_TITLE : RECORD_CASH_TITLE}
      description={markPaid ? markPaidNote(balanceCents) : recordCashNote(balanceCents)}
      scroll
      testID="record-cash"
    >
      <View className="gap-3">
        <View>
          {heading(HOW_MUCH_LABEL)}
          <Input
            key={`amount-${round}`}
            defaultValue={owed}
            onChangeText={setAmount}
            keyboardType="decimal-pad"
            accessibilityLabel={HOW_MUCH_LABEL}
            testID="record-cash-amount"
            trailing={<Text className="pr-3.5 text-[15px] text-text-3">USD</Text>}
          />
          {problem ? (
            <Text className="mt-1 text-xs text-danger-text" testID="record-cash-problem">
              {problem}
            </Text>
          ) : null}
        </View>

        <View>
          {heading(HOW_PAID_LABEL)}
          <Segmented<ManualPaymentMethod>
            label={HOW_PAID_LABEL}
            value={method}
            onChange={setMethod}
            options={METHOD_CHOICES.map((m) => ({ ...m, testID: `record-cash-${m.value}` }))}
          />
        </View>

        <View>
          {heading(PAID_THROUGH_LABEL)}
          <Input
            key={`through-${round}`}
            defaultValue=""
            onChangeText={setPaidThrough}
            maxLength={80}
            placeholder="Chase QuickAccept"
            accessibilityLabel={PAID_THROUGH_LABEL}
            testID="record-cash-through"
          />
          <Text className="mt-1 text-xs text-text-3">{PAID_THROUGH_HINT}</Text>
        </View>

        <View>
          {heading(PAID_ON_LABEL)}
          <Segmented<'today' | 'yesterday'>
            label={PAID_ON_LABEL}
            value={day}
            onChange={setDay}
            options={[
              { value: 'today', label: 'Today', testID: 'record-cash-today' },
              { value: 'yesterday', label: 'Yesterday', testID: 'record-cash-yesterday' },
            ]}
          />
        </View>

        <View>
          {heading(PAYMENT_NOTE_LABEL)}
          <Input
            key={`reference-${round}`}
            defaultValue=""
            onChangeText={setNote}
            maxLength={500}
            accessibilityLabel={PAYMENT_NOTE_LABEL}
            testID="record-cash-reference"
          />
          <Text className="mt-1 text-xs text-text-3">{PAYMENT_NOTE_HINT}</Text>
        </View>

        <View className="flex-row items-center justify-between gap-3">
          <Text className="flex-1 text-[14px]">{RECEIPT_LABEL}</Text>
          <Switch
            label={RECEIPT_LABEL}
            checked={receipt}
            onCheckedChange={setReceipt}
            testID="record-cash-receipt"
          />
        </View>

        <Text className="rounded-menu bg-card-2 px-3 py-2.5 text-[12.5px] leading-[1.45] text-text-2">
          Works with no signal. It is recorded in your name the moment you press it, and reaches
          HandsFreeOS when you are back online.
        </Text>

        <View className="gap-2">
          <Button onPress={record} loading={busy} disabled={!!problem} testID="record-cash-confirm">
            {markPaid ? MARK_PAID_TITLE : 'Record it'}
          </Button>
          <Button variant="ghost" onPress={onClose}>
            Cancel
          </Button>
        </View>
      </View>
    </Sheet>
  );
}
