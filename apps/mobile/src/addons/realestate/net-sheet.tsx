import { money, parseMoney } from '@hfos/core';
import {
  EMPTY_NET_FIGURES,
  netEstimate,
  type NetFigures,
  type OfferForNet,
} from '@hfos/core/addons/realestate/net';
import {
  RE_LISTING_ONLY,
  RE_NET_WORDS as W,
} from '@hfos/core/addons/realestate/phone-words-listing';
import { listPriceOfCopy } from '@hfos/core/addons/realestate/views/listing';
import {
  offersCompareOfCopy,
  type OffersCompareView,
} from '@hfos/core/addons/realestate/views/offers';
import * as React from 'react';
import { View } from 'react-native';

import { SlidersHorizontal } from '@/components/icons';
import { List } from '@/components/shell/list';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { api, errorMessage, unwrap } from '@/lib/api';

import { saveNetSheet } from './listing-actions';
import {
  Chips,
  DealSubpage,
  FieldError,
  FieldLabel,
  SignalNote,
  SummaryAnswer,
  useDealPage,
  useSummaryAnswer,
} from './subpage';

/**
 * What the seller walks away with, offer by offer (board 88, last panel; the spec's X-04), worked out on the phone
 * by core's `netEstimate` with the same figures and the same offers' terms as the web. Before any offer, it's worked
 * out at the list price. New figures save with no signal, kept beside the estimates they made. An estimate, never a
 * settlement statement.
 */

export interface NetColumn {
  readonly id: string;
  /** "Okafor offer · $495,000" */
  readonly name: string;
  readonly offer: OfferForNet;
}

/** Each open offer with its own fee and credit (from its terms), or the list price alone before any; as the web. */
export function netColumns(compare: OffersCompareView, listPriceCents: number | null): NetColumn[] {
  if (compare.rows.length)
    return compare.rows.map((r) => ({
      id: r.offerId,
      name: W.offer(r.buyers ?? `Offer ${r.number}`, money(r.priceCents)),
      offer: {
        priceCents: r.priceCents,
        sellerCreditCents: r.sellerCreditCents,
        buyerAgentFeeBp: null,
        buyerAgentFeeCents: -(r.net.lines.find((l) => l.key === 'buyer_agent_fee')?.cents ?? 0),
      },
    }));
  if (listPriceCents === null) return [];
  return [
    {
      id: 'list',
      name: W.atList(money(listPriceCents)),
      offer: {
        priceCents: listPriceCents,
        sellerCreditCents: 0,
        buyerAgentFeeBp: null,
        buyerAgentFeeCents: 0,
      },
    },
  ];
}

/** The figures a save holds, as the estimate works from them; none saved yet is nothing owed and no fee. */
export function figuresOf(f: OffersCompareView['figures']): NetFigures {
  if (!f) return EMPTY_NET_FIGURES;
  return {
    payoffCents: f.payoffCents,
    listingFeeBp: f.listingFeeBp,
    listingFeeCents: f.listingFeeCents,
    titleEscrowCents: f.titleEscrowCents,
    transferTaxBp: f.transferTaxBp,
    otherCents: f.otherCents,
    otherNote: f.otherNote,
  };
}

