'use client';
/**
 * A network's short setup (docs/outreach.md, decision 83; the canvas "Social Outreach setup"), Facebook first and then
 * each other network the person turned on: Allow it in Chrome and a playbook that runs there (every network but
 * Facebook), their profile there, what it does there, then their first day there. And the end, once every network is.
 *
 * - **Allow** ticks by itself: the computer's check-in says which networks Chrome lets it on, and the page reads the
 *   setup again every few seconds while it waits.
 * - **What it does there** asks Sending as cards, nothing picked to start (decision 26 stays), the usual one marked;
 *   everything else is under More choices. A business that allows only Off says so: to an owner or admin with a link
 *   to Team rules, to anyone else with who to ask.
 * - **Start** says what's still in the way before the press, beside the button it keeps from being pressed, and a
 *   refusal in the server's words after, each with where to fix it (clients branch on the rule and its details, never
 *   on the words). The profile there is never in the way (decision 90): what's left of it shows beside a Start that
 *   works, with **Do it now**. A warning on the network today keeps Start from being pressed, saying so.
 */
import {
  choicesFor,
  WHEELS_START_WORDS,
  wheelsMatter,
  type SendingMode,
} from '@hfos/core/addons/outreach/automation';
import { warnedTodayWords } from '@hfos/core/addons/outreach/live';
import { withNetwork } from '@hfos/core/addons/outreach/network-words';
import { PLATFORMS, type Platform } from '@hfos/core/addons/outreach/networks';
import {
  outreachSetupPath,
  SETUP_SENDING,
  SETUP_WORDS,
  startAdvice,
  startBlocker,
  stopAfter,
  type SetupStop,
} from '@hfos/core/addons/outreach/setup';
import { ArrowRight, ChevronDown, Play } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { PhoneAppDialog } from '@/components/home/phone-app-dialog';
import { Badge } from '@/components/ui/badge';
import { Button, ButtonLink } from '@/components/ui/button';
import { RadioCard } from '@/components/ui/radio-card';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import { outreachHref } from './address';
import { ComputerNote } from './asks';
import { PictureStep } from './extension-download';
import { ProfileBody } from './get-ready';
import { allowPictures } from './install-pictures';
import { useServerNow } from './live-view';
import { PreDayList } from './pre-day-list';
import {
  ExtensionTicks,
  HoursPart,
  NetworkModes,
  NetworkTicks,
  PushesPart,
  VoicePart,
  wheelsOf,
} from './settings-view';
import { getSetup, laidOut, saveSetup } from './setup-api';
import { startRefused } from './start-refused';
import {
  Note,
  OtherDevice,
  StepFooter,
  stateOf,
  useStepNav,
  Waiting,
  type StepNav,
} from './setup-steps';
import { pressDay } from './status-strip';
import type { Asks, Automation, Live, Readiness, Setup } from './types';

const W = SETUP_WORDS;

type NetStop = Extract<SetupStop, { net: Platform }>;

interface NetProps {
  workspaceId: string;
  at: NetStop;
  setup: Setup;
  me: Automation;
  asks: Asks | null;
  readiness: Readiness | null;
  live: Live | null;
  nav: StepNav;
}

/** Chrome's Allow, a step at a time, ticking by itself once the computer says it's let on. */
function AllowStep({ workspaceId, at, setup, nav }: NetProps) {
  const router = useRouter();
  const name = PLATFORMS[at.net];
  const done = stateOf(setup, at)?.state === 'done';
  // The computer's check-in that says so isn't broadcast: read the setup again while waiting.
  useEffect(() => {
    if (done) return;
    const t = setInterval(() => router.refresh(), 5_000);
    return () => clearInterval(t);
  }, [done, router]);
  const pictures = allowPictures(name, W.site(at.net));
  return (
    <>
      <OtherDevice />
      {!setup.extensionAt ? (
        <Note tone="wait">
          {W.left.extensionFirst}{' '}
          <Link
            className="font-medium underline"
            href={outreachSetupPath(workspaceId, { step: { net: null, step: 'extension' } })}
          >
            {W.main.extension.name}
          </Link>
        </Note>
      ) : null}
      <ol className="flex flex-col" data-testid="outreach-setup-allow-steps">
        {W.allow(at.net).map((s, i) => (
          <PictureStep
            key={s.title}
            n={i + 1}
            title={s.title}
            text={s.text}
            picture={pictures[i]}
            last={i === 2}
          />
        ))}
      </ol>
      {done ? (
        <Note tone="good" testId="outreach-setup-allowed">
          {W.allowed(name, setup.computer)}
        </Note>
      ) : (
        <Waiting testId="outreach-setup-allow-waiting">{W.allowWaiting}</Waiting>
      )}
      <StepFooter nav={nav} done={done} />
    </>
  );
}

