'use client';
/**
 * The seller's estimate (board 41, design/realestate/NetSheet.dc.html; the spec's X-04 "Seller net sheet"): the
 * agent's figures (what's owed on the mortgage, the listing fee, title and escrow, transfer tax, other costs) and what
 * the seller would take home from each open offer, worked out by core's `netEstimate` as the figures are typed. Each
 * offer's own fee and credit come from its terms. Every save is kept beside the estimates it made. It's an estimate,
 * never a settlement statement, and says so. Before any offer, it's worked out at the list price.
 */
import { fmtMonthDay, localDayOf, money } from '@hfos/core';
import { netEstimate, type NetFigures, type NetLineKey } from '@hfos/core/addons/realestate/net';
import { useState } from 'react';
import { PageHeader } from '@/components/shell/page-header';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { parseMoney } from '@/lib/format';
import { CardHead } from './bits';
import { DealCrumb, firstNames } from './buyer-bits';
import { buyersOf } from './listing-offers-page';
import type { Compare } from './types';
import { useAct } from './use-act';

const thisYear = () => new Date().getFullYear();
type Figures = NonNullable<Compare['figures']>;

const LINE_LABELS: Readonly<Record<NetLineKey, string>> = {
  price: 'Price',
  listing_fee: 'Listing fee',
  buyer_agent_fee: 'Their agent’s fee',
  seller_credit: 'Seller credit',
  payoff: 'Mortgage payoff',
  title_escrow: 'Title and escrow',
  transfer_tax: 'Transfer tax',
  other: 'Other costs',
};

const dollars = (c: number) => (c ? (c / 100).toLocaleString('en-US') : '');
const percent = (bp: number | null) =>
  bp === null ? '' : (bp / 100).toLocaleString('en-US', { maximumFractionDigits: 3 });
