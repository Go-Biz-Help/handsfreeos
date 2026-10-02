'use client';
/**
 * A deal (board 3, design/realestate/DealPage.dc.html): where it stands and its next move, what could stop its
 * closing, its duties by what brought them, and at the side its dates, people, commission and client updates.
 * Duties open in the drawer (board 5). What a person may do comes from the deal itself (`can`), so the page shows
 * only what works for them.
 */
import { fmtMonthDay, localDayOf as dateOf } from '@hfos/core';
import { dueWords, startedByWords } from '@hfos/core/addons/realestate/rule-words';
import {
  BACK_EVENTS,
  isDoneDuty,
  LISTING_EXITS,
  STAGE_LABELS,
  stagesOf,
  type DealStage,
  type DutyStatus,
} from '@hfos/core/addons/realestate/states';
import {
  OUTCOME_LABELS,
  sideWords,
  DEAL_ROLE_LABELS,
  type DealRole,
} from '@hfos/core/addons/realestate/words';
import { Ban, Check, ChevronDown, Circle, Clock, FileText, History, Plus } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import { Callout } from '@/components/crm/chips';
import { PageHeader } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button, ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { useLiveRefresh } from '@/lib/realtime/live-provider';
import { cn } from '@/lib/utils';
import { CardHead, dealHref, DutyStatusBadge, HealthDot, realestateHref } from './bits';
import { firstNames } from './buyer-bits';
import {
  AddDutyDialog,
  ApplyVersionDialog,
  CloseDialog,
  MomentDialog,
  ReasonDialog,
  WireDialog,
} from './deal-dialogs';
import {
  AgreementCard,
  ClientTodoCard,
  FinancingCard,
  HomesCard,
  OffersCmaCard,
  ToursCard,
  WhatTheyWantCard,
} from './buyer-cards';
import { CommissionCard, KeyDatesCard, PeopleCard, UpdatesCard } from './deal-side';
import {
  ListingCard,
  ListingCmasCard,
  MarketingCard,
  MatchingCard,
  NetSheetCard,
  OffersCard,
} from './listing-cards';
import { OpenHousesCard } from './open-houses-page';
import { SuggestionsCard } from './suggestions-card';
import { DutyDrawer } from './duty-drawer';
import type {
  BuyerSide,
  DealDuty,
  DealGet,
  DealRisks,
  Draft,
  ListingSide,
  Teammate,
} from './types';
import { useAct } from './use-act';

type Dialog =
  | 'moment'
  | 'close'
  | 'wire'
  | 'apply'
  | 'duty'
  | 'terminate'
  | 'offer_lost'
  | 'end'
  | 'reopen'
  | null;