export function NetSheetScreen({ dealId }: { dealId: string }) {
  const { ctx, copy, deal, whole } = useDealPage(dealId);
  const compare = React.useMemo(
    () => offersCompareOfCopy(copy, dealId, { userId: ctx.userId }),
    [copy, dealId, ctx.userId],
  );
  const listPrice = listPriceOfCopy(copy, dealId);
  const client = copy.clients.get(dealId);
  const seller = (client ? copy.personParts(client)?.firstName : null) || null;
  const server = useSummaryAnswer(
    !!deal && !whole,
    async () =>
      unwrap(
        await api.POST('/v1/queries/realestate.offers.compare', {
          body: { workspaceId: ctx.workspaceId, dealId },
        }),
      ),
    `net-sheet:${dealId}`,
    'estimates',
  );
  const [changing, setChanging] = React.useState(false);
  const [picked, setPicked] = React.useState<string | null>(null);
  const columns = compare ? netColumns(compare, listPrice) : [];
  const column = columns.find((c) => c.id === picked) ?? columns[0] ?? null;
  return (
    <DealSubpage
      workspaceId={ctx.workspaceId}
      dealId={dealId}
      deal={deal}
      title={W.title}
      subtitle={column?.name}
      testID="re-net-sheet"
    >
      {!whole ? (
        <SummaryAnswer answer={server} what="estimates">
          {(data) => (
            <NetSheetBody
              columns={netColumns(data, listPrice)}
              picked={picked}
              onPick={setPicked}
              figures={figuresOf(data.figures)}
              seller={seller}
            />
          )}
        </SummaryAnswer>
      ) : compare ? (
        <NetSheetBody
          columns={columns}
          picked={picked}
          onPick={setPicked}
          figures={figuresOf(compare.figures)}
          seller={seller}
          onChange={() => setChanging(true)}
        />
      ) : (
        <Card className="p-4">
          <Text className="text-[14px] text-text-2">{RE_LISTING_ONLY(deal?.name ?? '')}</Text>
        </Card>
      )}
      {compare ? (
        <FiguresSheet
          open={changing}
          figures={figuresOf(compare.figures)}
          onClose={() => setChanging(false)}
          onSave={async (figures) => {
            await saveNetSheet({
              workspaceId: ctx.workspaceId,
              dealId,
              userId: ctx.userId,
              version: compare.figures?.version ?? 0,
              figures,
            });
            toast.show(W.saved);
          }}
        />
      ) : null}
    </DealSubpage>
  );
}

/** "−$27,225", "$495,000". */
const signed = (c: number) => (c < 0 ? `−${money(-c)}` : money(c));

export function NetSheetBody({
  columns,
  picked,
  onPick,
  figures,
  seller,
  onChange,
}: {
  columns: readonly NetColumn[];
  picked: string | null;
  onPick: (id: string) => void;
  figures: NetFigures;
  seller: string | null;
  onChange?: () => void;
}) {
  const column = columns.find((c) => c.id === picked) ?? columns[0] ?? null;
  const net = column ? netEstimate(column.offer, figures) : null;
  return (
    <View className="gap-3" testID="net-sheet-body">
      {columns.length > 1 ? (
        <Chips
          value={column?.id ?? ''}
          onChange={onPick}
          options={columns.map((c) => [c.id, c.name.split(' · ')[0]!] as const)}
          testID="net-offer"
        />
      ) : null}
      {net ? (
        <List testID="net-lines">
          {net.lines.map((l) => (
            <View key={l.key} className="flex-row items-center gap-3 px-4 py-3">
              <Text className="flex-1 text-base text-text-2">{l.label}</Text>
              <Text className="text-base tabular-nums">{signed(l.cents)}</Text>
            </View>
          ))}
          <View className="flex-row items-center gap-3 px-4 py-3">
            <Text className="flex-1 text-base font-semibold">{W.nets(seller)}</Text>
            <Text className="text-base font-semibold tabular-nums" testID="net-total">
              {signed(net.netCents)}
            </Text>
          </View>
        </List>
      ) : (
        <Card className="p-4">
          <Text className="text-[14px] text-text-2">{W.noOffer}</Text>
        </Card>
      )}
      <Text className="px-1 text-[12.5px] text-text-3">{W.estimate}</Text>
      {onChange ? (
        <Button variant="secondary" icon={SlidersHorizontal} onPress={onChange} testID="net-change">
          {W.change}
        </Button>
      ) : null}
      <SignalNote>{W.note}</SignalNote>
    </View>
  );
}

const dollars = (c: number | null) => (c ? (c / 100).toLocaleString('en-US') : '');
const percent = (bp: number | null) =>
  bp === null ? '' : (bp / 100).toLocaleString('en-US', { maximumFractionDigits: 3 });
/** "3" or "2.5" to basis points; empty is none, anything else null (as the web reads it). */
export function bpOf(text: string): number | null | undefined {
  const t = text.trim().replace(/%$/, '');
  if (!t) return undefined;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? Math.round(n * 100) : null;
}

