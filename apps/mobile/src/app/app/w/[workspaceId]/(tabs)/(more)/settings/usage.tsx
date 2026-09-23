import {
  BALANCE_WORDS,
  balanceHeadline,
  cardLine,
  MIN_TOPUP_CENTS,
  money,
  parseMoney,
  topUpCapLine,
  whenLabel,
  type BalanceTone,
} from '@hfos/core';
import { router, useLocalSearchParams } from 'expo-router';
import * as React from 'react';
import { View } from 'react-native';

import { CreditCard, ExternalLink, Info, Wallet as WalletIcon } from '@/components/icons';
import { businessHref, useBusiness } from '@/components/shell/business-context';
import { List, ListLabel, ListRow } from '@/components/shell/list';
import { Screen } from '@/components/shell/screen';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { FieldError, Label } from '@/components/ui/label';
import { Sheet } from '@/components/ui/sheet';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { errorMessage } from '@/lib/api';
import { openWeb } from '@/lib/open-web';
import { cn } from '@/lib/utils';
import { useMoneyRole, useMoneyZone } from '@/money/use-money';
import {
  useWallet,
  walletCard,
  walletCommands,
  type StatementEntry,
  type Wallet,
  type WalletView,
} from '@/money/use-wallet';

/**
 * **Balance** — Settings → Usage & balance at phone size: what the business has left, what it has spent, the card
 * that tops it up, what things cost, and the statement behind the number.
 *
 * Three things make this different from the web's page:
 *
 * - **It is live or it says so.** Nothing here is in the phone's copy (`use-wallet.ts` says why), so with no signal
 *   the screen says it needs one rather than showing yesterday's balance.
 * - **Topping up asks first.** On the web the button sits under a heading, at a desk. On a phone it is one tap from
 *   a pocket, and it charges a card, so it asks with the amount and the card in the question.
 * - **A member may look.** `wallet.get` is `money.read`, which a member has, and the phone's own Action Center sends
 *   them here when the balance is running out. Spending the business's money is `money.manage`, so the switches and
 *   the buttons are an owner's and an admin's — the screen says that rather than leaving a dead button.
 */
