import {
  estimatesEmpty,
  invoicesEmpty,
  MONEY_DESCRIPTION,
  MONEY_TAB_LABELS,
  paymentsEmpty,
  type MoneyTab,
} from '@hfos/core';
import { router, type Href } from 'expo-router';
import * as React from 'react';
import { FlatList, Pressable, View } from 'react-native';

import {
  EstimateRowView,
  HeadlineNote,
  HeadlineStrip,
  InvoiceRowView,
  PaymentRowView,
  PlanRowView,
} from '@/components/money/money-rows';
import { businessHref, useBusiness } from '@/components/shell/business-context';
import { Screen } from '@/components/shell/screen';
import { Text } from '@/components/ui/text';
import { openWeb } from '@/lib/open-web';
import { cn } from '@/lib/utils';
import {
  useEstimates,
  useInvoices,
  useMoneyNow,
  useMoneyRole,
  useMoneySummary,
  useMoneyZone,
  usePayments,
  useSubscriptions,
} from '@/money/use-money';

/**
 * **Money** (the canvas's "Dale's invoices"): what is outstanding, what is late and what has come in, then the
 * invoices, the estimates, the payments and the plans — each as the person looking may see them.
 *
 * **A member sees their own jobs' documents and nothing else.** That is true before this screen runs: the phone's copy
 * only ever receives the estimates and invoices a member is on (migration 0056's viewer lists, through their `me_v1`
 * sync bucket), so there is no figure here to hide. What this screen does decide is the parts that are about the
 * *whole business* — the three headline figures, Payments and Plans — which are core's `moneyTabsFor` and
 * `seesWholeBusiness`, and which a member simply doesn't get.
 *
 * Making and editing documents is the web's in M10; New invoice and New estimate open it.
 */
export default function Money() {
  const { business } = useBusiness();
  const { whole, tabs } = useMoneyRole();
  const timeZone = useMoneyZone();
  const now = useMoneyNow();
  const [tab, setTab] = React.useState<MoneyTab>('invoices');
  const summary = useMoneySummary(timeZone);

  const invoices = useInvoices();
  const estimates = useEstimates();
  const payments = usePayments();
  const plans = useSubscriptions();

  const openInvoice = React.useCallback(
    (id: string) => router.push(businessHref(business.id, `money/invoices/${id}`) as Href),
    [business.id],
  );
  const openEstimate = React.useCallback(
    (id: string) => router.push(businessHref(business.id, `money/estimates/${id}`) as Href),
    [business.id],
  );

  return (
    <Screen title="Money" subtitle={MONEY_DESCRIPTION} leading="back" testID="money" scroll={false}>
      {summary ? (
        <View className="gap-2 px-3 pb-3 pt-3">
          <HeadlineStrip summary={summary} timeZone={timeZone} />
          <HeadlineNote summary={summary} timeZone={timeZone} />
        </View>
      ) : (
        <View className="px-4 pb-1 pt-3">
          <Text className="text-[12.5px] leading-[1.45] text-text-3" testID="money-member-note">
            You see the estimates and invoices for the jobs you are on. Nothing else in Money is on
            this phone.
          </Text>
        </View>
      )}

      <View className="flex-row gap-1.5 px-3 pb-3" testID="money-tabs">
        {tabs.map((t) => (
          <Pressable
            key={t}
            role="tab"
            accessibilityState={{ selected: t === tab }}
            testID={`money-tab-${t}`}
            onPress={() => setTab(t)}
            className={cn(
              'h-11 flex-1 items-center justify-center rounded-full border',
              t === tab ? 'border-transparent bg-accent-soft' : 'border-border-strong bg-card',
            )}
          >
            <Text
              className={cn(
                'text-[13px] font-medium',
                t === tab ? 'text-accent-text' : 'text-text-2',
              )}
            >
              {MONEY_TAB_LABELS[t]}
            </Text>
          </Pressable>
        ))}
      </View>

      {tab === 'invoices' ? (
        <List
          data={invoices.items}
          empty={invoicesEmpty(false)}
          testID="invoices"
          render={(item) => (
            <InvoiceRowView
              invoice={item}
              now={now}
              timeZone={timeZone}
              onPress={(i) => openInvoice(i.id)}
            />
          )}
          note={
            whole
              ? 'Members see only the invoices for jobs they are on. Owners and admins see them all.'
              : null
          }
          onNew={whole ? () => void openWeb(`/app/w/${business.id}/money/invoices/new`) : null}
          newLabel="New invoice on the web"
        />
      ) : tab === 'estimates' ? (
        <List
          data={estimates.items}
          empty={estimatesEmpty(false)}
          testID="estimates"
          render={(item) => (
            <EstimateRowView
              estimate={item}
              now={now}
              timeZone={timeZone}
              onPress={(e) => openEstimate(e.id)}
            />
          )}
          note={null}
          onNew={whole ? () => void openWeb(`/app/w/${business.id}/money/estimates/new`) : null}
          newLabel="New estimate on the web"
        />
      ) : tab === 'payments' ? (
        <List
          data={payments}
          empty={paymentsEmpty(false)}
          testID="payments"
          render={(item) => (
            <PaymentRowView
              payment={item}
              timeZone={timeZone}
              onPress={(p) => (p.invoice_id ? openInvoice(p.invoice_id) : undefined)}
            />
          )}
          note="Every payment belongs to an invoice, even a quick payment or a setup fee."
          onNew={null}
          newLabel=""
        />
      ) : (
        <List
          data={plans}
          empty={{
            title: 'Nobody is on a plan yet',
            body: 'Start a customer on a plan from their record on the web. It bills itself through the account you are paid into.',
          }}
          testID="plans"
          render={(item) => (
            <PlanRowView
              plan={item}
              timeZone={timeZone}
              onPress={() => void openWeb(`/app/w/${business.id}/money/plans/${item.id}`)}
            />
          )}
          note={null}
          onNew={null}
          newLabel=""
        />
      )}
    </Screen>
  );
}

