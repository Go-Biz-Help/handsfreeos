import {
  EXPENSES_DESCRIPTION,
  EXPENSES_EMPTY,
  EXPENSES_ONLY_MANAGERS,
  EXPENSES_TAB_LABEL,
  formatDateOnly,
  inOutFigures,
  money,
  monthLabel,
} from '@hfos/core';
import { useLocalSearchParams } from 'expo-router';
import * as React from 'react';
import { FlatList, Pressable, ScrollView, View } from 'react-native';

import { Paperclip, Plus } from '@/components/icons';
import { ExpenseSheet } from '@/components/money/expense-sheet';
import { useBusiness } from '@/components/shell/business-context';
import { Screen } from '@/components/shell/screen';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { FilterChip } from '@/components/ui/filter-chip';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';
import { useExpenses, type Expense, type InOut } from '@/money/expenses';
import { useMoneyRole, useMoneyZone } from '@/money/use-money';

/**
 * **Money → Expenses** (the owner, 25 Nov 2026: "I snap a receipt, it gets filed, and each month I see money in and
 * money out"): the month's money in, money out and what's left; the months before it; what the money went on; and
 * the month's expenses, each with its receipt. Add expense takes the receipt's photo there and then. Only whoever
 * manages money sees it, as on the web, and it needs a signal: none of it is in the phone's copy.
 */
export default function Expenses() {
  const { business } = useBusiness();
  const { whole } = useMoneyRole();
  const zone = useMoneyZone();
  const view = useExpenses(business.id, whole);
  const [sheet, setSheet] = React.useState<{ open: boolean; expense: Expense | null }>({
    open: false,
    expense: null,
  });
  // Snap receipt on the Quick actions widget (`?add=1`, docs/phone-widgets.md): Add expense opens once, ready for
  // the receipt's photo.
  const { add } = useLocalSearchParams<{ add?: string }>();
  const added = React.useRef(false);
  React.useEffect(() => {
    if (add !== '1' || added.current || !whole) return;
    added.current = true;
    setSheet({ open: true, expense: null });
  }, [add, whole]);

  if (!whole)
    return (
      <Screen title={EXPENSES_TAB_LABEL} leading="back" testID="expenses">
        <Card className="p-6">
          <Text className="text-center text-text-2" testID="expenses-only-managers">
            {EXPENSES_ONLY_MANAGERS}
          </Text>
        </Card>
      </Screen>
    );

  const { inOut } = view;
  const thisYear = inOut ? Number(inOut.thisMonth.slice(0, 4)) : undefined;
  const open = (expense: Expense | null) => setSheet({ open: true, expense });

  const header = inOut ? (
    <View className="gap-3 px-3 pb-3 pt-3">
      <Figures inOut={inOut} />
      <ScrollView horizontal showsHorizontalScrollIndicator={false} testID="expenses-months">
        <View className="flex-row gap-1.5">
          {inOut.months.map((m) => (
            <FilterChip
              key={m.month}
              label={monthLabel(m.month, thisYear)}
              on={m.month === inOut.breakdown.month}
              onPress={() => view.showMonth(m.month)}
              testID={`expenses-month-${m.month}`}
            />
          ))}
        </View>
      </ScrollView>
      <Breakdown inOut={inOut} />
      <Button icon={Plus} onPress={() => open(null)} testID="expenses-add">
        Add expense
      </Button>
    </View>
  ) : null;

  return (
    <Screen
      title={EXPENSES_TAB_LABEL}
      subtitle={EXPENSES_DESCRIPTION}
      leading="back"
      scroll={false}
      testID="expenses"
    >
      {view.loading ? (
        <Card className="m-3 p-6">
          <Text className="text-center text-text-2">Loading…</Text>
        </Card>
      ) : view.error && !inOut ? (
        <Card className="m-3 gap-3 p-6">
          <Text className="text-center text-text-2" testID="expenses-error">
            {view.error}
          </Text>
          <Button variant="secondary" onPress={view.reload}>
            Try again
          </Button>
        </Card>
      ) : (
        <FlatList
          data={view.expenses as Expense[]}
          keyExtractor={(e) => e.id}
          ListHeaderComponent={header}
          renderItem={({ item }) => <ExpenseRowView expense={item} onPress={() => open(item)} />}
          ListEmptyComponent={
            <View
              className="mx-3 rounded-card border border-border bg-card px-6 py-8"
              testID="expenses-empty"
            >
              <Text className="text-center text-[13px] text-text-2">{EXPENSES_EMPTY}</Text>
            </View>
          }
          ListFooterComponent={
            view.hasMore ? (
              <View className="px-3 pt-2">
                <Button
                  variant="secondary"
                  onPress={view.more}
                  loading={view.loadingMore}
                  testID="expenses-more"
                >
                  Show more
                </Button>
              </View>
            ) : null
          }
          contentContainerClassName="pb-10"
          testID="expenses-list"
        />
      )}
      <ExpenseSheet
        open={sheet.open}
        expense={sheet.expense}
        onClose={() => setSheet((s) => ({ ...s, open: false }))}
        onSaved={view.reload}
        workspaceId={business.id}
        timeZone={inOut?.timeZone ?? zone}
      />
    </Screen>
  );
}

