import {
  addDays,
  EXPENSE_CATEGORIES,
  EXPENSE_NOTE_MAX,
  EXPENSE_VENDOR_MAX,
  localDateOf,
  money,
  parseMoney,
  type ExpenseCategory,
  type ExpensePaidWith,
} from '@hfos/core';
import * as WebBrowser from 'expo-web-browser';
import * as React from 'react';
import { Image, View } from 'react-native';

import { Camera, ImagePlus, Receipt } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { FilterChip } from '@/components/ui/filter-chip';
import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { signedUrl } from '@/inbox/storage';
import { errorMessage } from '@/lib/api';
import {
  expenseCalls,
  takeReceipt,
  type Expense,
  type ExpenseInput,
  type ReceiptPhoto,
} from '@/money/expenses';

/** How it was paid, in words short enough for a phone's row of chips. */
const PAID_WITH: readonly { value: ExpensePaidWith; label: string }[] = [
  { value: 'card', label: 'Card' },
  { value: 'cash', label: 'Cash' },
  { value: 'check', label: 'Check' },
  { value: 'bank', label: 'Bank' },
  { value: 'other', label: 'Other' },
];

type DayChoice = 'today' | 'yesterday' | 'other';

/** "11/20/2026" or "2026-11-20" as "2026-11-20"; null when it isn't a real day. */
export function parseDay(text: string): string | null {
  const t = text.trim();
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t);
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
  const [y, m, d] = us
    ? [Number(us[3]), Number(us[1]), Number(us[2])]
    : iso
      ? [Number(iso[1]), Number(iso[2]), Number(iso[3])]
      : [0, 0, 0];
  if (!y) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d)
    return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** "2026-11-20" as "11/20/2026", the way a day is typed here. */
const typedDay = (day: string) => {
  const [y, m, d] = day.split('-');
  return `${Number(m)}/${Number(d)}/${y}`;
};

/**
 * **Add an expense**, or change one: who it was paid to, the whole amount and the tax in it, the day, a category,
 * how it was paid, a note, and a photo of the receipt taken there and then. Changing one also shows its receipt
 * and removes it for good, after a second press. Everything here needs a signal.
 */
