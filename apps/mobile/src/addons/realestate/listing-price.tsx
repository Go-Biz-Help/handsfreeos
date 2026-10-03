import { fmtMonthDay, localDateOf, localDayOf, money, parseMoney } from '@hfos/core';
import {
  RE_LISTING_ONLY,
  RE_PRICE_WORDS as W,
} from '@hfos/core/addons/realestate/phone-words-listing';
import {
  listingPricesOfCopy,
  type ListingPricesView,
} from '@hfos/core/addons/realestate/views/listing';
import * as React from 'react';
import { View } from 'react-native';

import { List, ListLabel } from '@/components/shell/list';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { api, errorMessage, unwrap } from '@/lib/api';

import { proposePrice } from './listing-actions';
import {
  CheckRow,
  DealSubpage,
  FieldError,
  FieldLabel,
  SignalNote,
  SummaryAnswer,
  useDealPage,
  useSummaryAnswer,
} from './subpage';

/**
 * A listing's price on the phone (board 88, first panel): what it's asking and since when, a change waiting on the
 * seller, and its history. Chris decided (2026-10-01) the seller signs off a new price first: asking reaches their
 * portal, so with no signal it waits and asks again after 30 minutes. `?change=1` opens the change.
 */

const DAY_MS = 86_400_000;