function List<T extends { id: string }>({
  data,
  empty,
  render,
  note,
  onNew,
  newLabel,
  testID,
}: {
  data: readonly T[];
  empty: { title: string; body: string };
  render: (item: T) => React.ReactElement;
  note: string | null;
  onNew: (() => void) | null;
  newLabel: string;
  testID: string;
}) {
  if (data.length === 0)
    return (
      <View
        className="mx-3 rounded-card border border-border bg-card px-6 py-10"
        testID={`${testID}-empty`}
      >
        <Text className="text-center text-[15px] font-semibold">{empty.title}</Text>
        <Text className="mt-1 text-center text-[13px] text-text-2">{empty.body}</Text>
        {onNew ? (
          <Pressable
            role="button"
            onPress={onNew}
            className="mt-3.5 h-11 items-center justify-center self-center rounded-menu border border-border-strong px-[18px]"
            testID={`${testID}-new`}
          >
            <Text className="text-[15px] font-medium">{newLabel}</Text>
          </Pressable>
        ) : null}
      </View>
    );
  return (
    <FlatList
      data={data as T[]}
      keyExtractor={(item) => item.id}
      renderItem={({ item }) => render(item)}
      initialNumToRender={12}
      windowSize={7}
      className="border-t border-border"
      contentContainerClassName="pb-10"
      testID={`${testID}-list`}
      ListFooterComponent={
        <View className="gap-2 px-4 pt-2.5">
          {note ? <Text className="text-xs leading-[1.45] text-text-3">{note}</Text> : null}
          {onNew ? (
            <Pressable
              role="button"
              onPress={onNew}
              testID={`${testID}-new`}
              className="h-11 justify-center"
            >
              <Text className="text-[13px] font-medium text-accent-text">{newLabel}</Text>
            </Pressable>
          ) : null}
        </View>
      }
    />
  );
}
