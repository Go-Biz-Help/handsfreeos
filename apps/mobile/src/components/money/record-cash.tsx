import {
  HOW_MUCH_LABEL,
  HOW_PAID_LABEL,
  overBalanceProblem,
  parseMoney,
  PAYMENT_METHOD_LABELS,
  RECORD_CASH_TITLE,
  recordCashNote,
  recordedToast,
  REFERENCE_HINT,
  REFERENCE_LABEL,
} from '@hfos/core';
import * as React from 'react';
import { View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { useBusiness } from '@/components/shell/business-context';
import { recordCash } from '@/money/actions';

/**
 * **Record cash or a check** (the canvas's sheet). It comes first on an unpaid invoice on a phone, because that is
 * what happens at the door: Elena hands over check 4127 and it is written down there and then.
 *
 * It works with no signal — `invoice.record_cash_payment` is an `anytime` change — so the invoice shows the money the
 * moment it is pressed and the change reaches HandsFreeOS when the phone does. The sheet says exactly that, so nobody
 * presses it twice.
 */
export function RecordCashSheet({
  open,
  onClose,
  invoiceId,
  balanceCents,
}: {
  open: boolean;
  onClose: () => void;
  invoiceId: string;
  balanceCents: number;
}) {
  const { business } = useBusiness();
  // Plain digits, not "$1,313.83": the field opens a decimal pad, which can't type a dollar sign or a comma. What is
  // owed is said in words above it, and `parseMoney` reads either.
  const owed = (balanceCents / 100).toFixed(2);
  const [amount, setAmount] = React.useState(owed);
  const [method, setMethod] = React.useState<'cash' | 'check' | 'other'>('cash');
  const [reference, setReference] = React.useState('');
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
    setReference('');
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
        reference: reference || null,
      });
      toast.show(recordedToast(cents));
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'That didn’t work.');
      setBusy(false);
    }
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={RECORD_CASH_TITLE}
      description={recordCashNote(balanceCents)}
      scroll
      testID="record-cash"
    >
      <View className="gap-3">
        <View>
          <Text className="mb-1.5 text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3">
            {HOW_MUCH_LABEL}
          </Text>
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
          <Text className="mb-1.5 text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3">
            {HOW_PAID_LABEL}
          </Text>
          <Segmented<'cash' | 'check' | 'other'>
            label={HOW_PAID_LABEL}
            value={method}
            onChange={setMethod}
            options={[
              { value: 'cash', label: PAYMENT_METHOD_LABELS.cash, testID: 'record-cash-cash' },
              { value: 'check', label: PAYMENT_METHOD_LABELS.check, testID: 'record-cash-check' },
              { value: 'other', label: PAYMENT_METHOD_LABELS.other, testID: 'record-cash-other' },
            ]}
          />
        </View>

        <View>
          <Text className="mb-1.5 text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3">
            {REFERENCE_LABEL}
          </Text>
          <Input
            key={`reference-${round}`}
            defaultValue=""
            onChangeText={setReference}
            accessibilityLabel={REFERENCE_LABEL}
            testID="record-cash-reference"
          />
          <Text className="mt-1 text-xs text-text-3">{REFERENCE_HINT}</Text>
        </View>

        <Text className="rounded-menu bg-card-2 px-3 py-2.5 text-[12.5px] leading-[1.45] text-text-2">
          Works with no signal. It is recorded in your name the moment you press it, and reaches
          HandsFreeOS when you are back online.
        </Text>

        <View className="gap-2">
          <Button onPress={record} loading={busy} disabled={!!problem} testID="record-cash-confirm">
            Record it
          </Button>
          <Button variant="ghost" onPress={onClose}>
            Cancel
          </Button>
        </View>
      </View>
    </Sheet>
  );
}