export function ExpenseSheet({
  open,
  onClose,
  onSaved,
  workspaceId,
  timeZone,
  expense,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  workspaceId: string;
  timeZone: string;
  /** The expense being changed; none to add one. */
  expense: Expense | null;
}) {
  const today = localDateOf(Date.now(), timeZone);
  const yesterday = addDays(today, -1);
  const [vendor, setVendor] = React.useState('');
  const [amount, setAmount] = React.useState('');
  const [tax, setTax] = React.useState('');
  const [dayChoice, setDayChoice] = React.useState<DayChoice>('today');
  const [otherDay, setOtherDay] = React.useState('');
  const [category, setCategory] = React.useState<ExpenseCategory | null>(null);
  const [paidWith, setPaidWith] = React.useState<ExpensePaidWith | null>(null);
  const [note, setNote] = React.useState('');
  const [photo, setPhoto] = React.useState<ReceiptPhoto | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [removing, setRemoving] = React.useState(false);
  const [tried, setTried] = React.useState(false);
  /** Remounts the boxes each time the sheet opens; uncontrolled boxes keep fast typing on Android in order. */
  const [round, setRound] = React.useState(0);

  React.useEffect(() => {
    if (!open) return;
    const day = expense?.spentOn ?? today;
    setVendor(expense?.vendor ?? '');
    setAmount(expense ? (expense.amountCents / 100).toFixed(2) : '');
    setTax(expense?.taxCents != null ? (expense.taxCents / 100).toFixed(2) : '');
    setDayChoice(day === today ? 'today' : day === yesterday ? 'yesterday' : 'other');
    setOtherDay(typedDay(day));
    setCategory((expense?.category as ExpenseCategory | undefined) ?? null);
    setPaidWith((expense?.paidWith as ExpensePaidWith | null | undefined) ?? null);
    setNote(expense?.note ?? '');
    setPhoto(null);
    setBusy(false);
    setRemoving(false);
    setTried(false);
    setRound((n) => n + 1);
    // Only when it opens: what's typed stays while it's open.
  }, [open, expense?.id]);

  const amountCents = parseMoney(amount);
  const taxCents = tax.trim() ? parseMoney(tax) : null;
  const spentOn =
    dayChoice === 'today' ? today : dayChoice === 'yesterday' ? yesterday : parseDay(otherDay);
  const problems = {
    vendor: vendor.trim() ? null : 'Say who it was paid to: the store, supplier or person.',
    amount:
      amountCents === null
        ? 'That isn’t an amount. Type it like 42.50.'
        : amountCents <= 0
          ? 'How much was it?'
          : null,
    tax:
      tax.trim() && taxCents === null
        ? 'That isn’t an amount. Type it like 3.12.'
        : taxCents !== null && amountCents !== null && taxCents > amountCents
          ? 'The tax is more than the whole amount.'
          : null,
    day: spentOn ? null : 'Type the day like 11/20/2026.',
    category: category ? null : 'Pick what it was for.',
  };
  const firstProblem = Object.values(problems).find(Boolean) ?? null;

  const take = async (source: 'camera' | 'library') => {
    try {
      const taken = await takeReceipt(source);
      if (taken.kind === 'taken') setPhoto(taken.photo);
      else if (taken.kind === 'no-camera-permission')
        toast.error(
          'HandsFreeOS can’t use the camera. Turn it on in your phone’s Settings, or choose a photo instead.',
        );
    } catch {
      toast.error('That photo couldn’t be opened. Try another one.');
    }
  };

  const save = async () => {
    setTried(true);
    if (firstProblem || amountCents === null || !spentOn || !category) return;
    setBusy(true);
    const input: ExpenseInput = {
      spentOn,
      amountCents,
      taxCents,
      vendor: vendor.trim(),
      category,
      paidWith,
      note: note.trim() || null,
    };
    const calls = expenseCalls(workspaceId);
    try {
      if (expense) await calls.change(expense.id, input, photo);
      else await calls.add(input, photo);
      toast.show(expense ? 'Expense saved.' : `Added ${money(amountCents)} at ${input.vendor}.`);
      onSaved();
      onClose();
    } catch (error) {
      toast.error(errorMessage(error));
      setBusy(false);
      // An expense added with a receipt that didn't go up is still added: show it.
      onSaved();
    }
  };

  const remove = async () => {
    if (!expense) return;
    if (!removing) {
      setRemoving(true);
      return;
    }
    setBusy(true);
    try {
      await expenseCalls(workspaceId).remove(expense.id);
      toast.show('Expense removed.');
      onSaved();
      onClose();
    } catch (error) {
      toast.error(errorMessage(error));
      setBusy(false);
    }
  };

  const seeReceipt = async () => {
    const r = expense?.receipt;
    if (!r) return;
    const url = await signedUrl(r.bucket, r.objectPath).catch(() => null);
    if (!url) {
      toast.error('The receipt couldn’t be opened. Check your connection and try again.');
      return;
    }
    await WebBrowser.openBrowserAsync(url);
  };

  const heading = (words: string) => (
    <Text className="mb-1.5 text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3">
      {words}
    </Text>
  );
  const problem = (words: string | null, testID: string) =>
    tried && words ? (
      <Text className="mt-1 text-xs text-danger-text" testID={testID}>
        {words}
      </Text>
    ) : null;

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={expense ? 'Change this expense' : 'Add an expense'}
      description="The whole amount paid, tax in it. Add a photo of the receipt so it’s kept with it."
      scroll
      testID="expense-sheet"
    >
      <View className="gap-3">
        <View>
          {heading('Receipt')}
          {photo ? (
            <View className="flex-row items-center gap-3">
              <Image
                source={{ uri: photo.uri }}
                className="h-16 w-12 rounded-control bg-card-2"
                accessibilityLabel="The receipt photo"
              />
              <Text className="flex-1 text-[13px] text-text-2">
                {expense?.receipt
                  ? 'This photo takes the old one’s place.'
                  : 'This photo is kept with it.'}
              </Text>
              <Button variant="ghost" size="sm" onPress={() => setPhoto(null)}>
                Take it off
              </Button>
            </View>
          ) : (
            <View className="gap-2">
              {expense?.receipt ? (
                <Button
                  variant="secondary"
                  size="md"
                  icon={Receipt}
                  onPress={() => void seeReceipt()}
                  testID="expense-see-receipt"
                >
                  See the receipt
                </Button>
              ) : null}
              <View className="flex-row gap-2">
                <Button
                  variant="secondary"
                  size="md"
                  icon={Camera}
                  className="flex-1"
                  onPress={() => void take('camera')}
                  testID="expense-take-photo"
                >
                  {expense?.receipt ? 'New photo' : 'Take a photo'}
                </Button>
                <Button
                  variant="secondary"
                  size="md"
                  icon={ImagePlus}
                  className="flex-1"
                  onPress={() => void take('library')}
                  testID="expense-choose-photo"
                >
                  Choose one
                </Button>
              </View>
            </View>
          )}
        </View>

        <View>
          {heading('Paid to')}
          <Input
            key={`vendor-${round}`}
            defaultValue={expense?.vendor ?? ''}
            onChangeText={setVendor}
            maxLength={EXPENSE_VENDOR_MAX}
            placeholder="Home Depot"
            accessibilityLabel="Paid to"
            testID="expense-vendor"
          />
          {problem(problems.vendor, 'expense-vendor-problem')}
        </View>

        <View className="flex-row gap-3">
          <View className="flex-1">
            {heading('Amount')}
            <Input
              key={`amount-${round}`}
              defaultValue={expense ? (expense.amountCents / 100).toFixed(2) : ''}
              onChangeText={setAmount}
              keyboardType="decimal-pad"
              placeholder="42.50"
              accessibilityLabel="Amount"
              testID="expense-amount"
            />
            {problem(problems.amount, 'expense-amount-problem')}
          </View>
          <View className="flex-1">
            {heading('Tax in it')}
            <Input
              key={`tax-${round}`}
              defaultValue={expense?.taxCents != null ? (expense.taxCents / 100).toFixed(2) : ''}
              onChangeText={setTax}
              keyboardType="decimal-pad"
              placeholder="When it shows"
              accessibilityLabel="Tax in it"
              testID="expense-tax"
            />
            {problem(problems.tax, 'expense-tax-problem')}
          </View>
        </View>

        <View>
          {heading('Day')}
          <Segmented<DayChoice>
            label="Day"
            value={dayChoice}
            onChange={setDayChoice}
            options={[
              { value: 'today', label: 'Today', testID: 'expense-today' },
              { value: 'yesterday', label: 'Yesterday', testID: 'expense-yesterday' },
              { value: 'other', label: 'Another day', testID: 'expense-other-day' },
            ]}
          />
          {dayChoice === 'other' ? (
            <View className="mt-2">
              <Input
                key={`day-${round}`}
                defaultValue={otherDay}
                onChangeText={setOtherDay}
                keyboardType="numbers-and-punctuation"
                placeholder="11/20/2026"
                accessibilityLabel="The day, like 11/20/2026"
                testID="expense-day"
              />
              {problem(problems.day, 'expense-day-problem')}
            </View>
          ) : null}
        </View>

        <View>
          {heading('What it was for')}
          <View className="flex-row flex-wrap gap-1.5">
            {EXPENSE_CATEGORIES.map((c) => (
              <FilterChip
                key={c.id}
                label={c.label}
                on={category === c.id}
                onPress={() => setCategory(c.id)}
                testID={`expense-category-${c.id}`}
              />
            ))}
          </View>
          {problem(problems.category, 'expense-category-problem')}
        </View>

        <View>
          {heading('Paid with')}
          <View className="flex-row flex-wrap gap-1.5">
            {PAID_WITH.map((p) => (
              <FilterChip
                key={p.value}
                label={p.label}
                on={paidWith === p.value}
                onPress={() => setPaidWith(paidWith === p.value ? null : p.value)}
                testID={`expense-paid-${p.value}`}
              />
            ))}
          </View>
        </View>

        <View>
          {heading('Note')}
          <Input
            key={`note-${round}`}
            defaultValue={expense?.note ?? ''}
            onChangeText={setNote}
            maxLength={EXPENSE_NOTE_MAX}
            placeholder="Lumber for the Garcia deck"
            accessibilityLabel="Note"
            testID="expense-note"
          />
        </View>

        <View className="gap-2">
          <Button onPress={() => void save()} loading={busy} testID="expense-save">
            {expense ? 'Save' : 'Add expense'}
          </Button>
          {expense ? (
            <Button
              variant="ghostDanger"
              onPress={() => void remove()}
              disabled={busy}
              testID="expense-remove"
            >
              {removing ? 'Press again to remove it for good' : 'Remove this expense'}
            </Button>
          ) : (
            <Button variant="ghost" onPress={onClose}>
              Cancel
            </Button>
          )}
        </View>
      </View>
    </Sheet>
  );
}
