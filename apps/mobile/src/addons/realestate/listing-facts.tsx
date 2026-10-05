import { fmtMonthDay, fmtTime, localDayOf, money, parseMoney } from '@hfos/core';
import { FACT_FROM, LISTING_HOME_FACT_KEYS } from '@hfos/core/addons/realestate/listing';
import { LISTING_FACTS } from '@hfos/core/addons/realestate/homes';
import {
  factPhrase,
  RE_FACTS_WORDS as W,
  RE_LISTING_ONLY,
} from '@hfos/core/addons/realestate/phone-words-listing';
import {
  listingFactLinesOfCopy,
  listingOfCopy,
  type ListingFactLine,
  type ListingView,
} from '@hfos/core/addons/realestate/views/listing';
import * as React from 'react';
import { View } from 'react-native';

import { Check, Pencil, Tag, TriangleAlert } from '@/components/icons';
import { List, ListLabel } from '@/components/shell/list';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { api, errorMessage, unwrap } from '@/lib/api';

import { confirmFacts, lookUpListing } from './listing-actions';
import { SignalButton } from './kit';
import {
  ChangeButton,
  CheckRow,
  Chips,
  DealSubpage,
  FieldError,
  FieldLabel,
  SummaryAnswer,
  useDealPage,
  useSummaryAnswer,
} from './subpage';

/**
 * A listing's facts on the phone (board 87, first and last panels): each fact with where it came from, a banner when
 * the MLS says something else, and everything the MLS said about the listing, kept as it said it. Reading works with
 * no signal; asking the MLS again needs it.
 */

type FactKey = ListingFactLine['key'];
/** The facts typed as a number on the phone (a home's type is picked on the web). */
const TYPED: readonly FactKey[] = LISTING_HOME_FACT_KEYS.filter((k) => k !== 'property_type');

export function ListingFactsScreen({ dealId }: { dealId: string }) {
  const { ctx, copy, deal, whole } = useDealPage(dealId);
  const listing = React.useMemo(
    () => listingOfCopy(copy, dealId, { userId: ctx.userId }),
    [copy, dealId, ctx.userId],
  );
  const lines = React.useMemo(
    () => listingFactLinesOfCopy(copy, dealId, { userId: ctx.userId }),
    [copy, dealId, ctx.userId],
  );
  const server = useSummaryAnswer(
    !!deal && !whole,
    async () =>
      unwrap(
        await api.POST('/v1/queries/realestate.listing', {
          body: { workspaceId: ctx.workspaceId, dealId },
        }),
      ).listing,
    `listing:${dealId}`,
    'facts',
  );
  const [changing, setChanging] = React.useState(false);
  return (
    <DealSubpage
      workspaceId={ctx.workspaceId}
      dealId={dealId}
      deal={deal}
      title={W.title}
      testID="re-listing-facts"
    >
      {!whole ? (
        <SummaryAnswer answer={server} what="facts">
          {(data) => (
            <ListingFactsBody
              listing={data}
              lines={data.choices.flatMap((c) =>
                c.confirmed
                  ? [
                      {
                        key: c.key,
                        label: c.label,
                        words: c.confirmed.words,
                        from: c.confirmed.from,
                        mlsWords: data.feed.mls?.differs.includes(c.key)
                          ? (c.candidates.find((x) => x.from === 'mls')?.words ?? null)
                          : null,
                      },
                    ]
                  : [],
              )}
              timeZone={ctx.timeZone}
            />
          )}
        </SummaryAnswer>
      ) : listing && lines ? (
        <ListingFactsBody
          listing={listing}
          lines={lines}
          timeZone={ctx.timeZone}
          onChange={() => setChanging(true)}
          onCheck={async () => {
            await lookUpListing({ workspaceId: ctx.workspaceId, dealId });
            toast.show(W.asked);
          }}
        />
      ) : (
        <Card className="p-4">
          <Text className="text-[14px] text-text-2">{RE_LISTING_ONLY(deal?.name ?? '')}</Text>
        </Card>
      )}
      {listing && lines ? (
        <FactSheet
          open={changing}
          lines={lines}
          onClose={() => setChanging(false)}
          onSave={async (key, value) => {
            await confirmFacts({
              workspaceId: ctx.workspaceId,
              dealId,
              facts: { ...listing.facts, [key]: value },
              sources: { ...Object.fromEntries(lines.map((l) => [l.key, l.from])), [key]: 'agent' },
            });
            toast.show(W.saved);
          }}
        />
      ) : null}
    </DealSubpage>
  );
}

