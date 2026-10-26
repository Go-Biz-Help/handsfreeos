'use client';
/**
 * The main setup's steps (docs/outreach.md, decisions 83 and 88; the canvas "Social Outreach setup"): the business's
 * part (the main offer, a playbook, a short video if it wants one, the team's rules), the computer (the extension), and
 * the person (their messages, the networks they use, then their goal across those networks). Each says where it stands
 * from the server's facts, and its own button does the step: built elsewhere (the main offer, a playbook), it opens
 * there and comes back here.
 *
 * The step's footer (`StepFooter`): Back, Skip for now while it's left to do, and Next once it's done. Moving on reads
 * the setup afresh, so the next step not done opens.
 */
import {
  BusinessRules,
  businessLimitsOn,
  SENDING_MODES,
} from '@hfos/core/addons/outreach/automation';
import { settingsToSave } from '@hfos/core/addons/outreach/chat-read';
import { DAILY_STEPS } from '@hfos/core/addons/outreach/limits';
import { dailyWordsOn, withNetwork } from '@hfos/core/addons/outreach/network-words';
import {
  networkLimitsNow,
  PLATFORMS,
  WORKING_PLATFORMS,
  type Platform,
} from '@hfos/core/addons/outreach/networks';
import { PLAYBOOK_TEMPLATE_KEYS, PLAYBOOK_TEMPLATES } from '@hfos/core/addons/outreach/playbooks';
import {
  outreachSetupPath,
  SETUP_WORDS,
  stopAfter,
  stopBefore,
  whenWords,
  type SetupScreen,
  type SetupStop,
} from '@hfos/core/addons/outreach/setup';
import { ArrowLeft, ArrowRight, Check, Clock } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button, ButtonLink } from '@/components/ui/button';
import { CopyField } from '@/components/ui/copy-field';
import { Switch } from '@/components/ui/switch';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { cn } from '@/lib/utils';
import { ExtensionDownload, StuckFold } from './extension-download';
import { MessagesBody, NumbersBody } from './get-ready';
import { RulesForm } from './settings-view';
import { getSetup, isDesktopChrome, laidOut } from './setup-api';
import type { Automation, Readiness, Setup } from './types';
import { useAct } from './use-act';

const W = SETUP_WORDS;

/** Moving through the setup: to a step, on to the next not done (read afresh), or back. */
export function useStepNav(workspaceId: string, at: SetupStop, setup: Setup) {
  const router = useRouter();
  const { busy, act } = useAct();
  const go = (to: SetupScreen) => router.push(outreachSetupPath(workspaceId, { step: to }));
  const carryOn = async () => go(stopAfter(at, laidOut(await getSetup(workspaceId))));
  const skip = () => go(stopAfter(at, laidOut(setup)));
  const back = () => go(stopBefore(at, laidOut(setup)));
  return { busy, act, go, carryOn, skip, back };
}

export type StepNav = ReturnType<typeof useStepNav>;

/** Where a step stands, as its row says. */
export const stateOf = (setup: Setup, at: SetupStop) =>
  at.net === null
    ? setup.states.find((s) => s.step === at.step)
    : setup.networks.find((n) => n.platform === at.net)?.steps.find((s) => s.step === at.step);

/** Back, Skip for now while it's left, and Next once done; or the step's own button in Next's place. */
export function StepFooter({
  nav,
  done,
  optional = false,
  children,
}: {
  nav: StepNav;
  done: boolean;
  /** The video: Next goes on whether or not it's done. */
  optional?: boolean;
  /** The step's own button, in Next's place. */
  children?: ReactNode;
}) {
  return (
    <div className="mt-auto flex flex-wrap-reverse items-center justify-between gap-3 border-t border-border pt-4">
      <Button
        variant="ghost"
        onClick={nav.back}
        disabled={nav.busy !== null}
        data-testid="outreach-setup-back"
      >
        <ArrowLeft className="h-4 w-4" strokeWidth={1.75} />
        {W.back}
      </Button>
      <div className="flex flex-wrap items-center gap-2">
        {!done && !optional ? (
          <Button
            variant="ghost"
            size="lg"
            onClick={nav.skip}
            disabled={nav.busy !== null}
            data-testid="outreach-setup-skip"
          >
            {W.skip}
          </Button>
        ) : null}
        {children ??
          (done || optional ? (
            <Button
              size="lg"
              onClick={() => void nav.carryOn()}
              disabled={nav.busy !== null}
              data-testid="outreach-setup-next"
            >
              {W.next}
              <ArrowRight className="h-4 w-4" strokeWidth={1.75} />
            </Button>
          ) : null)}
      </div>
    </div>
  );
}