export function ListingPriceScreen({ dealId, change }: { dealId: string; change?: boolean }) {
  const { ctx, copy, deal, whole } = useDealPage(dealId);
  const prices = React.useMemo(
    () => listingPricesOfCopy(copy, dealId, { userId: ctx.userId }),
    [copy, dealId, ctx.userId],
  );
  const client = copy.clients.get(dealId);
  const seller = (client ? copy.personParts(client)?.firstName : null) || 'the seller';
  // When it was first listed: the list price's first entry on Key dates.
  const listedAt = React.useMemo(() => {
    const first = (copy.terms.get(dealId) ?? [])
      .filter((t) => t.key === 'list_price')
      .sort((a, b) => a.enteredAt - b.enteredAt)[0];
    return first ? new Date(first.enteredAt).toISOString() : null;
  }, [copy, dealId]);
  const server = useSummaryAnswer(
    !!deal && !whole,
    async () =>
      unwrap(
        await api.POST('/v1/queries/realestate.listing.prices', {
          body: { workspaceId: ctx.workspaceId, dealId },
        }),
      ),
    `listing-prices:${dealId}`,
    'price',
  );
  const [changing, setChanging] = React.useState(!!change);
  return (
    <DealSubpage
      workspaceId={ctx.workspaceId}
      dealId={dealId}
      deal={deal}
      title={W.title}
      testID="re-listing-price"
    >
      {!whole ? (
        <SummaryAnswer answer={server} what="price">
          {(data) => (
            <PriceBody
              prices={data}
              seller={seller}
              listedAt={listedAt}
              today={ctx.today}
              timeZone={ctx.timeZone}
            />
          )}
        </SummaryAnswer>
      ) : prices ? (
        <PriceBody
          prices={prices}
          seller={seller}
          listedAt={listedAt}
          today={ctx.today}
          timeZone={ctx.timeZone}
          onChange={() => setChanging(true)}
        />
      ) : (
        <Card className="p-4">
          <Text className="text-[14px] text-text-2">{RE_LISTING_ONLY(deal?.name ?? '')}</Text>
        </Card>
      )}
      {prices?.currentCents != null && !prices.waiting ? (
        <PriceSheet
          open={changing}
          seller={seller}
          currentCents={prices.currentCents}
          onClose={() => setChanging(false)}
          onAsk={async (priceCents, note) => {
            await proposePrice({
              workspaceId: ctx.workspaceId,
              dealId,
              userId: ctx.userId,
              fromCents: prices.currentCents!,
              priceCents,
              note,
            });
            toast.show(W.sent(seller));
          }}
        />
      ) : null}
    </DealSubpage>
  );
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function PriceBody({
  prices,
  seller,
  listedAt,
  today,
  timeZone,
  onChange,
}: {
  prices: ListingPricesView;
  seller: string;
  /** When the list price was first entered. */
  listedAt: string | null;
  today: string;
  timeZone: string;
  onChange?: () => void;
}) {
  const Seller = cap(seller);
  const day = (iso: string) => fmtMonthDay(localDayOf(iso, timeZone));
  const applied = prices.history.filter((p) => p.state === 'applied');
  const since = applied[0]?.appliedAt ?? listedAt;
  const days = since
    ? Math.max(
        0,
        Math.round(
          (Date.parse(today) - Date.parse(localDateOf(Date.parse(since), timeZone))) / DAY_MS,
        ),
      )
    : null;
  const w = prices.waiting;
  // The price it was first listed at: before the oldest change, or the one there is.
  const oldest = prices.history.at(-1);
  const firstCents = oldest ? oldest.fromCents : prices.currentCents;
  return (
    <View className="gap-3" testID="price-body">
      <Card className="gap-1 p-4">
        <Text className="text-[13px] text-text-2">{W.asking}</Text>
        {prices.currentCents !== null ? (
          <>
            <Text className="text-[28px] font-bold tracking-[-0.5px]" testID="price-asking">
              {money(prices.currentCents)}
            </Text>
            {since && days !== null ? (
              <Text className="text-[13.5px] text-text-2">
                {W.since(day(since), days, prices.showings.showings)}
              </Text>
            ) : null}
          </>
        ) : (
          <Text className="text-[14px] text-text-2">{W.noPrice}</Text>
        )}
      </Card>
      {w ? (
        <>
          <ListLabel>{W.asked(Seller)}</ListLabel>
          <Card className="gap-1 p-4" testID="price-waiting">
            <View className="flex-row items-start justify-between gap-2">
              <Text className="flex-1 text-[15px] font-semibold">
                {w.toCents < w.fromCents ? W.lower(money(w.toCents)) : W.raise(money(w.toCents))}
              </Text>
              <Badge variant="pending">{W.waitingOn(Seller)}</Badge>
            </View>
            <Text className="text-[13.5px] text-text-2">
              {[W.askedIn(day(w.proposedAt), Seller), w.note].filter(Boolean).join(' · ')}
            </Text>
          </Card>
        </>
      ) : null}
      <ListLabel>{W.history}</ListLabel>
      <List testID="price-history">
        {prices.history
          .filter((p) => p.state === 'applied' || p.state === 'withdrawn')
          .map((p) => (
            <CheckRow
              key={p.id}
              label={money(p.toCents)}
              line={
                p.state === 'withdrawn'
                  ? W.withdrawn(day(p.proposedAt))
                  : W.changed(
                      day(p.appliedAt ?? p.proposedAt),
                      p.how === 'let_through'
                        ? W.letThrough
                        : p.signedBy
                          ? W.signedBy(p.signedBy)
                          : null,
                    )
              }
            />
          ))}
        {firstCents !== null ? (
          <CheckRow
            label={money(firstCents)}
            line={listedAt ? W.listed(day(listedAt)) : null}
            testID="price-listed"
          />
        ) : null}
      </List>
      {onChange && prices.currentCents !== null && !w ? (
        <Button variant="secondary" onPress={onChange} testID="price-change">
          {W.change}
        </Button>
      ) : null}
      <SignalNote>{W.note}</SignalNote>
    </View>
  );
}

/** A new price, and why, asked of the seller. */
export function PriceSheet({
  open,
  seller,
  currentCents,
  onClose,
  onAsk,
}: {
  open: boolean;
  seller: string;
  currentCents: number;
  onClose: () => void;
  onAsk: (priceCents: number, note: string | null) => Promise<void>;
}) {
  const [price, setPrice] = React.useState('');
  const [note, setNote] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!open) return;
    setPrice('');
    setNote('');
    setError(null);
  }, [open]);
  const ask = async () => {
    const cents = parseMoney(price);
    if (cents === null || cents <= 0) {
      setError(W.enterPrice);
      return;
    }
    if (cents === currentCents) {
      setError(W.same);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onAsk(cents, note.trim() || null);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet open={open} onClose={onClose} title={W.changeTitle} testID="price-sheet">
      <View className="gap-3">
        <FieldLabel>{W.newPrice}</FieldLabel>
        <Input
          value={price}
          onChangeText={setPrice}
          keyboardType="decimal-pad"
          placeholder={money(currentCents)}
          invalid={!!error}
          testID="price-new"
        />
        <FieldLabel>{W.why}</FieldLabel>
        <Input value={note} onChangeText={setNote} placeholder={W.whyHint} testID="price-why" />
        <FieldError testID="price-error">{error}</FieldError>
        <Button loading={busy} onPress={() => void ask()} testID="price-ask">
          {W.ask(cap(seller))}
        </Button>
        <SignalNote>{W.note}</SignalNote>
      </View>
    </Sheet>
  );
}
