'use client';
/**
 * Social Outreach's Settings tab, a page for each part (docs/outreach.md, decision 73; Chris, 16 Oct 2026, the "Social
 * Outreach settings by platform" design). The menu beside it (./home.tsx) opens one at a time (`?part=`):
 *
 * - **General**: the person's own on every network: how the AI writes for them, their working hours, and how their
 *   phone and the extension tell them what waits; Set up again; and for owners and admins, **For your team**: the
 *   choices people may pick, where a new person starts, where the team gets the extension (./extension-link.tsx),
 *   and the business's other Social Outreach settings (./business-settings.tsx).
 * - **Each network**: On for you; what the extension does there on its own and along the way, in the network's words;
 *   on Facebook, the extension's switches; the person's daily limits there as they stand; **Your profile** there, read
 *   by their computer and checked by the AI, with the words to put in (./get-ready.tsx's sheet, decision 80), on a
 *   network still looked at too; and for owners and admins, **For your team on** it: whether the team may use it, and
 *   its daily limits for each person.
 * - **Your computer** (./live-view.tsx) and **Start fresh**, for owners (./start-fresh.tsx).
 *
 * Owners and admins pick whose settings they see, above every part; the person sees who changed theirs last. Every
 * change saves as it's made (./use-autosave.ts): the person's through `outreach.automation.save`, the business's
 * through `addon.save_settings`, and the line under the page's title says how it went. No Save buttons, but the
 * extension's link, a box to type in that keeps its own.
 */
