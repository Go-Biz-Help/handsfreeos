'use client';
/**
 * A listing's price (board 42, design/realestate/PriceChange.dc.html). Chris decided (2026-10-01): the seller signs
 * off before a new price is used. "Change the price" puts the exact words in their portal; once they sign, the new
 * price is used at once (Key dates, the public page, the flyer, matching) and the agent is reminded to change it on
 * the MLS. An owner or admin can let one through with a reason; a waiting change can be withdrawn.
 */
import { fmtMonthDay, localDayOf as dateOf, money } from '@hfos/core';
import Link from 'next/link';
import { useState } from 'react';
import { Callout } from '@/components/crm/chips';
import { PageHeader } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { parseMoney } from '@/lib/format';
import { useLiveRefresh } from '@/lib/realtime/live-provider';
import { CardHead, dealHref } from './bits';
import { DealCrumb, firstNames } from './buyer-bits';
import { ReasonDialog } from './deal-dialogs';
import type { ListingView, Prices, TermHistory } from './types';
import { useAct } from './use-act';
import { useQueryState } from './use-query-state';

const thisYear = () => new Date().getFullYear();

export function PricePage({
  workspaceId,
  dealId,
  dealName,
  timeZone,
  listing: l,
  prices,
  listPrices,
  sellers,
  live,
}: {
  workspaceId: string;
  dealId: string;
  dealName: string;
  timeZone: string;
  listing: ListingView;
  prices: Prices;
  /** The list price's own entries on Key dates: the first is when it was listed. */
  listPrices: TermHistory['entries'];
  sellers: readonly string[];
  live: boolean;
}) {
  useLiveRefresh(['custom_record']);
  const [change, setChange] = useQueryState('change');
  const [dialog, setDialog] = useState<'through' | 'withdraw' | null>(null);
  const seller = firstNames(sellers) || 'the seller';
  const Seller = seller.replace(/^./, (m) => m.toUpperCase());
  const street = l.street ?? dealName;
  const current = prices.currentCents;
  const waiting = prices.waiting;
  const day = (iso: string) => fmtMonthDay(dateOf(iso, timeZone), thisYear());
  const listed = [...listPrices].sort((a, b) => a.enteredAt.localeCompare(b.enteredAt))[0];

  return (
    <div data-testid="realestate-price">
      <DealCrumb workspaceId={workspaceId} dealId={dealId} dealName={dealName} here="Price" />
      <PageHeader
        title="Price"
        description={`${street} · ${current !== null ? `${money(current)} now` : 'no list price yet'}`}
        actions={
          live ? (
            <Button
              onClick={() => setChange('1')}
              disabled={current === null || !!waiting}
              data-testid="price-change"
            >
              Change the price
            </Button>
          ) : null
        }
      />
      {current === null ? (
        <Callout tone="neutral" className="mb-4">
          No list price yet. Enter it under{' '}
          <Link
            href={dealHref(workspaceId, dealId, 'dates')}
            className="font-semibold text-accent-text hover:underline"
          >
            Key dates
          </Link>{' '}
          (List price); a change after that goes to {seller} to sign off.
        </Callout>
      ) : null}
      <div className="space-y-4">
        {waiting ? (
          <Card className="p-4 md:p-5" data-testid="price-waiting">
            <CardHead
              title={`Waiting for ${seller}`}
              action={<Badge variant="pending">Sent {day(waiting.proposedAt)}</Badge>}
            />
            <div className="text-[20px] font-semibold tabular-nums">
              <span className="text-text-3 line-through">{money(waiting.fromCents)}</span> →{' '}
              {money(waiting.toCents)}
            </div>
            <p className="mt-2 text-[14px] italic text-text-2">“{waiting.words}”</p>
            {waiting.note ? <p className="mt-1 text-[13.5px]">Why: {waiting.note}</p> : null}
            <Callout tone="danger" className="mt-3">
              <div className="font-semibold text-text">
                {Seller} hasn’t signed off the new price yet.
              </div>
              <div>
                It’s waiting in their portal. Once they sign, the new price is used at once, and
                you’re reminded to change it on the MLS.
              </div>
            </Callout>
            {live ? (
              <div className="mt-3 flex flex-wrap gap-2">
                {l.can.letThrough ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setDialog('through')}
                    data-testid="price-let-through"
                  >
                    Signed on paper? Use it with a reason
                  </Button>
                ) : null}
                <Button size="sm" variant="ghost" onClick={() => setDialog('withdraw')}>
                  Withdraw it
                </Button>
              </div>
            ) : null}
          </Card>
        ) : null}
        <Card className="overflow-x-auto p-0" data-testid="price-history">
          <div className="px-4 pt-4 md:px-5">
            <CardHead title="History" />
          </div>
          <table className="w-full min-w-[560px] text-left text-[13.5px]">
            <thead className="border-b border-border text-xs font-semibold uppercase tracking-wide text-text-3">
              <tr>
                <th className="px-5 py-2.5 font-semibold">Date</th>
                <th className="px-3 py-2.5 font-semibold">Price</th>
                <th className="px-3 py-2.5 font-semibold">What happened</th>
                <th className="px-5 py-2.5 font-semibold">Sign-off</th>
              </tr>
            </thead>
            <tbody>
              {prices.history
                .filter((p) => p.state !== 'waiting')
                .map((p) => (
                  <tr key={p.id} className="border-b border-border">
                    <td className="px-5 py-3">{day(p.appliedAt ?? p.proposedAt)}</td>
                    <td
                      className={
                        p.state === 'withdrawn'
                          ? 'px-3 py-3 text-text-3 line-through'
                          : 'px-3 py-3 font-semibold tabular-nums'
                      }
                    >
                      {money(p.toCents)}
                    </td>
                    <td className="px-3 py-3">
                      {p.state === 'withdrawn'
                        ? `Withdrawn${p.withdrawnReason ? `: ${p.withdrawnReason}` : ''}`
                        : `${p.toCents < p.fromCents ? 'Lowered' : 'Raised'} from ${money(p.fromCents)}`}
                    </td>
                    <td className="px-5 py-3 text-text-2">
                      {p.state === 'withdrawn'
                        ? '—'
                        : p.how === 'portal'
                          ? `Signed off by ${p.signedBy ?? seller} in the portal`
                          : `Used without the portal${p.overrideReason ? `: ${p.overrideReason}` : ''}`}
                    </td>
                  </tr>
                ))}
              {listed ? (
                <tr>
                  <td className="px-5 py-3">{day(listed.enteredAt)}</td>
                  <td className="px-3 py-3 font-semibold tabular-nums">
                    {listed.cents !== null ? money(listed.cents) : '—'}
                  </td>
                  <td className="px-3 py-3">Listed</td>
                  <td className="px-5 py-3 text-text-2">
                    {listed.source === 'agreement'
                      ? 'With the listing agreement'
                      : `Entered by ${listed.enteredBy?.name ?? 'your team'}`}
                  </td>
                </tr>
              ) : (
                <tr>
                  <td colSpan={4} className="px-5 py-3 text-text-2">
                    Nothing yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </Card>
      </div>
      <p className="mt-3 text-[12.5px] text-text-3">
        Once used, the new price replaces the list price on Key dates, the public page and the
        flyer, matching runs again, and you’re reminded to change it on the MLS.
      </p>
      <ChangePriceDialog
        open={change !== null}
        onClose={() => setChange(null)}
        workspaceId={workspaceId}
        dealId={dealId}
        street={street}
        current={current}
        seller={seller}
      />
      <ReasonDialog
        open={dialog === 'through'}
        onOpenChange={(o) => !o && setDialog(null)}
        title="Use the new price without the portal sign-off?"
        description={`Say how ${seller} approved it, like “signed the change on paper”. It’s kept on the deal.`}
        submit="Use it"
        done="The new price is in use. Change it on the MLS too."
        run={async (reason) =>
          unwrap(
            await apiBrowser().POST('/v1/commands/realestate.listing.price.let_through', {
              body: { workspaceId, priceId: waiting!.id, reason },
            }),
          )
        }
      />
      <ReasonDialog
        open={dialog === 'withdraw'}
        onOpenChange={(o) => !o && setDialog(null)}
        title="Withdraw the price change?"
        description={`It leaves ${seller}’s portal, and the price stays ${current !== null ? money(current) : 'as it is'}.`}
        submit="Withdraw it"
        danger
        done="Withdrawn."
        run={async (reason) =>
          unwrap(
            await apiBrowser().POST('/v1/commands/realestate.listing.price.withdraw', {
              body: { workspaceId, priceId: waiting!.id, reason },
            }),
          )
        }
      />
    </div>
  );
}

