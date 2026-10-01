'use client';
/**
 * Offers on a buyer deal (boards 20 and 21, design/realestate/Offers.dc.html and OfferSummary.dc.html): every offer
 * and its versions side by side, the clock on the one waiting for an answer, recording the answer, and the one-page
 * summary the client sees in their portal. The deal's CMAs are listed beside them.
 */
import { fmtMonthDay, money } from '@hfos/core';
import { CMA_STATUSES } from '@hfos/core/addons/realestate/cma';
import {
  LIVE_OFFER_STATUSES,
  LOAN_TYPES,
  OFFER_STATUSES,
} from '@hfos/core/addons/realestate/offer-words';
import Link from 'next/link';
import { useState } from 'react';
import { Callout } from '@/components/crm/chips';
import { PageHeader } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button, ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { dateOf, fmtTime } from '@/lib/calendar/time';
import { useLiveRefresh } from '@/lib/realtime/live-provider';
import { cn } from '@/lib/utils';
import { CardHead, dealHref } from './bits';
import { DealCrumb, firstNames, street } from './buyer-bits';
import { ReasonDialog } from './deal-dialogs';
import { AnswerDialog, StartOfferDialog, VersionDialog } from './offer-dialogs';
import type { CmaRow, DealDocument, Home, Offer, OfferVersion } from './types';
import { useAct } from './use-act';
import { useQueryState } from './use-query-state';

const thisYear = () => new Date().getFullYear();

const statusVariant = (s: Offer['status']) =>
  s === 'accepted'
    ? 'ok'
    : s === 'waiting_us'
      ? 'pending'
      : LIVE_OFFER_STATUSES.includes(s)
        ? 'accent'
        : 'gray';

