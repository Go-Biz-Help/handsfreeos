'use client';
/**
 * Social Outreach's setup, in HandsFreeOS (docs/outreach.md, decisions 36 and 45): a step at a time in the same card
 * as the main app's onboarding, with the summary beside it. Pick the playbooks, set the team's rules (owners and
 * admins), choose your own settings, install the extension and sign in, then bring in your groups. Each step's button
 * saves where the person got to (`outreach.setup.save`), so leaving and coming back opens on the next step
 * (`setupOpenAt`, in the page). The extension signing in ticks the install step live.
 *
 * `SetupBanner` is the slim "Finish setting up" line on Social Outreach's tabs, which fetches for itself.
 */
import {
  WHEELS_START_WORDS,
  wheelsMatter,
  type AutomationSettings,
} from '@hfos/core/addons/outreach/automation';
import { ASK_WORDS } from '@hfos/core/addons/outreach/asks';
import { GROUP_VERDICTS } from '@hfos/core/addons/outreach/groups';
import { PLAYBOOK_TEMPLATE_KEYS, PLAYBOOK_TEMPLATES } from '@hfos/core/addons/outreach/playbooks';
import {
  nextScreen,
  outreachSetupPath,
  previousScreen,
  SETUP_WORDS,
  setupSummary,
  stepsDone,
  whenWords,
  type SetupScreen,
  type SetupStep,
} from '@hfos/core/addons/outreach/setup';
import { ArrowLeft, ArrowRight, Check } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { PhoneAppDialog } from '@/components/home/phone-app-dialog';
import { SetupCard, SetupPage } from '@/components/onboarding-setup/frame';
import { Button, ButtonLink } from '@/components/ui/button';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { useLiveRefresh, useLiveVersion } from '@/lib/realtime/live-provider';
import { outreachHref } from './address';
import { AskButton, ComputerNote } from './asks';
import { ExtensionDownload } from './extension-download';
import { ChoicesForm, RulesForm } from './settings-view';
import type { Asks, Automation, Setup } from './types';
import { useAct } from './use-act';

const W = SETUP_WORDS;

/** Chrome (or another Chromium browser) on a computer: where a build loaded by hand works. A hint, never a block. */
export function isDesktopChrome(userAgent: string): boolean {
  return /Chrome\//.test(userAgent) && !/Mobile|Android|CriOS/.test(userAgent);
}

async function saveSetup(
  workspaceId: string,
  body: {
    reached?: SetupStep;
    finished?: true;
    started?: true;
    hideBanner?: true;
  },
) {
  return unwrap(
    await apiBrowser().POST('/v1/commands/outreach.setup.save', { body: { workspaceId, ...body } }),
  );
}