export default function Balance() {
  const { business } = useBusiness();
  // Spending the business's balance is managing its money (money.manage, 0105).
  const { whole: manage } = useMoneyRole();
  const timeZone = useMoneyZone();
  const view = useWallet(business.id);
  const { wallet, reload } = view;
  const [busy, setBusy] = React.useState(false);
  // The provider sends them back to this screen's own address with `?card=` on it (the app claims that link:
  // `links/route-map.ts`), so coming back from the card page lands here rather than in a browser tab.
  const { card: cameBackWith } = useLocalSearchParams<{ card?: string }>();
  const handled = React.useRef<string | null>(null);

  /**
   * Adding a card, in two halves. The first asks the worker for the provider's page and opens it; the second
   * runs when they come back, and hands the session over so the worker can read the card off the provider —
   * the address bar is only ever a name for what happened, never the card itself.
   */
  const addCard = () => {
    setBusy(true);
    void (async () => {
      try {
        const started = await walletCard({ workspaceId: business.id });
        if (started.stage !== 'started') return;
        toast.show(BALANCE_WORDS.addingCard);
        const opened = await openWeb(started.hostedUrl);
        if (!opened) toast.error(BALANCE_WORDS.noBrowser);
      } catch (e) {
        toast.error(errorMessage(e));
      } finally {
        setBusy(false);
      }
    })();
  };

  React.useEffect(() => {
    const mark = typeof cameBackWith === 'string' ? cameBackWith : null;
    if (!mark || handled.current === mark) return;
    handled.current = mark;
    // Off the address as soon as it is taken, so opening this screen again is never a second save.
    router.setParams({ card: '' });
    if (mark === 'cancelled') {
      toast.show(BALANCE_WORDS.cardNotSaved);
      return;
    }
    setBusy(true);
    void (async () => {
      try {
        const answer = await walletCard({ workspaceId: business.id, sessionRef: mark });
        toast.show(
          answer.stage === 'saved' && answer.card.cardLast4
            ? BALANCE_WORDS.cardSaved(`${BALANCE_WORDS.cardTitle} ••${answer.card.cardLast4}`)
            : BALANCE_WORDS.cardNotSaved,
        );
        reload();
      } catch (e) {
        toast.error(errorMessage(e));
      } finally {
        setBusy(false);
      }
    })();
  }, [business.id, cameBackWith, reload]);

  /** Every command on this screen: sent, then the whole screen read back, because each changes the balance. */
  const run = async (what: () => Promise<void>, said: string) => {
    setBusy(true);
    try {
      await what();
      toast.show(said);
      reload();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen
      title={BALANCE_WORDS.phoneTitle}
      leading="back"
      back={businessHref(business.id, 'settings')}
      testID="balance"
    >
      {wallet ? (
        <>
          <BalanceCard
            wallet={wallet}
            manage={manage}
            busy={busy}
            onTopUp={() =>
              void run(() => walletCommands.topUp(business.id), BALANCE_WORDS.toppingUp)
            }
          />
          {!manage ? (
            <Note tone="info" words={BALANCE_WORDS.memberNote} testID="balance-member" />
          ) : null}
          <AutoTopUp
            wallet={wallet}
            manage={manage}
            busy={busy}
            onSave={(patch, said) =>
              void run(() => walletCommands.setAutoTopup(business.id, patch), said)
            }
          />
          <CardOnFile
            wallet={wallet}
            manage={manage}
            busy={busy}
            onAddCard={addCard}
            onForget={() =>
              void run(() => walletCommands.forgetCard(business.id), BALANCE_WORDS.cardRemoved)
            }
          />
          <Prices view={view} />
          <StatementRows view={view} timeZone={timeZone} />
        </>
      ) : view.loading ? (
        <Card className="items-center gap-2 px-5 py-8" testID="balance-loading">
          <Icon as={WalletIcon} className="size-6 text-text-3" />
          <Text className="text-[14.5px] text-text-2">{BALANCE_WORDS.loading}</Text>
        </Card>
      ) : (
        <Card className="items-center gap-3 px-5 py-8" testID="balance-error">
          <Icon as={WalletIcon} className="size-6 text-text-3" />
          <Text className="text-center text-[14.5px] leading-[21px] text-text-2">
            {view.error ?? BALANCE_WORDS.needsSignal}
          </Text>
          <Button
            variant="secondary"
            className="self-stretch"
            onPress={reload}
            testID="balance-retry"
          >
            {BALANCE_WORDS.retry}
          </Button>
        </Card>
      )}
    </Screen>
  );
}

const TONE: Readonly<Record<BalanceTone, string>> = {
  ok: 'text-text',
  warn: 'text-warning-text',
  bad: 'text-danger-text',
};

/** The number, the sentence over it, what has gone lately, and the one button that adds to it. */
function BalanceCard({
  wallet,
  manage,
  busy,
  onTopUp,
}: {
  wallet: Wallet;
  manage: boolean;
  busy: boolean;
  onTopUp: () => void;
}) {
  const [asking, setAsking] = React.useState(false);
  const words = balanceHeadline(wallet);
  return (
    <Card className="gap-3 px-3.5 py-4" testID="balance-card">
      <View className="gap-1">
        <Text
          className={cn('text-[30px] font-semibold leading-none', TONE[words.tone])}
          testID="balance-left"
        >
          {money(wallet.balanceCents)}
        </Text>
        <Text className={cn('text-[13.5px]', TONE[words.tone])} testID="balance-headline">
          {words.headline}
        </Text>
      </View>
      <View className="flex-row flex-wrap items-center gap-x-3 gap-y-1.5">
        <Text className="text-[13px] text-text-2">
          {BALANCE_WORDS.thisMonth(wallet.spentThisMonthCents)}
        </Text>
        <Text className="text-[13px] text-text-3">
          {BALANCE_WORDS.last30(wallet.spent30dCents)}
        </Text>
        {wallet.pendingTopUpCents !== null ? (
          <Badge variant="accent" testID="balance-pending">
            <Text>{BALANCE_WORDS.onItsWay(wallet.pendingTopUpCents)}</Text>
          </Badge>
        ) : null}
      </View>
      {wallet.suspended ? (
        <Note
          tone="danger"
          testID="balance-suspended"
          words={`${wallet.suspended.reason ?? BALANCE_WORDS.suspendedFallback} ${BALANCE_WORDS.suspendedTail}`}
        />
      ) : null}
      {/* Why the top-up is bigger than usual, and the one setting that fixes it — in the same breath. */}
      {wallet.escalation ? (
        <Note tone="warning" words={wallet.escalation} testID="balance-escalation" />
      ) : null}
      {manage ? (
        <Button
          className="mt-0.5"
          disabled={busy || !wallet.card}
          onPress={() => setAsking(true)}
          testID="balance-top-up"
        >
          {BALANCE_WORDS.topUp}
        </Button>
      ) : null}
      <Sheet
        open={asking}
        onClose={() => setAsking(false)}
        title={BALANCE_WORDS.topUpAskTitle}
        testID="balance-top-up-sheet"
      >
        <Text className="mb-4 mt-1 text-sm leading-5 text-text-2">
          {BALANCE_WORDS.topUpAsk(
            wallet.topupCents,
            wallet.card ? cardLine(wallet.card) : BALANCE_WORDS.cardNone,
          )}
        </Text>
        <View className="gap-2">
          <Button
            onPress={() => {
              setAsking(false);
              onTopUp();
            }}
            testID="balance-top-up-confirm"
          >
            {BALANCE_WORDS.topUpConfirm(wallet.topupCents)}
          </Button>
          <Button variant="ghost" onPress={() => setAsking(false)} testID="balance-top-up-cancel">
            {BALANCE_WORDS.keep}
          </Button>
        </View>
      </Sheet>
    </Card>
  );
}

/** The switch and the two amounts behind it, each typed in a sheet rather than in a row a thumb has to find. */
function AutoTopUp({
  wallet,
  manage,
  busy,
  onSave,
}: {
  wallet: Wallet;
  manage: boolean;
  busy: boolean;
  onSave: (
    patch: { autoTopup?: boolean; floorCents?: number; topupCents?: number },
    said: string,
  ) => void;
}) {
  const [editing, setEditing] = React.useState<'floor' | 'topup' | null>(null);
  return (
    <>
      <ListLabel>{BALANCE_WORDS.autoTitle}</ListLabel>
      <List testID="balance-auto">
        <ListRow
          label={BALANCE_WORDS.autoSwitch}
          detail={BALANCE_WORDS.autoDetail}
          end={
            <Switch
              label={BALANCE_WORDS.autoSwitch}
              checked={wallet.autoTopup}
              disabled={!manage || busy || !wallet.card}
              onCheckedChange={(next) =>
                onSave({ autoTopup: next }, next ? BALANCE_WORDS.autoOn : BALANCE_WORDS.autoOff)
              }
              testID="balance-auto-switch"
            />
          }
        />
        <ListRow
          label={BALANCE_WORDS.floorLabel}
          end={money(wallet.floorCents)}
          onPress={manage ? () => setEditing('floor') : undefined}
          testID="balance-floor"
        />
        <ListRow
          label={BALANCE_WORDS.amountLabel}
          end={money(wallet.topupCents)}
          onPress={manage ? () => setEditing('topup') : undefined}
          testID="balance-amount"
        />
      </List>
      <Text className="px-1 text-[12.5px] leading-[18px] text-text-3" testID="balance-cap">
        {topUpCapLine(wallet.maxTopupCents)}
      </Text>
      {!wallet.card ? (
        <Text className="px-1 text-[12.5px] leading-[18px] text-text-3">
          {BALANCE_WORDS.autoNeedsCard}
        </Text>
      ) : null}
      <AmountSheet
        which={editing}
        cents={editing === 'floor' ? wallet.floorCents : wallet.topupCents}
        onClose={() => setEditing(null)}
        onSave={(cents) => {
          const patch = editing === 'floor' ? { floorCents: cents } : { topupCents: cents };
          setEditing(null);
          onSave(patch, BALANCE_WORDS.saved);
        }}
      />
    </>
  );
}

/** One amount, typed. The top-up has a floor of its own, so it is refused here rather than by the API. */
function AmountSheet({
  which,
  cents,
  onClose,
  onSave,
}: {
  which: 'floor' | 'topup' | null;
  cents: number;
  onClose: () => void;
  onSave: (cents: number) => void;
}) {
  const [typed, setTyped] = React.useState('');
  const [refused, setRefused] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (which) {
      setTyped(String(cents / 100));
      setRefused(null);
    }
  }, [cents, which]);

  const save = () => {
    const parsed = parseMoney(typed);
    if (parsed === null) return setRefused(BALANCE_WORDS.amountRefused);
    if (which === 'topup' && parsed < MIN_TOPUP_CENTS)
      return setRefused(BALANCE_WORDS.amountTooSmall);
    onSave(parsed);
  };

  return (
    <Sheet
      open={which !== null}
      onClose={onClose}
      title={which === 'floor' ? BALANCE_WORDS.floorLabel : BALANCE_WORDS.amountLabel}
      testID="balance-amount-sheet"
    >
      <View className="mt-1 gap-1.5">
        <Label>{BALANCE_WORDS.amountLabel}</Label>
        <Input
          value={typed}
          onChangeText={(next) => {
            setTyped(next);
            setRefused(null);
          }}
          keyboardType="decimal-pad"
          invalid={refused !== null}
          autoFocus
          testID="balance-amount-input"
        />
        <FieldError testID="balance-amount-refused">{refused}</FieldError>
      </View>
      <View className="mt-4 gap-2">
        <Button onPress={save} testID="balance-amount-save">
          {BALANCE_WORDS.save}
        </Button>
        <Button variant="ghost" onPress={onClose} testID="balance-amount-cancel">
          {BALANCE_WORDS.cancel}
        </Button>
      </View>
    </Sheet>
  );
}

