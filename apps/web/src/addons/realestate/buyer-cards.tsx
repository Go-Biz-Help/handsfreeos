'use client';
/**
 * A buyer deal's own cards on the deal page (board 13, design/realestate/BuyerWorkspace.dc.html): what the buyer
 * wants, their homes and tours in the main column; the buyer agreement, financing, the client's to-do, and offers
 * and CMAs at the side. Each card opens its own page, where the work is done.
 */
import { fmtDateShort, fmtMonthDay, fmtWhen, localDayOf as dateOf, money } from '@hfos/core';
import { CMA_STATUSES } from '@hfos/core/addons/realestate/cma';
import { HOME_STATUSES } from '@hfos/core/addons/realestate/homes';
import { LIVE_OFFER_STATUSES, OFFER_STATUSES } from '@hfos/core/addons/realestate/offer-words';
import { TOUR_STATUSES } from '@hfos/core/addons/realestate/tours';
import { Home as HomeIcon } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { Callout } from '@/components/crm/chips';
import { Badge } from '@/components/ui/badge';
import { ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { CardHead, dealHref, Line } from './bits';
import { firstNames, FitList, homeFactsLine, profileLines, street } from './buyer-bits';
import type { BuyerSide, Home, Tour } from './types';

const thisYear = () => new Date().getFullYear();

function HeadLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="text-[13px] text-accent-text hover:underline">
      {children}
    </Link>
  );
}

export function WhatTheyWantCard({
  workspaceId,
  dealId,
  buyer,
}: {
  workspaceId: string;
  dealId: string;
  buyer: BuyerSide;
}) {
  const href = dealHref(workspaceId, dealId, 'buyer');
  const confirmedMust = buyer.memory.items
    .filter((i) => i.status === 'confirmed' && i.kind === 'must_have')
    .map((i) => i.words);
  const lines = profileLines(buyer.profile, confirmedMust);
  const pre = buyer.financing.steps.find((s) => s.step === 'preapproval');
  if (pre?.status === 'done' && pre.amountCents !== null)
    lines.splice(1, 0, {
      label: 'Preapproved to',
      value: `${money(pre.amountCents)}${pre.expiresOn ? ` · until ${fmtMonthDay(pre.expiresOn, thisYear())}` : ''}`,
    });
  const waiting = buyer.memory.waiting;
  return (
    <Card className="p-4 md:p-5" data-testid="buyer-wants">
      <CardHead
        title="What they want"
        action={
          <HeadLink href={href}>
            {waiting ? `Buyer memory · ${waiting} to confirm` : 'Buyer memory'}
          </HeadLink>
        }
      />
      {lines.length === 0 ? (
        <p className="text-[13.5px] text-text-2">
          Nothing yet. Add their budget, areas and must-haves on{' '}
          <Link href={href} className="text-accent-text hover:underline">
            What they want
          </Link>
          , so every home is checked against them.
        </p>
      ) : (
        <div className="grid gap-x-6 sm:grid-cols-2">
          {lines.map((l) => (
            <Line key={l.label} label={l.label}>
              {l.value}
            </Line>
          ))}
        </div>
      )}
    </Card>
  );
}

/** Saved by a client first, then the ones the agent is working on, then the best fits. */
const homeRank = (h: Home) =>
  (h.reactions.some((r) => r.reaction === 'saved') ? 0 : 2) +
  (['shortlisted', 'toured', 'offered'].includes(h.status) ? 0 : 1);

/** Who on the deal said what about a home: "Saved by Linh", "Passed: “too far from work”", "Added by Linh". */
export function HomeVoice({ home }: { home: Home }) {
  const saved = home.reactions.filter((r) => r.reaction === 'saved');
  const passed = home.reactions.filter((r) => r.reaction === 'passed');
  if (passed.length)
    return (
      <Badge variant="danger" className="max-w-full truncate">
        {passed[0]!.note
          ? `Passed: “${passed[0]!.note}”`
          : `Passed by ${firstNames(passed.map((r) => r.name))}`}
      </Badge>
    );
  if (saved.length)
    return <Badge variant="ok">Saved by {firstNames(saved.map((r) => r.name))}</Badge>;
  if (home.addedByClient)
    return <Badge variant="accent">Added by {firstNames([home.addedByClient.name])}</Badge>;
  return <Badge variant="gray">No answer yet</Badge>;
}

