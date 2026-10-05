import { fmtAt, fmtMonthDay, fmtTime, localDayOf, money, parseMoney } from '@hfos/core';
import { SELLER_CHOICES } from '@hfos/core/addons/realestate/net';
import {
  answerByWords,
  closingWords,
  offerBadge,
  offerName,
  offerTermRows,
  offerTermsLine,
  riskWords,
  versionAt,
  versionWords,
  versusWords,
  RE_BUYER_WORDS as W,
} from '@hfos/core/addons/realestate/phone-words-buyer';
import { RE_PHONE_WORDS } from '@hfos/core/addons/realestate/phone-words';
import {
  offersCompareOfCopy,
  offersOfCopy,
  type OffersCompareView,
  type OffersView,
} from '@hfos/core/addons/realestate/views/offers';
import { useQuery } from '@powersync/react-native';
import * as React from 'react';
import { Linking, Pressable, View } from 'react-native';

import { Field } from '@/components/calendar/new-appointment';
import { Check, ChevronRight, Globe, Phone } from '@/components/icons';
import { Screen } from '@/components/shell/screen';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { api, unwrap } from '@/lib/api';
import { openWeb } from '@/lib/open-web';
import { cn } from '@/lib/utils';

import { addOfferVersion, shareOfferSummary } from './buyer-actions';
import {
  attempt,
  DealNotHere,
  GroupLabel,
  KeyValues,
  SignalNote,
  SummaryHead,
  useBuyerDeal,
  type BuyerDeal,
} from './buyer-kit';
import {
  NeedsSignalCard,
  openRe,
  reHref,
  SignalButton,
  useLiveAnswer,
  type ReContext,
} from './kit';

/**
 * Offers (board 84): each with the clock on its answer and, on a listing, the seller's net worked out from the same
 * figures as the web; one offer's terms with every version kept; and its one-page summary as the client sees it, with
 * what they answered from their portal. Offers stay online: writing a counter or sharing the summary needs signal.
 * `?start=1` (starting an offer) opens on the web, where the whole offer is written.
 */

type Offer = OffersView['offers'][number];
type Version = Offer['versions'][number];
type CompareRow = OffersCompareView['rows'][number];

interface OffersData {
  readonly offers: OffersView | null;
  readonly compare: OffersCompareView | null;
}

/** The deal's offers, and on a listing its offers side by side: from the phone's copy, or with signal on a summary. */
function useOffers(dealId: string) {
  const { ctx, copy, deal } = useBuyerDeal(dealId);
  const kept = React.useMemo<OffersData>(
    () => ({
      offers: offersOfCopy(copy, dealId, ctx),
      compare: offersCompareOfCopy(copy, dealId, ctx),
    }),
    [copy, dealId, ctx],
  );
  const full = deal?.full ?? false;
  const live = useLiveAnswer<OffersData>(
    deal && !full
      ? async () => {
          const body = { workspaceId: ctx.workspaceId, dealId };
          const [offers, compare] = await Promise.all([
            api.POST('/v1/queries/realestate.offers', { body }).then(unwrap),
            deal.side === 'listing'
              ? api.POST('/v1/queries/realestate.offers.compare', { body }).then(unwrap)
              : Promise.resolve(null),
          ]);
          return { offers, compare };
        }
      : null,
    `offers:${dealId}`,
    RE_PHONE_WORDS.summaryNeedsSignal(W.offers),
  );
  return { ctx, deal, full, data: full ? kept : live.data, live };
}

