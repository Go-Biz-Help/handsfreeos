'use client';
/**
 * Social Outreach's setup, in HandsFreeOS (docs/outreach.md, decisions 36, 45, 57 and 83; the canvas "Social Outreach
 * setup"): a page of its own over the app, in the main onboarding's frame. A welcome, then the main setup (the
 * business's part for owners and admins, the computer, then the person), then a short setup for each network they
 * turned on, Facebook first, each ending with a first day there.
 *
 * The rail beside the steps shows every step where it stands, worked out on the server from facts
 * (`outreach.setup`), and ticks as they change, in this tab or another, or on the person's computer. Each row is a
 * link. Skip for now goes on and leaves a step to do; leaving opens it again at the first step left.
 *
 * `SetupBanner` is the slim "Next: …" line at the top of the Set up page (decision 129), and `RailList` its list of
 * every step.
 */
import { PLATFORMS } from '@hfos/core/addons/outreach/networks';
import {
  bannerWords,
  doneOf,
  networksWorking,
  outreachSetupPath,
  SETUP_PART_OF,
  SETUP_PARTS,
  SETUP_WORDS,
  sameStop,
  stopKey,
  type SetupScreen,
  type SetupStop,
  type StepState,
} from '@hfos/core/addons/outreach/setup';
import {
  ArrowRight,
  Building2,
  Check,
  ChevronDown,
  Clock,
  Laptop,
  Play,
  RefreshCw,
  UserRound,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { ReactNode } from 'react';
import { SetupCard, SetupPage } from '@/components/onboarding-setup/frame';
import { Button, ButtonLink } from '@/components/ui/button';
import { useLiveRefresh } from '@/lib/realtime/live-provider';
import { cn } from '@/lib/utils';
import { outreachHref } from './address';
import { laidOut, saveSetup } from './setup-api';
import { MainStep } from './setup-steps';
import { NetworkStepView, SetupDone } from './setup-network';
import type { Asks, Automation, Live, Readiness, Setup } from './types';
import { useAct } from './use-act';

const W = SETUP_WORDS;

const PART_ICON = { business: Building2, computer: Laptop, you: UserRound } as const;

/** A row's mark: done, waiting, look again, or its number. */
function Dot({
  state,
  label,
  on,
  net,
}: {
  state: StepState;
  label: string;
  on: boolean;
  net?: boolean;
}) {
  const box = cn(
    'flex h-5 w-5 flex-none items-center justify-center rounded-full border-[1.5px] text-[11px] font-semibold',
    net && 'rounded-[6px] text-[10.5px]',
  );
  if (state === 'done')
    return (
      <span
        className={cn(box, 'border-success bg-success text-on-solid')}
        role="img"
        aria-label="Done"
      >
        <Check className="h-3 w-3" strokeWidth={3} aria-hidden="true" />
      </span>
    );
  if (state === 'waiting')
    return (
      <span
        className={cn(box, 'border-warning text-warning')}
        role="img"
        aria-label="Waiting on an owner"
      >
        <Clock className="h-3 w-3" strokeWidth={2.5} aria-hidden="true" />
      </span>
    );
  if (state === 'again')
    return (
      <span className={cn(box, 'border-warning text-warning')} role="img" aria-label="Look again">
        <RefreshCw className="h-3 w-3" strokeWidth={2.5} aria-hidden="true" />
      </span>
    );
  return (
    <span
      className={cn(
        box,
        on ? 'border-accent text-accent-text' : 'border-border-strong text-text-3',
      )}
      aria-hidden="true"
    >
      {label}
    </span>
  );
}

const rowClass = (on: boolean) =>
  cn(
    'flex items-center gap-2.5 rounded-control px-2.5 py-[7px] text-[13.5px] hover:bg-card-2 hover:text-text',
    on
      ? 'bg-accent-soft font-medium text-accent-text hover:bg-accent-soft hover:text-accent-text'
      : 'text-text-2',
  );

const Head = ({ children, first }: { children: ReactNode; first?: boolean }) => (
  <p
    className={cn(
      'px-2.5 text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3',
      first ? 'mb-1' : 'mb-1 mt-4',
    )}
  >
    {children}
  </p>
);

/** Every step where it stands: the main parts, then each network, the one being set up opened under its row. */
export function RailList({
  workspaceId,
  setup,
  at,
}: {
  workspaceId: string;
  setup: Setup;
  at: SetupScreen;
}) {
  const here = (s: SetupStop) => at !== 'welcome' && at !== 'done' && sameStop(at, s);
  let n = 0;
  return (
    <div data-testid="outreach-setup-rail">
      {SETUP_PARTS.map((part, pi) => {
        const steps = setup.states.filter((s) => SETUP_PART_OF[s.step] === part);
        const theirs = part === 'business' && !setup.canManage;
        if (!steps.length && !theirs) return null;
        return (
          <div key={part}>
            <Head first={pi === 0}>{W.parts[part].name}</Head>
            <ol className="flex flex-col gap-0.5">
              {theirs
                ? setup.business.map((b) => (
                    <li
                      key={b.item}
                      className={rowClass(false)}
                      data-testid={`outreach-setup-rail-business-${b.item}`}
                      data-state={b.state}
                    >
                      <Dot state={b.state} label="" on={false} />
                      <span className="min-w-0 flex-1">{W.main[b.item].name}</span>
                    </li>
                  ))
                : steps.map((s) => {
                    n += 1;
                    const stop = { net: null, step: s.step } as const;
                    return (
                      <li key={s.step}>
                        <Link
                          href={outreachSetupPath(workspaceId, { step: stop })}
                          className={rowClass(here(stop))}
                          aria-current={here(stop) ? 'step' : undefined}
                          data-testid={`outreach-setup-rail-${s.step}`}
                          data-state={s.state}
                        >
                          <Dot state={s.state} label={String(n)} on={here(stop)} />
                          <span className="min-w-0 flex-1">{W.main[s.step].name}</span>
                          {s.optional ? (
                            <span className="text-[12px] text-text-3">{W.optional}</span>
                          ) : null}
                        </Link>
                      </li>
                    );
                  })}
            </ol>
            {theirs && setup.business.length ? (
              <p className="px-2.5 pt-1 text-[12.5px] text-text-3">{W.ownersDo}</p>
            ) : null}
          </div>
        );
      })}
      <Head>{W.networksHead}</Head>
      <ol className="flex flex-col gap-0.5">
        {setup.networks.map((net) => {
          const name = PLATFORMS[net.platform];
          const open = at !== 'welcome' && at !== 'done' && at.net === net.platform;
          const { done, of } = doneOf(net.steps);
          const first = net.steps.find((s) => s.state !== 'done') ?? net.steps[0]!;
          return (
            <li key={net.platform}>
              <Link
                href={outreachSetupPath(workspaceId, {
                  step: { net: net.platform, step: first.step },
                })}
                className={cn(rowClass(false), open && 'font-semibold text-text')}
                data-testid={`outreach-setup-rail-${net.platform}`}
                data-state={done === of ? 'done' : 'todo'}
              >
                <Dot state={done === of ? 'done' : 'todo'} label={name[0]!} on={false} net />
                <span className="min-w-0 flex-1">{name}</span>
                {!open ? (
                  <span className="text-[12px] text-text-3">
                    {done === of ? W.working : done ? `${done} of ${of}` : W.steps(of)}
                  </span>
                ) : null}
              </Link>
              {open ? (
                <ol className="mb-1.5 ml-[19px] mt-0.5 flex flex-col gap-0.5 border-l border-border pl-2">
                  {net.steps.map((s, i) => {
                    const stop = { net: net.platform, step: s.step } as const;
                    return (
                      <li key={s.step}>
                        <Link
                          href={outreachSetupPath(workspaceId, { step: stop })}
                          className={rowClass(here(stop))}
                          aria-current={here(stop) ? 'step' : undefined}
                          data-testid={`outreach-setup-rail-${net.platform}-${s.step}`}
                          data-state={s.state}
                        >
                          <Dot state={s.state} label={String(i + 1)} on={here(stop)} />
                          <span className="min-w-0 flex-1">{W.network[s.step].name}</span>
                        </Link>
                      </li>
                    );
                  })}
                </ol>
              ) : null}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** How far along: the main setup's, or the network's being set up. */
function progressOf(setup: Setup, at: SetupScreen) {
  if (at !== 'welcome' && at !== 'done' && at.net) {
    const net = setup.networks.find((n) => n.platform === at.net);
    const { done, of } = doneOf(net?.steps ?? []);
    return { done, of, words: W.progressOn(PLATFORMS[at.net], done, of) };
  }
  const { done, of } = doneOf(setup.states);
  return { done, of, words: W.progress(done, of) };
}

function Progress({ setup, at }: { setup: Setup; at: SetupScreen }) {
  const { done, of, words } = progressOf(setup, at);
  return (
    <div className="mx-2.5 mt-[18px] flex flex-col gap-1.5 text-[12.5px] text-text-2">
      <span>{words}</span>
      <div
        className="h-1.5 overflow-hidden rounded-full bg-card-3"
        role="progressbar"
        aria-label={words}
        aria-valuemin={0}
        aria-valuemax={of}
        aria-valuenow={done}
      >
        <div
          className="h-full rounded-full bg-accent"
          style={{ width: `${of ? (done / of) * 100 : 0}%` }}
        />
      </div>
    </div>
  );
}

/** The rail: beside the card on a computer, folded above it on a phone. */
function Rail({ workspaceId, setup, at }: { workspaceId: string; setup: Setup; at: SetupScreen }) {
  const { words } = progressOf(setup, at);
  return (
    <>
      <nav
        aria-label="Setup steps"
        className="hidden w-[248px] flex-none md:block"
        data-testid="outreach-setup-steps"
      >
        <RailList workspaceId={workspaceId} setup={setup} at={at} />
        <Progress setup={setup} at={at} />
      </nav>
      <details className="group w-full rounded-menu border border-border bg-card md:hidden">
        <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 px-3.5 text-[13.5px] [&::-webkit-details-marker]:hidden">
          <span>
            <span className="font-semibold">Steps</span> · {words}
          </span>
          <ChevronDown
            className="h-4 w-4 transition-transform duration-150 group-open:rotate-180"
            strokeWidth={1.75}
            aria-hidden="true"
          />
        </summary>
        <nav aria-label="Setup steps" className="border-t border-border p-2">
          <RailList workspaceId={workspaceId} setup={setup} at={at} />
        </nav>
      </details>
    </>
  );
}

/** The welcome: what's ahead, by part, then a short setup for each network. */
function Welcome({ setup }: { setup: Setup }) {
  const parts = SETUP_PARTS.filter((p) => setup.states.some((s) => SETUP_PART_OF[s.step] === p));
  return (
    <div className="flex flex-col gap-4" data-testid="outreach-setup-welcome">
      {!setup.canManage && setup.business.some((b) => b.state !== 'done') ? (
        <p
          className="flex items-start gap-2.5 rounded-menu bg-warning-soft px-3.5 py-2.5 text-[13.5px] text-warning-text"
          data-testid="outreach-setup-waiting-business"
        >
          <Clock className="mt-0.5 h-4 w-4 flex-none" strokeWidth={1.75} aria-hidden="true" />
          {setup.business.find((b) => b.state !== 'done')?.item === 'offer'
            ? W.left.offerWaiting
            : W.left.playbookWaiting}{' '}
          You can do your part meanwhile.
        </p>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-[repeat(auto-fit,minmax(200px,1fr))]">
        {parts.map((part, i) => {
          const Icon = PART_ICON[part];
          const n = setup.states.filter((s) => SETUP_PART_OF[s.step] === part).length;
          return (
            <section
              key={part}
              className="flex flex-col gap-2.5 rounded-card border border-border bg-card p-4 shadow-1"
            >
              <div className="flex items-center gap-2.5">
                <span className="flex h-8 w-8 items-center justify-center rounded-[8px] bg-accent-soft text-accent-text">
                  <Icon className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
                </span>
                <h2 className="text-[15px] font-semibold">
                  {setup.canManage ? `${i + 1} · ` : ''}
                  {W.parts[part].name}
                </h2>
              </div>
              <p className="text-[13.5px] text-text-2">{W.parts[part].about}</p>
              <p className="mt-auto text-[12.5px] text-text-3">
                {W.steps(n)}
                {part === 'business' ? ` · ${W.welcome.owners}` : ''}
              </p>
            </section>
          );
        })}
      </div>
      <div className="flex items-center gap-3 rounded-card border border-dashed border-border-strong bg-card px-4 py-3.5">
        <span className="flex h-8 w-8 flex-none items-center justify-center rounded-full bg-success-soft text-success-text">
          <Play className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <p className="font-semibold">{W.welcome.then}</p>
          <p className="text-[13px] text-text-2">{W.welcome.thenAbout}</p>
        </div>
      </div>
      <p className="rounded-menu bg-card-2 px-3.5 py-2.5 text-[13.5px] text-text-2">
        {setup.canManage ? W.welcome.time : W.welcome.timeMember}
      </p>
    </div>
  );
}

export function SetupView({
  workspaceId,
  businessName,
  email,
  firstName,
  at,
  fromExtension,
  resumed = false,
  setup,
  me,
  business,
  asks,
  readiness,
  live,
}: {
  workspaceId: string;
  businessName: string;
  /** Who's signed in: the extension signs in with the same. */
  email: string;
  /** Their first name, for a member's welcome. */
  firstName: string | null;
  at: SetupScreen;
  /** Opened by the extension at its first sign-in. */
  fromExtension: boolean;
  /** Opened where they'd left off: "Carry on where you left off". */
  resumed?: boolean;
  setup: Setup;
  /** The person's own settings, the business's defaults until they save theirs. */
  me: Automation;
  /** The business's Social Outreach settings, for owners and admins. */
  business: Readonly<Record<string, unknown>> | null;
  /** Asked of the person's computer: a profile's read and its bio; null on the other steps. */
  asks: Asks | null;
  /** Get ready's items on the step's network: null where the step doesn't read them. */
  readiness: Readiness | null;
  /** The network's live view, for its Start and the end; null on the other steps. */
  live: Live | null;
}) {
  const router = useRouter();
  // A step done in another tab, on the computer or the phone, the settings or the business's rules changed: it ticks.
  useLiveRefresh([
    'outreach_setup',
    'outreach_automation',
    'outreach_playbook',
    'outreach_ask',
    'outreach_computer',
    'outreach_day',
    'main_offer',
    'addon',
    'workspace',
  ]);
  const { busy, act } = useAct();
  const go = (to: SetupScreen) => router.push(outreachSetupPath(workspaceId, { step: to }));
  const later = async () => {
    // Leaving for later counts as starting, so they aren't sent here again.
    const ok = setup.startedAt
      ? true
      : await act('later', () => saveSetup(workspaceId, { started: true }));
    if (ok) router.push(outreachHref(workspaceId));
  };
  const laterButton = (
    <Button
      variant="ghost"
      onClick={() => void later()}
      loading={busy === 'later'}
      disabled={busy !== null && busy !== 'later'}
      data-testid="outreach-setup-later"
    >
      {W.later}
    </Button>
  );
  const network = at !== 'welcome' && at !== 'done' && at.net ? at.net : null;
  const settingUp = network
    ? W.settingUpOn(PLATFORMS[network], businessName)
    : W.settingUp(businessName);

  let counter: string = W.title;
  let title: string;
  let hint: string;
  let body: ReactNode;
  let footer: ReactNode = null;
  if (at === 'welcome') {
    title = setup.canManage
      ? W.welcome.title
      : firstName
        ? W.welcome.memberTitle(firstName)
        : W.welcome.title;
    hint = setup.canManage ? W.welcome.hint : W.welcome.memberHint;
    body = <Welcome setup={setup} />;
    footer = (
      <div className="mt-auto flex justify-end border-t border-border pt-4">
        <Button
          size="lg"
          onClick={() =>
            void act('start', () => saveSetup(workspaceId, { started: true })).then(
              (ok) => ok && go(setup.next ?? 'done'),
            )
          }
          loading={busy === 'start'}
          disabled={busy !== null && busy !== 'start'}
          data-testid="outreach-setup-start"
        >
          {W.welcome.start}
          <ArrowRight className="h-4 w-4" strokeWidth={1.75} />
        </Button>
      </div>
    );
  } else if (at === 'done') {
    title = W.done.title;
    hint = W.done.hint;
    body = <SetupDone workspaceId={workspaceId} live={live} />;
  } else if (at.net === null) {
    const part = SETUP_PART_OF[at.step];
    const inPart = setup.states.filter((s) => SETUP_PART_OF[s.step] === part);
    counter = W.counter(
      W.parts[part].name,
      inPart.findIndex((s) => s.step === at.step) + 1,
      inPart.length,
    );
    title = W.main[at.step].title;
    hint = W.main[at.step].hint;
    body = (
      <MainStep
        workspaceId={workspaceId}
        businessName={businessName}
        email={email}
        at={at}
        setup={setup}
        me={me}
        business={business}
        readiness={readiness}
      />
    );
  } else {
    const net = setup.networks.find((n) => n.platform === at.net);
    const name = PLATFORMS[at.net];
    const i = net?.steps.findIndex((s) => s.step === at.step) ?? 0;
    counter = W.counter(name, i + 1, net?.steps.length ?? 1);
    const words = W.network[at.step];
    title = words.title(name);
    hint = typeof words.hint === 'function' ? words.hint(name) : words.hint;
    body = (
      <NetworkStepView
        workspaceId={workspaceId}
        at={at}
        setup={setup}
        me={me}
        asks={asks}
        readiness={readiness}
        live={live}
      />
    );
  }

  const banner =
    fromExtension &&
    (at === 'welcome' || (setup.next && at !== 'done' && sameStop(at, setup.next))) ? (
      <div
        className="flex items-start gap-2.5 rounded-menu bg-success-soft px-3.5 py-2.5 text-[13.5px] text-success-text"
        data-testid="outreach-setup-from-extension"
      >
        <Check className="mt-0.5 h-4 w-4 flex-none" strokeWidth={2} />
        <span className="min-w-0 flex-1">{W.fromExtension}</span>
      </div>
    ) : resumed && at !== 'welcome' && at !== 'done' ? (
      <div
        className="flex flex-wrap items-center justify-between gap-2 rounded-menu bg-accent-soft px-3.5 py-2.5 text-[13.5px] text-accent-text"
        data-testid="outreach-setup-resumed"
      >
        <span className="min-w-0 flex-1">{W.resumed}</span>
        <Link
          className="font-medium underline"
          href={outreachSetupPath(workspaceId, { step: 'welcome' })}
          data-testid="outreach-setup-start-over"
        >
          {W.startOver}
        </Link>
      </div>
    ) : undefined;

  // A page of its own over the app, as the main app's onboarding is: no sidebar, Finish later at the top.
  return (
    <div className="fixed inset-0 z-40 overflow-y-auto bg-bg" data-testid="outreach-setup-page">
      <SetupPage
        business={{ name: businessName, home: outreachHref(workspaceId) }}
        email={email}
        settingUp={settingUp}
        finishLater={at === 'done' ? <span /> : laterButton}
      >
        <div className="flex w-full flex-col items-start gap-4 md:flex-row md:gap-8">
          {at !== 'welcome' ? <Rail workspaceId={workspaceId} setup={setup} at={at} /> : null}
          <SetupCard
            testId="outreach-setup"
            screen={stopKey(at)}
            counter={counter}
            title={title}
            hint={hint}
            banner={banner}
            summary={null}
            footer={footer}
          >
            {body}
          </SetupCard>
        </div>
      </SetupPage>
    </div>
  );
}

/**
 * The slim line at the top of the Set up page (decision 129) while a step is left: "Next: set up LinkedIn · 1 of 5
 * done. Facebook is working." with Carry on, and Hide, which takes Set up out of the side menu too.
 */
export function SetupBanner({
  workspaceId,
  setup,
  onHidden,
}: {
  workspaceId: string;
  setup: Setup;
  /** Hidden: the setup as it's kept now. */
  onHidden: (setup: Setup) => void;
}) {
  const { busy, act } = useAct();
  if (!setup.next) return null;
  const laid = laidOut(setup);
  const next = setup.next;
  const working = networksWorking(laid).map((p) => PLATFORMS[p]);
  const { done, of } = next.net
    ? doneOf(setup.networks.find((n) => n.platform === next.net)?.steps ?? [])
    : doneOf(setup.states);
  return (
    <div
      className="mb-4 flex flex-wrap items-center gap-3 rounded-menu bg-accent-soft px-3.5 py-2.5 text-[13.5px] text-accent-text"
      data-testid="outreach-setup-banner"
    >
      <div className="flex min-w-0 flex-[1_1_280px] flex-col gap-1.5">
        <span>
          {bannerWords(laid, next)}
          {working.length ? ` ${W.bannerWorking(working)}` : ''}
        </span>
        <div
          className="h-1 max-w-[260px] overflow-hidden rounded-full bg-[color-mix(in_oklab,var(--accent)_18%,transparent)]"
          role="progressbar"
          aria-label={W.progress(done, of)}
          aria-valuemin={0}
          aria-valuemax={of}
          aria-valuenow={done}
        >
          <div
            className="h-full rounded-full bg-accent"
            style={{ width: `${of ? (done / of) * 100 : 0}%` }}
          />
        </div>
      </div>
      <ButtonLink
        size="sm"
        variant="primary"
        href={outreachSetupPath(workspaceId, { step: next })}
        data-testid="outreach-setup-carry-on"
      >
        {W.carryOn}
      </ButtonLink>
      {/* Hidden already: Set up has left the menu, and the line stays here. */}
      {setup.banner ? (
        <Button
          size="sm"
          variant="ghost"
          loading={busy === 'hide'}
          onClick={() =>
            void act('hide', async () =>
              onHidden(await saveSetup(workspaceId, { hideBanner: true })),
            )
          }
          data-testid="outreach-setup-hide"
        >
          {W.hide}
        </Button>
      ) : null}
    </div>
  );
}