export function Note({
  children,
  tone = 'plain',
  testId,
}: {
  children: ReactNode;
  tone?: 'plain' | 'good' | 'wait' | 'accent';
  testId?: string;
}) {
  return (
    <p
      className={cn(
        'flex items-start gap-2.5 rounded-menu px-3.5 py-2.5 text-[13.5px]',
        tone === 'plain' && 'bg-card-2 text-text-2',
        tone === 'good' && 'bg-success-soft text-success-text',
        tone === 'wait' && 'bg-warning-soft text-warning-text',
        tone === 'accent' && 'bg-accent-soft text-accent-text',
      )}
      data-testid={testId}
    >
      {tone === 'good' ? (
        <Check className="mt-0.5 h-4 w-4 flex-none" strokeWidth={2} aria-hidden="true" />
      ) : tone === 'wait' ? (
        <Clock className="mt-0.5 h-4 w-4 flex-none" strokeWidth={1.75} aria-hidden="true" />
      ) : null}
      <span className="min-w-0 flex-1">{children}</span>
    </p>
  );
}

/** Waiting on something that ticks itself: the extension signing in, Chrome's Allow. */
export function Waiting({ children, testId }: { children: ReactNode; testId: string }) {
  return (
    <p
      className="flex items-center gap-2.5 rounded-menu bg-card-2 px-3.5 py-3 text-[13.5px] text-text-2"
      role="status"
      data-testid={testId}
    >
      <span className="h-2 w-2 flex-none animate-pulse rounded-full bg-accent" aria-hidden="true" />
      {children}
    </p>
  );
}

/** On a phone or another browser: open this page on a computer in Chrome, with its link to copy. */
export function OtherDevice() {
  const [chrome, setChrome] = useState(true);
  const [href, setHref] = useState('');
  useEffect(() => {
    setChrome(isDesktopChrome(navigator.userAgent));
    setHref(window.location.href);
  }, []);
  if (chrome) return null;
  return (
    <div
      className="flex flex-col gap-2.5 rounded-menu bg-accent-soft p-3.5"
      data-testid="outreach-setup-not-chrome"
    >
      <p className="text-[14px] text-accent-text">{W.notChrome}</p>
      {href ? (
        <div className="flex flex-col gap-1">
          <span className="text-[13px] font-medium">{W.pageLink}</span>
          <CopyField value={href} label={W.copyLink} copied={W.copied} />
        </div>
      ) : null}
      <p className="text-[13px] text-text-2">{W.keptPlace}</p>
    </div>
  );
}

const live = (r: Readiness | null) => r?.offer ?? null;

/** The main offer: built on its own page, which comes back here once it's live. */
function OfferStep({ workspaceId, setup, readiness, nav }: StepProps) {
  const state = stateOf(setup, { net: null, step: 'offer' });
  const done = state?.state === 'done';
  const offer = live(readiness);
  const href = `/app/w/${workspaceId}/main-offer/build?${new URLSearchParams({
    back: outreachSetupPath(workspaceId, { step: { net: null, step: 'offer' } }),
  }).toString()}`;
  return (
    <>
      {done && offer ? (
        <Note tone="good" testId="outreach-setup-offer-live">
          {W.offerLive(offer.version)} “{offer.line}”
        </Note>
      ) : state?.state === 'waiting' ? (
        <Note tone="wait">{state.left}</Note>
      ) : state?.left ? (
        <Note>{state.left}</Note>
      ) : null}
      {state?.state !== 'waiting' ? (
        <div>
          <ButtonLink
            href={href}
            variant={done ? 'secondary' : 'primary'}
            data-testid="outreach-setup-offer-open"
          >
            {done ? W.offerOpen : W.offerWrite}
          </ButtonLink>
        </div>
      ) : null}
      <StepFooter nav={nav} done={done} />
    </>
  );
}