export function ListingFactsBody({
  listing,
  lines,
  timeZone,
  onChange,
  onCheck,
}: {
  listing: Pick<ListingView, 'feed' | 'listPriceCents'>;
  lines: readonly ListingFactLine[];
  timeZone: string;
  onChange?: () => void;
  onCheck?: () => Promise<void>;
}) {
  const differ = lines.filter((l) => l.mlsWords);
  return (
    <View className="gap-3" testID="listing-facts-body">
      {differ.map((l) => (
        <Card
          key={l.key}
          className="flex-row gap-2.5 border-warning bg-warning-soft p-3.5"
          testID={`facts-differs-${l.key}`}
        >
          <Icon as={TriangleAlert} className="mt-0.5 size-4 text-warning-text" />
          <Text className="flex-1 text-[14px] leading-[20px] text-warning-text">
            {W.differs(factPhrase(l.key, l.mlsWords!), l.words)}
          </Text>
        </Card>
      ))}
      {lines.length ? (
        <List testID="listing-facts">
          {lines.map((l) => (
            <View key={l.key} className="flex-row items-start gap-3 px-4 py-3">
              <Text className="flex-1 text-base text-text-2">{l.label}</Text>
              <View className="items-end gap-px">
                <Text className="text-base">{l.words}</Text>
                <Text className="text-[12.5px] text-text-3">
                  {[FACT_FROM[l.from], l.mlsWords ? W.mlsSays(l.mlsWords) : null]
                    .filter(Boolean)
                    .join(' · ')}
                </Text>
              </View>
            </View>
          ))}
        </List>
      ) : (
        <Card className="p-4">
          <Text className="text-[14px] text-text-2">{W.none}</Text>
        </Card>
      )}
      {onChange ? (
        <Button variant="secondary" icon={Pencil} onPress={onChange} testID="facts-change">
          {W.change}
        </Button>
      ) : null}
      <MlsSaid listing={listing} lines={lines} timeZone={timeZone} onCheck={onCheck} />
    </View>
  );
}

