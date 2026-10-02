'use client';
/**
 * A listing deal's own cards on the deal page (board 32, design/realestate/ListingWorkspace.dc.html): the listing
 * itself in the main column, and at the side the seller's to-do (the to-do card), matching to our buyers and the
 * deal's CMAs. Each card opens its own page, where the work is done.
 */
import { fmtMonthDay, localDayOf as dateOf, money } from '@hfos/core';
import { CMA_STATUSES } from '@hfos/core/addons/realestate/cma';
import { SELLER_CHOICES } from '@hfos/core/addons/realestate/net';
import { dueWords, LIVE_OFFER_STATUSES } from '@hfos/core/addons/realestate/offer-words';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { usePublicOrigin } from '@/lib/use-origin';
import { CardHead, dealHref, HeadLink, Line } from './bits';
import { firstNames, street } from './buyer-bits';
import { listingFactsLine, priceWas, SignedPhoto } from './listing-bits';
import { buyersOf } from './listing-offers-page';
import type { ListingSide } from './types';
import { useAct } from './use-act';

const thisYear = () => new Date().getFullYear();

/** How they pay, in a word: "cash", "conventional", "FHA". */
const payingShort = (paying: string) => {
  const w = paying.split(' · ')[0] ?? paying;
  return w === w.toUpperCase() ? w : w.toLowerCase();
};

/** The seller's first names on the deal: "Maria and Tom", or "the seller". */
export const sellerNames = (side: ListingSide) =>
  firstNames(side.tasks.clients.map((c) => c.name)) || 'the seller';