export function HomesCard({
  workspaceId,
  dealId,
  timeZone,
  buyer,
  live,
}: {
  workspaceId: string;
  dealId: string;
  timeZone: string;
  buyer: BuyerSide;
  live: boolean;
}) {
  const href = dealHref(workspaceId, dealId, 'homes');
  const shown = buyer.homes
    .filter((h) => h.status !== 'removed' && h.status !== 'passed')
    .sort(
      (a, b) =>
        homeRank(a) - homeRank(b) ||
        a.fit.missed - b.fit.missed ||
        b.addedAt.localeCompare(a.addedAt),
    )
    .slice(0, 3);
  const upcoming = buyer.tours.tours.filter((t) => t.status === 'planned');
  const onTour = (h: Home) => upcoming.find((t) => t.stops.some((s) => s.homeId === h.id));
  return (
    <Card className="p-4 md:p-5" data-testid="buyer-homes">
      <CardHead
        title="Homes"
        action={
          <div className="flex items-center gap-3">
            {buyer.homes.length ? <HeadLink href={href}>All {buyer.homes.length}</HeadLink> : null}
            {live ? (
              <ButtonLink size="sm" variant="secondary" href={`${href}?add=1`}>
                Add a home
              </ButtonLink>
            ) : null}
          </div>
        }
      />
      {shown.length === 0 ? (
        <p className="text-[13.5px] text-text-2">
          No homes yet. Paste an address or a listing’s text, and the client can add the ones they
          find in their portal.
        </p>
      ) : (
        <ul className="space-y-2.5">
          {shown.map((h) => {
            const tour = onTour(h);
            return (
              <li key={h.id}>
                <Link
                  href={`${href}?home=${h.id}`}
                  className="flex items-start gap-3 rounded-menu border border-border p-3 hover:bg-card-2"
                >
                  <span className="hidden h-14 w-16 flex-none items-center justify-center rounded-control bg-card-2 text-text-3 sm:flex">
                    <HomeIcon className="h-5 w-5" strokeWidth={1.5} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[14px] font-semibold">{street(h.address)}</div>
                    <div className="text-[12.5px] text-text-2">
                      {homeFactsLine(h.facts) || 'No facts yet'}
                    </div>
                    <FitList
                      fit={h.fit}
                      className="mt-1 flex flex-wrap gap-x-3 space-y-0 [&>li]:inline-flex"
                    />
                  </div>
                  <div className="flex flex-none flex-col items-end gap-1 text-[12.5px] text-text-2">
                    <HomeVoice home={h} />
                    {h.factsState === 'suggested'
                      ? 'Facts to confirm'
                      : h.factsState === 'filling'
                        ? 'Reading the listing…'
                        : tour
                          ? `On the ${fmtDateShort(dateOf(tour.startsAt, timeZone))} tour`
                          : HOME_STATUSES[h.status]}
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

/** "3 homes · 418 Maple Ave, 12 Birch Ln, 9 Cedar St", or how the feedback stands once it's done. */
export function tourLine(t: Tour): string {
  const homes = `${t.stops.length} ${t.stops.length === 1 ? 'home' : 'homes'}`;
  if (t.status === 'done') {
    const heard = t.stops.filter((s) => s.feedback.length).length;
    return `${homes} · ${heard === t.stops.length ? 'feedback on every home' : heard ? `feedback on ${heard}` : 'no feedback yet'}`;
  }
  return `${homes} · ${t.stops.map((s) => street(s.address)).join(', ')}`;
}

export function ToursCard({
  workspaceId,
  dealId,
  timeZone,
  buyer,
  live,
}: {
  workspaceId: string;
  dealId: string;
  timeZone: string;
  buyer: BuyerSide;
  live: boolean;
}) {
  const href = dealHref(workspaceId, dealId, 'tours');
  const list = [...buyer.tours.tours]
    .sort((a, b) =>
      a.status === 'planned' && b.status === 'planned'
        ? a.startsAt.localeCompare(b.startsAt)
        : a.status === 'planned'
          ? -1
          : b.status === 'planned'
            ? 1
            : b.startsAt.localeCompare(a.startsAt),
    )
    .slice(0, 3);
  return (
    <Card className="p-4 md:p-5" data-testid="buyer-tours">
      <CardHead
        title="Tours"
        action={
          live ? (
            <HeadLink href={`${href}?plan=1`}>Plan a tour</HeadLink>
          ) : list.length ? (
            <HeadLink href={href}>All tours</HeadLink>
          ) : null
        }
      />
      {list.length === 0 ? (
        <p className="text-[13.5px] text-text-2">
          No tours yet. A tour goes on the calendar with its homes in order, and the client is
          invited.
        </p>
      ) : (
        <ul className="space-y-2.5">
          {list.map((t) => (
            <li key={t.id}>
              <Link
                href={`${href}#tour-${t.id}`}
                className="flex items-start justify-between gap-3 hover:underline"
              >
                <div className="min-w-0">
                  <div className="text-[14px] font-semibold">
                    {fmtWhen(t.startsAt, t.endsAt, timeZone)}
                  </div>
                  <div className="truncate text-[12.5px] text-text-2">{tourLine(t)}</div>
                </div>
                <Badge variant={t.status === 'done' ? 'ok' : 'gray'}>
                  {TOUR_STATUSES[t.status]}
                </Badge>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function AgreementCard({
  workspaceId,
  dealId,
  buyer,
}: {
  workspaceId: string;
  dealId: string;
  buyer: BuyerSide;
}) {
  const a = buyer.tours.agreement;
  return (
    <Card className="p-4 md:p-5" data-testid="buyer-agreement">
      <CardHead
        title="Buyer agreement"
        action={
          a.ok ? null : (
            <HeadLink href={dealHref(workspaceId, dealId, 'documents')}>Documents</HeadLink>
          )
        }
      />
      {a.ok ? (
        <div className="flex flex-wrap items-center gap-2 text-[13.5px] text-text-2">
          <Badge variant="ok">Signed</Badge>
          {a.endsOn ? <span>Ends {fmtMonthDay(a.endsOn, thisYear())}</span> : null}
        </div>
      ) : (
        <Callout tone={a.rule === 'buyer_agreement_expired' ? 'danger' : 'warning'}>
          {a.words}
        </Callout>
      )}
    </Card>
  );
}

export function FinancingCard({
  workspaceId,
  dealId,
  buyer,
}: {
  workspaceId: string;
  dealId: string;
  buyer: BuyerSide;
}) {
  const f = buyer.financing;
  // The steps done so far and the next two.
  const firstOpen = f.steps.findIndex((s) => s.status !== 'done');
  const shown = f.steps.slice(
    Math.max(0, (firstOpen < 0 ? f.steps.length : firstOpen) - 1),
    (firstOpen < 0 ? f.steps.length : firstOpen) + 2,
  );
  const lender = [f.lender.lenderName, f.lender.officerName].filter(Boolean).join(' · ');
  return (
    <Card className="p-4 md:p-5" data-testid="buyer-financing">
      <CardHead
        title="Financing"
        action={<HeadLink href={dealHref(workspaceId, dealId, 'financing')}>Open</HeadLink>}
      />
      {shown.map((s) => (
        <Line key={s.step} label={s.label}>
          {s.status === 'done' ? (
            <Badge variant="ok">Done</Badge>
          ) : s.warning ? (
            <span className="text-warning-text">{s.warning}</span>
          ) : (
            <span className="text-text-2">{s.line}</span>
          )}
        </Line>
      ))}
      {lender ? <Line label="Lender">{lender}</Line> : null}
    </Card>
  );
}

export function ClientTodoCard({
  workspaceId,
  dealId,
  buyer,
}: {
  workspaceId: string;
  dealId: string;
  buyer: BuyerSide;
}) {
  const href = dealHref(workspaceId, dealId, 'client-tasks');
  const { tasks, clients } = buyer.tasks;
  const shown = [...tasks]
    .sort((a, b) => Number(a.status === 'done') - Number(b.status === 'done'))
    .slice(0, 4);
  const notIn = clients.filter((c) => c.portal === 'none' || c.portal === 'revoked');
  return (
    <Card className="p-4 md:p-5" data-testid="buyer-todo">
      <CardHead title="Client’s to-do" action={<HeadLink href={href}>All</HeadLink>} />
      {shown.length === 0 ? (
        <p className="text-[13.5px] text-text-2">
          Nothing asked of them yet. Ask for their preapproval letter or ID, and they do it in their
          portal.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {shown.map((t) => (
            <li key={t.id} className="flex items-start justify-between gap-3 text-[13.5px]">
              <span className={cn(t.status === 'done' && 'text-text-2')}>{t.title}</span>
              {t.status === 'done' ? (
                <Badge variant="ok">Done</Badge>
              ) : (
                <span className="flex-none text-right text-[12.5px] text-warning-text">
                  {t.waiting ?? 'Open'}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {notIn.length && clients.length ? (
        <div className="mt-3 border-t border-border pt-3">
          <ButtonLink size="sm" variant="secondary" href={`${href}?invite=1`}>
            Invite {firstNames(notIn.map((c) => c.name))} to the portal
          </ButtonLink>
        </div>
      ) : null}
    </Card>
  );
}

export function OffersCmaCard({
  workspaceId,
  dealId,
  buyer,
}: {
  workspaceId: string;
  dealId: string;
  buyer: BuyerSide;
}) {
  const offers = [...buyer.offers].sort(
    (a, b) =>
      Number(LIVE_OFFER_STATUSES.includes(b.status)) -
        Number(LIVE_OFFER_STATUSES.includes(a.status)) || b.number - a.number,
  );
  const client = firstNames(buyer.tasks.clients.map((c) => c.name));
  return (
    <Card className="p-4 md:p-5" data-testid="buyer-offers">
      <CardHead
        title="Offers and CMA"
        action={
          offers.length || buyer.cmas.length ? (
            <HeadLink href={dealHref(workspaceId, dealId, 'offers')}>Offers</HeadLink>
          ) : null
        }
      />
      {offers.length === 0 && buyer.cmas.length === 0 ? (
        <p className="text-[13.5px] text-text-2">
          No offer yet. Start a CMA from a home on{' '}
          <Link
            href={dealHref(workspaceId, dealId, 'homes')}
            className="text-accent-text hover:underline"
          >
            Homes
          </Link>{' '}
          once {client || 'the client'} is ready.
        </p>
      ) : (
        <ul className="space-y-2">
          {offers.slice(0, 3).map((o) => (
            <li key={o.id}>
              <Link
                href={dealHref(workspaceId, dealId, `offers/${o.id}`)}
                className="flex items-start justify-between gap-3 text-[13.5px] hover:underline"
              >
                <div className="min-w-0">
                  <div className="truncate font-medium">
                    {street(o.address)} · {money(o.versions.at(-1)?.priceCents ?? 0)}
                  </div>
                  {o.clock?.words ? (
                    <div className="text-[12.5px] text-text-2">{o.clock.words}</div>
                  ) : null}
                </div>
                <Badge
                  variant={
                    o.status === 'accepted'
                      ? 'ok'
                      : o.status === 'waiting_us'
                        ? 'pending'
                        : LIVE_OFFER_STATUSES.includes(o.status)
                          ? 'accent'
                          : 'gray'
                  }
                >
                  {OFFER_STATUSES[o.status]}
                </Badge>
              </Link>
            </li>
          ))}
          {buyer.cmas.slice(0, 2).map((c) => (
            <li key={c.id}>
              <Link
                href={dealHref(workspaceId, dealId, `cma/${c.id}`)}
                className="flex items-start justify-between gap-3 text-[13.5px] hover:underline"
              >
                <div className="min-w-0">
                  <div className="truncate font-medium">CMA · {street(c.subjectAddress)}</div>
                  <div className="text-[12.5px] text-text-2">
                    {c.lowCents !== null && c.highCents !== null
                      ? `${money(c.lowCents)}–${money(c.highCents)}`
                      : `${c.comps} ${c.comps === 1 ? 'comp' : 'comps'} so far`}
                  </div>
                </div>
                <Badge variant={c.status === 'draft' ? 'gray' : 'ok'}>
                  {CMA_STATUSES[c.status]}
                </Badge>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