export function DealPage({
  workspaceId,
  timeZone,
  deal,
  risks,
  drafts,
  members,
  canManage,
  buyer,
  listing,
}: {
  workspaceId: string;
  timeZone: string;
  deal: DealGet;
  risks: DealRisks;
  drafts: readonly Draft[];
  members: readonly Teammate[];
  canManage: boolean;
  /** A buyer deal's own side: what they want, homes, tours, financing, the client's to-do, offers. */
  buyer?: BuyerSide | null;
  /** A listing deal's own side (round three): the listing, its marketing, offers and open houses, the seller. */
  listing?: ListingSide | null;
}) {
  useLiveRefresh(['custom_record']);
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const dutyId = params.get('duty');
  const openDuty = (id: string | null) => {
    const next = new URLSearchParams(params.toString());
    if (id) next.set('duty', id);
    else next.delete('duty');
    const q = next.toString();
    router.replace(q ? `${pathname}?${q}` : pathname, { scroll: false });
  };
  const [dialog, setDialog] = useState<Dialog>(null);
  const [endHow, setEndHow] = useState<'withdrawn' | 'expired' | 'cancelled' | 'lost'>('lost');
  const { busy, act } = useAct();
  const endAs = (how: typeof endHow) => {
    setEndHow(how);
    setDialog('end');
  };
  const d = deal.deal;
  const dealId = d.dealId;
  const ended = d.outcome !== null;
  const live = !ended && !d.archived;

  // The side's run of stages; a listing's exits only when it's in one.
  const run = stagesOf(d.side).filter(
    (s) => !(LISTING_EXITS as readonly string[]).includes(s) || s === d.stage,
  );
  const here = run.indexOf(d.stage as DealStage);
  const next = here >= 0 ? run[here + 1] : undefined;
  const atClosing = d.stage === 'closing';
  const canEvent = (event: string) =>
    (
      (
        BACK_EVENTS as Readonly<
          Record<string, Readonly<Record<string, { from: readonly string[] }>>>
        >
      )[d.side]?.[event]?.from ?? []
    ).includes(d.stage);

  const move = (stage: string) =>
    act(
      'move',
      async () =>
        unwrap(
          await apiBrowser().POST('/v1/commands/realestate.deal.move_stage', {
            body: { workspaceId, dealId, stage },
          }),
        ),
      `Moved to ${STAGE_LABELS[stage as DealStage] ?? stage}.`,
    );

  const main = deal.team.find((t) => t.main);
  const others = deal.team.filter((t) => !t.main);
  const clients = buyer?.tasks.clients ?? listing?.tasks.clients ?? [];
  const inPortal = clients
    .map((c) => c.portalSince)
    .filter((x): x is string => !!x)
    .sort()[0];
  const description = [
    `${sideWords(d.side)[0]!.toUpperCase()}${sideWords(d.side).slice(1)}`,
    clients.length ? clientNames(clients.map((c) => c.name)) : null,
    main ? `${main.name} (main agent)` : null,
    ...others.map(
      (t) => `${t.name} (${(DEAL_ROLE_LABELS[t.role as DealRole] ?? t.role).toLowerCase()})`,
    ),
    ...deal.links.map((l) => `linked to ${l.name}`),
    inPortal ? `in the portal since ${fmtMonthDay(dateOf(inPortal, timeZone), thisYear)}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div data-testid="realestate-deal">
      <div className="mb-3.5 flex items-center gap-1.5 text-[13px]">
        <Link href={realestateHref(workspaceId)} className="text-accent-text hover:underline">
          Deals
        </Link>
        <span className="text-text-3">/</span>
        <span className="truncate text-text-2">{d.name}</span>
      </div>
      <PageHeader
        title={
          deal.property && !d.name.includes(deal.property.address)
            ? `${d.name} · ${deal.property.address}`
            : d.name
        }
        description={description}
        actions={
          <>
            <ButtonLink href={dealHref(workspaceId, dealId, 'dates')} variant="secondary">
              Key dates
            </ButtonLink>
            <ButtonLink href={dealHref(workspaceId, dealId, 'documents')} variant="secondary">
              Documents
            </ButtonLink>
            {listing ? (
              <ButtonLink
                href={dealHref(workspaceId, dealId, 'marketing')}
                variant="secondary"
                data-testid="deal-marketing"
              >
                Marketing
              </ButtonLink>
            ) : null}
            {buyer && live ? (
              <ButtonLink
                href={dealHref(workspaceId, dealId, 'tours?plan=1')}
                variant="secondary"
                data-testid="deal-plan-tour"
              >
                Plan a tour
              </ButtonLink>
            ) : null}
            {live && atClosing ? (
              <Button variant="success" onClick={() => setDialog('close')} data-testid="deal-close">
                Close the deal
              </Button>
            ) : live && next ? (
              <Button
                onClick={() => void move(next)}
                loading={busy === 'move'}
                data-testid="deal-next-stage"
              >
                Move to {STAGE_LABELS[next]}
              </Button>
            ) : null}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" aria-label="More for this deal" data-testid="deal-more">
                  More
                  <ChevronDown className="h-4 w-4" strokeWidth={1.75} />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-64">
                {live ? (
                  <>
                    <DropdownMenuItem onSelect={() => setDialog('moment')}>
                      Record what happened…
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => setDialog('duty')}>
                      Add a duty…
                    </DropdownMenuItem>
                    {canEvent('offer_lost') ? (
                      <DropdownMenuItem onSelect={() => setDialog('offer_lost')}>
                        The offer was lost…
                      </DropdownMenuItem>
                    ) : null}
                    {canEvent('terminated') ? (
                      <DropdownMenuItem onSelect={() => setDialog('terminate')}>
                        Terminate the contract…
                      </DropdownMenuItem>
                    ) : null}
                    <DropdownMenuItem onSelect={() => setDialog('wire')} danger>
                      Report changed wiring…
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    {d.side === 'listing' ? (
                      <>
                        {canEvent('withdrawn') ? (
                          <DropdownMenuItem onSelect={() => endAs('withdrawn')}>
                            Withdraw the listing…
                          </DropdownMenuItem>
                        ) : null}
                        {canEvent('expired') ? (
                          <DropdownMenuItem onSelect={() => endAs('expired')}>
                            The listing expired…
                          </DropdownMenuItem>
                        ) : null}
                        {canEvent('cancelled') ? (
                          <DropdownMenuItem onSelect={() => endAs('cancelled')}>
                            Cancel the listing…
                          </DropdownMenuItem>
                        ) : null}
                        {canEvent('back_on_market') ? (
                          <DropdownMenuItem onSelect={() => void move('active')}>
                            Back on the market
                          </DropdownMenuItem>
                        ) : null}
                      </>
                    ) : (
                      <DropdownMenuItem onSelect={() => endAs('lost')}>
                        The buyer stopped looking…
                      </DropdownMenuItem>
                    )}
                  </>
                ) : null}
                {ended && !d.archived ? (
                  <DropdownMenuItem onSelect={() => setDialog('reopen')}>
                    Reopen the deal…
                  </DropdownMenuItem>
                ) : null}
                {canManage && live ? (
                  <DropdownMenuItem onSelect={() => setDialog('apply')}>
                    Apply the newest duty list…
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuItem asChild>
                  <Link href={dealHref(workspaceId, dealId, 'history')}>
                    <History className="h-4 w-4" strokeWidth={1.75} />
                    History
                  </Link>
                </DropdownMenuItem>
                {deal.can.archive ? (
                  <DropdownMenuItem
                    onSelect={() =>
                      void act(
                        'archive',
                        async () =>
                          d.archived
                            ? unwrap(
                                await apiBrowser().POST('/v1/commands/realestate.deal.restore', {
                                  body: { workspaceId, dealId },
                                }),
                              )
                            : unwrap(
                                await apiBrowser().POST('/v1/commands/realestate.deal.archive', {
                                  body: { workspaceId, dealId },
                                }),
                              ),
                        d.archived ? 'Restored.' : 'Archived. It’s kept; nothing is deleted.',
                      )
                    }
                  >
                    {d.archived ? 'Restore' : 'Archive'}
                  </DropdownMenuItem>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        }
      />

      <div className="mb-5 flex flex-wrap gap-1.5" aria-label="Stages" data-testid="deal-stages">
        {run.map((s, i) => {
          const passed = here >= 0 && i < here;
          const current = s === d.stage;
          const ahead = live && here >= 0 && i > here;
          const label = STAGE_LABELS[s];
          const className = cn(
            'inline-flex h-7 items-center rounded-full px-2.5 text-[12.5px]',
            current && 'bg-accent font-semibold text-on-solid',
            passed && 'bg-success-soft text-success-text',
            !current && !passed && 'bg-card-2 text-text-2',
          );
          return ahead && s !== 'past_client' ? (
            <button
              key={s}
              type="button"
              className={cn(className, 'hover:bg-card-3')}
              title={`Move to ${label}`}
              onClick={() =>
                confirm(
                  `Move this deal to ${label}? Duties for the stages it passes are added too.`,
                ) && void move(s)
              }
            >
              {label}
            </button>
          ) : (
            <span key={s} className={className} aria-current={current ? 'step' : undefined}>
              {label}
            </span>
          );
        })}
      </div>

      {d.archived ? (
        <Callout tone="neutral" className="mb-4">
          Archived. Nothing on it changes until it’s restored.
        </Callout>
      ) : ended ? (
        <Callout tone={d.outcome === 'closed' ? 'info' : 'neutral'} className="mb-4">
          {(OUTCOME_LABELS as Readonly<Record<string, string>>)[d.outcome!] ?? d.outcome}
          {d.outcomeAt
            ? ` ${new Date(d.outcomeAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
            : ''}
          {d.outcomeReason ? `: ${d.outcomeReason}` : '.'}
        </Callout>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px] lg:gap-5">
        <div className="min-w-0 space-y-4 lg:space-y-5">
          {buyer ? (
            <>
              <SuggestionsCard
                workspaceId={workspaceId}
                suggestions={buyer.suggestions}
                clients={firstNames(buyer.tasks.clients.map((c) => c.name))}
                live={live}
              />
              <WhatTheyWantCard workspaceId={workspaceId} dealId={dealId} buyer={buyer} />
              <HomesCard
                workspaceId={workspaceId}
                dealId={dealId}
                timeZone={timeZone}
                buyer={buyer}
                live={live}
              />
              <ToursCard
                workspaceId={workspaceId}
                dealId={dealId}
                timeZone={timeZone}
                buyer={buyer}
                live={live}
              />
            </>
          ) : null}
          {listing ? (
            <>
              <ListingCard
                workspaceId={workspaceId}
                dealId={dealId}
                timeZone={timeZone}
                side={listing}
              />
              <OffersCard
                workspaceId={workspaceId}
                dealId={dealId}
                timeZone={timeZone}
                side={listing}
              />
              <OpenHousesCard
                workspaceId={workspaceId}
                dealId={dealId}
                list={listing.openHouses}
                timeZone={timeZone}
              />
            </>
          ) : null}
          <RisksCard risks={risks} onOpen={openDuty} workspaceId={workspaceId} dealId={dealId} />
          <DutiesCard
            duties={deal.duties}
            timeZone={timeZone}
            onOpen={openDuty}
            onAdd={live ? () => setDialog('duty') : undefined}
          />
        </div>
        <div className="space-y-4 lg:space-y-5">
          {buyer ? (
            <>
              <AgreementCard workspaceId={workspaceId} dealId={dealId} buyer={buyer} />
              <FinancingCard workspaceId={workspaceId} dealId={dealId} buyer={buyer} />
              <ClientTodoCard workspaceId={workspaceId} dealId={dealId} list={buyer.tasks} />
              <OffersCmaCard workspaceId={workspaceId} dealId={dealId} buyer={buyer} />
            </>
          ) : null}
          {listing ? (
            <>
              <MarketingCard workspaceId={workspaceId} dealId={dealId} side={listing} />
              <ClientTodoCard
                workspaceId={workspaceId}
                dealId={dealId}
                list={listing.tasks}
                title="Seller’s to-do"
                empty="Nothing asked of them yet. Ask them about their home from the facts page, and they answer in their portal."
              />
              <MatchingCard side={listing} />
              <NetSheetCard
                workspaceId={workspaceId}
                dealId={dealId}
                timeZone={timeZone}
                side={listing}
              />
              <ListingCmasCard
                workspaceId={workspaceId}
                dealId={dealId}
                side={listing}
                live={live}
              />
            </>
          ) : null}
          <KeyDatesCard workspaceId={workspaceId} deal={deal} />
          <PeopleCard workspaceId={workspaceId} deal={deal} members={members} />
          <CommissionCard workspaceId={workspaceId} deal={deal} />
          <UpdatesCard workspaceId={workspaceId} dealId={dealId} drafts={drafts} />
          <Card className="p-4 md:p-5">
            <div className="flex flex-col gap-2 text-[13.5px]">
              <Link
                href={dealHref(workspaceId, dealId, 'documents')}
                className="inline-flex items-center gap-2 hover:underline"
              >
                <FileText className="h-4 w-4 text-text-3" strokeWidth={1.75} />
                Documents
              </Link>
              <Link
                href={dealHref(workspaceId, dealId, 'history')}
                className="inline-flex items-center gap-2 hover:underline"
              >
                <History className="h-4 w-4 text-text-3" strokeWidth={1.75} />
                History
              </Link>
            </div>
          </Card>
        </div>
      </div>

      <DutyDrawer
        workspaceId={workspaceId}
        dutyId={dutyId}
        onClose={() => openDuty(null)}
        timeZone={timeZone}
        members={members}
      />
      <MomentDialog
        open={dialog === 'moment'}
        onOpenChange={(o) => !o && setDialog(null)}
        workspaceId={workspaceId}
        dealId={dealId}
      />
      <CloseDialog
        open={dialog === 'close'}
        onOpenChange={(o) => !o && setDialog(null)}
        workspaceId={workspaceId}
        dealId={dealId}
        hasLead={!!d.leadId}
      />
      <WireDialog
        open={dialog === 'wire'}
        onOpenChange={(o) => !o && setDialog(null)}
        workspaceId={workspaceId}
        dealId={dealId}
      />
      <ApplyVersionDialog
        open={dialog === 'apply'}
        onOpenChange={(o) => !o && setDialog(null)}
        workspaceId={workspaceId}
        dealId={dealId}
      />
      <AddDutyDialog
        open={dialog === 'duty'}
        onOpenChange={(o) => !o && setDialog(null)}
        workspaceId={workspaceId}
        dealId={dealId}
        members={members}
      />
      <ReasonDialog
        open={dialog === 'terminate'}
        onOpenChange={(o) => !o && setDialog(null)}
        title="Terminate the contract?"
        description={
          d.side === 'buyer'
            ? 'The deal goes back to searching. Contract duties still open are cancelled; its history is kept.'
            : 'The listing goes back on the market. Contract duties still open are cancelled; its history is kept.'
        }
        submit="Terminate"
        danger
        done="Terminated."
        run={async (reason) =>
          unwrap(
            await apiBrowser().POST('/v1/commands/realestate.deal.terminate', {
              body: { workspaceId, dealId, reason },
            }),
          )
        }
      />
      <ReasonDialog
        open={dialog === 'offer_lost'}
        onOpenChange={(o) => !o && setDialog(null)}
        title="The offer was lost?"
        description="The deal goes back to touring, with its history kept."
        submit="Record it"
        done="Recorded. Back to touring."
        run={async (reason) =>
          unwrap(
            await apiBrowser().POST('/v1/commands/realestate.deal.record_offer_lost', {
              body: { workspaceId, dealId, reason },
            }),
          )
        }
      />
      <ReasonDialog
        open={dialog === 'end'}
        onOpenChange={(o) => !o && setDialog(null)}
        title={
          endHow === 'withdrawn'
            ? 'Withdraw the listing?'
            : endHow === 'expired'
              ? 'The listing expired?'
              : endHow === 'cancelled'
                ? 'Cancel the listing?'
                : 'End this buyer deal?'
        }
        description="Its open duties are cancelled and its history is kept. It can be reopened."
        submit="End it"
        danger
        done="Ended."
        run={async (reason) =>
          unwrap(
            await apiBrowser().POST('/v1/commands/realestate.deal.end', {
              body: { workspaceId, dealId, how: endHow, reason },
            }),
          )
        }
      />
      <ReasonDialog
        open={dialog === 'reopen'}
        onOpenChange={(o) => !o && setDialog(null)}
        title="Reopen the deal?"
        description="It goes back to where it was, and its duties pick up again."
        submit="Reopen"
        done="Reopened."
        run={async (reason) =>
          unwrap(
            await apiBrowser().POST('/v1/commands/realestate.deal.reopen', {
              body: { workspaceId, dealId, reason },
            }),
          )
        }
      />
    </div>
  );
}

