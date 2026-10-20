'use client';
import {
  DESK_BUSINESS_WORDS,
  DESK_FLAG_ACTIONS,
  DESK_QUICK_LOOK_TABS,
  DESK_QUICK_LOOK_WORDS,
  DESK_SETUP_STATE_WORDS,
  DESK_WALLET_WORDS,
  deskActiveAgo,
  deskActivityBars,
  deskBusinessFlags,
  deskLastActive,
  deskMoreLines,
  deskPlanAndBalanceShort,
  deskPlanLabel,
  deskPlanLines,
  deskProblemReportLine,
  deskQuickLookCounts,
  deskSetupRows,
  deskSetupScore,
  deskTheirMoneyLines,
  deskTrafficLines,
  deskWalletLines,
  type DeskFlagTone,
  type DeskQuickLookTab,
  type DeskSetupState,
} from '@hfos/core';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { Check, ChevronLeft, ChevronRight, Copy, ExternalLink, X } from 'lucide-react';
import Link from 'next/link';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { STATUS_WORD, whenWords } from '@/components/admin/ticket-bits';
import { ViewAsButton } from '@/components/admin/view-as';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
import { Button, buttonClassName } from '@/components/ui/button';
import { copyText } from '@/components/ui/copy-field';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { Ok } from '@/lib/api/types';
import { cn } from '@/lib/utils';

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

const TONE: Readonly<Record<DeskFlagTone, { box: string; dot: string }>> = {
  danger: { box: 'bg-danger-soft text-danger-text', dot: 'bg-danger' },
  warning: { box: 'bg-warning-soft text-warning-text', dot: 'bg-warning' },
  accent: { box: 'bg-accent-soft text-accent-text', dot: 'bg-accent' },
};

const SETUP_BADGE: Readonly<Record<DeskSetupState, BadgeVariant>> = {
  yes: 'ok',
  no: 'gray',
  waiting: 'pending',
  problem: 'danger',
};

const SETUP_DOT: Readonly<Record<DeskSetupState, string>> = {
  yes: 'bg-success',
  no: 'border-[1.5px] border-text-3',
  waiting: 'bg-warning',
  problem: 'bg-danger',
};

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter((w) => /^[\p{L}\p{N}]/u.test(w))
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');

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

function Section({
  title,
  aside,
  children,
  className,
}: {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('rounded-card border border-border p-4', className)}>
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold">{title}</h3>
        {aside ? <span className="text-xs text-text-3">{aside}</span> : null}
      </div>
      {children}
    </section>
  );
}