import {
  choicesFor,
  freshWords,
  hoursProblem,
  NOT_FRESH,
  OTHER_PLATFORMS,
  wheelsWords,
  type AutomationSettings,
  type BusinessRules,
  type NetworkChoices,
  type OtherPlatform,
} from '@hfos/core/addons/outreach/automation';
import { outreachSettings, settingsToSave } from '@hfos/core/addons/outreach/chat-read';
import {
  NETWORK_WORDS as NW,
  networksOn,
  withNetwork,
} from '@hfos/core/addons/outreach/network-words';
import { askableOn } from '@hfos/core/addons/outreach/asks';
import {
  isLooking,
  PLATFORM_KEYS,
  PLATFORMS,
  type Platform,
} from '@hfos/core/addons/outreach/networks';
import { allowedOn, REPORT_WORDS } from '@hfos/core/addons/outreach/reports';
import {
  isNetworkPart,
  limitsShownOn,
  SETTINGS_WORDS as S,
  type SettingsPart,
} from '@hfos/core/addons/outreach/settings-parts';
import { profileWordsOn, READY_WORDS as R, tickCounts } from '@hfos/core/addons/outreach/readiness';
import { checkCounts } from '@hfos/core/addons/outreach/profile-check';
import { networkSteps, outreachSetupPath, SETUP_WORDS } from '@hfos/core/addons/outreach/setup';
import { START_FRESH_WORDS as F, OUTREACH_WORDS as W } from '@hfos/core/addons/outreach/words';
import { AlertCircle, Check, Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button, ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { useLiveRefresh } from '@/lib/realtime/live-provider';
import { cn } from '@/lib/utils';
import { outreachHref } from './address';
import { countriesProblem, TeamSettingsFields, type TeamSettings } from './business-settings';
import { AskButton } from './asks';
import { ExtensionDownload } from './extension-download';
import { ExtensionLinkForm } from './extension-link';
import { ProfileSheet } from './get-ready';
import { ComputersCard, useServerNow } from './live-view';
import {
  AllowedPicks,
  DefaultsFold,
  ExtensionTicks,
  HoursPart,
  LimitsFields,
  NetworkModes,
  NetworkTicks,
  Part,
  PushesPart,
  select,
  Tick,
  VoicePart,
  wheelsOf,
} from './settings-view';
import { StartFresh } from './start-fresh';
import type { Asks, Automation, AutomationPeople, Live, Readiness } from './types';
import { useAutosave, type Autosave, type SaveStatus } from './use-autosave';
import { ProfilesSideBySide } from './profile-whole';

/** The business's settings the Settings pages change, as they read them: the extension's link has its own box. */
function teamOf(settings: unknown): TeamSettings {
  const { extensionLink: _link, ...rest } = outreachSettings(settings);
  return rest;
}

/** What the business allows, as the person's pages show it. */
type Rules = Pick<
  BusinessRules,
  | 'sendingAllowed'
  | 'repliesAllowed'
  | 'postingAllowed'
  | 'dailyLimits'
  | 'networksAllowed'
  | 'networkLimits'
>;

interface Props {
  workspaceId: string;
  /** The part the address asked for. */
  part: SettingsPart;
  /** Whose settings are shown: the person's own, or someone else's for an owner or admin. */
  me: Automation;
  /** Whether they're the person's own. */
  mine: boolean;
  /** Everyone who uses Social Outreach, for owners and admins. */
  people: AutomationPeople | null;
  /** The business's Social Outreach settings, for owners and admins. */
  business: Readonly<Record<string, unknown>> | null;
  /** An owner, who may erase everything and start fresh (`addons.purge`). */
  canStartFresh?: boolean;
  /** The person's computers: null when they couldn't be had, or on another part. */
  live?: Live | null;
  /** The business's own link to the extension's zip, when it gave one: else HandsFreeOS's own. */
  extensionLink?: string | null;
  /** On a network's page, the person's own: Check LinkedIn's ask, and their computer (decision 74). */
  asks?: Asks | null;
  /** On a network's page, the person's own profile there, read and checked (decision 80). */
  readiness?: Readiness | null;
}

export function SettingsView(props: Props) {
  // A change made elsewhere (the person on another screen, or an owner) shows here too.
  useLiveRefresh(['outreach_automation', 'addon']);
  // A form for each person: picking someone else starts the forms again from theirs.
  return <SettingsPages key={props.me.userId} {...props} />;
}

function SettingsPages({
  workspaceId,
  part,
  me,
  mine,
  people,
  business,
  canStartFresh = false,
  live = null,
  extensionLink = null,
  asks = null,
  readiness = null,
}: Props) {
  const router = useRouter();
  const person = useAutosave<AutomationSettings>(
    me.settings,
    async (settings) =>
      unwrap(
        await apiBrowser().POST('/v1/commands/outreach.automation.save', {
          body: { workspaceId, userId: me.userId, settings },
        }),
      ).settings,
    // Hours caught halfway (a start moved past the end, no day ticked) wait, saying why under them.
    (value) => hoursProblem(value.hours) !== null,
  );
  // The business's settings as the page was last drawn with them: a save keeps the extension's link as it is there.
  const businessNow = useRef(business);
  useEffect(() => {
    businessNow.current = business;
  });
  const team = useAutosave<TeamSettings>(
    teamOf(business),
    async (value) => {
      const settings = settingsToSave(businessNow.current, value);
      unwrap(
        await apiBrowser().POST('/v1/commands/addon.save_settings', {
          body: { workspaceId, addonId: 'outreach', settings },
        }),
      );
      return teamOf(settings);
    },
    // Only these countries, with none picked yet, waits for one.
    (value) => countriesProblem(value.countries) !== null,
  );
  // What the business allows: an owner's or admin's own changes show at once.
  const rules: Rules = business ? team.value.rules : me.rules;
  const statuses = business ? [person.status, team.status] : [person.status];
  const shown: SettingsPart =
    (part === 'computer' && !mine) || (part === 'fresh' && !canStartFresh) ? 'general' : part;
  return (
    <div className="space-y-5" data-testid="outreach-settings-view" data-part={shown}>
      {people ? (
        <label className="flex flex-wrap items-center gap-2 text-[13px]">
          <span className="font-semibold">{W.settingsFor}</span>
          <select
            className={select}
            value={me.userId}
            onChange={(e) =>
              router.push(
                outreachHref(workspaceId, {
                  view: 'settings',
                  part: shown === 'computer' || shown === 'fresh' ? 'general' : shown,
                  for: e.target.value,
                }),
              )
            }
            data-testid="outreach-settings-for"
          >
            {people.people.map((p) => (
              <option key={p.userId} value={p.userId}>
                {p.name}
                {p.saved ? '' : W.notSetYet}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {isNetworkPart(shown) ? (
        <NetworkPage
          // Its switch's line is its own.
          key={shown}
          platform={shown}
          me={me}
          rules={rules}
          person={person}
          team={business ? team : null}
          statuses={statuses}
          workspaceId={workspaceId}
          asks={mine ? asks : null}
          readiness={mine ? readiness : null}
        />
      ) : shown === 'computer' ? (
        <>
          <PageTitle title={W.settingsParts.computer} about={S.computerAbout} />
          <Card className="space-y-3 p-5" data-testid="outreach-settings-computer">
            {live ? <ComputerPart workspaceId={workspaceId} live={live} /> : null}
            <ExtensionDownload link={extensionLink} folded />
          </Card>
        </>
      ) : shown === 'fresh' ? (
        <>
          <PageTitle title={F.title} about={F.about} />
          <StartFresh workspaceId={workspaceId} />
        </>
      ) : (
        <>
          <GeneralPage
            workspaceId={workspaceId}
            me={me}
            mine={mine}
            business={business}
            person={person}
            team={team}
            statuses={statuses}
          />
          {/* Their own profiles on every network, side by side (decision 84). */}
          {mine ? (
            <ProfilesSideBySide
              workspaceId={workspaceId}
              networks={networksOn(person.value, rules.networksAllowed)}
            />
          ) : null}
        </>
      )}
    </div>
  );
}

/** A page's title, the line about it, what sits beside them (a network's switch), and how its saving stands. */
function PageTitle({
  title,
  about,
  aside,
  children,
}: {
  title: string;
  about: string;
  aside?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2
            className="text-2xl font-semibold leading-tight tracking-tight"
            data-testid="outreach-settings-title"
          >
            {title}
          </h2>
          <p className="mt-1 text-text-2">{about}</p>
        </div>
        {aside}
      </div>
      {children}
    </div>
  );
}

const newest = (statuses: readonly SaveStatus[]) =>
  statuses
    .flatMap((s) => (s.state === 'saved' || s.state === 'failed' ? [s] : []))
    .sort((a, b) => b.at - a.at)[0];

/**
 * How the page's saving stands: that changes save as they're made, Saving…, Saved, or the server's words when one
 * was refused (and the form put back as it's kept). The newest news of the page's forms.
 */
function SaveLine({ statuses }: { statuses: readonly SaveStatus[] }) {
  const saving = statuses.some((s) => s.state === 'saving');
  const last = newest(statuses);
  if (!saving && last?.state === 'failed')
    return (
      <p
        role="alert"
        className="flex items-start gap-2 rounded-menu bg-danger-soft px-3 py-2 text-[13px] text-danger-text"
        data-testid="outreach-settings-status"
        data-state="failed"
      >
        <AlertCircle className="mt-0.5 h-4 w-4 flex-none" strokeWidth={1.75} aria-hidden />
        {last.words}
      </p>
    );
  const state = saving ? 'saving' : last ? 'saved' : 'idle';
  return (
    <p
      role="status"
      className={cn(
        'inline-flex min-h-7 items-center gap-1.5 rounded-full px-2.5 py-1 text-[12.5px] font-medium',
        saving ? 'bg-card-2 text-text-2' : 'bg-success-soft text-success-text',
      )}
      data-testid="outreach-settings-status"
      data-state={state}
    >
      {saving ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.75} aria-hidden />
      ) : (
        <Check className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
      )}
      {saving ? S.saving : last ? S.saved : S.autosaves}
    </p>
  );
}

/** The person's own, on every network; and for owners and admins, what's the business's on every network. */
function GeneralPage({
  workspaceId,
  me,
  mine,
  business,
  person,
  team,
  statuses,
}: {
  workspaceId: string;
  me: Automation;
  mine: boolean;
  business: Readonly<Record<string, unknown>> | null;
  person: Autosave<AutomationSettings>;
  team: Autosave<TeamSettings>;
  statuses: readonly SaveStatus[];
}) {
  const own = { value: person.value, onChange: person.set, card: true, testId: 'outreach-my' };
  const setRules = (rules: BusinessRules) => team.set((v) => ({ ...v, rules }));
  return (
    <>
      <PageTitle title={S.general} about={S.generalAbout}>
        <SaveLine statuses={statuses} />
      </PageTitle>
      {mine ? (
        <div
          className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-border bg-card px-4 py-3"
          data-testid="outreach-setup-again"
        >
          <p className="min-w-0 flex-1 text-[13px] text-text-2">
            {business ? SETUP_WORDS.againAboutManage : SETUP_WORDS.againAbout}
          </p>
          <ButtonLink
            size="sm"
            href={outreachSetupPath(workspaceId, { again: true })}
            data-testid="outreach-setup-again-open"
          >
            {SETUP_WORDS.again}
          </ButtonLink>
        </div>
      ) : null}
      {me.changedBy ? (
        <p className="text-[13px] text-text-2" data-testid="outreach-settings-changed-by">
          {W.changedBy(me.changedBy)}
        </p>
      ) : null}
      <VoicePart {...own} />
      <HoursPart {...own} timezone={me.timezone} />
      <PushesPart {...own} switches />
      {business ? (
        <Part card title={S.team} badge={S.teamWho} about={S.teamAbout} testId="outreach-team">
          <AllowedPicks rules={team.value.rules} onChange={setRules} />
          <div className="border-t border-border pt-4">
            <DefaultsFold rules={team.value.rules} onChange={setRules} timezone={me.timezone} />
          </div>
          <div className="border-t border-border pt-4">
            <ExtensionLinkForm
              key={String(business.extensionLink ?? '')}
              workspaceId={workspaceId}
              settings={business}
            />
          </div>
          <div className="border-t border-border pt-4">
            <TeamSettingsFields
              value={team.value}
              onChange={(change) => team.set((v) => ({ ...v, ...change }))}
            />
          </div>
        </Part>
      ) : (
        <p className="text-[13px] text-text-2" data-testid="outreach-settings-not-owner">
          {W.abouts.notOwner}
        </p>
      )}
    </>
  );
}

/**
 * A network's page, in its words: the person's switch for it, which saves at once with a line beside it once done
 * (Chris, 2026-10-16), what it does there, and their limits there; then the team's say on it for owners and admins.
 */
function NetworkPage({
  platform,
  me,
  rules,
  person,
  team,
  statuses,
  workspaceId,
  asks,
  readiness,
}: {
  platform: Platform;
  me: Automation;
  rules: Rules;
  person: Autosave<AutomationSettings>;
  /** The business's, for owners and admins. */
  team: Autosave<TeamSettings> | null;
  statuses: readonly SaveStatus[];
  workspaceId: string;
  /** The person's own: Check LinkedIn's ask, and their computer; null on someone else's settings. */
  asks: Asks | null;
  /** The person's own profile on the network, read and checked: null on someone else's settings. */
  readiness: Readiness | null;
}) {
  const [switching, setSwitching] = useState(false);
  const [said, setSaid] = useState<{ readonly ok: boolean; readonly words: string } | null>(null);
  const name = PLATFORMS[platform];
  const value = person.value;
  const may = rules.networksAllowed.includes(platform);
  const on = may && networksOn(value, rules.networksAllowed).includes(platform);
  const choices = choicesFor(value, platform);
  const set = (change: Partial<NetworkChoices>) =>
    person.set((v) => withNetwork(v, platform, change));
  const wheels = wheelsOf(me, platform);
  // Half limits while they're new there (decision 96): its own on each network. None from a server before it.
  const fresh = me.fresh?.[platform] ?? NOT_FRESH;
  // Facebook's choices are the settings' own fields, and its extension's switches are the person's.
  const facebook = !OTHER_PLATFORMS.includes(platform as OtherPlatform);
  // A network still looked at (decision 78) has nothing to choose yet: only Chrome's say and its Check.
  const looking = isLooking(platform);
  const testId = `outreach-my-networks-${platform}`;
  const flip = (next: boolean) => {
    setSwitching(true);
    setSaid(null);
    person.set(
      (v) => withNetwork(v, platform, { on: next }),
      (ok, words) => {
        setSwitching(false);
        setSaid({ ok, words: ok ? NW.switched(name, next) : (words ?? '') });
      },
    );
  };
  return (
    <>
      <PageTitle
        title={name}
        about={S.networkAbout(name)}
        aside={
          <div className="flex items-center gap-2.5 rounded-[10px] border border-border bg-card px-3 py-2">
            <span className="text-[14px] font-medium">{S.onForYou}</span>
            <Switch
              checked={on}
              onChange={flip}
              label={name}
              disabled={!may}
              busy={switching}
              testId={`${testId}-on`}
            />
          </div>
        }
      >
        {said ? (
          <p
            role={said.ok ? 'status' : 'alert'}
            className={cn('text-[13px]', said.ok ? 'text-success-text' : 'text-danger-text')}
            data-testid={`${testId}-${said.ok ? 'saved' : 'problem'}`}
          >
            {said.words}
          </p>
        ) : null}
        <SaveLine statuses={statuses} />
      </PageTitle>
      {on && !looking && asks ? (
        // Turned on: its own short setup, from Chrome's Allow to a first day there (decision 83).
        <div
          className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-border bg-card px-4 py-3"
          data-testid={`${testId}-set-up`}
        >
          <p className="min-w-0 flex-[1_1_260px] text-[13px] text-text-2">
            {SETUP_WORDS.setUpNetworkAbout(platform)}
          </p>
          <ButtonLink
            size="sm"
            variant="secondary"
            href={outreachSetupPath(workspaceId, {
              step: { net: platform, step: networkSteps(platform)[0]! },
            })}
          >
            {SETUP_WORDS.setUpNetwork(name)}
          </ButtonLink>
        </div>
      ) : null}
      {!may ? (
        <p className="text-[13px] text-text-2" data-testid={`${testId}-not-allowed`}>
          {NW.notAllowed(name, team !== null)}
        </p>
      ) : !on ? (
        <p
          className="rounded-card border border-dashed border-border-strong px-5 py-4 text-[13px] text-text-2"
          data-testid={`${testId}-off`}
        >
          {NW.off(name)}
        </p>
      ) : (
        <>
          {facebook ? null : asks?.computer && !allowedOn(asks.computer.allowed, platform) ? (
            // Their computer said Chrome hasn't let it on the network: its asks there wait for this.
            <p
              role="alert"
              className="rounded-menu bg-warning-soft px-3.5 py-2.5 text-[13px] text-warning-text"
              data-testid={`${testId}-chrome-blocked`}
            >
              {REPORT_WORDS.notAllowed(asks.computer.name, platform)}
            </p>
          ) : (
            <p
              className="rounded-menu bg-accent-soft px-3.5 py-2.5 text-[13px] text-accent-text"
              data-testid={`${testId}-chrome`}
            >
              {S.builtIn(name)}
            </p>
          )}
          {looking ? (
            <p
              className="rounded-card border border-dashed border-border-strong px-5 py-4 text-[13px] text-text-2"
              data-testid={`${testId}-looking`}
            >
              {NW.looking(name)}
            </p>
          ) : (
            <>
              {wheels.on ? (
                <p
                  className="rounded-menu bg-warning-soft px-3.5 py-2.5 text-[13px] text-warning-text"
                  data-testid={`${testId}-wheels`}
                >
                  {wheelsWords(wheels)}
                </p>
              ) : null}
              {fresh.on ? (
                <p
                  className="rounded-menu bg-card-2 px-3.5 py-2.5 text-[13px] text-text-2"
                  data-testid={`${testId}-fresh`}
                >
                  {freshWords(fresh, platform)}
                </p>
              ) : null}
              <NetworkModes
                card
                platform={platform}
                value={choices}
                onChange={set}
                sendingAllowed={rules.sendingAllowed}
                repliesAllowed={rules.repliesAllowed}
                postingAllowed={rules.postingAllowed}
                wheelsStart={!wheels.from}
                testId={testId}
              />
              <NetworkTicks
                card
                platform={platform}
                value={choices}
                onChange={set}
                testId={testId}
              />
              {facebook ? (
                <ExtensionTicks
                  card
                  switches
                  value={value}
                  onChange={person.set}
                  testId="outreach-my"
                />
              ) : null}
              <Part
                card
                title={S.yourLimits(name)}
                about={NW.limitsAbout(name)}
                testId={`${testId}-limits`}
              >
                <ul className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
                  {limitsShownOn(platform, rules, wheels.on || fresh.on).map((l) => (
                    <li
                      key={l.key}
                      className="min-w-0 rounded-[10px] bg-card-2 p-3"
                      data-testid={`${testId}-limit-${l.key}`}
                    >
                      <div className="text-xl font-semibold tabular-nums">
                        {l.most.toLocaleString('en-US')}
                      </div>
                      <div className="text-[12.5px] text-text-2">{l.label}</div>
                      {l.note ? <div className="text-[12px] text-text-3">{l.note}</div> : null}
                    </li>
                  ))}
                </ul>
                <div className="mt-4 border-t border-border pt-4">
                  <Tick
                    switches
                    words={[NW.young(name), NW.youngAbout(name)]}
                    checked={choices.young}
                    onChange={(young) => set({ young })}
                    testId={`${testId}-young`}
                  />
                </div>
              </Part>
            </>
          )}
          {asks && readiness ? (
            <ProfilePart
              workspaceId={workspaceId}
              platform={platform}
              readiness={readiness}
              asks={asks}
              testId={`${testId}-profile`}
            />
          ) : null}
          {asks && askableOn(platform, 'checkup') ? (
            <Part
              card
              title={REPORT_WORDS.checkupTitle(name)}
              about={REPORT_WORDS.checkupAbout(platform)}
              testId={`${testId}-checkup`}
            >
              <AskButton
                workspaceId={workspaceId}
                asks={asks}
                ask={{ kind: 'checkup' }}
                platform={platform}
                label={REPORT_WORDS.checkupTitle(name)}
                testId={`${testId}-checkup-ask`}
              />
            </Part>
          ) : null}
        </>
      )}
      {team ? <TeamOnNetwork platform={platform} team={team} /> : null}
    </>
  );
}

/**
 * The person's profile on the network (decision 80): how far it is, and Get ready's sheet to read it, see the AI's check
 * and put its words in, here on every network, one still looked at too. What their computer reads or puts in shows as
 * it ends.
 */
function ProfilePart({
  workspaceId,
  platform,
  readiness: start,
  asks,
  testId,
}: {
  workspaceId: string;
  platform: Platform;
  readiness: Readiness;
  asks: Asks;
  testId: string;
}) {
  useLiveRefresh(['outreach_setup', 'outreach_ask'], 800);
  const router = useRouter();
  const [readiness, setReadiness] = useState(start);
  useEffect(() => setReadiness(start), [start]);
  // A refresh already on its way from before a tick would put it back as it was; one after it brings the tick.
  const changed = (next: Readiness) => {
    setReadiness(next);
    router.refresh();
  };
  const [open, setOpen] = useState(false);
  const P = profileWordsOn(platform);
  const live = readiness.offer?.version ?? null;
  const check = checkCounts(readiness.profileCheck, live) ? readiness.profileCheck : null;
  const right = P.items.filter(
    (i) => tickCounts(readiness.profile[i.item], live) || check?.items[i.item]?.ok === true,
  ).length;
  return (
    <Part card title={S.yourProfile(PLATFORMS[platform])} about={P.hint} testId={testId}>
      <p className="text-[13px] text-text-2" data-testid={`${testId}-state`}>
        {check || right ? S.profileRight(right, P.items.length) : P.notRead}
      </p>
      <div>
        <Button
          size="sm"
          variant={check ? 'secondary' : 'primary'}
          onClick={() => setOpen(true)}
          data-testid={`${testId}-open`}
        >
          {R.items.profile.go}
        </Button>
      </div>
      <ProfileSheet
        workspaceId={workspaceId}
        readiness={readiness}
        asks={asks}
        open={open}
        onClose={() => setOpen(false)}
        onChange={changed}
      />
    </Part>
  );
}

/** For owners and admins, a network's say for the whole team: whether it may use it, and each person's daily limits. */
function TeamOnNetwork({ platform, team }: { platform: Platform; team: Autosave<TeamSettings> }) {
  const name = PLATFORMS[platform];
  const { rules } = team.value;
  // Facebook is always allowed (`BusinessRules.networksAllowed`).
  const always = !OTHER_PLATFORMS.includes(platform as OtherPlatform);
  const allowed = always || rules.networksAllowed.includes(platform);
  return (
    <Part card title={S.teamOn(name)} badge={S.teamWho} testId={`outreach-team-${platform}`}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="text-[14px] font-semibold">{S.teamMay(name)}</div>
          {always ? null : <div className="text-[13px] text-text-2">{S.teamMayAbout(name)}</div>}
        </div>
        {always ? (
          <Badge variant="gray">{NW.alwaysAllowed}</Badge>
        ) : (
          <Switch
            checked={allowed}
            onChange={(next) =>
              team.set((v) => ({
                ...v,
                rules: {
                  ...v.rules,
                  networksAllowed: PLATFORM_KEYS.filter((p) =>
                    p === platform ? next : v.rules.networksAllowed.includes(p),
                  ),
                },
              }))
            }
            label={S.teamMay(name)}
            testId={`outreach-rules-network-${platform}`}
          />
        )}
      </div>
      {allowed && !isLooking(platform) ? (
        <div className="border-t border-border pt-4">
          <LimitsFields
            platform={platform}
            rules={rules}
            title={W.sections.limits}
            onChange={(next, typed) =>
              (typed ? team.type : team.set)((v) => ({ ...v, rules: next }))
            }
            onBlur={team.flush}
          />
        </div>
      ) : null}
    </Part>
  );
}

/** The person's computers, to rename; or how to get one going. */
function ComputerPart({ workspaceId, live }: { workspaceId: string; live: Live }) {
  const now = useServerNow(live.now);
  return live.computers.length ? (
    <ComputersCard workspaceId={workspaceId} live={live} now={now} bare />
  ) : (
    <p className="text-[13px] text-text-2">{W.noComputer}</p>
  );
}