/** Money in, money out and what's left, for the month shown. */
function Figures({ inOut }: { inOut: InOut }) {
  const shown = inOut.months.find((m) => m.month === inOut.breakdown.month) ?? {
    month: inOut.breakdown.month,
    inCents: inOut.breakdown.inCents,
    outCents: inOut.breakdown.outCents,
    expenseCount: 0,
  };
  const figures = inOutFigures(shown, inOut.thisMonth);
  return (
    <View className="gap-1.5">
      <View className="flex-row gap-px overflow-hidden rounded-card border border-border bg-border">
        {figures.map((f) => (
          <View
            key={f.key}
            className="flex-1 gap-0.5 bg-card px-3 py-3"
            testID={`expenses-${f.key}`}
          >
            <Text
              className={cn(
                'text-lg font-semibold leading-[22px]',
                f.tone === 'bad' && 'text-danger-text',
                f.tone === 'good' && 'text-success-text',
              )}
              numberOfLines={1}
              adjustsFontSizeToFit
              testID={`expenses-${f.key}-value`}
            >
              {f.value}
            </Text>
            <Text className="text-[12px] text-text-2">{f.label}</Text>
          </View>
        ))}
      </View>
      <Text className="px-1 text-xs leading-[1.45] text-text-3">
        {`${figures[1]!.sub}. ${figures[2]!.sub}.`}
      </Text>
    </View>
  );
}

/** What the month's money went on, biggest first, each with a bar. */
function Breakdown({ inOut }: { inOut: InOut }) {
  const cats = inOut.breakdown.categories;
  if (!cats.length) return null;
  const biggest = Math.max(...cats.map((c) => c.cents), 1);
  return (
    <View
      className="gap-2 rounded-card border border-border bg-card px-3.5 py-3"
      testID="expenses-breakdown"
    >
      <Text className="text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3">
        Where it went
      </Text>
      {cats.map((c) => (
        <View key={c.category} className="gap-1" testID={`expenses-category-${c.category}`}>
          <View className="flex-row justify-between gap-2">
            <Text className="flex-1 text-[13px]" numberOfLines={1}>
              {c.label}
            </Text>
            <Text className="text-[13px] tabular-nums text-text-2">{money(c.cents)}</Text>
          </View>
          <View className="h-1.5 overflow-hidden rounded-full bg-card-2">
            <View
              className="h-full rounded-full bg-accent"
              style={{ width: `${Math.max(4, Math.round((c.cents / biggest) * 100))}%` }}
            />
          </View>
        </View>
      ))}
    </View>
  );
}

function ExpenseRowView({ expense, onPress }: { expense: Expense; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      role="button"
      accessibilityLabel={`${expense.vendor}, ${money(expense.amountCents)}`}
      className="flex-row items-center gap-3 border-b border-border bg-card px-4 py-3 active:bg-card-2"
      testID={`expense-${expense.id}`}
    >
      <View className="flex-1 gap-0.5">
        <Text className="text-[15px] font-medium" numberOfLines={1}>
          {expense.vendor}
        </Text>
        <Text className="text-[12.5px] text-text-2" numberOfLines={1}>
          {`${expense.categoryLabel} · ${formatDateOnly(expense.spentOn)}`}
        </Text>
      </View>
      {expense.receipt ? (
        <Icon as={Paperclip} className="size-4 text-text-3" accessibilityLabel="Has a receipt" />
      ) : null}
      <Text className="text-[15px] font-medium tabular-nums">{money(expense.amountCents)}</Text>
    </Pressable>
  );
}