const playbookHref = (workspaceId: string, id: string, net: Platform) =>
  `/app/w/${workspaceId}/a/outreach/playbooks/${id}?${new URLSearchParams({ from: 'setup', open: 'where', net }).toString()}`;

/** A playbook that runs there: an owner turns the network on under a playbook's Where, or writes one for it. */
function PlaybookOnStep({ workspaceId, at, setup, nav }: NetProps) {
  const name = PLATFORMS[at.net];
  const state = stateOf(setup, at);
  const done = state?.state === 'done';
  return (
    <>
      {state?.state === 'waiting' ? <Note tone="wait">{state.left}</Note> : null}
      {setup.canManage ? (
        <>
          {setup.playbooks.length ? (
            <ul className="flex flex-col gap-2" data-testid="outreach-setup-net-playbooks">
              {setup.playbooks.map((p) => {
                const runs = p.networks.includes(at.net);
                return (
                  <li
                    key={p.id}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-border px-4 py-3"
                  >
                    <span className="min-w-0 font-medium">{p.name}</span>
                    {runs ? (
                      <Badge variant="ok">{W.playbookRunsOn(name)}</Badge>
                    ) : (
                      <ButtonLink
                        size="sm"
                        variant="secondary"
                        href={playbookHref(workspaceId, p.id, at.net)}
                      >
                        {W.playbookOn(name)}
                      </ButtonLink>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : null}
          {!done && state?.left ? <Note>{state.left}</Note> : null}
          <div>
            <ButtonLink
              size="sm"
              variant="ghost"
              href={`/app/w/${workspaceId}/a/outreach/playbooks/new?${new URLSearchParams({ from: 'setup', net: at.net }).toString()}`}
              data-testid="outreach-setup-net-write-own"
            >
              {W.writeOwn}
            </ButtonLink>
          </div>
        </>
      ) : null}
      <StepFooter nav={nav} done={done} />
    </>
  );
}

/**
 * Their profile there: read by their computer and checked by the AI (Get ready's own part, decision 64). Advice: the
 * first day never waits on it (decision 90).
 */
function ProfileStep({ workspaceId, at, setup, asks, readiness, nav }: NetProps) {
  const router = useRouter();
  const done = stateOf(setup, at)?.state === 'done';
  return (
    <>
      {readiness ? (
        <div className="grid gap-4" data-testid="outreach-setup-profile">
          {/* Why Read my profile waits: no computer, or it's offline. */}
          {asks ? <ComputerNote asks={asks} /> : null}
          {/* Advice, never in the way of the first day (decision 90). */}
          {done ? null : (
            <Note testId="outreach-setup-profile-later">{W.network.profile.later}</Note>
          )}
          <ProfileBody
            workspaceId={workspaceId}
            readiness={readiness}
            asks={asks}
            onChange={() => router.refresh()}
          />
        </div>
      ) : null}
      <StepFooter nav={nav} done={done} />
    </>
  );
}

/** What it does there: Sending as cards, nothing picked to start, and the rest folded. */
function ChoicesStep({ workspaceId, at, setup, me, nav }: NetProps) {
  const name = PLATFORMS[at.net];
  const [value, setValue] = useState(me.settings);
  const kept = choicesFor(me.settings, at.net);
  const [picked, setPicked] = useState<SendingMode | null>(
    setup.settingsSaved && kept.sending !== 'off' ? kept.sending : null,
  );
  const network = choicesFor(value, at.net);
  const modes = SETUP_SENDING.filter((m) => me.rules.sendingAllowed.includes(m));
  const wheels = wheelsOf(me, at.net);
  const done = stateOf(setup, at)?.state === 'done';
  const save = async () => {
    if (!picked) return;
    const ok = await nav.act('choices', async () =>
      unwrap(
        await apiBrowser().POST('/v1/commands/outreach.automation.save', {
          body: {
            workspaceId,
            settings: withNetwork(value, at.net, { on: true, sending: picked }),
          },
        }),
      ),
    );
    if (ok) await nav.carryOn();
  };
  return (
    <>
      {modes.length ? (
        <div
          role="radiogroup"
          aria-label={W.pickOne}
          className="flex flex-col gap-2.5"
          data-testid="outreach-setup-sending"
        >
          {modes.map((m) => (
            <div key={m} className="flex flex-col gap-1.5">
              <RadioCard
                selected={picked === m}
                onSelect={() => setPicked(m)}
                title={W.sendingCards[m].title}
                description={W.sendingCards[m].about}
                testId={`outreach-setup-sending-${m}`}
              />
              {m === 'steps' ? (
                <span className="ml-0.5">
                  <Badge variant="accent">{W.mostPeople}</Badge>
                </span>
              ) : null}
            </div>
          ))}
        </div>
      ) : setup.canManage ? (
        // The business allows only Off, and this person can change that: where.
        <div
          className="flex flex-wrap items-center justify-between gap-3 rounded-menu bg-warning-soft px-3.5 py-2.5 text-[13.5px] text-warning-text"
          data-testid="outreach-setup-sending-only-off"
        >
          <p className="min-w-0 flex-[1_1_260px]">{W.sendingOnlyOffManage}</p>
          <ButtonLink
            size="sm"
            variant="secondary"
            href={outreachSetupPath(workspaceId, { step: { net: null, step: 'rules' } })}
            data-testid="outreach-setup-to-rules"
          >
            {W.toRules}
          </ButtonLink>
        </div>
      ) : (
        <Note tone="wait" testId="outreach-setup-sending-only-off">
          {W.sendingOnlyOff}
        </Note>
      )}
      {picked && wheelsMatter({ sending: picked, replies: network.replies }) && !wheels.from ? (
        <Note tone="wait" testId="outreach-setup-wheels">
          {WHEELS_START_WORDS}
        </Note>
      ) : null}
      <details
        className="group rounded-menu border border-border"
        data-testid="outreach-setup-more"
      >
        <summary className="flex cursor-pointer list-none items-center justify-between gap-2 rounded-menu px-3.5 py-2.5 font-medium [&::-webkit-details-marker]:hidden">
          {W.moreChoices(name)}
          <ChevronDown
            className="h-4 w-4 transition-transform duration-150 group-open:rotate-180"
            strokeWidth={1.75}
            aria-hidden="true"
          />
        </summary>
        <div className="space-y-5 border-t border-border p-3.5">
          <NetworkModes
            platform={at.net}
            value={network}
            onChange={(change) => setValue((v) => withNetwork(v, at.net, change))}
            sendingAllowed={me.rules.sendingAllowed}
            repliesAllowed={me.rules.repliesAllowed}
            postingAllowed={me.rules.postingAllowed}
            sendingPart={false}
            testId="outreach-setup-more"
          />
          <NetworkTicks
            platform={at.net}
            value={network}
            onChange={(change) => setValue((v) => withNetwork(v, at.net, change))}
            testId="outreach-setup-more"
          />
          {/* Theirs on every network: asked once, on Facebook's. */}
          {at.net === 'facebook' ? (
            <>
              <VoicePart value={value} onChange={setValue} testId="outreach-setup-more" />
              <ExtensionTicks value={value} onChange={setValue} testId="outreach-setup-more" />
              <PushesPart value={value} onChange={setValue} testId="outreach-setup-more" />
              <HoursPart
                value={value}
                onChange={setValue}
                timezone={me.timezone}
                testId="outreach-setup-more"
              />
            </>
          ) : null}
        </div>
      </details>
      <StepFooter nav={nav} done={done}>
        {!picked && modes.length ? (
          <span className="text-[13px] text-text-3">{W.pickToCarryOn}</span>
        ) : null}
        <Button
          size="lg"
          onClick={() => void save()}
          loading={nav.busy === 'choices'}
          disabled={nav.busy !== null || !picked}
          data-testid="outreach-setup-choices-save"
        >
          {W.saveAndCarryOn}
          <ArrowRight className="h-4 w-4" strokeWidth={1.75} />
        </Button>
      </StepFooter>
    </>
  );
}

/**
 * The first day there: what's still in the way, beside the Start it keeps from being pressed; the profile's advice
 * beside a Start that works; what happens next, and the press.
 */
function StartStep({ workspaceId, at, setup, live, nav }: NetProps) {
  const router = useRouter();
  const name = PLATFORMS[at.net];
  const blocker = startBlocker(laidOut(setup), at.net);
  const advice = startAdvice(laidOut(setup), at.net);
  // A warning there today: nothing to fix, and no day there until tomorrow.
  const warned = live !== null && (live.warning?.today === true || live.day.why === 'warning');
  const done = stateOf(setup, at)?.state === 'done';
  const [refused, setRefused] = useState<{ words: string; fix: SetupStop | null } | null>(null);
  const [busy, setBusy] = useState(false);
  // The next network after this one, still to set up.
  const after = setup.networks.slice(setup.networks.findIndex((n) => n.platform === at.net) + 1);
  const then = after.find((n) => n.steps.some((s) => s.state !== 'done'));
  const start = async () => {
    setBusy(true);
    setRefused(null);
    try {
      await pressDay(workspaceId, at.net, 'start');
      await saveSetup(workspaceId, { finished: true });
      const to = stopAfter(at, laidOut(await getSetup(workspaceId)));
      router.push(outreachSetupPath(workspaceId, { step: to }));
    } catch (e) {
      // A refusal with a rule stays beside Start in its words, with its fix (`startRefused`); anything else is a toast.
      const kept = startRefused(e, at.net, setup.canManage);
      if (kept) setRefused({ words: kept.words, fix: kept.fix });
      else toast.error(errorMessage(e));
      setBusy(false);
    }
  };
  const fixLink = (stop: SetupStop, testId = 'outreach-setup-fix') => (
    <ButtonLink
      size="sm"
      variant="secondary"
      href={outreachSetupPath(workspaceId, { step: stop })}
      data-testid={testId}
    >
      {W.start.doItNow}
    </ButtonLink>
  );
  return (
    <>
      {blocker && !done ? (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-card bg-warning-soft px-4 py-3.5 text-warning-text"
          data-testid="outreach-setup-blocker"
        >
          <div className="min-w-0 flex-[1_1_280px]">
            <p className="font-semibold">{W.start.blocked}</p>
            <p className="text-[13.5px]">{blocker.left}</p>
          </div>
          {blocker.stop ? fixLink(blocker.stop) : null}
        </div>
      ) : null}
      {warned && !blocker && !done ? (
        <div
          role="alert"
          className="rounded-card bg-danger-soft px-4 py-3.5 text-[13.5px] text-danger-text"
          data-testid="outreach-setup-warned"
        >
          {warnedTodayWords(at.net)}
        </div>
      ) : null}
      {advice && !blocker && !done ? (
        <div
          className="flex flex-wrap items-center justify-between gap-3 rounded-card bg-card-2 px-4 py-3.5 text-text-2"
          data-testid="outreach-setup-advice"
        >
          {/* "Start now" only beside a Start that can be pressed: a warning or a refusal says what's in the way. */}
          <p className="min-w-0 flex-[1_1_280px] text-[13.5px]">
            {advice.left} {warned || refused ? W.network.profile.later : W.start.later}
          </p>
          {fixLink(advice.stop, 'outreach-setup-advice-fix')}
        </div>
      ) : null}
      {refused ? (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-card bg-warning-soft px-4 py-3.5 text-[13.5px] text-warning-text"
          data-testid="outreach-setup-refused"
        >
          <p className="min-w-0 flex-[1_1_280px]">{refused.words}</p>
          {refused.fix ? fixLink(refused.fix) : null}
        </div>
      ) : null}
      <section>
        <h2 className="mb-1 text-[15px] font-semibold">{W.start.happens}</h2>
        <ol className="flex flex-col">
          {W.start.steps.map((s, i) => (
            <li key={s.title} className="grid grid-cols-[28px_minmax(0,1fr)] gap-3 py-2.5">
              <span
                className="flex h-7 w-7 items-center justify-center rounded-full bg-card-2 text-[13px] font-semibold text-text-2"
                aria-hidden="true"
              >
                {i + 1}
              </span>
              <div>
                <p className="font-medium">{s.title}</p>
                <p className="text-[13px] text-text-2">{s.text}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>
      {then ? (
        <div
          className="flex flex-wrap items-center gap-3 rounded-card border border-border px-4 py-3.5"
          data-testid="outreach-setup-then"
        >
          <span
            className="flex h-8 w-8 flex-none items-center justify-center rounded-[8px] bg-card-2 font-bold text-text-2"
            aria-hidden="true"
          >
            {PLATFORMS[then.platform][0]}
          </span>
          <div className="min-w-0 flex-[1_1_240px]">
            <p className="font-semibold">{W.start.then(PLATFORMS[then.platform])}</p>
            <p className="text-[13px] text-text-2">{W.start.thenAbout(then.steps.length)}</p>
          </div>
        </div>
      ) : null}
      <StepFooter nav={nav} done={done}>
        {done ? undefined : (
          <Button
            size="lg"
            onClick={() => void start()}
            loading={busy}
            disabled={busy || blocker !== null || warned}
            data-testid="outreach-setup-start-day"
          >
            <Play className="h-3.5 w-3.5" strokeWidth={1.75} />
            {W.start.go(name)}
          </Button>
        )}
      </StepFooter>
    </>
  );
}

/** A network's step asked for. */
export function NetworkStepView(props: Omit<NetProps, 'nav'>) {
  const nav = useStepNav(props.workspaceId, props.at, props.setup);
  const all = { ...props, nav };
  switch (props.at.step) {
    case 'allow':
      return <AllowStep {...all} />;
    case 'playbook':
      return <PlaybookOnStep {...all} />;
    case 'profile':
      return <ProfileStep {...all} />;
    case 'choices':
      return <ChoicesStep {...all} />;
    case 'start':
      return <StartStep {...all} />;
  }
}

/** The end: the first lists being read (decision 60), the phone app, and Today. */
export function SetupDone({ workspaceId, live }: { workspaceId: string; live: Live | null }) {
  const [phone, setPhone] = useState(false);
  const now = useServerNow(live?.now ?? new Date(0).toISOString());
  return (
    <div className="flex flex-col gap-4" data-testid="outreach-setup-done">
      {live ? <PreDayList live={live} now={now} /> : null}
      <div className="flex flex-wrap items-center gap-3 rounded-card border border-border px-4 py-3.5">
        <span className="min-w-0 flex-[1_1_260px] text-[13.5px] text-text-2">{W.phone}</span>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => setPhone(true)}
          data-testid="outreach-setup-phone"
        >
          {W.getPhone}
        </Button>
      </div>
      <p className="flex flex-wrap gap-x-4 gap-y-1 text-[13px]">
        <Link className="underline" href={outreachHref(workspaceId, { view: 'settings' })}>
          {W.changeLater}
        </Link>
        <Link
          className="underline"
          href={outreachSetupPath(workspaceId, { again: true })}
          data-testid="outreach-setup-again-link"
        >
          {W.again}
        </Link>
      </p>
      <div className="mt-auto flex justify-end border-t border-border pt-4">
        <ButtonLink
          size="lg"
          variant="primary"
          href={outreachHref(workspaceId, { view: 'today' })}
          data-testid="outreach-setup-today"
        >
          {W.goToday}
          <ArrowRight className="h-4 w-4" strokeWidth={1.75} />
        </ButtonLink>
      </div>
      <PhoneAppDialog open={phone} onOpenChange={setPhone} />
    </div>
  );
}