const playbookHref = (workspaceId: string, id: string, more: Record<string, string>) =>
  `/app/w/${workspaceId}/a/outreach/playbooks/${id}?${new URLSearchParams({ from: 'setup', ...more }).toString()}`;
const newPlaybookHref = (workspaceId: string, more: Record<string, string>) =>
  `/app/w/${workspaceId}/a/outreach/playbooks/new?${new URLSearchParams({ from: 'setup', ...more }).toString()}`;

/** A playbook: start from one of ours, or write one; each in use says whether it has its niche. */
function PlaybookStep({ workspaceId, setup, nav }: StepProps) {
  const state = stateOf(setup, { net: null, step: 'playbook' });
  const done = state?.state === 'done';
  const names = new Set(setup.playbooks.map((p) => p.name.toLowerCase()));
  const used = new Set(setup.playbooks.map((p) => p.template));
  const templates = PLAYBOOK_TEMPLATE_KEYS.filter(
    (k) => !used.has(k) && !names.has(PLAYBOOK_TEMPLATES[k].name.toLowerCase()),
  );
  return (
    <>
      {setup.playbooks.length ? (
        <div className="flex flex-col gap-2" data-testid="outreach-setup-playbooks">
          <h2 className="text-[15px] font-semibold">{W.playbooksInUse}</h2>
          {setup.playbooks.map((p) => (
            <div
              key={p.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-border px-4 py-3"
            >
              <span className="flex min-w-0 items-center gap-2 font-medium">
                {p.niche ? (
                  <Check
                    className="h-4 w-4 flex-none text-success"
                    strokeWidth={2}
                    aria-hidden="true"
                  />
                ) : null}
                {p.name}
              </span>
              {!p.niche ? (
                <ButtonLink
                  size="sm"
                  variant="secondary"
                  href={playbookHref(workspaceId, p.id, {})}
                >
                  {W.playbookNiche}
                </ButtonLink>
              ) : null}
            </div>
          ))}
        </div>
      ) : state?.left ? (
        <Note>{state.left}</Note>
      ) : null}
      {templates.length ? (
        <div className="flex flex-col gap-2">
          <div>
            <h2 className="text-[15px] font-semibold">{W.templates}</h2>
            <p className="text-[13px] text-text-2">{W.templateAbout}</p>
          </div>
          {templates.map((k) => (
            <div
              key={k}
              className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-border bg-card px-4 py-3"
            >
              <div className="min-w-0 flex-1">
                <p className="font-medium">{PLAYBOOK_TEMPLATES[k].name}</p>
                <p className="text-[13px] text-text-2">{PLAYBOOK_TEMPLATES[k].summary}</p>
              </div>
              <ButtonLink
                size="sm"
                href={newPlaybookHref(workspaceId, { template: k })}
                data-testid={`outreach-setup-template-${k}`}
              >
                {W.useTemplate}
              </ButtonLink>
            </div>
          ))}
        </div>
      ) : null}
      <div>
        <ButtonLink
          size="sm"
          variant="ghost"
          href={newPlaybookHref(workspaceId, {})}
          data-testid="outreach-setup-write-own"
        >
          {W.writeOwn}
        </ButtonLink>
      </div>
      <StepFooter nav={nav} done={done} />
    </>
  );
}

/** The short video: optional (decision 83). The AI writes its script on the playbook; or the business has none. */
function VideoStep({ workspaceId, setup, business, nav }: StepProps) {
  const linked = setup.playbooks.find((p) => p.video);
  const target = setup.playbooks.find((p) => p.niche) ?? setup.playbooks[0];
  const none = async () => {
    const ok = await nav.act('none', async () =>
      unwrap(
        await apiBrowser().POST('/v1/commands/addon.save_settings', {
          body: {
            workspaceId,
            addonId: 'outreach',
            settings: settingsToSave(business ?? {}, { noVideo: true }),
          },
        }),
      ),
    );
    if (ok) await nav.carryOn();
  };
  return (
    <>
      {linked ? (
        <Note tone="good" testId="outreach-setup-video-linked">
          {W.videoLinked}
        </Note>
      ) : setup.noVideo ? (
        <Note testId="outreach-setup-video-none">{W.videoNone}</Note>
      ) : !target ? (
        <Note>{W.left.playbook}</Note>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {target ? (
          <ButtonLink
            href={playbookHref(workspaceId, (linked ?? target).id, { open: 'video' })}
            variant={linked || setup.noVideo ? 'secondary' : 'primary'}
            data-testid="outreach-setup-video-open"
          >
            {linked ? W.videoOpen : W.videoWrite}
          </ButtonLink>
        ) : null}
        {!linked && !setup.noVideo ? (
          <Button
            variant="secondary"
            onClick={() => void none()}
            loading={nav.busy === 'none'}
            disabled={nav.busy !== null}
            data-testid="outreach-setup-no-video"
          >
            {W.noVideo}
          </Button>
        ) : null}
      </div>
      <StepFooter nav={nav} done={Boolean(linked) || setup.noVideo} optional />
    </>
  );
}

/** The team's rules in plain lines, kept in one press; Change them opens the whole form. */
function RulesStep({ workspaceId, setup, me, business, nav }: StepProps) {
  const [changing, setChanging] = useState(false);
  const kept = BusinessRules.safeParse(business?.rules ?? {});
  const rules = kept.success ? kept.data : BusinessRules.parse({});
  const done = stateOf(setup, { net: null, step: 'rules' })?.state === 'done';
  const keep = async () => {
    const ok = await nav.act('keep', async () =>
      unwrap(
        await apiBrowser().POST('/v1/commands/addon.save_settings', {
          body: {
            workspaceId,
            addonId: 'outreach',
            settings: settingsToSave(business ?? {}, { rules, rulesKept: true }),
          },
        }),
      ),
    );
    if (ok) await nav.carryOn();
  };
  if (changing && business)
    return (
      <>
        <RulesForm
          workspaceId={workspaceId}
          settings={business}
          timezone={me.timezone}
          carryOn={() => void nav.carryOn()}
          carryingOn={nav.busy !== null}
        />
        <StepFooter nav={nav} done={done}>
          <span />
        </StepFooter>
      </>
    );
  const allSending = rules.sendingAllowed.length === Object.keys(SENDING_MODES).length;
  // Every network the business uses, Facebook always among them.
  const networks = WORKING_PLATFORMS.filter((p) => rules.networksAllowed.includes(p));
  const row = (title: string, about: ReactNode, last = false) => (
    <div
      className={cn(
        'grid gap-1 border-t border-border py-3.5 sm:grid-cols-[150px_minmax(0,1fr)] sm:gap-3.5',
        last && 'border-b',
      )}
    >
      <p className="font-semibold">{title}</p>
      <div className="text-text-2">{about}</div>
    </div>
  );
  return (
    <>
      <div data-testid="outreach-setup-rules">
        {row(
          W.rulesChoices,
          allSending
            ? W.rulesChoicesAbout
            : rules.sendingAllowed.map((m) => SENDING_MODES[m]).join(' · '),
        )}
        {row(W.rulesNetworks, W.rulesNetworksAbout(networks.map((p) => PLATFORMS[p])))}
        {networks.map((p) => {
          // The business's own on each network, at most its starting ones, as everyone's day keeps them.
          const limits = networkLimitsNow(p, false, businessLimitsOn(rules, p));
          const words = dailyWordsOn(p);
          return (
            <div key={p} data-testid={`outreach-setup-rules-limits-${p}`}>
              {row(
                W.rulesLimits(PLATFORMS[p]),
                <div className="flex flex-wrap gap-1.5">
                  {DAILY_STEPS.map((step) => (
                    <Badge key={step}>
                      {limits[step]} {words[step].many}
                    </Badge>
                  ))}
                </div>,
              )}
            </div>
          );
        })}
        {row(
          W.rulesNew,
          rules.defaults.sending === 'off'
            ? W.rulesNewAbout
            : SENDING_MODES[rules.defaults.sending],
          true,
        )}
      </div>
      <Note>{W.rulesWarning}</Note>
      <StepFooter nav={nav} done={done}>
        <Button
          variant="secondary"
          size="lg"
          onClick={() => setChanging(true)}
          disabled={nav.busy !== null}
          data-testid="outreach-setup-rules-change"
        >
          {W.changeRules}
        </Button>
        <Button
          size="lg"
          onClick={() => void keep()}
          loading={nav.busy === 'keep'}
          disabled={nav.busy !== null}
          data-testid="outreach-setup-rules-keep"
        >
          {W.keepRules}
          <ArrowRight className="h-4 w-4" strokeWidth={1.75} />
        </Button>
      </StepFooter>
    </>
  );
}

/** The extension: five steps with pictures, then a line that ticks itself when it signs in. */
function ExtensionStep({ email, setup, me, nav }: StepProps) {
  const done = Boolean(setup.extensionAt);
  return (
    <>
      <OtherDevice />
      <ExtensionDownload link={setup.extensionLink} email={email} />
      {setup.extensionAt ? (
        <Note tone="good" testId="outreach-setup-signed-in">
          {/* In the business's time zone, so the server and the browser write the same; only the minute may tick. */}
          <span suppressHydrationWarning>
            {W.signedIn(whenWords(setup.extensionAt, Date.now(), me.timezone))}
          </span>
        </Note>
      ) : (
        <Waiting testId="outreach-setup-waiting">{W.waiting}</Waiting>
      )}
      <p className="text-[13px] text-text-3">{W.otherNetworksLater}</p>
      <StuckFold />
      <StepFooter nav={nav} done={done} />
    </>
  );
}

/** The messages: the samples in their voice, OK'd here (Get ready's own part, decision 65). */
function MessagesStep({ workspaceId, setup, readiness, nav }: StepProps) {
  const router = useRouter();
  const state = stateOf(setup, { net: null, step: 'messages' });
  const done = state?.state === 'done';
  // An owner who skipped the business's part: samples need the live offer and a niche, so say so and link there.
  const first = setup.states.find(
    (s) => (s.step === 'offer' || s.step === 'playbook') && s.state !== 'done',
  );
  return (
    <>
      {state?.state === 'waiting' ? <Note tone="wait">{state.left}</Note> : null}
      {state?.state === 'todo' && first ? (
        <div
          className="flex flex-wrap items-center justify-between gap-3 rounded-menu bg-warning-soft px-3.5 py-2.5 text-[13.5px] text-warning-text"
          data-testid="outreach-setup-messages-first"
        >
          <p className="min-w-0 flex-[1_1_280px]">{state.left}</p>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => nav.go({ net: null, step: first.step })}
          >
            {W.start.doItNow}
          </Button>
        </div>
      ) : null}
      {readiness ? (
        <div className="grid gap-4" data-testid="outreach-setup-messages">
          <MessagesBody
            workspaceId={workspaceId}
            readiness={readiness}
            onChange={() => router.refresh()}
            onDone={() => void nav.carryOn()}
          />
        </div>
      ) : null}
      <StepFooter nav={nav} done={done} />
    </>
  );
}

/** The goal: calls booked a month, the days, and the math on the networks picked before it (Get ready's own part). */
function NumbersStep({ workspaceId, setup, readiness, nav }: StepProps) {
  const router = useRouter();
  const done = stateOf(setup, { net: null, step: 'numbers' })?.state === 'done';
  return (
    <>
      {readiness ? (
        <div className="grid gap-6" data-testid="outreach-setup-numbers">
          <NumbersBody
            workspaceId={workspaceId}
            readiness={readiness}
            onChange={() => router.refresh()}
            onDone={() => void nav.carryOn()}
          />
        </div>
      ) : null}
      <StepFooter nav={nav} done={done} />
    </>
  );
}

/** The networks they use: a switch each, inside what the business allows, then a short setup for each. */
function NetworksStep({ workspaceId, setup, me, nav }: StepProps) {
  const [value, setValue] = useState(me.settings);
  const allowed = me.rules.networksAllowed;
  const may = WORKING_PLATFORMS.filter((p) => allowed.includes(p));
  const not = WORKING_PLATFORMS.filter((p) => !allowed.includes(p));
  const on = may.filter((p) => value.networks[p].on);
  const done = stateOf(setup, { net: null, step: 'networks' })?.state === 'done';
  // The goal comes next while it's left: it counts every network turned on here (decision 88).
  const goalFirst = stateOf(setup, { net: null, step: 'numbers' })?.state !== 'done';
  const save = async () => {
    const ok = await nav.act('networks', async () =>
      unwrap(
        await apiBrowser().POST('/v1/commands/outreach.automation.save', {
          body: { workspaceId, settings: value },
        }),
      ),
    );
    if (ok) await nav.carryOn();
  };
  const set = (p: Platform, next: boolean) => setValue((v) => withNetwork(v, p, { on: next }));
  return (
    <>
      <ul className="flex flex-col gap-2.5" data-testid="outreach-setup-networks">
        {may.map((p) => (
          <li
            key={p}
            className={cn(
              'flex items-center gap-3.5 rounded-card border bg-card px-4 py-3.5',
              value.networks[p].on
                ? 'border-[color-mix(in_oklab,var(--accent)_45%,var(--border))]'
                : 'border-border',
            )}
            data-testid={`outreach-setup-network-${p}`}
          >
            <span
              className={cn(
                'flex h-9 w-9 flex-none items-center justify-center rounded-[9px] text-[14px] font-bold',
                value.networks[p].on ? 'bg-accent-soft text-accent-text' : 'bg-card-2 text-text-2',
              )}
              aria-hidden="true"
            >
              {PLATFORMS[p][0]}
            </span>
            <div className="min-w-0 flex-1">
              <p className="font-semibold">{PLATFORMS[p]}</p>
              <p className="text-[13px] text-text-2">{W.networkAbout[p]}</p>
            </div>
            <Switch
              checked={value.networks[p].on}
              onChange={(next) => set(p, next)}
              label={PLATFORMS[p]}
              testId={`outreach-setup-network-${p}-on`}
            />
          </li>
        ))}
      </ul>
      {not.length ? <Note>{W.networksNotAllowed(not.map((p) => PLATFORMS[p]))}</Note> : null}
      <Note testId="outreach-setup-networks-next">
        {on.length
          ? W.networksNext(
              on.map((p) => PLATFORMS[p]),
              goalFirst,
            )
          : W.networksNone}
      </Note>
      <StepFooter nav={nav} done={done}>
        <Button
          size="lg"
          onClick={() => void save()}
          loading={nav.busy === 'networks'}
          disabled={nav.busy !== null || !on.length}
          data-testid="outreach-setup-networks-save"
        >
          {!on.length ? W.next : goalFirst ? W.saveAndCarryOn : W.saveAndSetUp(PLATFORMS[on[0]!])}
          <ArrowRight className="h-4 w-4" strokeWidth={1.75} />
        </Button>
      </StepFooter>
    </>
  );
}

interface StepProps {
  workspaceId: string;
  businessName: string;
  email: string;
  setup: Setup;
  me: Automation;
  business: Readonly<Record<string, unknown>> | null;
  readiness: Readiness | null;
  nav: StepNav;
}

/** The main setup's step asked for. */
export function MainStep({
  at,
  ...props
}: Omit<StepProps, 'nav'> & { at: Extract<SetupStop, { net: null }> }) {
  const nav = useStepNav(props.workspaceId, at, props.setup);
  const all = { ...props, nav };
  switch (at.step) {
    case 'offer':
      return <OfferStep {...all} />;
    case 'playbook':
      return <PlaybookStep {...all} />;
    case 'video':
      return <VideoStep {...all} />;
    case 'rules':
      return <RulesStep {...all} />;
    case 'extension':
      return <ExtensionStep {...all} />;
    case 'messages':
      return <MessagesStep {...all} />;
    case 'networks':
      return <NetworksStep {...all} />;
    case 'numbers':
      return <NumbersStep {...all} />;
  }
}
