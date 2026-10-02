'use client';
/**
 * A listing's offers side by side (board 40, design/realestate/ListingOffers.dc.html). Chris decided (2026-10-01):
 * side by side, with what the seller would take home from each. Each column is an offer's newest version; the row
 * the seller cares most about comes first, and the most they'd take home is marked. "Share with the seller" puts
 * them in their portal as they are now; what the seller says back (accept, counter, decline, let's talk) is shown
 * here and tells the agent what they want. Nothing here signs anything: the contract is still the forms software's.
 */
import { fmtMonthDay, localDayOf, money } from '@hfos/core';
import { SELLER_CHOICES } from '@hfos/core/addons/realestate/net';
import {
  COMPARE_LABELS,
  dueWords,
  LIVE_OFFER_STATUSES,
  offerStatusWords,
} from '@hfos/core/addons/realestate/offer-words';
import { MessageSquare } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { Callout } from '@/components/crm/chips';
import { PageHeader } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button, ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { useLiveRefresh } from '@/lib/realtime/live-provider';
import { cn } from '@/lib/utils';
import { CardHead, dealHref } from './bits';
import { DealCrumb, firstNames } from './buyer-bits';
import { AnswerDialog, StartOfferDialog, VersionDialog } from './offer-dialogs';
import type { Compare, CompareRow, DealDocument, Offer } from './types';
import { useAct } from './use-act';
import { useQueryState } from './use-query-state';

const thisYear = () => new Date().getFullYear();
const dash = <span className="text-text-3">—</span>;

/** "Wei Chen", or "Offer 2" when the buyers' names weren't given. */
export const buyersOf = (r: Pick<CompareRow, 'buyers' | 'number'>) =>
  r.buyers ?? `Offer ${r.number}`;

/** The rows of the table after the take-home, in core's order, each a cell per offer. */
function cellsFor(
  key: Exclude<keyof typeof COMPARE_LABELS, 'net'>,
  r: CompareRow,
  timeZone: string,
): ReactNode {
  switch (key) {
    case 'priceCents':
      return money(r.priceCents);
    case 'paying':
      return r.paying;
    case 'emdCents':
      return r.emdCents !== null ? money(r.emdCents) : dash;
    case 'sellerCreditCents':
      return money(r.sellerCreditCents);
    case 'homeSale':
      return r.homeSale === null ? dash : r.homeSale ? <Badge variant="pending">Yes</Badge> : 'No';
    case 'closingDate':
      return r.closingDate ? fmtMonthDay(r.closingDate, thisYear()) : dash;
    case 'respondBy':
      return r.respondBy ? dueWords(r.respondBy, timeZone, Date.now()) : dash;
    default:
      return r[key] ?? dash;
  }
}