/** "3" or "2.5" to basis points; empty is none, anything else null. */
function bpOf(text: string): number | null | undefined {
  const t = text.trim().replace(/%$/, '');
  if (!t) return undefined;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? Math.round(n * 100) : null;
}
const signed = (c: number) => (c < 0 ? `−${money(-c)}` : c === 0 ? '$0' : money(c));
/** One saved set of figures in words: "payoff $212,400 · listing fee 3% · title and escrow $3,850". */
function figureWords(f: Figures): string {
  return [
    `payoff ${money(f.payoffCents)}`,
    f.listingFeeBp !== null
      ? `listing fee ${percent(f.listingFeeBp)}%`
      : f.listingFeeCents !== null
        ? `listing fee ${money(f.listingFeeCents)}`
        : null,
    `title and escrow ${money(f.titleEscrowCents)}`,
    f.transferTaxBp ? `transfer tax ${percent(f.transferTaxBp)}%` : null,
    f.otherCents ? `other ${money(f.otherCents)}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

export function NetSheetPage({
  workspaceId,
  dealId,
  dealName,
  timeZone,
  compare,
  listPriceCents,
  sellers,
  live,
}: {
  workspaceId: string;
  dealId: string;
  dealName: string;
  timeZone: string;
  compare: Compare;
  listPriceCents: number | null;
  sellers: readonly string[];
  live: boolean;
}) {
  const seller = firstNames(sellers) || 'the seller';
  const f = compare.figures;
  const [payoff, setPayoff] = useState(dollars(f?.payoffCents ?? 0));
  const [feeAs, setFeeAs] = useState<'pct' | 'amount'>(
    f?.listingFeeCents !== null && f?.listingFeeCents !== undefined ? 'amount' : 'pct',
  );
  const [fee, setFee] = useState(
    f?.listingFeeCents !== null && f?.listingFeeCents !== undefined
      ? dollars(f.listingFeeCents)
      : percent(f?.listingFeeBp ?? null),
  );
  const [title, setTitle] = useState(dollars(f?.titleEscrowCents ?? 0));
  const [tax, setTax] = useState(percent(f?.transferTaxBp ?? 0) || '');
  const [other, setOther] = useState(dollars(f?.otherCents ?? 0));
  const [otherNote, setOtherNote] = useState(f?.otherNote ?? '');
  const [note, setNote] = useState(f?.note ?? '');
  const { busy, errors, act } = useAct();
  const day = (iso: string) => fmtMonthDay(localDayOf(iso, timeZone), thisYear());

  // The figures as typed: what the table works out from, before they're saved.
  const feeBp = feeAs === 'pct' ? bpOf(fee) : undefined;
  const feeCents = feeAs === 'amount' ? parseMoney(fee) : null;
  const taxBp = bpOf(tax);
  const bad = {
    fee: feeAs === 'pct' ? feeBp === null : !!fee.trim() && feeCents === null,
    tax: taxBp === null,
    payoff: !!payoff.trim() && parseMoney(payoff) === null,
    title: !!title.trim() && parseMoney(title) === null,
    other: !!other.trim() && parseMoney(other) === null,
  };
  const figures: NetFigures = {
    payoffCents: parseMoney(payoff) ?? 0,
    listingFeeBp: feeAs === 'pct' ? (feeBp ?? null) : null,
    listingFeeCents: feeAs === 'amount' ? (feeCents ?? null) : null,
    titleEscrowCents: parseMoney(title) ?? 0,
    transferTaxBp: taxBp ?? 0,
    otherCents: parseMoney(other) ?? 0,
    otherNote: otherNote.trim() || null,
  };
  // Each offer's own fee and credit, from its terms (its estimate's lines); before any, the list price alone.
  const columns = compare.rows.length
    ? compare.rows.map((r) => ({
        id: r.offerId,
        name: `${buyersOf(r)}${r.paying ? ` · ${r.paying.split(' · ')[0]}` : ''}`,
        offer: {
          priceCents: r.priceCents,
          sellerCreditCents: r.sellerCreditCents,
          buyerAgentFeeBp: null,
          buyerAgentFeeCents: -(r.net.lines.find((l) => l.key === 'buyer_agent_fee')?.cents ?? 0),
        },
      }))
    : listPriceCents !== null
      ? [
          {
            id: 'list',
            name: 'At the list price',
            offer: {
              priceCents: listPriceCents,
              sellerCreditCents: 0,
              buyerAgentFeeBp: null,
              buyerAgentFeeCents: 0,
            },
          },
        ]
      : [];
  const estimates = columns.map((c) => ({ ...c, net: netEstimate(c.offer, figures) }));
  const keys = (estimates[0]?.net.lines ?? []).map((l) => l.key);
  const lineLabel = (k: NetLineKey) =>
    k === 'listing_fee' && figures.listingFeeBp !== null
      ? `Listing fee · ${percent(figures.listingFeeBp)}%`
      : k === 'transfer_tax'
        ? `Transfer tax · ${percent(figures.transferTaxBp) || '0'}%`
        : k === 'other' && figures.otherNote
          ? `Other costs · ${figures.otherNote}`
          : LINE_LABELS[k];

  const save = () =>
    act(
      'save',
      async () =>
        unwrap(
          await apiBrowser().POST('/v1/commands/realestate.net_sheet.save', {
            body: {
              workspaceId,
              dealId,
              payoffCents: figures.payoffCents,
              listingFeeBp: figures.listingFeeBp,
              listingFeeCents: figures.listingFeeCents,
              titleEscrowCents: figures.titleEscrowCents,
              transferTaxBp: figures.transferTaxBp,
              otherCents: figures.otherCents,
              otherNote: figures.otherNote ?? null,
              note: note.trim() || null,
            },
          }),
        ),
      'Saved. The estimates use these figures now.',
    );

  return (
    <div data-testid="realestate-net-sheet">
      <DealCrumb
        workspaceId={workspaceId}
        dealId={dealId}
        dealName={dealName}
        here="Seller’s estimate"
      />
      <PageHeader
        title={`What ${seller} would take home`}
        description={`An estimate, not a settlement statement${f ? ` · figures as of ${day(f.savedAt)}` : ' · no figures saved yet'}`}
        actions={
          live ? (
            <Button
              onClick={() => void save()}
              loading={busy === 'save'}
              disabled={Object.values(bad).some(Boolean)}
              data-testid="net-save"
            >
              Save the figures
            </Button>
          ) : null
        }
      />
      <div className="grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)] lg:gap-5">
        <Card className="h-fit p-4 md:p-5" data-testid="net-figures">
          <CardHead title="The figures" />
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <Field
              label="Mortgage payoff"
              htmlFor="net-payoff"
              error={bad.payoff ? 'Enter an amount, like 212,400.' : errors.payoffCents}
            >
              <Input
                id="net-payoff"
                inputMode="decimal"
                placeholder="$"
                value={payoff}
                onChange={(e) => setPayoff(e.target.value)}
                disabled={!live}
                data-testid="net-payoff"
              />
            </Field>
            <Field
              label="Listing fee"
              htmlFor="net-fee"
              error={
                bad.fee
                  ? feeAs === 'pct'
                    ? 'Enter a percent between 0 and 100, like 3.'
                    : 'Enter an amount, like 16,050.'
                  : (errors.listingFeeCents ?? errors.listingFeeBp)
              }
            >
              <div className="flex gap-2">
                <Input
                  id="net-fee"
                  inputMode="decimal"
                  placeholder={feeAs === 'pct' ? '%' : '$'}
                  value={fee}
                  onChange={(e) => setFee(e.target.value)}
                  disabled={!live}
                  className="min-w-0 flex-1"
                  data-testid="net-fee"
                />
                <Segmented<'pct' | 'amount'>
                  value={feeAs}
                  onChange={(v) => {
                    setFeeAs(v);
                    setFee('');
                  }}
                  ariaLabel="Listing fee as"
                  options={[
                    { value: 'pct', label: '%' },
                    { value: 'amount', label: '$' },
                  ]}
                />
              </div>
            </Field>
            <Field
              label="Title and escrow"
              htmlFor="net-title"
              error={bad.title ? 'Enter an amount, like 3,850.' : errors.titleEscrowCents}
            >
              <Input
                id="net-title"
                inputMode="decimal"
                placeholder="$"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                disabled={!live}
              />
            </Field>
            <Field
              label="Transfer tax"
              htmlFor="net-tax"
              hint="A percent of the price; 0 where there’s none, as in Texas."
              error={bad.tax ? 'Enter a percent between 0 and 100.' : errors.transferTaxBp}
            >
              <Input
                id="net-tax"
                inputMode="decimal"
                placeholder="%"
                value={tax}
                onChange={(e) => setTax(e.target.value)}
                disabled={!live}
              />
            </Field>
            <Field
              label="Other costs"
              htmlFor="net-other"
              error={bad.other ? 'Enter an amount, like 750.' : errors.otherCents}
            >
              <Input
                id="net-other"
                inputMode="decimal"
                placeholder="$"
                value={other}
                onChange={(e) => setOther(e.target.value)}
                disabled={!live}
              />
            </Field>
            <Field label="What they are" htmlFor="net-other-note" error={errors.otherNote}>
              <Input
                id="net-other-note"
                placeholder="Survey $450, HOA transfer $300"
                value={otherNote}
                onChange={(e) => setOtherNote(e.target.value)}
                maxLength={300}
                disabled={!live}
              />
            </Field>
            <Field
              label="Where they come from (optional)"
              htmlFor="net-note"
              hint="Kept with these figures, for you and your team."
              error={errors.note}
            >
              <Input
                id="net-note"
                placeholder="Summit Lending’s payoff letter, Oct 28"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                maxLength={500}
                disabled={!live}
              />
            </Field>
          </form>
        </Card>
        <div className="min-w-0">
          {estimates.length === 0 ? (
            <Card className="p-5 text-[13.5px] text-text-2">
              No offers and no list price yet. Enter the list price on Key dates, and the estimate
              shows here at that price; each offer gets its own once it’s in.
            </Card>
          ) : (
            <Card className="overflow-x-auto p-0" data-testid="net-table">
              <table className="w-full min-w-[520px] text-left text-[13.5px]">
                <thead className="border-b border-border text-xs font-semibold uppercase tracking-wide text-text-3">
                  <tr>
                    <th className="px-4 py-3" />
                    {estimates.map((c) => (
                      <th key={c.id} className="px-4 py-3 font-semibold">
                        {c.name}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {keys.map((k) => (
                    <tr key={k} className="border-b border-border">
                      <td className="px-4 py-2.5">{lineLabel(k)}</td>
                      {estimates.map((c) => (
                        <td key={c.id} className="px-4 py-2.5 tabular-nums">
                          {signed(c.net.lines.find((l) => l.key === k)?.cents ?? 0)}
                        </td>
                      ))}
                    </tr>
                  ))}
                  <tr>
                    <td className="px-4 py-3 font-semibold">About what {seller} takes home</td>
                    {estimates.map((c) => (
                      <td
                        key={c.id}
                        className="px-4 py-3 font-semibold tabular-nums"
                        data-testid="net-total"
                      >
                        {signed(c.net.netCents)}
                      </td>
                    ))}
                  </tr>
                </tbody>
              </table>
            </Card>
          )}
          <p className="mt-3 text-[12.5px] text-text-3">
            Each offer’s own fee and credit come from its terms. Every time the figures change, the
            old ones are kept beside the estimates they made. Proof for “Seller net sheet”.
          </p>
          {compare.figureHistory.length ? (
            <Card className="mt-4 p-4 md:p-5" data-testid="net-history">
              <CardHead title="Earlier figures" />
              <ul className="space-y-2 text-[13px]">
                {compare.figureHistory.map((h) => (
                  <li key={h.version}>
                    <div className="font-medium">
                      Version {h.version} · {day(h.savedAt)}
                      {h.savedBy ? ` · ${h.savedBy.fullName}` : ''}
                    </div>
                    <div className="text-text-2">
                      {figureWords(h)}
                      {h.note ? ` · ${h.note}` : ''}
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
        </div>
      </div>
    </div>
  );
}
