'use client';
import {
  DESK_BUSINESS_WORDS,
  DESK_QUICK_LOOK_TABS,
  DESK_QUICK_LOOK_WORDS,
  DESK_WALLET_WORDS,
  deskBusinessFlags,
  deskLastActive,
  deskMoreLines,
  deskPlanAndBalanceShort,
  deskPlanLabel,
  deskPlanLines,
  deskQuickLookCounts,
  deskSetupRows,
  deskSetupScore,
  deskWalletLines,
  type DeskQuickLookTab,
} from '@hfos/core';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { ChevronLeft, ChevronRight, Copy, ExternalLink, X } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import {
  ActivitySection,
  FLAG_ACTION_CLASS,
  FlagList,
  GlanceCounts,
  GlanceLines,
  GlanceSection,
  initials,
  MoreAboutThem,
  ProblemReportsSection,
  SetupDots,
  SetupRows,
  TheirMoneySection,
} from '@/components/admin/business-glance';
import { STATUS_WORD, whenWords } from '@/components/admin/ticket-bits';
import { ViewAsButton } from '@/components/admin/view-as';
import { Badge } from '@/components/ui/badge';
import { Button, buttonClassName } from '@/components/ui/button';
import { copyText } from '@/components/ui/copy-field';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { Ok } from '@/lib/api/types';

/** A business on the directory's page, as far as the quick look needs it before its details arrive. */
export interface QuickLookRow {
  readonly workspaceId: string;
  readonly name: string;
}

/** What this support person may do from the quick look. */
export interface QuickLookStaff {
  readonly canViewAs: boolean;
  readonly founder: boolean;
}

interface Look {
  readonly detail: Ok<'/v1/queries/platform.business.get'>;
  readonly wallet: Ok<'/v1/queries/platform.wallet.get'>;
  readonly glance: Ok<'/v1/queries/platform.business.glance'>;
}

async function load(workspaceId: string): Promise<Look> {
  const api = apiBrowser();
  const body = { workspaceId };
  const [detail, wallet, glance] = await Promise.all([
    api.POST('/v1/queries/platform.business.get', { body }).then(unwrap),
    api.POST('/v1/queries/platform.wallet.get', { body }).then(unwrap),
    api.POST('/v1/queries/platform.business.glance', { body }).then(unwrap),
  ]);
  return { detail, wallet, glance };
}

type Loaded = { readonly look: Look } | { readonly error: string };

/**
 * One business's details, kept once read so stepping back to it is instant, and the next one read ahead so stepping
 * forward is too. Closing the window keeps them: the directory is the same page.
 */
function useLook(workspaceId: string | null, ahead: string | null) {
  const asked = useRef(new Set<string>());
  const [settled, setSettled] = useState<ReadonlyMap<string, Loaded>>(new Map());

  const fetchOne = useCallback((id: string) => {
    if (asked.current.has(id)) return;
    asked.current.add(id);
    void load(id)
      .then(
        (look): Loaded => ({ look }),
        (e: unknown): Loaded => ({ error: errorMessage(e) }),
      )
      .then((r) => setSettled((m) => new Map(m).set(id, r)));
  }, []);

  const current = workspaceId ? settled.get(workspaceId) : undefined;
  useEffect(() => {
    if (workspaceId) fetchOne(workspaceId);
  }, [workspaceId, fetchOne]);
  useEffect(() => {
    if (ahead && current) fetchOne(ahead);
  }, [ahead, current, fetchOne]);

  const retry = () => {
    if (!workspaceId) return;
    asked.current.delete(workspaceId);
    setSettled((m) => {
      const next = new Map(m);
      next.delete(workspaceId);
      return next;
    });
    fetchOne(workspaceId);
  };
  return { loaded: current ?? null, retry };
}

/**
 * A business opened from the directory in a window instead of a page (/admin/businesses): what needs a look, the
 * numbers, its plan and balance, what is set up, its people and tickets. The arrows, or ← and →, step through the
 * businesses on the page; the full page is one click away for changing anything.
 */