export function ListingOffersPage({
  workspaceId,
  dealId,
  dealName,
  timeZone,
  compare,
  offers,
  documents,
  sellers,
  live,
}: {
  workspaceId: string;
  dealId: string;
  dealName: string;
  timeZone: string;
  compare: Compare;
  offers: readonly Offer[];
  documents: readonly DealDocument[];
  sellers: readonly string[];
  live: boolean;
}) {
  useLiveRefresh(['custom_record']);
  const [start, setStart] = useQueryState('start');
  const [dialog, setDialog] = useState<{ kind: 'answer' | 'version'; offerId: string } | null>(
    null,
  );
  const { busy, act } = useAct();
  const seller = firstNames(sellers) || 'the seller';
  const rows = compare.rows;
  const open = rows.filter((r) => r.status !== 'accepted');
  const ended = offers.filter(
    (o) => !LIVE_OFFER_STATUSES.includes(o.status) && o.status !== 'accepted',
  );
  const day = (iso: string) => fmtMonthDay(localDayOf(iso, timeZone), thisYear());
  const said = compare.choices[0];
  const saidRow = said ? rows.find((r) => r.offerId === said.offerId) : undefined;
  const offerOf = (id: string) => offers.find((o) => o.id === id);
  const shown = (Object.keys(COMPARE_LABELS) as (keyof typeof COMPARE_LABELS)[]).filter(
    (k): k is Exclude<keyof typeof COMPARE_LABELS, 'net'> =>
      k !== 'net' &&
      // A row nobody's offer says anything about is left out.
      (['priceCents', 'paying', 'sellerCreditCents'].includes(k) ||
        rows.some((r) => r[k] !== null && r[k] !== undefined)),
  );
  const active = dialog ? offerOf(dialog.offerId) : undefined;

  return (
    <div data-testid="realestate-listing-offers">
      <DealCrumb workspaceId={workspaceId} dealId={dealId} dealName={dealName} here="Offers" />
      <PageHeader
        title={rows.length > 1 ? 'Offers · side by side' : 'Offers'}
        description={`${rows.length} ${rows.length === 1 ? 'offer' : 'offers'}${
          compare.shared ? ` · shared with ${seller} ${day(compare.shared.at)}` : ''
        }`}
        actions={
          <>
            <ButtonLink href={dealHref(workspaceId, dealId, 'net-sheet')} variant="secondary">
              Seller’s estimate
            </ButtonLink>
            {live ? (
              <>
                <Button variant="secondary" onClick={() => setStart('')} data-testid="offers-start">
                  Add an offer
                </Button>
                <Button
                  disabled={!open.length}
                  loading={busy === 'share'}
                  onClick={() =>
                    void act(
                      'share',
                      async () =>
                        unwrap(
                          await apiBrowser().POST(
                            '/v1/commands/realestate.offers.share_comparison',
                            { body: { workspaceId, dealId } },
                          ),
                        ),
                      `Shared. ${seller.replace(/^./, (m) => m.toUpperCase())} sees them side by side in their portal.`,
                    )
                  }
                  data-testid="offers-share"
                >
                  Share with {seller}
                </Button>
              </>
            ) : null}
          </>
        }
      />
      {said ? (
        <Callout tone="neutral" icon={MessageSquare} className="mb-4" data-testid="offers-choice">
          <div>
            <div className="font-semibold text-text">
              {said.name}: {SELLER_CHOICES[said.choice]}
              {saidRow ? ` the ${buyersOf(saidRow)} offer` : ''}
            </div>
            <div>
              {said.words ? `“${said.words}” · ` : ''}from their portal,{' '}
              {dueWords(said.at, timeZone, Date.now())}. It tells you what they want; the paperwork
              is still signed in your forms software.
            </div>
          </div>
        </Callout>
      ) : null}
      {!compare.figures && rows.length ? (
        <Callout tone="neutral" className="mb-4">
          The take-home leaves out the mortgage payoff and the listing’s costs until you enter them
          on the{' '}
          <Link
            href={dealHref(workspaceId, dealId, 'net-sheet')}
            className="font-semibold text-accent-text hover:underline"
          >
            seller’s estimate
          </Link>
          .
        </Callout>
      ) : null}
      {rows.length === 0 ? (
        <Card className="p-5 text-[13.5px] text-text-2">
          No offers yet. When one comes in, add it with its terms from the contract; they line up
          here side by side, each with what {seller} would take home.
        </Card>
      ) : (
        <Card className="overflow-x-auto p-0" data-testid="offers-compare">
          <table className="w-full min-w-[640px] border-collapse text-left text-[13.5px]">
            <thead>
              <tr className="border-b border-border">
                <th className="w-[150px] bg-card-2 px-4 py-3" />
                {rows.map((r) => (
                  <th key={r.offerId} className="px-4 py-3 align-top font-normal">
                    <Link
                      href={dealHref(workspaceId, dealId, `offers/${r.offerId}`)}
                      className="text-[14.5px] font-semibold hover:underline"
                    >
                      {buyersOf(r)}
                    </Link>
                    <div className="text-[12.5px] text-text-2">
                      {[r.agent, r.brokerage].filter(Boolean).join(' · ') || 'No agent named'}
                    </div>
                    <Badge
                      variant={
                        r.status === 'accepted'
                          ? 'ok'
                          : r.status === 'waiting_us'
                            ? 'pending'
                            : 'accent'
                      }
                      className="mt-1"
                    >
                      {offerStatusWords(r.status, 'listing')}
                    </Badge>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-border">
                <th className="bg-card-2 px-4 py-2.5 font-normal text-text-2">
                  {seller.replace(/^./, (m) => m.toUpperCase())} takes home
                </th>
                {rows.map((r) => (
                  <td
                    key={r.offerId}
                    className={cn(
                      'px-4 py-2.5 tabular-nums',
                      r.best && 'bg-success-soft font-semibold',
                    )}
                    data-testid={r.best ? 'offers-best' : undefined}
                  >
                    about {money(r.net.netCents)}
                  </td>
                ))}
              </tr>
              {shown.map((k) => (
                <tr key={k} className="border-b border-border">
                  <th className="bg-card-2 px-4 py-2.5 font-normal text-text-2">
                    {COMPARE_LABELS[k]}
                  </th>
                  {rows.map((r) => (
                    <td key={r.offerId} className="px-4 py-2.5">
                      {cellsFor(k, r, timeZone)}
                    </td>
                  ))}
                </tr>
              ))}
              {live ? (
                <tr>
                  <th className="bg-card-2 px-4 py-2.5" />
                  {rows.map((r) => (
                    <td key={r.offerId} className="px-4 py-2.5">
                      {LIVE_OFFER_STATUSES.includes(r.status) ? (
                        <div className="flex flex-wrap gap-1.5">
                          <Button
                            size="sm"
                            variant={r.status === 'waiting_us' ? 'primary' : 'secondary'}
                            onClick={() => setDialog({ kind: 'answer', offerId: r.offerId })}
                            data-testid="offers-answer"
                          >
                            Record our answer
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setDialog({ kind: 'version', offerId: r.offerId })}
                          >
                            Add a version
                          </Button>
                        </div>
                      ) : (
                        <Link
                          href={dealHref(workspaceId, dealId, `offers/${r.offerId}`)}
                          className="text-[13px] text-accent-text hover:underline"
                        >
                          Open
                        </Link>
                      )}
                    </td>
                  ))}
                </tr>
              ) : null}
            </tbody>
          </table>
        </Card>
      )}
      <p className="mt-3 text-[12.5px] text-text-3">
        What {seller} takes home is an estimate from the figures on the{' '}
        <Link
          href={dealHref(workspaceId, dealId, 'net-sheet')}
          className="text-accent-text hover:underline"
        >
          seller’s estimate
        </Link>
        . Every offer and counter is kept as it was sent or received.
      </p>
      {ended.length ? (
        <Card className="mt-4 p-4 md:p-5" data-testid="offers-ended">
          <CardHead title="Ended" />
          <ul className="space-y-1.5 text-[13.5px]">
            {ended.map((o) => (
              <li key={o.id} className="flex items-baseline justify-between gap-3">
                <Link
                  href={dealHref(workspaceId, dealId, `offers/${o.id}`)}
                  className="truncate font-medium hover:underline"
                >
                  {o.buyerNames ?? `Offer ${o.number}`} ·{' '}
                  {money(o.versions.at(-1)?.priceCents ?? 0)}
                </Link>
                <span className="shrink-0 text-text-2">
                  {offerStatusWords(o.status, 'listing')}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
      <StartOfferDialog
        open={start !== null}
        onOpenChange={(o) => !o && setStart(null)}
        workspaceId={workspaceId}
        dealId={dealId}
        timeZone={timeZone}
        homes={[]}
        documents={documents}
        side="listing"
      />
      {active ? (
        <>
          <AnswerDialog
            offer={active}
            open={dialog?.kind === 'answer'}
            onOpenChange={(x) => !x && setDialog(null)}
            workspaceId={workspaceId}
            timeZone={timeZone}
            dealSide="listing"
          />
          <VersionDialog
            offer={active}
            open={dialog?.kind === 'version'}
            onOpenChange={(x) => !x && setDialog(null)}
            workspaceId={workspaceId}
            timeZone={timeZone}
            documents={documents}
            dealSide="listing"
          />
        </>
      ) : null}
    </div>
  );
}