/**
 * The card the top-ups are charged to. Adding one opens the payment provider's own page in the browser and
 * comes back here when it is done: there is no field in the app a card could be typed into, which is what
 * keeps the app itself out of the way of anybody's card number.
 */
function CardOnFile({
  wallet,
  manage,
  busy,
  onAddCard,
  onForget,
}: {
  wallet: Wallet;
  manage: boolean;
  busy: boolean;
  onAddCard: () => void;
  onForget: () => void;
}) {
  const [asking, setAsking] = React.useState(false);
  return (
    <>
      <ListLabel>{BALANCE_WORDS.cardTitle}</ListLabel>
      <List testID="balance-card-on-file">
        <ListRow
          icon={wallet.card ? CreditCard : WalletIcon}
          label={
            wallet.card
              ? cardLine(wallet.card)
              : wallet.cardRequested
                ? BALANCE_WORDS.cardWaiting
                : BALANCE_WORDS.cardNone
          }
          detail={BALANCE_WORDS.cardDetail}
          chevron={false}
        />
      </List>
      {manage ? (
        <View className="gap-2 px-1">
          <Button
            variant={wallet.card ? 'secondary' : 'primary'}
            icon={ExternalLink}
            disabled={busy}
            onPress={onAddCard}
            testID="balance-add-card"
          >
            {wallet.card ? BALANCE_WORDS.changeCard : BALANCE_WORDS.addCard}
          </Button>
          {wallet.card ? (
            <Button
              variant="dangerOutline"
              disabled={busy}
              onPress={() => setAsking(true)}
              testID="balance-forget-card"
            >
              {BALANCE_WORDS.removeCard}
            </Button>
          ) : null}
          <Text className="text-[12.5px] leading-[18px] text-text-3">
            {BALANCE_WORDS.cardOnProvider}
          </Text>
        </View>
      ) : null}
      <Sheet
        open={asking}
        onClose={() => setAsking(false)}
        title={BALANCE_WORDS.removeCardTitle}
        testID="balance-forget-card-sheet"
      >
        <Text className="mb-4 mt-1 text-sm leading-5 text-text-2">
          {BALANCE_WORDS.removeCardAsk}
        </Text>
        <View className="gap-2">
          <Button
            variant="danger"
            onPress={() => {
              setAsking(false);
              onForget();
            }}
            testID="balance-forget-card-confirm"
          >
            {BALANCE_WORDS.removeCard}
          </Button>
          <Button variant="ghost" onPress={() => setAsking(false)}>
            {BALANCE_WORDS.keep}
          </Button>
        </View>
      </Sheet>
    </>
  );
}