function Footer({ children, back }: { children?: ReactNode; back: ReactNode }) {
  return (
    <div className="mt-auto flex flex-wrap-reverse items-center justify-between gap-3 border-t border-border pt-4">
      {back}
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

function Note({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <p
      className="rounded-menu bg-card-2 px-3.5 py-2.5 text-[13.5px] text-text-2"
      data-testid={testId}
    >
      {children}
    </p>
  );
}

export function SetupView({
  workspaceId,
  businessName,
  email,
  at,
  fromExtension,
  resumed = false,
  setup,
  me,
  business,
  asks,
}: {
  workspaceId: string;
  businessName: string;
  /** Who's signed in: the extension signs in with the same. */
  email: string;
  at: SetupScreen;
  /** Opened by the extension at its first sign-in. */
  fromExtension: boolean;
  /** Opened where they'd left off, with some steps finished before: "Carry on where you left off". */
  resumed?: boolean;
  setup: Setup;
  /** The person's own settings, the business's defaults until they save theirs. */
  me: Automation;
  /** The business's Social Outreach settings, for owners and admins. */
  business: Readonly<Record<string, unknown>> | null;
  /** Save my groups, asked of the person's computer (./asks.tsx): the groups step's; null on the others. */
  asks: Asks | null;
}) {
  const router = useRouter();
  // The extension signing in, a playbook written in another tab, or the settings changed: it shows here.
  useLiveRefresh([
    'outreach_setup',
    'outreach_automation',
    'outreach_playbook',
    'outreach_ask',
    'outreach_group',
    'addon',
    'workspace',
  ]);
  const { busy, act } = useAct();
  const [value, setValue] = useState<AutomationSettings>(me.settings);
  const [phone, setPhone] = useState(false);
  const [chrome, setChrome] = useState(true);
  useEffect(() => setChrome(isDesktopChrome(navigator.userAgent)), []);

  const steps = setup.steps;
  const go = (to: SetupScreen) => router.push(outreachSetupPath(workspaceId, { step: to }));
  /** Marks a step finished, after its own save, and moves on. */
  const carryOn = async (step: SetupStep, before?: () => Promise<unknown>, finished = false) => {
    const ok = await act(step, async () => {
      if (before) await before();
      await saveSetup(workspaceId, { reached: step, ...(finished ? { finished: true } : {}) });
    });
    if (ok) go(nextScreen(step, steps));
  };
  const later = async () => {
    // Leaving for later counts as starting, so they aren't sent here again.
    const ok = setup.startedAt
      ? true
      : await act('later', () => saveSetup(workspaceId, { started: true }));
    if (ok) router.push(outreachHref(workspaceId));
  };

  const prev = previousScreen(at, steps);
  const back =
    prev && at !== 'done' ? (
      <Button
        variant="ghost"
        onClick={() => go(prev)}
        disabled={busy !== null}
        data-testid="outreach-setup-back"
      >
        <ArrowLeft className="h-4 w-4" strokeWidth={1.75} />
        {W.back}
      </Button>
    ) : (
      <span />
    );
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
  const primary = (
    step: SetupStep,
    label: string,
    run?: () => Promise<unknown>,
    testId = 'outreach-setup-next',
  ) => (
    <Button
      size="lg"
      onClick={() => void carryOn(step, run, step === 'groups')}
      loading={busy === step}
      disabled={busy !== null && busy !== step}
      data-testid={testId}
    >
      {label}
      <ArrowRight className="h-4 w-4" strokeWidth={1.75} />
    </Button>
  );

  let body: ReactNode = null;
  let footer: ReactNode = null;

  if (at === 'welcome') {
    body = (
      <div className="flex flex-col gap-4" data-testid="outreach-setup-welcome">
        <div>
          <h2 className="text-[14px] font-semibold">{W.welcome.steps}</h2>
          <ol className="mt-2.5 flex flex-col gap-3">
            {steps.map((s, i) => (
              <li key={s} className="flex items-start gap-3">
                <span className="flex h-6 w-6 flex-none items-center justify-center rounded-full bg-accent-soft text-[12.5px] font-semibold text-accent-text">
                  {i + 1}
                </span>
                <div className="min-w-0">
                  <p className="text-[14px] font-medium">{W.steps[s].name}</p>
                  <p className="text-[13px] text-text-2">{W.stepAbout[s]}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
        <Note>{W.welcome.time}</Note>
      </div>
    );
    footer = (
      <Footer back={back}>
        <Button
          size="lg"
          onClick={() =>
            void act('start', () => saveSetup(workspaceId, { started: true })).then(
              (ok) => ok && go(steps[0] ?? 'playbooks'),
            )
          }
          loading={busy === 'start'}
          disabled={busy !== null && busy !== 'start'}
          data-testid="outreach-setup-start"
        >
          {W.welcome.start}
          <ArrowRight className="h-4 w-4" strokeWidth={1.75} />
        </Button>
      </Footer>
    );
  } else if (at === 'playbooks') {
    const names = new Set(setup.playbooks.map((p) => p.name.toLowerCase()));
    const used = new Set(setup.playbooks.map((p) => p.template));
    const templates = PLAYBOOK_TEMPLATE_KEYS.filter(
      (k) => !used.has(k) && !names.has(PLAYBOOK_TEMPLATES[k].name.toLowerCase()),
    );
    const builder = (template?: string) =>
      `/app/w/${workspaceId}/a/outreach/playbooks/new?${new URLSearchParams({
        ...(template ? { template } : {}),
        from: 'setup',
      }).toString()}`;
    body = (
      <div className="flex flex-col gap-4" data-testid="outreach-setup-playbooks">
        {setup.playbooks.length ? (
          <div>
            <h2 className="text-[14px] font-semibold">{W.playbooksInUse}</h2>
            <ul className="mt-1.5 flex flex-col gap-1.5">
              {setup.playbooks.map((p) => (
                <li key={p.name} className="flex items-center gap-2 text-[14px]">
                  <Check className="h-4 w-4 flex-none text-success-text" strokeWidth={2} />
                  {p.name}
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <Note testId="outreach-setup-no-playbook">
            {setup.canManage ? W.playbooksNoneManage : W.playbooksNone}
          </Note>
        )}
        {setup.canManage ? (
          <div className="flex flex-col gap-2">
            {templates.length ? (
              <>
                <div>
                  <h2 className="text-[14px] font-semibold">{W.templates}</h2>
                  <p className="text-[13px] text-text-2">{W.templateAbout}</p>
                </div>
                {templates.map((k) => (
                  <div
                    key={k}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-border bg-card px-4 py-3"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-[14px] font-medium">{PLAYBOOK_TEMPLATES[k].name}</p>
                      <p className="text-[13px] text-text-2">{PLAYBOOK_TEMPLATES[k].summary}</p>
                    </div>
                    <ButtonLink
                      size="sm"
                      href={builder(k)}
                      data-testid={`outreach-setup-template-${k}`}
                    >
                      {W.useTemplate}
                    </ButtonLink>
                  </div>
                ))}
              </>
            ) : null}
            <div>
              <ButtonLink
                size="sm"
                variant="ghost"
                href={builder()}
                data-testid="outreach-setup-write-own"
              >
                {W.writeOwn}
              </ButtonLink>
            </div>
          </div>
        ) : null}
      </div>
    );
    footer = (
      <Footer back={back}>
        {primary('playbooks', setup.playbooks.length || !setup.canManage ? W.next : W.skip)}
      </Footer>
    );
  } else if (at === 'rules') {
    body = business ? (
      <RulesForm
        key={JSON.stringify(business.rules ?? null)}
        workspaceId={workspaceId}
        settings={business}
        timezone={me.timezone}
        carryOn={() => void carryOn('rules')}
        carryingOn={busy !== null}
      />
    ) : (
      <Note>{W.steps.rules.hint}</Note>
    );
    footer = <Footer back={back} />;
  } else if (at === 'settings') {
    body = (
      <div className="flex flex-col gap-3">
        {me.changedBy ? (
          <p className="text-[13px] text-text-2">{W.pickedForYou(me.changedBy)}</p>
        ) : null}
        <ChoicesForm
          value={value}
          onChange={setValue}
          sendingAllowed={me.rules.sendingAllowed}
          repliesAllowed={me.rules.repliesAllowed}
          postingAllowed={me.rules.postingAllowed}
          timezone={me.timezone}
          testId="outreach-setup-my"
        />
        {wheelsMatter(value) && !me.wheels.from ? (
          <p className="text-[13px] text-text-2">{WHEELS_START_WORDS}</p>
        ) : null}
      </div>
    );
    footer = (
      <Footer back={back}>
        {primary('settings', W.next, async () =>
          // Always saved, even unchanged: they've chosen, and the extension stops sending them here.
          unwrap(
            await apiBrowser().POST('/v1/commands/outreach.automation.save', {
              body: { workspaceId, settings: value },
            }),
          ),
        )}
      </Footer>
    );
  } else if (at === 'extension') {
    body = (
      <div className="flex flex-col gap-4" data-testid="outreach-setup-extension">
        {!chrome ? <Note testId="outreach-setup-not-chrome">{W.notChrome}</Note> : null}
        <ExtensionDownload link={setup.extensionLink} email={email} businessName={businessName} />
        {setup.extensionAt ? (
          <p
            className="flex items-start gap-2 rounded-menu bg-success-soft px-3.5 py-2.5 text-[13.5px] text-success-text"
            data-testid="outreach-setup-signed-in"
          >
            <Check className="mt-0.5 h-4 w-4 flex-none" strokeWidth={2} />
            {/* In the business's time zone, so the server and the browser write the same; only the minute may tick. */}
            <span suppressHydrationWarning>
              {W.signedIn(whenWords(setup.extensionAt, Date.now(), me.timezone))}
            </span>
          </p>
        ) : (
          <p
            className="flex items-center gap-2 rounded-menu bg-card-2 px-3.5 py-2.5 text-[13.5px] text-text-2"
            data-testid="outreach-setup-waiting"
          >
            <span className="h-2 w-2 flex-none animate-pulse rounded-full bg-accent" aria-hidden />
            {W.waiting}
          </p>
        )}
        <p className="text-[12.5px] text-text-3">{W.update}</p>
      </div>
    );
    footer = (
      <Footer back={back}>
        {setup.extensionAt
          ? primary('extension', W.next)
          : primary('extension', W.skip, undefined, 'outreach-setup-skip')}
      </Footer>
    );
  } else if (at === 'groups') {
    const mine = setup.groups.latest;
    body = (
      <div className="flex flex-col gap-4" data-testid="outreach-setup-groups">
        <p className="text-[14px]">{W.groupsHow}</p>
        {asks ? (
          <>
            <ComputerNote asks={asks} />
            <AskButton
              workspaceId={workspaceId}
              asks={asks}
              ask={{ kind: 'groups' }}
              label={ASK_WORDS.saveGroups}
              testId="outreach-setup-ask-groups"
            />
          </>
        ) : null}
        <Note testId="outreach-setup-groups-count">
          {setup.groups.mine ? W.groupsSome(setup.groups.mine) : W.groupsNone}
        </Note>
        {mine.length ? (
          <ul className="flex flex-col gap-1.5">
            {mine.map((g) => (
              <li key={g.groupId} className="flex items-center justify-between gap-3 text-[14px]">
                <span className="min-w-0 truncate">{g.name ?? 'A group'}</span>
                <span className="flex-none text-[13px] text-text-2">
                  {GROUP_VERDICTS[g.verdict]}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        {setup.groups.mine ? (
          <Link
            className="text-[13px] text-text-2 underline"
            href={outreachHref(workspaceId, { view: 'groups', groups: 'all' })}
          >
            {W.allGroups}
          </Link>
        ) : null}
      </div>
    );
    footer = <Footer back={back}>{primary('groups', W.finish)}</Footer>;
  } else {
    body = (
      <div className="flex flex-col gap-4" data-testid="outreach-setup-done">
        <ul className="flex flex-col gap-2">
          {setupSummary(setup, setup.settingsSaved ? me.settings : null, me.timezone).map(
            (line) => (
              <li
                key={line}
                className="flex items-start gap-2 text-[14px]"
                suppressHydrationWarning
              >
                <Check className="mt-0.5 h-4 w-4 flex-none text-success-text" strokeWidth={2} />
                {line}
              </li>
            ),
          )}
        </ul>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="secondary"
            onClick={() => setPhone(true)}
            data-testid="outreach-setup-phone"
          >
            {W.getPhone}
          </Button>
          <span className="text-[13px] text-text-2">{W.phone}</span>
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
        <PhoneAppDialog open={phone} onOpenChange={setPhone} />
      </div>
    );
    footer = (
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
    );
  }

  const index = at === 'done' || at === 'welcome' ? -1 : steps.indexOf(at);
  const banner =
    fromExtension && (at === 'welcome' || at === steps[0]) ? (
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
        settingUp={W.settingUp(businessName)}
        finishLater={at === 'done' ? <span /> : laterButton}
      >
        <SetupCard
          testId="outreach-setup"
          screen={at}
          counter={
            at === 'done' || at === 'welcome'
              ? W.title
              : W.counter(index + 1, steps.length, W.steps[at].name)
          }
          title={
            at === 'done' ? W.done.title : at === 'welcome' ? W.welcome.title : W.steps[at].title
          }
          hint={
            at === 'done'
              ? W.done.hint
              : at === 'welcome'
                ? W.welcome.hint
                : at === 'playbooks' && !setup.canManage
                  ? W.steps.playbooks.hintMember
                  : at === 'settings' && setup.settingsSaved
                    ? W.steps.settings.hintSaved
                    : W.steps[at].hint
          }
          banner={banner}
          summary={
            at === 'done' || at === 'welcome'
              ? null
              : setupSummary(setup, setup.settingsSaved ? me.settings : null, me.timezone)
          }
          footer={footer}
        >
          {body}
        </SetupCard>
      </SetupPage>
    </div>
  );
}

/**
 * The slim line on Social Outreach's tabs until the setup is finished: "Finish setting up Social Outreach: 2 of 5
 * done." with Carry on and Hide. Shown only to someone who started it or never saved their own settings
 * (`showsSetupBanner`), so people who have used it for weeks aren't nagged.
 */
export function SetupBanner({ workspaceId }: { workspaceId: string }) {
  const [setup, setSetup] = useState<Setup | null>(null);
  const version = useLiveVersion(['outreach_setup', 'outreach_automation']);
  const { busy, act } = useAct();
  useEffect(() => {
    let live = true;
    void apiBrowser()
      .POST('/v1/queries/outreach.setup', { body: { workspaceId } })
      .then((r) => {
        if (live && r.data) setSetup(r.data);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [workspaceId, version]);
  if (!setup?.banner) return null;
  return (
    <div
      className="mb-4 flex flex-wrap items-center gap-3 rounded-menu bg-accent-soft px-3.5 py-2.5 text-[13.5px] text-accent-text"
      data-testid="outreach-setup-banner"
    >
      <span className="min-w-0 flex-1">
        {W.banner(stepsDone(setup.reached, setup.steps), setup.steps.length)}
      </span>
      <ButtonLink
        size="sm"
        variant="primary"
        href={outreachSetupPath(workspaceId)}
        data-testid="outreach-setup-carry-on"
      >
        {W.carryOn}
      </ButtonLink>
      <Button
        size="sm"
        variant="ghost"
        loading={busy === 'hide'}
        onClick={() =>
          void act('hide', async () => setSetup(await saveSetup(workspaceId, { hideBanner: true })))
        }
        data-testid="outreach-setup-hide"
      >
        {W.hide}
      </Button>
    </div>
  );
}