export function ListingCard({
  workspaceId,
  dealId,
  timeZone,
  side,
}: {
  workspaceId: string;
  dealId: string;
  timeZone: string;
  side: ListingSide;
}) {
  const { listing: l, marketing: m, prices, files } = side;
  const cover = [...l.photos].sort((a, b) => a.position - b.position)[0];
  const coverFile = cover ? files.find((f) => f.id === cover.fileId) : undefined;
  const facts = listingFactsLine(l.facts);
  const was = priceWas(prices, timeZone);
  const day = (iso: string) => fmtMonthDay(dateOf(iso, timeZone), thisYear());
  const signed = l.description.inUse;
  const sent = l.description.working?.state === 'sent';
  const published = m.page.state === 'published' && !!m.page.path;
  const origin = usePublicOrigin(side.brandedOrigin);
  return (
    <Card className="p-4 md:p-5" data-testid="listing-card">
      <CardHead
        title="The listing"
        action={<HeadLink href={dealHref(workspaceId, dealId, 'facts')}>Facts</HeadLink>}
      />
      <div className="grid gap-4 sm:grid-cols-[220px_minmax(0,1fr)]">
        <Link href={dealHref(workspaceId, dealId, 'photos')} className="block">
          <SignedPhoto
            file={coverFile}
            alt={cover?.caption ?? 'The front of the home'}
            className="h-[150px] rounded-control"
            label={cover ? (cover.caption ?? 'Photo') : 'No photos yet'}
          />
          <span className="mt-1 block text-[12px] text-text-3">
            {l.photos.length
              ? `${cover?.caption ?? 'Photo'} · 1 of ${l.photos.length}`
              : 'Add the photos'}
          </span>
        </Link>
        <div className="min-w-0">
          <div className="text-[22px] font-semibold tabular-nums" data-testid="listing-price">
            {l.listPriceCents !== null ? money(l.listPriceCents) : 'No list price yet'}
          </div>
          {was ? <div className="text-[13px] text-text-2">{was}</div> : null}
          <div className="mt-1 text-[13.5px]">
            {facts || (
              <span className="text-text-2">
                No facts confirmed yet.{' '}
                <Link
                  href={dealHref(workspaceId, dealId, 'facts')}
                  className="text-accent-text hover:underline"
                >
                  Confirm them
                </Link>
              </span>
            )}
          </div>
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {l.mls ? (
              <Badge variant="ok">
                Live on the MLS since {fmtMonthDay(l.mls.liveOn, thisYear())} · #{l.mls.number}
              </Badge>
            ) : (
              <Badge variant="gray">Not live on the MLS yet</Badge>
            )}
            {signed ? (
              <Badge variant="ok">Description signed off {day(signed.signedAt)}</Badge>
            ) : sent ? (
              <Badge variant="pending">Description waiting on {sellerNames(side)}</Badge>
            ) : (
              <Badge variant="gray">No description yet</Badge>
            )}
            {published ? (
              <Badge variant="ok">Public page up</Badge>
            ) : (
              <Badge variant="gray">No public page yet</Badge>
            )}
          </div>
          {published ? (
            <a
              href={`${origin}${m.page.path!}`}
              target="_blank"
              rel="noreferrer"
              className="mt-2 block break-all text-[13px] text-accent-text hover:underline"
            >
              {`${origin}${m.page.path!}`.replace(/^https?:\/\//, '')}
            </a>
          ) : null}
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[13px]">
            <Link
              href={dealHref(workspaceId, dealId, 'facts')}
              className="text-accent-text hover:underline"
            >
              The home’s facts
            </Link>
            <Link
              href={dealHref(workspaceId, dealId, 'photos')}
              className="text-accent-text hover:underline"
            >
              Photos ({l.photos.length})
            </Link>
            <Link
              href={dealHref(workspaceId, dealId, 'description')}
              className="text-accent-text hover:underline"
            >
              Description
            </Link>
            <Link
              href={dealHref(workspaceId, dealId, 'price')}
              className="text-accent-text hover:underline"
            >
              {prices.waiting ? 'Price · waiting on the seller' : 'Price'}
            </Link>
          </div>
        </div>
      </div>
    </Card>
  );
}

/** The listing's offers on its deal page (board 32's Offers): each with what the seller would take home. */
export function OffersCard({
  workspaceId,
  dealId,
  timeZone,
  side,
}: {
  workspaceId: string;
  dealId: string;
  timeZone: string;
  side: ListingSide;
}) {
  const { rows, shared, choices } = side.compare;
  const seller = sellerNames(side);
  const open = rows.filter((r) => LIVE_OFFER_STATUSES.includes(r.status));
  const due = open
    .map((r) => r.respondBy)
    .filter((x): x is string => !!x)
    .sort()[0];
  const said = choices[0];
  const saidRow = said ? rows.find((r) => r.offerId === said.offerId) : undefined;
  const day = (iso: string) => fmtMonthDay(dateOf(iso, timeZone), thisYear());
  return (
    <Card className="p-4 md:p-5" data-testid="listing-offers">
      <CardHead
        title="Offers"
        action={
          <HeadLink href={dealHref(workspaceId, dealId, 'offers')}>
            {rows.length > 1 ? 'Side by side' : 'Open'}
          </HeadLink>
        }
      />
      {rows.length === 0 ? (
        <p className="text-[13.5px] text-text-2">
          None yet. Add each one with its terms; they line up side by side, with what {seller} would
          take home from each.
        </p>
      ) : (
        <>
          {open.length ? (
            <div className="mb-3 rounded-menu bg-warning-soft px-3.5 py-3 text-[13.5px] text-warning-text">
              <div className="font-semibold text-text">
                {open.length} {open.length === 1 ? 'offer' : 'offers'}
                {due ? ` · the first answer is due ${dueWords(due, timeZone, Date.now())}` : ''}
              </div>
              <div>
                {shared
                  ? `Shared with ${seller} ${day(shared.at)}.`
                  : `Not shared with ${seller} yet.`}
                {said
                  ? ` ${said.name}: ${SELLER_CHOICES[said.choice]}${saidRow ? ` the ${buyersOf(saidRow)} offer` : ''}.`
                  : ''}
              </div>
            </div>
          ) : null}
          <ul className="space-y-1.5">
            {rows.map((r) => (
              <li
                key={r.offerId}
                className="flex flex-wrap items-baseline justify-between gap-x-3 text-[13.5px]"
              >
                <span>
                  {buyersOf(r)} · {payingShort(r.paying)}
                </span>
                <span className="tabular-nums">
                  {money(r.priceCents)} · {seller} takes home about{' '}
                  <span className={r.best ? 'font-semibold' : undefined}>
                    {money(r.net.netCents)}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}

/** The seller's estimate on the deal page (board 32's Seller's estimate): the figures, in a line. */
export function NetSheetCard({
  workspaceId,
  dealId,
  timeZone,
  side,
}: {
  workspaceId: string;
  dealId: string;
  timeZone: string;
  side: ListingSide;
}) {
  const f = side.compare.figures;
  return (
    <Card className="p-4 md:p-5" data-testid="listing-net-sheet">
      <CardHead
        title="Seller’s estimate"
        action={<HeadLink href={dealHref(workspaceId, dealId, 'net-sheet')}>Open</HeadLink>}
      />
      <p className="text-[13.5px] text-text-2">
        {f
          ? [
              `Payoff ${money(f.payoffCents)}`,
              f.listingFeeBp !== null
                ? `listing fee ${(f.listingFeeBp / 100).toLocaleString('en-US')}%`
                : f.listingFeeCents !== null
                  ? `listing fee ${money(f.listingFeeCents)}`
                  : null,
              `title and escrow ${money(f.titleEscrowCents)}`,
            ]
              .filter(Boolean)
              .join(' · ') + `. Updated ${fmtMonthDay(dateOf(f.savedAt, timeZone), thisYear())}.`
          : `No figures yet. Enter what’s owed and the costs, and it works out what ${sellerNames(side)} would take home from each offer.`}
      </p>
    </Card>
  );
}

/** The listing's marketing at a glance (board 32's Marketing): what's up, and what waits for the MLS. */
export function MarketingCard({
  workspaceId,
  dealId,
  side,
}: {
  workspaceId: string;
  dealId: string;
  side: ListingSide;
}) {
  const m = side.marketing;
  const drafts = m.posts.items.length;
  return (
    <Card className="p-4 md:p-5" data-testid="listing-marketing">
      <CardHead
        title="Marketing"
        action={<HeadLink href={dealHref(workspaceId, dealId, 'marketing')}>Open</HeadLink>}
      />
      {!m.mls ? (
        <p className="mb-1 text-[13px] text-text-2">
          Nothing goes outside your office until it’s live on the MLS.
        </p>
      ) : null}
      <Line label="Public page">
        {m.page.state === 'published' ? (
          <Badge variant="ok">Published</Badge>
        ) : m.page.state === 'down' ? (
          <Badge variant="gray">Taken down</Badge>
        ) : (
          <span className="text-text-2">Not up yet</span>
        )}
      </Line>
      <Line label="Flyer">
        {m.mls && m.ready.description ? (
          'Ready to print'
        ) : (
          <span className="text-text-2">Not yet</span>
        )}
      </Line>
      <Line label="Social posts">
        {m.posts.state === 'drafting' ? (
          'Drafting…'
        ) : drafts ? (
          `${drafts} ${drafts === 1 ? 'draft' : 'drafts'}`
        ) : (
          <span className="text-text-2">None yet</span>
        )}
      </Line>
    </Card>
  );
}

/** Matching to our buyers (board 32's Matching): how many, never who. */
export function MatchingCard({ side }: { side: ListingSide }) {
  const { suggested, added } = side.listing.matches;
  return (
    <Card className="p-4 md:p-5" data-testid="listing-matching">
      <CardHead title="Matching" />
      <p className="text-[13.5px] text-text-2">
        {suggested
          ? `Suggested to the agents of ${suggested} of our buyers${added ? ` · ${added} added it to their homes` : ''}. Who they are stays on their deals.`
          : side.listing.mls
            ? 'None of our buyers’ searches fit it yet. It’s checked again when the price changes or a buyer’s search does.'
            : 'Once it’s live on the MLS, it’s suggested to the agents of our buyers it fits. Who they are stays on their deals.'}
      </p>
    </Card>
  );
}

/** The listing's CMAs, and starting one from its own confirmed facts. */
export function ListingCmasCard({
  workspaceId,
  dealId,
  side,
  live,
}: {
  workspaceId: string;
  dealId: string;
  side: ListingSide;
  live: boolean;
}) {
  const router = useRouter();
  const { busy, act } = useAct();
  return (
    <Card className="p-4 md:p-5" data-testid="listing-cmas">
      <CardHead
        title="CMAs"
        action={
          live ? (
            <Button
              size="sm"
              variant="secondary"
              loading={busy === 'cma'}
              onClick={() =>
                void act('cma', async () => {
                  const out = unwrap(
                    await apiBrowser().POST('/v1/commands/realestate.cma.start', {
                      body: { workspaceId, dealId },
                    }),
                  );
                  router.push(dealHref(workspaceId, dealId, `cma/${out.cmaId}`));
                })
              }
              data-testid="listing-cma-start"
            >
              Start a CMA
            </Button>
          ) : null
        }
      />
      {side.cmas.length === 0 ? (
        <p className="text-[13.5px] text-text-2">
          None yet. A CMA starts from the home’s confirmed facts and its price, and helps you
          recommend one.
        </p>
      ) : (
        <ul className="space-y-2">
          {side.cmas.map((c) => (
            <li key={c.id}>
              <Link
                href={dealHref(workspaceId, dealId, `cma/${c.id}`)}
                className="flex items-start justify-between gap-3 text-[13.5px] hover:underline"
              >
                <span className="min-w-0 truncate font-medium">
                  CMA {c.number} · {street(c.subjectAddress)}
                </span>
                <Badge variant={c.status === 'draft' ? 'gray' : 'ok'}>
                  {CMA_STATUSES[c.status]}
                </Badge>
              </Link>
              {c.lowCents !== null && c.highCents !== null ? (
                <div className="text-[12.5px] text-text-2">
                  {money(c.lowCents)}–{money(c.highCents)}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