/** The figures the estimates work from: what's owed, the listing fee, title and escrow, transfer tax, other costs. */
export function FiguresSheet({
  open,
  figures: f,
  onClose,
  onSave,
}: {
  open: boolean;
  figures: NetFigures;
  onClose: () => void;
  onSave: (figures: NetFigures) => Promise<void>;
}) {
  const [payoff, setPayoff] = React.useState('');
  const [feeAs, setFeeAs] = React.useState<'pct' | 'amount'>('pct');
  const [fee, setFee] = React.useState('');
  const [title, setTitle] = React.useState('');
  const [tax, setTax] = React.useState('');
  const [other, setOther] = React.useState('');
  const [otherNote, setOtherNote] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!open) return;
    setPayoff(dollars(f.payoffCents));
    setFeeAs(f.listingFeeCents !== null ? 'amount' : 'pct');
    setFee(f.listingFeeCents !== null ? dollars(f.listingFeeCents) : percent(f.listingFeeBp));
    setTitle(dollars(f.titleEscrowCents));
    setTax(f.transferTaxBp ? percent(f.transferTaxBp) : '');
    setOther(dollars(f.otherCents));
    setOtherNote(f.otherNote ?? '');
    setError(null);
  }, [open, f]);
  const save = async () => {
    const payoffCents = parseMoney(payoff);
    const titleCents = parseMoney(title);
    const otherCents = parseMoney(other);
    const feeBp = feeAs === 'pct' ? bpOf(fee) : undefined;
    const feeCents = feeAs === 'amount' ? parseMoney(fee) : null;
    const taxBp = bpOf(tax);
    if (payoffCents === null) return setError(W.bad(W.payoff));
    if (titleCents === null) return setError(W.bad(W.title_));
    if (otherCents === null) return setError(W.bad(W.other));
    if (feeAs === 'pct' && feeBp === null) return setError(W.badPct(W.fee));
    if (feeAs === 'amount' && fee.trim() && feeCents === null) return setError(W.bad(W.fee));
    if (taxBp === null) return setError(W.badPct(W.taxName));
    setBusy(true);
    setError(null);
    try {
      await onSave({
        payoffCents,
        listingFeeBp: feeAs === 'pct' ? (feeBp ?? null) : null,
        listingFeeCents: feeAs === 'amount' ? feeCents || null : null,
        titleEscrowCents: titleCents,
        transferTaxBp: taxBp ?? 0,
        otherCents,
        otherNote: otherNote.trim() || null,
      });
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet open={open} onClose={onClose} title={W.changeTitle} testID="net-figures-sheet">
      <View className="gap-3">
        <FieldLabel>{W.payoff}</FieldLabel>
        <Input
          value={payoff}
          onChangeText={setPayoff}
          keyboardType="decimal-pad"
          placeholder="$"
          testID="net-payoff"
        />
        <FieldLabel>{W.fee}</FieldLabel>
        <View className="flex-row items-center gap-2">
          <Input
            value={fee}
            onChangeText={setFee}
            keyboardType="decimal-pad"
            className="flex-1"
            testID="net-fee"
          />
          <Segmented
            label={W.fee}
            value={feeAs}
            onChange={setFeeAs}
            className="w-28"
            options={[
              { value: 'pct', label: W.feePct, testID: 'net-fee-pct' },
              { value: 'amount', label: W.feeAmount, testID: 'net-fee-amount' },
            ]}
          />
        </View>
        <FieldLabel>{W.title_}</FieldLabel>
        <Input
          value={title}
          onChangeText={setTitle}
          keyboardType="decimal-pad"
          placeholder="$"
          testID="net-title"
        />
        <FieldLabel>{W.tax}</FieldLabel>
        <Input value={tax} onChangeText={setTax} keyboardType="decimal-pad" testID="net-tax" />
        <FieldLabel>{W.other}</FieldLabel>
        <Input
          value={other}
          onChangeText={setOther}
          keyboardType="decimal-pad"
          placeholder="$"
          testID="net-other"
        />
        <FieldLabel>{W.otherNote}</FieldLabel>
        <Input value={otherNote} onChangeText={setOtherNote} testID="net-other-note" />
        <FieldError testID="net-error">{error}</FieldError>
        <Button loading={busy} onPress={() => void save()} testID="net-save">
          {W.save}
        </Button>
      </View>
    </Sheet>
  );
}