function Lines({
  lines,
}: {
  lines: readonly { label: string; value: string; tone?: 'danger' | null }[];
}) {
  return (
    <dl className="mt-3 flex flex-col gap-2 text-[13px]">
      {lines.map((l) => (
        <div key={l.label} className="flex justify-between gap-3">
          <dt className="text-text-3">{l.label}</dt>
          <dd className={cn('text-right', l.tone === 'danger' && 'font-semibold text-danger-text')}>
            {l.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function Overview({ look, onTab }: { look: Look; onTab: (tab: DeskQuickLookTab) => void }) {
  const { detail, wallet, glance } = look;
  const flags = deskBusinessFlags({ ...detail.business, tickets: detail.tickets }, glance, wallet);
  const setup = deskSetupRows(glance.setup);
  const total = glance.activity.reduce((a, n) => a + n, 0);
  const bars = deskActivityBars(glance.activity);
  const people = detail.people.slice(0, 3);
  return (
    <div className="flex flex-col gap-5">
      {flags.length ? (
        <ul aria-label={DESK_BUSINESS_WORDS.needsALook} className="flex flex-col gap-1.5">
          {flags.map((f) => (
            <li
              key={f.key}
              className={cn(
                'flex items-center gap-3 rounded-menu py-1.5 pl-3 pr-1.5 text-[13px]',
                TONE[f.tone].box,
              )}
            >
              <span
                aria-hidden
                className={cn('h-2 w-2 flex-none rounded-full', TONE[f.tone].dot)}
              />
              <span className="min-w-0 flex-1 py-1">{f.text}</span>
              {f.tab ? (
                <button
                  type="button"
                  onClick={() => onTab(f.tab!)}
                  className="h-8 flex-none rounded-control bg-card/60 px-2.5 text-xs font-semibold hover:bg-card"
                >
                  {DESK_FLAG_ACTIONS[f.tab]}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="flex items-center gap-2.5 rounded-menu bg-success-soft px-3 py-2.5 text-[13px] text-success-text">
          <Check className="h-4 w-4" />
          {DESK_QUICK_LOOK_WORDS.nothingNeedsALook}
        </p>
      )}

      <dl className="grid grid-cols-3 gap-2.5 sm:grid-cols-6">
        {deskQuickLookCounts(detail.counts, glance).map((c) => (
          <div key={c.label} className="rounded-card border border-border px-3 py-2.5">
            <dt className="text-xs leading-tight text-text-3">{c.label}</dt>
            <dd className="mt-0.5 text-lg font-semibold tabular-nums">{c.value}</dd>
          </div>
        ))}
      </dl>

      <div className="grid items-start gap-4 md:grid-cols-2">
        <div className="flex flex-col gap-4">
          <Section
            title={DESK_QUICK_LOOK_WORDS.lastThirtyDays}
            aside={DESK_QUICK_LOOK_WORDS.activityTotal(total)}
          >
            <div
              role="img"
              aria-label={DESK_QUICK_LOOK_WORDS.activityChart(total)}
              className="mt-3 flex h-14 items-end gap-[3px]"
            >
              {bars.map((share, i) => (
                <span
                  key={i}
                  className={cn(
                    'flex-1 rounded-[2px]',
                    share === 0
                      ? 'bg-card-3'
                      : i === bars.length - 1
                        ? 'bg-accent'
                        : 'bg-accent-soft-2',
                  )}
                  style={{ height: `${Math.max(4, Math.round(share * 100))}%` }}
                />
              ))}
            </div>
            <div className="mt-1.5 flex justify-between text-[11px] text-text-3">
              <span>{DESK_QUICK_LOOK_WORDS.thirtyDaysAgo}</span>
              <span>{DESK_QUICK_LOOK_WORDS.today}</span>
            </div>
            <dl className="mt-3 grid grid-cols-4 gap-2">
              {deskTrafficLines(glance.traffic).map((t) => (
                <div key={t.label}>
                  <dt className="text-xs text-text-3">{t.label}</dt>
                  <dd className="text-[15px] font-semibold tabular-nums">{t.value}</dd>
                </div>
              ))}
            </dl>
          </Section>

          <Section
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
          </Section>
        </div>

        <div className="flex flex-col gap-4">
          <Section title={DESK_QUICK_LOOK_WORDS.planAndBalance}>
            <Lines lines={deskPlanAndBalanceShort(glance.plan, wallet)} />
          </Section>
          <Section title={DESK_BUSINESS_WORDS.whatIsSetUp} aside={deskSetupScore(setup)}>
            <ul className="mt-3 flex flex-col gap-2 text-[13px]">
              {setup.map((s) => (
                <li key={s.key} className="flex items-center gap-2">
                  <span
                    aria-hidden
                    className={cn('h-2 w-2 flex-none rounded-full', SETUP_DOT[s.state])}
                  />
                  <span className="flex-none">{s.label}</span>
                  <span
                    className={cn(
                      'min-w-0 flex-1 truncate text-right',
                      s.state === 'problem' ? 'text-danger-text' : 'text-text-3',
                    )}
                  >
                    {s.detail}
                  </span>
                </li>
              ))}
            </ul>
          </Section>
        </div>
      </div>

      <section>
        <h3 className="text-sm font-semibold">{DESK_QUICK_LOOK_WORDS.moreAboutThem}</h3>
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
          {deskMoreLines(detail.business, glance, detail.phoneModel).map((m) => (
            <div key={m.label}>
              <dt className="text-xs text-text-3">{m.label}</dt>
              <dd className="mt-0.5 text-[13px]">{m.value}</dd>
            </div>
          ))}
        </dl>
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
        <Section title={DESK_QUICK_LOOK_WORDS.whatTheyPayUs}>
          <p className="mt-1 text-xs text-text-3">{DESK_QUICK_LOOK_WORDS.whatTheyPayUsExplain}</p>
          <Lines lines={deskPlanLines(glance.plan)} />
          {wallet.opened ? (
            <Lines lines={deskWalletLines(wallet)} />
          ) : (
            <p className="mt-3 text-[13px] text-text-3">{DESK_WALLET_WORDS.notOpened}</p>
          )}
        </Section>
        <Section title={DESK_QUICK_LOOK_WORDS.whatCustomersPayThem}>
          <p className="mt-1 text-xs text-text-3">
            {DESK_QUICK_LOOK_WORDS.whatCustomersPayThemExplain}
          </p>
          <Lines lines={deskTheirMoneyLines(glance)} />
        </Section>
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
  return (
    <ul className="divide-y divide-border overflow-hidden rounded-card border border-border">
      {deskSetupRows(look.glance.setup).map((s) => (
        <li
          key={s.key}
          className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-[13px]"
        >
          <span className="w-48 flex-none font-semibold">{s.label}</span>
          <span className="min-w-0 flex-1 basis-40 text-text-2">{s.detail}</span>
          <Badge variant={SETUP_BADGE[s.state]}>{DESK_SETUP_STATE_WORDS[s.state]}</Badge>
        </li>
      ))}
    </ul>
  );
}

function Tickets({ look }: { look: Look }) {
  const { tickets } = look.detail;
  const reports = look.glance.problemReports.recent;
  return (
    <div className="flex flex-col gap-4">
      <Section title={DESK_BUSINESS_WORDS.theirTickets}>
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
      </Section>
      <Section title={DESK_QUICK_LOOK_WORDS.problemReports}>
        {reports.length === 0 ? (
          <p className="mt-2 text-[13px] text-text-3">{DESK_QUICK_LOOK_WORDS.noProblemReports}</p>
        ) : (
          <ul className="mt-3 flex flex-col gap-2 text-[13px]">
            {reports.map((r) => (
              <li key={r.id} className="flex flex-wrap items-baseline gap-x-2">
                <Link
                  href={`/admin/problems/${r.id}`}
                  className="min-w-0 flex-1 hover:text-accent-text"
                >
                  {deskProblemReportLine(r)}
                </Link>
                <span className="text-xs text-text-3">{deskActiveAgo(r.createdAt)}</span>
                <Badge variant={r.handled ? 'ok' : 'pending'}>
                  {r.handled ? DESK_QUICK_LOOK_WORDS.handled : DESK_QUICK_LOOK_WORDS.notHandled}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </Section>
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