export function OffersScreen({ dealId, start }: { dealId: string; start?: boolean }) {
  const { ctx, deal, full, data, live } = useOffers(dealId);
  if (!deal) return <DealNotHere title={W.offersTitle} workspaceId={ctx.workspaceId} />;
  return (
    <Screen
      title={W.offersTitle}
      subtitle={deal.name}
      leading="back"
      back={reHref(ctx.workspaceId, `deals/${dealId}`)}
      testID="re-offers"
    >
      {!full ? <SummaryHead /> : null}
      {start ? (
        <Card className="gap-2.5 p-3.5" testID="re-offers-start">
          <Text className="text-[14.5px] leading-[20px] text-text-2">{W.startOnWeb}</Text>
          <Button
            variant="secondary"
            icon={Globe}
            onPress={() =>
              void openWeb(`/app/w/${ctx.workspaceId}/a/realestate/deals/${dealId}/offers?start=1`)
            }
          >
            {RE_PHONE_WORDS.openOnWeb}
          </Button>
        </Card>
      ) : null}
      {data?.offers ? (
        <OffersBody
          workspaceId={ctx.workspaceId}
          deal={deal}
          offers={data.offers.offers}
          compare={data.compare}
          ctx={ctx}
        />
      ) : live.error ? (
        <NeedsSignalCard words={live.error} onRetry={live.reload} />
      ) : null}
    </Screen>
  );
}

const live_ = (o: Offer) => o.status === 'waiting_them' || o.status === 'waiting_us';
const newest = (o: Offer): Version => o.versions.at(-1)!;
/** The seller's (or buyer's) first name, for "Net to Maria". */
const firstOf = (name: string) => name.trim().split(/\s+/)[0] ?? name;