/** What a text, a minute of a call, a number and an AI reply cost this business today. */
function Prices({ view }: { view: WalletView }) {
  if (!view.prices?.items.length) return null;
  return (
    <>
      <ListLabel>{BALANCE_WORDS.pricesTitle}</ListLabel>
      <Card className="px-3.5 py-1" testID="balance-prices">
        {view.prices.items.map((price, i) => (
          <View
            key={price.key ?? price.what}
            className={cn(
              'flex-row items-center justify-between gap-3 py-2.5',
              i > 0 && 'border-t border-border',
            )}
          >
            <Text className="min-w-0 flex-1 text-[13.5px] text-text-2">{price.what}</Text>
            <Text className="font-mono text-[13px]">
              {price.unit === 'about' ? 'about ' : ''}
              {money(price.cents)}
              {price.unit !== 'about' && price.unit !== 'each' ? ` ${price.unit}` : ''}
            </Text>
          </View>
        ))}
      </Card>
    </>
  );
}

/** Every charge behind the number, newest first, a page at a time. */
function StatementRows({ view, timeZone }: { view: WalletView; timeZone: string }) {
  return (
    <>
      <ListLabel>{BALANCE_WORDS.statementTitle}</ListLabel>
      {view.entries.length ? (
        <Card className="px-3.5 py-1" testID="balance-statement">
          {view.entries.map((entry, i) => (
            <Row key={entry.id} entry={entry} timeZone={timeZone} first={i === 0} />
          ))}
        </Card>
      ) : (
        <Card className="px-3.5 py-4" testID="balance-statement-empty">
          <Text className="text-[13.5px] leading-5 text-text-2">
            {BALANCE_WORDS.statementEmpty}
          </Text>
        </Card>
      )}
      {view.hasMore ? (
        <Button
          variant="secondary"
          loading={view.loadingMore}
          onPress={view.more}
          testID="balance-statement-more"
        >
          {BALANCE_WORDS.statementMore}
        </Button>
      ) : null}
      <View className="flex-row items-start gap-[9px] rounded-[10px] bg-card-2 px-3 py-[11px]">
        <Icon as={Info} className="mt-px size-4 text-text-2" />
        <Text className="flex-1 text-[12.5px] leading-[18px] text-text-2">
          {BALANCE_WORDS.statementCsvOnWeb}
        </Text>
      </View>
    </>
  );
}