/** Everything the MLS said about the listing, kept as it said it; asking again needs signal. */
function MlsSaid({
  listing,
  lines,
  timeZone,
  onCheck,
}: {
  listing: Pick<ListingView, 'feed' | 'listPriceCents'>;
  lines: readonly ListingFactLine[];
  timeZone: string;
  onCheck?: () => Promise<void>;
}) {
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const mls = listing.feed.mls;
  const when = (at: string) => `${fmtMonthDay(localDayOf(at, timeZone))}, ${fmtTime(at, timeZone)}`;
  const differ = lines.filter((l) => l.mlsWords);
  const priceDiffers = listing.feed.differences.find((d) => d.key === 'price');
  const matches = !differ.length && !listing.feed.differences.length;
  return (
    <View className="gap-3" testID="listing-mls">
      <ListLabel>{W.mlsTitle}</ListLabel>
      {mls ? (
        <>
          <Card className="gap-1 p-4">
            <View className="flex-row items-start justify-between gap-2">
              <Text className="flex-1 text-[15px] font-semibold">
                {[mls.statusWords, mls.listPriceCents !== null ? money(mls.listPriceCents) : null]
                  .filter(Boolean)
                  .join(' · ')}
              </Text>
              <Badge variant={matches ? 'ok' : 'pending'}>
                {matches ? W.matches : W.differsBadge}
              </Badge>
            </View>
            <Text className="text-[13.5px] text-text-2">
              {[mls.mlsNumber, mls.sourceWords, W.checked(fmtTime(mls.checkedAt, timeZone))]
                .filter(Boolean)
                .join(' · ')}
            </Text>
          </Card>
          <ListLabel>{W.mlsSaid}</ListLabel>
          <List>
            <CheckRow icon={Check} label={W.status(mls.statusWords)} line={when(mls.checkedAt)} />
            {mls.listPriceCents !== null ? (
              <CheckRow
                icon={Tag}
                label={W.price(money(mls.listPriceCents))}
                line={priceDiffers ? priceDiffers.words : W.priceMatches}
              />
            ) : null}
            {differ.map((l) => (
              <CheckRow
                key={l.key}
                icon={TriangleAlert}
                label={W.fact(l.label, l.mlsWords!)}
                line={W.youHave(l.words)}
              />
            ))}
          </List>
        </>
      ) : (
        <Card className="p-4">
          <Text className="text-[14px] text-text-2">{listing.feed.words ?? W.notLooked}</Text>
        </Card>
      )}
      <FieldError>{error}</FieldError>
      {onCheck ? (
        <SignalButton
          label={W.checkAgain}
          why={W.checkWhy}
          variant="secondary"
          disabled={busy}
          onPress={() => {
            setBusy(true);
            setError(null);
            onCheck()
              .catch((e: unknown) => setError(errorMessage(e)))
              .finally(() => setBusy(false));
          }}
          testID="facts-check-again"
        />
      ) : null}
    </View>
  );
}

/** A fact typed as a number, as the server takes it: whole, a half, or cents. */
export function factValue(key: FactKey, text: string): number | null {
  const kind = LISTING_FACTS[key].kind;
  if (kind === 'money') {
    const cents = parseMoney(text);
    return cents === null || !text.trim() ? null : cents;
  }
  const n = Number(text.replace(/,/g, '').trim());
  if (!text.trim() || !Number.isFinite(n) || n < 0) return null;
  if (kind === 'half') return Math.round(n * 2) / 2;
  return Math.round(n);
}

/** Changing one fact: which, and what it is. Typed by the agent. */
export function FactSheet({
  open,
  lines,
  onClose,
  onSave,
}: {
  open: boolean;
  lines: readonly ListingFactLine[];
  onClose: () => void;
  onSave: (key: FactKey, value: number) => Promise<void>;
}) {
  const first = lines.find((l) => l.mlsWords)?.key ?? lines[0]?.key ?? TYPED[0]!;
  const [key, setKey] = React.useState<FactKey>(first);
  const [text, setText] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!open) return;
    setKey(first);
    setError(null);
    // The fact first shown, when the sheet opens.
  }, [open]);
  React.useEffect(() => {
    const l = lines.find((x) => x.key === key);
    setText(l ? l.words.replace(/[$,]/g, '') : '');
  }, [key, lines]);
  const save = async () => {
    const value = factValue(key, text);
    if (value === null) {
      setError(W.notANumber(LISTING_FACTS[key].label));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSave(key, value);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet open={open} onClose={onClose} title={W.changeTitle} testID="facts-sheet">
      <View className="gap-3">
        <FieldLabel>{W.which}</FieldLabel>
        <Chips
          value={key}
          onChange={setKey}
          options={TYPED.map((k) => [k, LISTING_FACTS[k].label] as const)}
          testID="facts-which"
        />
        <FieldLabel>{W.value}</FieldLabel>
        <Input
          value={text}
          onChangeText={setText}
          keyboardType="decimal-pad"
          invalid={!!error}
          testID="facts-value"
        />
        <FieldError testID="facts-error">{error}</FieldError>
        <ChangeButton
          command="realestate.listing.confirm_facts"
          label={W.save}
          why={W.saveWhy}
          loading={busy}
          onPress={() => void save()}
          testID="facts-save"
        />
      </View>
    </Sheet>
  );
}