export function OffersPage({
  workspaceId,
  dealId,
  dealName,
  timeZone,
  offers,
  cmas,
  homes,
  documents,
  live,
}: {
  workspaceId: string;
  dealId: string;
  dealName: string;
  timeZone: string;
  offers: readonly Offer[];
  cmas: readonly CmaRow[];
  homes: readonly Home[];
  documents: readonly DealDocument[];
  live: boolean;
}) {
  useLiveRefresh(['custom_record']);
  const [start, setStart] = useQueryState('start');
  const sorted = [...offers].sort(
    (a, b) =>
      Number(LIVE_OFFER_STATUSES.includes(b.status)) -
        Number(LIVE_OFFER_STATUSES.includes(a.status)) || b.number - a.number,
  );
  return (
    <div data-testid="realestate-offers">
      <DealCrumb workspaceId={workspaceId} dealId={dealId} dealName={dealName} here="Offers" />
      <PageHeader
        title="Offers"
        description={dealName}
        actions={
          live ? (
            <Button onClick={() => setStart('')} data-testid="offers-start">
              Make an offer
            </Button>
          ) : null
        }
      />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px] lg:gap-5">
        <div className="min-w-0 space-y-3">
          {sorted.length === 0 ? (
            <Card className="p-5 text-[13.5px] text-text-2">
              No offers yet. When there is one, type in its terms from the contract; every counter
              is kept beside it, with the clock on the answer.
            </Card>
          ) : (
            sorted.map((o) => {
              const v = o.versions.at(-1)!;
              return (
                <Link
                  key={o.id}
                  href={dealHref(workspaceId, dealId, `offers/${o.id}`)}
                  className="block"
                >
                  <Card className="flex items-start justify-between gap-3 p-4 hover:bg-card-2 md:p-5">
                    <div className="min-w-0">
                      <div className="text-[15px] font-semibold">
                        Offer {o.number} · {street(o.address)}
                      </div>
                      <div className="text-[13px] text-text-2">
                        {money(v.priceCents)} · version {v.number}
                        {o.theirAgentName ? ` · to ${o.theirAgentName}` : ''}
                      </div>
                      {o.clock?.words ? (
                        <div className="text-[13px] text-text-2">{o.clock.words}</div>
                      ) : null}
                    </div>
                    <Badge variant={statusVariant(o.status)}>{OFFER_STATUSES[o.status]}</Badge>
                  </Card>
                </Link>
              );
            })
          )}
        </div>
        <Card className="h-fit p-4 md:p-5" data-testid="offers-cmas">
          <CardHead title="CMAs" />
          {cmas.length === 0 ? (
            <p className="text-[13.5px] text-text-2">
              None yet. Start one from a home on{' '}
              <Link
                href={dealHref(workspaceId, dealId, 'homes')}
                className="text-accent-text hover:underline"
              >
                Homes
              </Link>
              .
            </p>
          ) : (
            <ul className="space-y-2">
              {cmas.map((c) => (
                <li key={c.id}>
                  <Link
                    href={dealHref(workspaceId, dealId, `cma/${c.id}`)}
                    className="flex items-start justify-between gap-3 text-[13.5px] hover:underline"
                  >
                    <div className="min-w-0">
                      <div className="truncate font-medium">
                        CMA {c.number} · {street(c.subjectAddress)}
                      </div>
                      <div className="text-[12.5px] text-text-2">
                        {c.lowCents !== null && c.highCents !== null
                          ? `${money(c.lowCents)}–${money(c.highCents)}`
                          : `${c.comps} ${c.comps === 1 ? 'comp' : 'comps'}`}
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
      </div>
      <StartOfferDialog
        open={start !== null}
        onOpenChange={(o) => !o && setStart(null)}
        workspaceId={workspaceId}
        dealId={dealId}
        timeZone={timeZone}
        homes={homes}
        documents={documents}
        homeId={start || null}
      />
    </div>
  );
}

/** "Oct 2, 6 PM". */
function respondWords(at: string, timeZone: string) {
  return `${fmtMonthDay(dateOf(at, timeZone), thisYear())}, ${fmtTime(at, timeZone).replace(':00', '')}`;
}

type Row = { label: string; value: (v: OfferVersion) => string };

const ROWS = (timeZone: string): Row[] => [
  { label: 'Price', value: (v) => money(v.priceCents) },
  {
    label: 'Earnest money',
    value: (v) =>
      v.emdCents === null
        ? '—'
        : `${money(v.emdCents)}${v.emdDays !== null ? ` · ${v.emdDays} days` : ''}`,
  },
  { label: 'Seller credit', value: (v) => money(v.sellerCreditCents) },
  {
    label: 'Inspection period',
    value: (v) =>
      v.inspectionDays === null ? '—' : v.inspectionDays ? `${v.inspectionDays} days` : 'None',
  },
  {
    label: 'Financing',
    value: (v) =>
      v.loanType === null
        ? '—'
        : v.loanType === 'cash'
          ? 'Cash'
          : `${LOAN_TYPES[v.loanType]}${v.financingDays !== null ? ` · ${v.financingDays} days` : ''}`,
  },
  {
    label: 'Appraisal',
    value: (v) =>
      v.appraisalContingency === null
        ? '—'
        : v.appraisalContingency
          ? 'Can back out if low'
          : 'No condition',
  },
  {
    label: 'Closing',
    value: (v) => (v.closingDate ? fmtMonthDay(v.closingDate, thisYear()) : '—'),
  },
  { label: 'Other', value: (v) => v.otherTerms ?? '—' },
  { label: 'Respond by', value: (v) => (v.respondBy ? respondWords(v.respondBy, timeZone) : '—') },
];

export function OfferPage({
  workspaceId,
  dealId,
  dealName,
  timeZone,
  offer: o,
  clients,
  documents,
  live,
}: {
  workspaceId: string;
  dealId: string;
  dealName: string;
  timeZone: string;
  offer: Offer;
  clients: readonly string[];
  documents: readonly DealDocument[];
  live: boolean;
}) {
  useLiveRefresh(['custom_record']);
  const [dialog, setDialog] = useState<'answer' | 'version' | 'withdraw' | null>(null);
  const { busy, act } = useAct();
  const who = firstNames(clients) || 'the client';
  const open = LIVE_OFFER_STATUSES.includes(o.status);
  const newest = o.versions.at(-1)!;
  const rows = ROWS(timeZone).filter((r) => o.versions.some((v) => r.value(v) !== '—'));
  const to = [o.theirAgentName, o.theirBrokerage].filter(Boolean).join(', ');
  return (
    <div data-testid="realestate-offer">
      <DealCrumb
        workspaceId={workspaceId}
        dealId={dealId}
        dealName={dealName}
        middle={{ label: 'Offers', path: 'offers' }}
        here={street(o.address)}
      />
      <PageHeader
        title={`Offer · ${street(o.address)}`}
        description={`${dealName}${to ? ` · to ${to}` : ''} · ${OFFER_STATUSES[o.status]}`}
        actions={
          <>
            <ButtonLink
              variant="secondary"
              href={dealHref(workspaceId, dealId, `offers/${o.id}/summary`)}
              data-testid="offer-summary-link"
            >
              {o.shared?.current ? `Summary shared with ${who}` : `Share a summary with ${who}`}
            </ButtonLink>
            {live && open ? (
              <>
                <Button onClick={() => setDialog('answer')} data-testid="offer-answer">
                  Record their answer
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost">More</Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-56">
                    <DropdownMenuItem onSelect={() => setDialog('version')}>
                      Add a counter…
                    </DropdownMenuItem>
                    <DropdownMenuItem danger onSelect={() => setDialog('withdraw')}>
                      Withdraw the offer…
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </>
            ) : null}
          </>
        }
      />
      {o.clock ? (
        <Callout tone="warning" className="mb-4" data-testid="offer-clock">
          <div className="font-semibold text-text">
            {o.clock.waitingOn === 'them' ? 'The seller’s answer' : 'Our answer'}
            {o.clock.words ? ` is ${o.clock.words.replace(/^Due/, 'due')}` : ' has no deadline'}
          </div>
          <div>
            From {newest.side === 'us' ? 'our' : 'the seller’s'}{' '}
            {newest.number === 1 ? 'offer' : 'counter'} (version {newest.number}).
            {o.clock.respondBy
              ? ' You’ll hear 2 hours before, at the deadline, and if it passes.'
              : ''}
          </div>
        </Callout>
      ) : o.endedReason ? (
        <Callout tone="neutral" className="mb-4">
          {OFFER_STATUSES[o.status]}: {o.endedReason}
        </Callout>
      ) : null}
      <Card className="overflow-x-auto p-0">
        <table className="w-full min-w-[560px] text-left text-[13.5px]">
          <thead className="border-b border-border text-xs font-semibold uppercase tracking-wide text-text-3">
            <tr>
              <th className="px-5 py-3 font-semibold">Term</th>
              {o.versions.map((v, i) => (
                <th key={v.id} className="px-3 py-3 font-semibold">
                  {v.number} ·{' '}
                  {v.side === 'us' ? (i === 0 ? 'Our offer' : 'Our counter') : 'Seller’s counter'} ·{' '}
                  {fmtMonthDay(dateOf(v.at, timeZone), thisYear())}
                  {o.acceptedVersionId === v.id ? ' · accepted' : ''}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label} className="border-b border-border">
                <td className="px-5 py-3 text-text-2">{r.label}</td>
                {o.versions.map((v, i) => {
                  const now = r.value(v);
                  const changed = i > 0 && now !== r.value(o.versions[i - 1]!);
                  return (
                    <td key={v.id} className={cn('px-3 py-3', changed && 'font-semibold')}>
                      {now}
                    </td>
                  );
                })}
              </tr>
            ))}
            <tr>
              <td className="px-5 py-3 text-text-2">Document</td>
              {o.versions.map((v) => (
                <td key={v.id} className="px-3 py-3">
                  {v.document ? (
                    <Badge variant={v.document.signed ? 'ok' : 'gray'}>
                      {v.document.signed ? 'Signed · uploaded' : 'Uploaded'}
                    </Badge>
                  ) : live && open ? (
                    <AttachDocument
                      documents={documents}
                      busy={busy === `doc-${v.id}`}
                      onPick={(documentId) =>
                        void act(
                          `doc-${v.id}`,
                          async () =>
                            unwrap(
                              await apiBrowser().POST(
                                '/v1/commands/realestate.offer.attach_document',
                                {
                                  body: { workspaceId, versionId: v.id, documentId },
                                },
                              ),
                            ),
                          'Attached.',
                        )
                      }
                    />
                  ) : (
                    <span className="text-text-3">Not uploaded</span>
                  )}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </Card>
      <p className="mt-3 text-[12.5px] text-text-3">
        Every version is kept as it was sent. The contract itself is filled in your forms software
        and uploaded; HandsFreeOS keeps the terms, the documents and the clock. When it’s accepted,
        its terms go to Key dates for you to confirm.
      </p>
      <AnswerDialog
        offer={o}
        open={dialog === 'answer'}
        onOpenChange={(x) => !x && setDialog(null)}
        workspaceId={workspaceId}
        timeZone={timeZone}
      />
      <VersionDialog
        offer={o}
        open={dialog === 'version'}
        onOpenChange={(x) => !x && setDialog(null)}
        workspaceId={workspaceId}
        timeZone={timeZone}
        documents={documents}
      />
      <ReasonDialog
        open={dialog === 'withdraw'}
        onOpenChange={(x) => !x && setDialog(null)}
        title="Withdraw the offer?"
        description="It ends here, and its versions are kept."
        submit="Withdraw it"
        danger
        done="Withdrawn."
        run={async (reason) =>
          unwrap(
            await apiBrowser().POST('/v1/commands/realestate.offer.withdraw', {
              body: { workspaceId, offerId: o.id, reason },
            }),
          )
        }
      />
    </div>
  );
}

function AttachDocument({
  documents,
  busy,
  onPick,
}: {
  documents: readonly DealDocument[];
  busy: boolean;
  onPick: (documentId: string) => void;
}) {
  const usable = documents.filter((d) => d.status !== 'void' && d.status !== 'superseded');
  if (!usable.length) return <span className="text-text-3">Not uploaded</span>;
  return (
    <select
      aria-label="Attach the uploaded contract"
      className="h-8 max-w-[180px] rounded-control border border-border-strong bg-card px-2 text-[13px]"
      value=""
      disabled={busy}
      onChange={(e) => e.target.value && onPick(e.target.value)}
    >
      <option value="">Attach the contract…</option>
      {usable.map((d) => (
        <option key={d.documentId} value={d.documentId}>
          {d.title}
        </option>
      ))}
    </select>
  );
}

/** The one-page summary (board 21), as the clients see it in their portal and as it prints. */
export function OfferSummaryPage({
  workspaceId,
  dealId,
  dealName,
  businessName,
  offer: o,
  clients,
  live,
}: {
  workspaceId: string;
  dealId: string;
  dealName: string;
  businessName: string;
  offer: Offer;
  clients: readonly string[];
  live: boolean;
}) {
  const { busy, act } = useAct();
  const who = firstNames(clients) || 'the client';
  const s = o.summary;
  const half = Math.ceil(s.lines.length / 2);
  return (
    <div data-testid="realestate-offer-summary">
      <div className="print:hidden">
        <DealCrumb
          workspaceId={workspaceId}
          dealId={dealId}
          dealName={dealName}
          middle={{ label: `Offer · ${street(o.address)}`, path: `offers/${o.id}` }}
          here="Summary"
        />
        <PageHeader
          title={`Summary for ${who}`}
          description="As it shows in their portal, and prints on one page"
          actions={
            <>
              <Button variant="secondary" onClick={() => window.print()}>
                Print
              </Button>
              {live ? (
                <Button
                  loading={busy === 'share'}
                  disabled={!!o.shared?.current}
                  onClick={() =>
                    void act(
                      'share',
                      async () =>
                        unwrap(
                          await apiBrowser().POST('/v1/commands/realestate.offer.share_summary', {
                            body: { workspaceId, offerId: o.id },
                          }),
                        ),
                      `Shared. It’s in ${who}’s portal.`,
                    )
                  }
                  data-testid="offer-share"
                >
                  {o.shared?.current ? 'Shared in the portal' : 'Share in the portal'}
                </Button>
              ) : null}
            </>
          }
        />
      </div>
      <Card className="mx-auto max-w-[810px] p-6 md:p-10 print:border-0 print:shadow-none">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-[19px] font-semibold">{s.title}</h2>
          <span className="text-[12.5px] text-text-2">
            {businessName} · {fmtMonthDay(new Date().toISOString().slice(0, 10), thisYear())}
          </span>
        </div>
        <p className="mt-3 text-[14px] text-text-2">{s.note}</p>
        <div className="mt-3 grid gap-x-6 sm:grid-cols-2">
          {[s.lines.slice(0, half), s.lines.slice(half)].map((col, i) => (
            <div key={i}>
              {col.map((l) => (
                <div
                  key={l.label}
                  className="flex items-baseline justify-between gap-3 py-1 text-[13.5px]"
                >
                  <span className="text-text-2">{l.label}</span>
                  <span className={cn('text-right', l.label === 'Price' && 'font-semibold')}>
                    {l.value}
                  </span>
                </div>
              ))}
            </div>
          ))}
        </div>
        <div className="mt-3 border-t border-border pt-3">
          <h3 className="text-[14px] font-semibold">What happens next</h3>
          <p className="mt-1 text-[14px] text-text-2">{s.next}</p>
        </div>
      </Card>
    </div>
  );
}