function ChangePriceDialog({
  open,
  onClose,
  workspaceId,
  dealId,
  street,
  current,
  seller,
}: {
  open: boolean;
  onClose: () => void;
  workspaceId: string;
  dealId: string;
  street: string;
  current: number | null;
  seller: string;
}) {
  const [price, setPrice] = useState('');
  const [note, setNote] = useState('');
  const { busy, errors, act } = useAct(() => {
    setPrice('');
    setNote('');
    onClose();
  });
  const cents = parseMoney(price);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title="Change the price"
        description={`${seller.replace(/^./, (m) => m.toUpperCase())} signs off these exact words in their portal before the new price is used.`}
      >
        <form
          className="mt-4 flex flex-col gap-3.5"
          onSubmit={(e) => {
            e.preventDefault();
            void act(
              'propose',
              async () =>
                unwrap(
                  await apiBrowser().POST('/v1/commands/realestate.listing.price.propose', {
                    body: {
                      workspaceId,
                      dealId,
                      priceCents: cents ?? 0,
                      note: note.trim() || undefined,
                    },
                  }),
                ),
              `Sent. It’s on ${seller}’s to-do in their portal.`,
            );
          }}
        >
          <Field label="New price" htmlFor="price-new" error={errors.priceCents}>
            <Input
              id="price-new"
              inputMode="decimal"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              placeholder="$"
              data-testid="price-new"
            />
          </Field>
          <Field
            label="Why (optional)"
            htmlFor="price-why"
            hint="Kept with the change, for you and your team."
          >
            <Textarea
              id="price-why"
              rows={2}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </Field>
          {cents && current !== null ? (
            <p className="rounded-menu bg-card-2 px-3 py-2 text-[13.5px] italic text-text-2">
              “Change the list price of {street} from {money(current)} to {money(cents)}.”
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              loading={busy === 'propose'}
              disabled={!cents}
              data-testid="price-send"
            >
              Send to {seller}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