export function OffersBody({
  workspaceId,
  deal,
  offers,
  compare,
  ctx,
}: {
  workspaceId: string;
  deal: BuyerDeal;
  offers: readonly Offer[];
  compare: OffersCompareView | null;
  ctx: Pick<ReContext, 'now' | 'today' | 'timeZone'>;
}) {
  const [sideBySide, setSideBySide] = React.useState(false);
  const open = offers.filter(live_);
  const ended = offers.filter((o) => !live_(o));
  const net = new Map((compare?.rows ?? []).map((r) => [r.offerId, r]));
  const seller = firstOf(deal.clients[0]?.name ?? 'the seller');
  return (
    <View className="gap-3" testID="re-offers-body">
      <GroupLabel>{W.offersIn(deal.name, open.length, deal.side)}</GroupLabel>
      {offers.length === 0 ? (
        <Card className="px-4 py-5">
          <Text className="text-[14.5px] leading-[21px] text-text-2">
            {W.offersEmpty(deal.side)}
          </Text>
        </Card>
      ) : null}
      {open.map((o) => {
        const v = newest(o);
        const row = net.get(o.id);
        return (
          <Card key={o.id}>
            <Pressable
              role="button"
              onPress={() => openRe(workspaceId, `deals/${deal.id}/offers/${o.id}`)}
              className="gap-1.5 p-3.5 active:bg-card-2"
              testID={`re-offer-${o.id}`}
            >
              <View className="flex-row flex-wrap items-center justify-between gap-2">
                <Text className="text-[15.5px] font-semibold">
                  {W.offerCard(offerName(o), v.priceCents)}
                </Text>
                {o.clock?.respondBy ? (
                  <Badge variant="pending">
                    {answerByWords(o.clock.respondBy, ctx.now, ctx.timeZone)}
                  </Badge>
                ) : (
                  <Badge variant={offerBadge(o.status, o.versions.length, deal.side).tone}>
                    {offerBadge(o.status, o.versions.length, deal.side).words}
                  </Badge>
                )}
              </View>
              <Text className="text-[13.5px] leading-[19px] text-text-2">
                {offerTermsLine(v, ctx.today)}
              </Text>
              {row ? (
                <Text className="text-[13.5px] text-text-2" testID={`re-offer-net-${o.id}`}>
                  {`${W.netTo(seller)} `}
                  <Text className="text-[13.5px] font-semibold">{money(row.net.netCents)}</Text>
                </Text>
              ) : null}
            </Pressable>
          </Card>
        );
      })}
      {deal.side === 'listing' && (compare?.rows.length ?? 0) > 1 ? (
        <Button variant="secondary" onPress={() => setSideBySide(true)} testID="re-offers-compare">
          {W.sideBySide}
        </Button>
      ) : null}
      {ended.length ? (
        <>
          <GroupLabel>{W.ended}</GroupLabel>
          <Card>
            {ended.map((o, i) => {
              const v = newest(o);
              const accepted = o.versions.find((x) => x.id === o.acceptedVersionId) ?? v;
              const badge = offerBadge(o.status, o.versions.length, deal.side);
              return (
                <Pressable
                  key={o.id}
                  role="button"
                  onPress={() => openRe(workspaceId, `deals/${deal.id}/offers/${o.id}`)}
                  className={cn(
                    'min-h-14 flex-row items-center gap-3 px-3.5 py-2.5 active:bg-card-2',
                    i > 0 && 'border-t border-border',
                  )}
                  testID={`re-offer-${o.id}`}
                >
                  {o.status === 'accepted' ? (
                    <Icon as={Check} className="size-[18px] text-success-text" />
                  ) : null}
                  <View className="min-w-0 flex-1 gap-px">
                    <Text className="text-base">
                      {o.status === 'accepted'
                        ? W.acceptedLine(offerName(o), accepted.number)
                        : W.endedLine(offerName(o), badge.words)}
                    </Text>
                    <Text className="text-[13px] text-text-3">
                      {[
                        money(accepted.priceCents),
                        o.endedAt
                          ? fmtMonthDay(
                              localDayOf(o.endedAt, ctx.timeZone),
                              Number(ctx.today.slice(0, 4)),
                            )
                          : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </Text>
                  </View>
                  <Icon as={ChevronRight} className="size-4 text-text-3" />
                </Pressable>
              );
            })}
          </Card>
        </>
      ) : null}
      {compare ? (
        <SideBySideSheet
          open={sideBySide}
          onClose={() => setSideBySide(false)}
          rows={compare.rows}
          offers={offers}
          seller={seller}
          today={ctx.today}
        />
      ) : null}
    </View>
  );
}

function SideBySideSheet({
  open,
  onClose,
  rows,
  offers,
  seller,
  today,
}: {
  open: boolean;
  onClose: () => void;
  rows: readonly CompareRow[];
  offers: readonly Offer[];
  seller: string;
  today: string;
}) {
  const nameOf = (id: string) => {
    const o = offers.find((x) => x.id === id);
    return o ? offerName(o) : '';
  };
  return (
    <Sheet open={open} onClose={onClose} title={W.sideBySide} scroll testID="re-offers-side">
      <View className="mt-3 gap-3">
        {rows.map((r) => (
          <KeyValues
            key={r.offerId}
            rows={[
              { label: nameOf(r.offerId), value: money(r.priceCents) },
              { label: W.paying, value: r.paying },
              ...(r.closingDate
                ? [{ label: W.closing, value: closingWords(r.closingDate, today) }]
                : []),
              ...(r.inspection ? [{ label: W.option, value: r.inspection }] : []),
              { label: W.netTo(seller).replace(/:$/, ''), value: money(r.net.netCents) },
            ]}
          />
        ))}
      </View>
    </Sheet>
  );
}

export function OfferScreen({ dealId, offerId }: { dealId: string; offerId: string }) {
  const { ctx, deal, full, data, live } = useOffers(dealId);
  if (!deal) return <DealNotHere title={W.offersTitle} workspaceId={ctx.workspaceId} />;
  const offer = data?.offers?.offers.find((o) => o.id === offerId) ?? null;
  return (
    <Screen
      title={offer ? W.offerTitle(offerName(offer)) : W.offersTitle}
      subtitle={deal.name}
      leading="back"
      back={reHref(ctx.workspaceId, `deals/${dealId}/offers`)}
      testID="re-offer"
    >
      {!full ? <SummaryHead /> : null}
      {offer ? (
        <OfferBody workspaceId={ctx.workspaceId} deal={deal} offer={offer} ctx={ctx} />
      ) : data ? (
        <NeedsSignalCard words={W.offerGone} />
      ) : live.error ? (
        <NeedsSignalCard words={live.error} onRetry={live.reload} />
      ) : null}
    </Screen>
  );
}

export function OfferBody({
  workspaceId,
  deal,
  offer,
  ctx,
}: {
  workspaceId: string;
  deal: BuyerDeal;
  offer: Offer;
  ctx: Pick<ReContext, 'now' | 'today' | 'timeZone'>;
}) {
  const [shownId, setShownId] = React.useState(newest(offer).id);
  const [countering, setCountering] = React.useState(false);
  const shown = offer.versions.find((v) => v.id === shownId) ?? newest(offer);
  const before = offer.versions.find((v) => v.number === shown.number - 1) ?? null;
  const badge = offerBadge(offer.status, offer.versions.length, deal.side);
  const name = offerName(offer);
  return (
    <View className="gap-3" testID="re-offer-body">
      <View className="flex-row items-center justify-between gap-2 px-1">
        <Text className="text-lg font-semibold">{W.offerHead(name, shown.number)}</Text>
        <Badge variant={badge.tone} testID="re-offer-badge">
          {badge.words}
        </Badge>
      </View>
      {offer.clock?.words ? (
        <Text className="px-1 text-[13px] text-text-2">{offer.clock.words}</Text>
      ) : null}
      <KeyValues rows={offerTermRows(shown, before, ctx.today)} testID="re-offer-terms" />
      <GroupLabel>{W.versions}</GroupLabel>
      <Card>
        {[...offer.versions].reverse().map((v, i) => (
          <Pressable
            key={v.id}
            role="button"
            accessibilityState={{ selected: v.id === shown.id }}
            onPress={() => setShownId(v.id)}
            className={cn(
              'min-h-14 flex-row items-center gap-3 px-3.5 py-2.5 active:bg-card-2',
              i > 0 && 'border-t border-border',
              v.id === shown.id && 'bg-card-2',
            )}
            testID={`re-offer-version-${v.number}`}
          >
            <View className="min-w-0 flex-1 gap-px">
              <Text className="text-base">{versionWords(v)}</Text>
              <Text className="text-[13px] text-text-3">
                {versionAt(v.at, ctx.timeZone, ctx.today)}
              </Text>
            </View>
            <Icon as={ChevronRight} className="size-4 text-text-3" />
          </Pressable>
        ))}
      </Card>
      <Button
        variant="secondary"
        onPress={() => openRe(workspaceId, `deals/${deal.id}/offers/${offer.id}/summary`)}
        testID="re-offer-summary"
      >
        {W.seeSummary}
      </Button>
      {live_(offer) ? (
        <>
          <SignalButton
            label={W.writeCounter}
            onPress={() => setCountering(true)}
            testID="re-offer-counter"
          />
          <SignalNote
            words={deal.side === 'listing' ? W.counterWhy : W.counterWhyBuyer}
            testID="re-offer-counter-why"
          />
          <CounterSheet
            open={countering}
            onClose={() => setCountering(false)}
            workspaceId={workspaceId}
            offer={offer}
          />
        </>
      ) : null}
    </View>
  );
}

const amountText = (cents: number | null) =>
  cents === null ? '' : (cents / 100).toLocaleString('en-US');

/** A counter: the newest terms, changed where the agent changes them. Needs signal. */
function CounterSheet({
  open,
  onClose,
  workspaceId,
  offer,
}: {
  open: boolean;
  onClose: () => void;
  workspaceId: string;
  offer: Offer;
}) {
  const v = newest(offer);
  const [price, setPrice] = React.useState(amountText(v.priceCents));
  const [emd, setEmd] = React.useState(amountText(v.emdCents));
  const [credit, setCredit] = React.useState(amountText(v.sellerCreditCents));
  const [closing, setClosing] = React.useState(v.closingDate ?? '');
  const [option, setOption] = React.useState(v.inspectionDays?.toString() ?? '');
  const [hours, setHours] = React.useState('24');
  const [note, setNote] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => {
    if (!open) return;
    setPrice(amountText(v.priceCents));
    setEmd(amountText(v.emdCents));
    setCredit(amountText(v.sellerCreditCents));
    setClosing(v.closingDate ?? '');
    setOption(v.inspectionDays?.toString() ?? '');
    setHours('24');
    setNote('');
  }, [open, v]);
  const send = async () => {
    const priceCents = parseMoney(price);
    if (!priceCents) {
      toast.error(W.notAmount(W.price));
      return;
    }
    const emdCents = emd.trim() ? parseMoney(emd) : null;
    const creditCents = credit.trim() ? parseMoney(credit) : 0;
    const days = option.trim() ? Number(option) : null;
    const within = Number(hours);
    setBusy(true);
    const ok = await attempt(
      () =>
        addOfferVersion({
          workspaceId,
          offerId: offer.id,
          side: 'us',
          terms: {
            priceCents,
            emdCents,
            emdDays: v.emdDays,
            sellerCreditCents: creditCents ?? 0,
            inspectionDays: days !== null && Number.isFinite(days) ? days : null,
            loanType: v.loanType,
            financingDays: v.financingDays,
            appraisalContingency: v.appraisalContingency,
            closingDate: closing.trim() || null,
            otherTerms: v.otherTerms,
            downPaymentPct: v.downPaymentPct,
            homeSaleContingency: v.homeSaleContingency,
            escalationCapCents: v.escalationCapCents,
            escalationStepCents: v.escalationStepCents,
            possession: v.possession,
            buyerAgentFeeBp: v.buyerAgentFeeBp,
            buyerAgentFeeCents: v.buyerAgentFeeCents,
          },
          respondBy:
            Number.isFinite(within) && within > 0
              ? new Date(Date.now() + within * 3_600_000).toISOString()
              : null,
          ...(note.trim() ? { note: note.trim() } : {}),
        }),
      W.counterSent,
    );
    setBusy(false);
    if (ok) onClose();
  };
  return (
    <Sheet open={open} onClose={onClose} title={W.counterTitle} scroll testID="re-counter">
      <View className="mt-3">
        <Field label={W.price}>
          <Input
            value={price}
            onChangeText={setPrice}
            keyboardType="decimal-pad"
            testID="re-counter-price"
          />
        </Field>
        <Field label={W.earnestMoney}>
          <Input value={emd} onChangeText={setEmd} keyboardType="decimal-pad" />
        </Field>
        <Field label={W.sellerPays}>
          <Input value={credit} onChangeText={setCredit} keyboardType="decimal-pad" />
        </Field>
        <View className="flex-row gap-2">
          <View className="flex-1">
            <Field label={W.optionDays}>
              <Input value={option} onChangeText={setOption} keyboardType="number-pad" />
            </Field>
          </View>
          <View className="flex-1">
            <Field label={W.closingOn}>
              <Input value={closing} onChangeText={setClosing} />
            </Field>
          </View>
        </View>
        <Field label={W.respondIn}>
          <Input value={hours} onChangeText={setHours} keyboardType="number-pad" />
        </Field>
        <Field label={W.counterNote}>
          <Input value={note} onChangeText={setNote} />
        </Field>
        <SignalButton
          label={W.writeCounter}
          onPress={() => void send()}
          disabled={busy}
          testID="re-counter-send"
        />
      </View>
    </Sheet>
  );
}

const PHONE_SQL = 'SELECT phone, phone_e164 FROM people WHERE id = ?';

export function OfferSummaryScreen({ dealId, offerId }: { dealId: string; offerId: string }) {
  const { ctx, deal, full, data, live } = useOffers(dealId);
  const client = deal?.clients[0] ?? null;
  const phone = useQuery<{ phone: string | null; phone_e164: string | null }>(PHONE_SQL, [
    client?.personId ?? '',
  ]).data[0];
  if (!deal) return <DealNotHere title={W.summary} workspaceId={ctx.workspaceId} />;
  const offer = data?.offers?.offers.find((o) => o.id === offerId) ?? null;
  return (
    <Screen
      title={W.summary}
      subtitle={offer ? W.offerTitle(offerName(offer)) : deal.name}
      leading="back"
      back={reHref(ctx.workspaceId, `deals/${dealId}/offers/${offerId}`)}
      testID="re-offer-summary-screen"
    >
      {!full ? <SummaryHead /> : null}
      {offer ? (
        <OfferSummaryBody
          workspaceId={ctx.workspaceId}
          deal={deal}
          offer={offer}
          offers={data?.offers?.offers ?? []}
          compare={data?.compare ?? null}
          phone={phone?.phone_e164 || phone?.phone || null}
          ctx={ctx}
          editable={full}
        />
      ) : data ? (
        <NeedsSignalCard words={W.offerGone} />
      ) : live.error ? (
        <NeedsSignalCard words={live.error} onRetry={live.reload} />
      ) : null}
    </Screen>
  );
}

export function OfferSummaryBody({
  workspaceId,
  deal,
  offer,
  offers,
  compare,
  phone,
  ctx,
  editable,
}: {
  workspaceId: string;
  deal: BuyerDeal;
  offer: Offer;
  offers: readonly Offer[];
  compare: OffersCompareView | null;
  phone: string | null;
  ctx: Pick<ReContext, 'now' | 'today' | 'timeZone'>;
  editable: boolean;
}) {
  const client = deal.clients[0] ?? null;
  const first = firstOf(client?.name ?? 'the client');
  const name = offerName(offer);
  const at = (iso: string) =>
    localDayOf(iso, ctx.timeZone) === ctx.today
      ? fmtTime(iso, ctx.timeZone)
      : fmtAt(iso, ctx.timeZone);
  const rows = compare?.rows ?? [];
  const mine = rows.find((r) => r.offerId === offer.id) ?? null;
  const rival = rows
    .filter((r) => r.offerId !== offer.id)
    .sort((a, b) => b.net.netCents - a.net.netCents)[0];
  const v = offer.versions.find((x) => x.id === mine?.versionId) ?? newest(offer);
  const choice = compare?.choices.find((c) => c.offerId === offer.id) ?? null;
  const rivalName = rival ? offerName(offers.find((o) => o.id === rival.offerId) ?? offer) : null;
  const lines =
    deal.side === 'listing' && mine
      ? [
          { label: W.youdNet, value: money(mine.net.netCents) },
          ...(v.closingDate
            ? [{ label: W.closing, value: closingWords(v.closingDate, ctx.today) }]
            : []),
          { label: W.risk, value: riskWords(v) },
          ...(rival && rivalName
            ? [
                {
                  label: W.versus(rivalName),
                  value: versusWords(
                    mine.net.netCents,
                    rival.net.netCents,
                    v.closingDate,
                    rival.closingDate,
                  ),
                },
              ]
            : []),
        ]
      : offer.summary.lines;
  const shared = offer.shared && offer.shared.current ? offer.shared : null;
  return (
    <View className="gap-3" testID="re-offer-summary-body">
      <Card className="gap-3 p-3.5">
        <View className="gap-1">
          <Text className="text-[16.5px] font-semibold">{W.summaryTitle(name)}</Text>
          <Text className="text-[13px] leading-[18px] text-text-2" testID="re-summary-for">
            {W.summaryFor(client?.name ?? first, first, shared ? at(shared.at) : null)}
          </Text>
        </View>
        <KeyValues rows={lines} testID="re-summary-lines" />
        {deal.side === 'buyer' ? (
          <Text className="text-[13px] leading-[18px] text-text-2">{offer.summary.next}</Text>
        ) : null}
        {choice ? (
          <Text className="text-[13.5px] text-text-2" testID="re-summary-choice">
            {`${W.said(choice.name)} `}
            <Text className="text-[13.5px] font-semibold">{`“${SELLER_CHOICES[choice.choice]}”`}</Text>
            {` ${W.saidAt(at(choice.at))}`}
          </Text>
        ) : null}
      </Card>
      {client ? (
        <Button
          icon={Phone}
          onPress={() => {
            if (!phone) {
              toast.error(W.noNumber(first));
              return;
            }
            void Linking.openURL(`tel:${phone.replace(/[^\d+]/g, '')}`);
          }}
          testID="re-summary-call"
        >
          {W.call(first)}
        </Button>
      ) : null}
      {editable && !shared && client ? (
        <SignalButton
          variant="secondary"
          label={W.shareSummary(first)}
          why={W.shareWhy}
          onPress={() =>
            void attempt(() => shareOfferSummary(workspaceId, offer.id), W.shared(first))
          }
          testID="re-summary-share"
        />
      ) : null}
    </View>
  );
}