/** One charge: what it was and when, then what it did to the balance and what was left. */
function Row({
  entry,
  timeZone,
  first,
}: {
  entry: StatementEntry;
  timeZone: string;
  first: boolean;
}) {
  const inward = entry.amountCents > 0;
  return (
    <View
      className={cn('flex-row items-center gap-3 py-2.5', !first && 'border-t border-border')}
      testID="balance-statement-row"
    >
      <View className="min-w-0 flex-1 gap-px">
        <Text className="text-[14px]" numberOfLines={1}>
          {entry.subject || BALANCE_WORDS.usage}
        </Text>
        <Text className="text-[12px] text-text-3" numberOfLines={1}>
          {whenLabel(Date.parse(entry.occurredAt), timeZone)}
          {entry.quantity !== null && entry.unit ? ` · ${entry.quantity} ${entry.unit}` : ''}
        </Text>
      </View>
      <View className="items-end gap-px">
        <Text className={cn('font-mono text-[13px]', inward ? 'text-success-text' : 'text-text-2')}>
          {inward ? '+' : '−'}
          {money(Math.abs(entry.amountCents))}
        </Text>
        <Text className="font-mono text-[12px] text-text-3">{money(entry.balanceAfterCents)}</Text>
      </View>
    </View>
  );
}

const NOTE = {
  danger: { bg: 'bg-danger-soft', fg: 'text-danger-text' },
  warning: { bg: 'bg-warning-soft', fg: 'text-warning-text' },
  info: { bg: 'bg-card-2', fg: 'text-text-2' },
} as const;

/** A coloured note: the card declined, the top-up that grew, or what a member may not do here. */
function Note({
  tone,
  words,
  testID,
}: {
  tone: keyof typeof NOTE;
  words: string;
  testID?: string;
}) {
  const look = NOTE[tone];
  return (
    <View className={cn('rounded-[10px] px-3 py-[11px]', look.bg)} testID={testID}>
      <Text className={cn('text-[13px] leading-[19px]', look.fg)}>{words}</Text>
    </View>
  );
}