export function BusinessQuickLook({
  rows,
  openId,
  onOpen,
  onClose,
  staff,
}: {
  rows: readonly QuickLookRow[];
  openId: string | null;
  onOpen: (workspaceId: string) => void;
  onClose: () => void;
  staff: QuickLookStaff;
}) {
  const [tab, setTab] = useState<DeskQuickLookTab>('overview');
  const index = rows.findIndex((r) => r.workspaceId === openId);
  const row = index >= 0 ? rows[index] : undefined;
  const step = (by: number) => {
    if (index < 0 || rows.length < 2) return;
    onOpen(rows[(index + by + rows.length) % rows.length]!.workspaceId);
  };
  const ahead = index >= 0 && rows.length > 1 ? rows[(index + 1) % rows.length]!.workspaceId : null;
  const { loaded, retry } = useLook(openId, ahead);

  // ← and → step through the page, except where they already mean something: typing, and the row of tabs.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const target = e.target as HTMLElement;
    if (target.closest('input, textarea, select, [contenteditable="true"], [role="tablist"]'))
      return;
    e.preventDefault();
    step(e.key === 'ArrowLeft' ? -1 : 1);
  };

  return (
    <DialogPrimitive.Root
      open={openId !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-[var(--scrim)] data-[state=open]:animate-in data-[state=open]:fade-in" />
        <DialogPrimitive.Content
          onKeyDown={onKeyDown}
          data-testid="business-quick-look"
          className="fixed inset-0 z-50 flex flex-col overflow-hidden bg-card focus:outline-none sm:inset-auto sm:left-1/2 sm:top-1/2 sm:h-[min(880px,calc(100dvh-48px))] sm:w-[min(920px,calc(100vw-48px))] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-dialog sm:border sm:border-border sm:shadow-3"
        >
          <Header
            name={row?.name ?? ''}
            look={loaded && 'look' in loaded ? loaded.look : null}
            position={index >= 0 ? DESK_QUICK_LOOK_WORDS.position(index + 1, rows.length) : ''}
            canStep={rows.length > 1}
            onStep={step}
            staff={staff}
            workspaceId={openId ?? ''}
          />
          <Tabs
            value={tab}
            onValueChange={(v) => setTab(v as DeskQuickLookTab)}
            className="flex min-h-0 flex-1 flex-col"
          >
            <TabsList className="flex-none px-3 sm:px-5">
              {DESK_QUICK_LOOK_TABS.map((t) => (
                <TabsTrigger key={t.key} value={t.key}>
                  {t.label}
                  <TabCount tab={t.key} look={loaded && 'look' in loaded ? loaded.look : null} />
                </TabsTrigger>
              ))}
            </TabsList>
            <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6 pt-5 sm:px-6">
              {!loaded ? (
                <p className="py-16 text-center text-[13px] text-text-3">
                  {DESK_QUICK_LOOK_WORDS.loading}
                </p>
              ) : 'error' in loaded ? (
                <div className="flex flex-col items-center gap-3 py-16 text-center text-[13px]">
                  <p className="text-text-2">{loaded.error || DESK_QUICK_LOOK_WORDS.failed}</p>
                  <Button variant="secondary" size="sm" onClick={retry}>
                    {DESK_QUICK_LOOK_WORDS.tryAgain}
                  </Button>
                </div>
              ) : (
                <>
                  <TabsContent value="overview">
                    <Overview look={loaded.look} onTab={setTab} />
                  </TabsContent>
                  <TabsContent value="people">
                    <People look={loaded.look} staff={staff} />
                  </TabsContent>
                  <TabsContent value="money">
                    <Money look={loaded.look} />
                  </TabsContent>
                  <TabsContent value="setup">
                    <SetUp look={loaded.look} />
                  </TabsContent>
                  <TabsContent value="tickets">
                    <Tickets look={loaded.look} />
                  </TabsContent>
                </>
              )}
            </div>
          </Tabs>
          <Footer workspaceId={openId ?? ''} />
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function Header({
  name,
  look,
  position,
  canStep,
  onStep,
  staff,
  workspaceId,
}: {
  name: string;
  look: Look | null;
  position: string;
  canStep: boolean;
  onStep: (by: number) => void;
  staff: QuickLookStaff;
  workspaceId: string;
}) {
  const b = look?.detail.business;
  return (
    <header className="relative flex flex-none flex-wrap items-start gap-x-4 gap-y-3 px-4 pb-3 pt-4 sm:px-6 sm:pt-5">
      <div
        aria-hidden
        className="hidden h-11 w-11 flex-none items-center justify-center rounded-menu bg-accent-soft text-base font-semibold text-accent-text sm:flex"
      >
        {initials(name)}
      </div>
      <div className="min-w-0 flex-1 basis-60 pr-10 sm:pr-0">
        <DialogPrimitive.Title className="truncate text-lg font-semibold tracking-tight sm:text-xl">
          {name}
        </DialogPrimitive.Title>
        <DialogPrimitive.Description className="mt-0.5 text-[13px] text-text-3">
          {b
            ? DESK_BUSINESS_WORDS.headline(b, new Date(b.createdAt).toLocaleDateString())
            : DESK_QUICK_LOOK_WORDS.loading}
        </DialogPrimitive.Description>
        {look ? (
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Badge variant={look.glance.plan ? 'ok' : 'gray'}>
              {deskPlanLabel(look.glance.plan)}
            </Badge>
            {b?.foundingSeat ? <Badge variant="ok">{b.foundingSeat}</Badge> : null}
          </div>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {canStep ? (
          <>
            <Button
              variant="secondary"
              size="icon"
              aria-label={DESK_QUICK_LOOK_WORDS.previous}
              onClick={() => onStep(-1)}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="min-w-12 text-center text-xs tabular-nums text-text-3">
              {position}
            </span>
            <Button
              variant="secondary"
              size="icon"
              aria-label={DESK_QUICK_LOOK_WORDS.next}
              onClick={() => onStep(1)}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
            <span aria-hidden className="mx-1 h-6 w-px bg-border" />
          </>
        ) : null}
        {staff.canViewAs && b ? (
          <ViewAsButton workspaceId={b.workspaceId} businessName={b.name} founder={staff.founder} />
        ) : null}
        <Link
          href={`/admin/businesses/${workspaceId}`}
          className={buttonClassName({ variant: 'secondary', size: 'sm' })}
        >
          {DESK_QUICK_LOOK_WORDS.fullPage}
          <ExternalLink className="h-3.5 w-3.5" />
        </Link>
        <DialogPrimitive.Close
          aria-label={DESK_QUICK_LOOK_WORDS.close}
          className="absolute right-3 top-3 rounded-control p-2 text-text-2 hover:bg-card-2 hover:text-text focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring sm:static sm:p-1.5"
        >
          <X className="h-[18px] w-[18px]" />
        </DialogPrimitive.Close>
      </div>
    </header>
  );
}

/** The number beside People and Tickets: how many people, and how many tickets are open. */
function TabCount({ tab, look }: { tab: DeskQuickLookTab; look: Look | null }) {
  if (!look) return null;
  const n =
    tab === 'people'
      ? look.detail.people.length
      : tab === 'tickets'
        ? look.detail.business.openTicketCount
        : 0;
  if (!n) return null;
  return (
    <span className="rounded-full bg-card-2 px-1.5 text-[11px] leading-[18px] text-text-2">
      {n}
    </span>
  );
}

function Overview({ look, onTab }: { look: Look; onTab: (tab: DeskQuickLookTab) => void }) {
  const { detail, wallet, glance } = look;
  const setup = deskSetupRows(glance.setup);
  const people = detail.people.slice(0, 3);
  return (
    <div className="flex flex-col gap-5">
      <FlagList
        flags={deskBusinessFlags({ ...detail.business, tickets: detail.tickets }, glance, wallet)}
        action={(tab, label) => (
          <button type="button" onClick={() => onTab(tab)} className={FLAG_ACTION_CLASS}>
            {label}
          </button>
        )}
      />

      <GlanceCounts items={deskQuickLookCounts(detail.counts, glance)} />

      <div className="grid items-start gap-4 md:grid-cols-2">
        <div className="flex flex-col gap-4">
          <ActivitySection glance={glance} heading="h3" />

          <GlanceSection
            heading="h3"
            title={DESK_BUSINESS_WORDS.theirPeople}
            aside={
              detail.people.length > people.length ? (
                <button
                  type="button"
                  onClick={() => onTab('people')}
                  className="font-medium text-accent-text hover:underline"
                >
                  {DESK_QUICK_LOOK_WORDS.seeAll(detail.people.length)}
                </button>
              ) : undefined
            }
          >
            <ul className="mt-3 flex flex-col gap-2 text-[13px]">
              {people.map((p) => (
                <li key={p.userId} className="flex items-center gap-2.5">
                  <span
                    aria-hidden
                    className="flex h-7 w-7 flex-none items-center justify-center rounded-full bg-card-2 text-[11px] font-semibold text-text-2"
                  >
                    {initials(p.fullName || p.email)}
                  </span>
                  <span className="min-w-0 flex-1 truncate">
                    {p.fullName || p.email}
                    <span className="text-text-3"> · {p.role}</span>
                  </span>
                  <span className="text-xs text-text-3">{deskLastActive(p.lastActiveAt)}</span>
                </li>
              ))}
            </ul>
          </GlanceSection>
        </div>

        <div className="flex flex-col gap-4">
          <GlanceSection heading="h3" title={DESK_QUICK_LOOK_WORDS.planAndBalance}>
            <GlanceLines lines={deskPlanAndBalanceShort(glance.plan, wallet)} />
          </GlanceSection>
          <GlanceSection
            heading="h3"
            title={DESK_BUSINESS_WORDS.whatIsSetUp}
            aside={deskSetupScore(setup)}
          >
            <SetupDots setup={setup} />
          </GlanceSection>
        </div>
      </div>

      <section>
        <h3 className="text-sm font-semibold">{DESK_QUICK_LOOK_WORDS.moreAboutThem}</h3>
        <MoreAboutThem lines={deskMoreLines(detail.business, glance, detail.phoneModel)} />
      </section>
    </div>
  );
}

function People({ look, staff }: { look: Look; staff: QuickLookStaff }) {
  const b = look.detail.business;
  return (
    <ul className="divide-y divide-border overflow-hidden rounded-card border border-border">
      {look.detail.people.map((p) => (
        <li
          key={p.userId}
          className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-[13px]"
        >
          <span
            aria-hidden
            className="flex h-8 w-8 flex-none items-center justify-center rounded-full bg-card-2 text-xs font-semibold text-text-2"
          >
            {initials(p.fullName || p.email)}
          </span>
          <span className="min-w-0 flex-1 basis-40">
            <span className="block truncate font-semibold">{p.fullName || p.email}</span>
            <span className="block truncate text-text-3">{p.email}</span>
          </span>
          <Badge variant={p.role === 'owner' ? 'owner' : 'gray'} className="capitalize">
            {p.role}
          </Badge>
          <span className="w-32 text-right text-text-3">
            {DESK_QUICK_LOOK_WORDS.active(p.lastActiveAt)}
          </span>
          {staff.canViewAs ? (
            <ViewAsButton
              workspaceId={b.workspaceId}
              businessName={b.name}
              founder={staff.founder}
              person={p}
            />
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function Money({ look }: { look: Look }) {
  const { wallet, glance, detail } = look;
  return (
    <div className="flex flex-col gap-4">
      <div className="grid items-start gap-4 md:grid-cols-2">
        <GlanceSection heading="h3" title={DESK_QUICK_LOOK_WORDS.whatTheyPayUs}>
          <p className="mt-1 text-xs text-text-3">{DESK_QUICK_LOOK_WORDS.whatTheyPayUsExplain}</p>
          <GlanceLines lines={deskPlanLines(glance.plan)} />
          {wallet.opened ? (
            <GlanceLines lines={deskWalletLines(wallet)} />
          ) : (
            <p className="mt-3 text-[13px] text-text-3">{DESK_WALLET_WORDS.notOpened}</p>
          )}
        </GlanceSection>
        <TheirMoneySection glance={glance} heading="h3" />
      </div>
      <p className="text-[13px] text-text-3">
        {DESK_QUICK_LOOK_WORDS.changeOnFullPage}{' '}
        <Link
          href={`/admin/businesses/${detail.business.workspaceId}`}
          className="font-medium text-accent-text hover:underline"
        >
          {DESK_QUICK_LOOK_WORDS.fullPage}
        </Link>
      </p>
    </div>
  );
}

function SetUp({ look }: { look: Look }) {
  return <SetupRows setup={deskSetupRows(look.glance.setup)} />;
}

function Tickets({ look }: { look: Look }) {
  const { tickets } = look.detail;
  return (
    <div className="flex flex-col gap-4">
      <GlanceSection heading="h3" title={DESK_BUSINESS_WORDS.theirTickets}>
        {tickets.length === 0 ? (
          <p className="mt-2 text-[13px] text-text-3">{DESK_BUSINESS_WORDS.neverWrittenIn}</p>
        ) : (
          <ul className="mt-3 flex flex-col gap-2 text-[13px]">
            {tickets.map((t) => (
              <li key={t.id}>
                <Link href={`/admin/tickets/${t.id}`} className="hover:text-accent-text">
                  #{t.number} {t.subject}
                  <span className="text-text-3">
                    {' '}
                    · {STATUS_WORD[t.status]} · {whenWords(t.createdAt)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </GlanceSection>
      <ProblemReportsSection glance={look.glance} heading="h3" />
    </div>
  );
}

function Footer({ workspaceId }: { workspaceId: string }) {
  return (
    <footer className="flex flex-none items-center gap-2.5 border-t border-border px-4 py-2.5 text-xs text-text-3 sm:px-6">
      <span className="hidden sm:inline">{DESK_QUICK_LOOK_WORDS.businessId}</span>
      <code className="min-w-0 truncate font-mono text-text-2">{workspaceId}</code>
      <button
        type="button"
        onClick={() => void copyText(workspaceId, DESK_QUICK_LOOK_WORDS.copied)}
        className="inline-flex h-7 flex-none items-center gap-1 rounded-control border border-border px-2 hover:bg-card-2"
      >
        <Copy className="h-3.5 w-3.5" />
        {DESK_QUICK_LOOK_WORDS.copy}
      </button>
      <span className="flex-1" />
      <span className="hidden md:inline">{DESK_QUICK_LOOK_WORDS.keys}</span>
    </footer>
  );
}