const thisYear = new Date().getFullYear();

/** "Linh & Tuan Nguyen" when they share a last name; "Linh Nguyen and Sam Park" when they don't. */
function clientNames(names: readonly string[]): string {
  const parts = names.map((n) => n.trim().split(/\s+/));
  const last = parts.map((p) => (p.length > 1 ? p.at(-1) : ''));
  if (names.length > 1 && last[0] && last.every((l) => l === last[0]))
    return `${parts.map((p) => p.slice(0, -1).join(' ')).join(' & ')} ${last[0]}`;
  return names.length > 1
    ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
    : (names[0] ?? '');
}

function RisksCard({
  risks,
  onOpen,
  workspaceId,
  dealId,
}: {
  risks: DealRisks;
  onOpen: (dutyId: string) => void;
  workspaceId: string;
  dealId: string;
}) {
  const [all, setAll] = useState(false);
  const reds = risks.reasons.filter((r) => r.level === 'red').length;
  const n = risks.reasons.length;
  // The first few, reds first (as the health check orders them); the rest a press away.
  const shown = all ? risks.reasons : risks.reasons.slice(0, 4);
  return (
    <Card className="p-4 md:p-5" data-testid="deal-risks">
      <CardHead
        icon={<HealthDot health={risks.health} />}
        title={
          n === 0
            ? 'Nothing stands in the way'
            : reds
              ? `${reds === 1 ? 'One thing' : `${reds} things`} could stop this closing`
              : `${n === 1 ? 'One thing needs' : `${n} things need`} attention`
        }
      />
      {n === 0 ? (
        <p className="text-[13.5px] text-text-2">
          Every duty that matters is on time, and its dates are confirmed.
        </p>
      ) : (
        <ul className="space-y-2">
          {shown.map((r, i) => (
            <li
              key={`${r.code}-${r.dutyId ?? i}`}
              className={cn(
                'flex items-start justify-between gap-3 rounded-menu px-3.5 py-3',
                r.level === 'red' ? 'bg-danger-soft' : 'bg-warning-soft',
              )}
            >
              <div className="min-w-0 text-[13.5px]">
                <div
                  className={cn(
                    'font-semibold',
                    r.level === 'red' ? 'text-danger-text' : 'text-warning-text',
                  )}
                >
                  {r.words}
                </div>
                <div className="text-text-2">
                  {[
                    r.accountable ? `Owner: ${r.accountable.name}` : null,
                    r.next ? `Next: ${r.next}` : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </div>
              </div>
              {r.dutyId ? (
                <Button size="sm" variant="secondary" onClick={() => onOpen(r.dutyId!)}>
                  Open
                </Button>
              ) : r.keys?.length ? (
                <ButtonLink size="sm" href={dealHref(workspaceId, dealId, 'dates')}>
                  Dates
                </ButtonLink>
              ) : null}
            </li>
          ))}
          {n > shown.length || all ? (
            <li>
              <button
                type="button"
                className="text-[13px] text-accent-text hover:underline"
                onClick={() => setAll(!all)}
                data-testid="risks-more"
              >
                {all ? 'Show fewer' : `Show all ${n}`}
              </button>
            </li>
          ) : null}
        </ul>
      )}
    </Card>
  );
}

const byDue = (a: DealDuty, b: DealDuty) =>
  (a.dueAt ?? '9999').localeCompare(b.dueAt ?? '9999') || a.title.localeCompare(b.title);

function DutiesCard({
  duties,
  timeZone,
  onOpen,
  onAdd,
}: {
  duties: readonly DealDuty[];
  timeZone: string;
  onOpen: (dutyId: string) => void;
  onAdd?: () => void;
}) {
  const [tab, setTab] = useState<'open' | 'done' | 'all'>('open');
  const done = (x: DealDuty) => isDoneDuty(x.status as DutyStatus);
  const counts = {
    open: duties.filter((x) => !done(x)).length,
    done: duties.filter(done).length,
  };
  const groups = useMemo(() => {
    const shown = duties.filter((x) =>
      tab === 'open' ? !done(x) : tab === 'done' ? done(x) : true,
    );
    const by = new Map<string, DealDuty[]>();
    for (const x of [...shown].sort(byDue)) {
      const g = startedByWords(x.startedBy);
      by.set(g, [...(by.get(g) ?? []), x]);
    }
    return [...by];
  }, [duties, tab]);
  return (
    <Card className="p-0" data-testid="deal-duties">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 pt-3 md:px-5">
        <h2 className="pb-2.5 text-[15px] font-semibold">Duties</h2>
        <div className="flex items-center gap-1">
          {(['open', 'done', 'all'] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              aria-pressed={tab === t}
              className={cn(
                '-mb-px border-b-2 px-3 py-2 text-[13.5px]',
                tab === t
                  ? 'border-accent font-medium text-accent-text'
                  : 'border-transparent text-text-2',
              )}
              data-testid={`duties-tab-${t}`}
            >
              {t === 'open'
                ? `Open · ${counts.open}`
                : t === 'done'
                  ? `Done · ${counts.done}`
                  : 'All'}
            </button>
          ))}
          {onAdd ? (
            <Button size="sm" variant="ghost" onClick={onAdd} aria-label="Add a duty">
              <Plus className="h-4 w-4" strokeWidth={1.75} />
            </Button>
          ) : null}
        </div>
      </div>
      {groups.length === 0 ? (
        <p className="px-5 py-6 text-[13.5px] text-text-2">
          {tab === 'open' ? 'Nothing open. Every duty so far is finished.' : 'Nothing here yet.'}
        </p>
      ) : (
        groups.map(([group, list]) => (
          <section key={group}>
            <h3 className="border-b border-border px-4 pb-1.5 pt-3.5 text-xs font-semibold uppercase tracking-wide text-text-3 md:px-5">
              {group}
            </h3>
            <ul>
              {list.map((x) => (
                <li key={x.dutyId} className="border-b border-border last:border-b-0">
                  <button
                    type="button"
                    onClick={() => onOpen(x.dutyId)}
                    className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-card-2 md:px-5"
                    data-testid={`duty-row-${x.key}`}
                  >
                    <StatusIcon status={x.status as DutyStatus} overdue={x.overdue} />
                    <div className="min-w-0 flex-1">
                      <div className={cn('text-[14px]', done(x) && 'text-text-2')}>{x.title}</div>
                      <div className="truncate text-[12.5px] text-text-3">
                        {[
                          x.accountable?.name,
                          x.proofMissing
                            ? `Still needs ${x.proofMissing}`
                            : x.proof
                              ? `Proof: ${x.proof}`
                              : null,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </div>
                    </div>
                    <div className="flex flex-none flex-col items-end gap-1 text-[12.5px]">
                      {x.status === 'waiting_external' && x.waitingOn ? (
                        <Badge variant="pending">Waiting on {x.waitingOn}</Badge>
                      ) : x.status === 'blocked' ? (
                        <Badge variant="danger">Blocked{x.blocked ? ` · ${x.blocked}` : ''}</Badge>
                      ) : x.status === 'draft' ? (
                        <Badge variant="pending">Waiting for dates</Badge>
                      ) : !done(x) && !x.proofMissing && x.proof ? (
                        <Badge variant="ok">Proof added</Badge>
                      ) : done(x) || x.overdue ? (
                        <DutyStatusBadge status={x.status as DutyStatus} overdue={x.overdue} />
                      ) : null}
                      <span
                        className={cn(
                          'tabular-nums',
                          x.overdue ? 'text-danger-text' : 'text-text-2',
                        )}
                      >
                        {x.dueAt ? dueWords(x.dueAt, timeZone, { open: !done(x) }) : ''}
                      </span>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </Card>
  );
}

function StatusIcon({ status, overdue }: { status: DutyStatus; overdue: boolean }) {
  const cls = 'mt-0.5 h-[18px] w-[18px] flex-none';
  if (status === 'completed' || status === 'waived')
    return (
      <span
        className={cn(
          cls,
          'inline-flex items-center justify-center rounded-full bg-success text-on-solid',
        )}
      >
        <Check className="h-3 w-3" strokeWidth={2.5} />
      </span>
    );
  if (status === 'blocked') return <Ban className={cn(cls, 'text-danger')} strokeWidth={1.75} />;
  if (status === 'waiting_external' || status === 'draft')
    return <Clock className={cn(cls, 'text-warning')} strokeWidth={1.75} />;
  return (
    <Circle
      className={cn(cls, overdue ? 'text-danger' : 'text-border-strong')}
      strokeWidth={1.75}
    />
  );
}
