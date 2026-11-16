import {
  autopilotOn,
  businessLimitsOn,
  choicesFor,
  freshWords,
  groupModeChange,
  groupModeOf,
  halvedNow,
  NOT_FRESH,
  OTHER_PLATFORMS,
  requestModeChange,
  wheelsWords,
  type AutomationOutput,
  type AutomationSettings,
  type OtherPlatform,
  type WheelsState,
} from '@hfos/core/addons/outreach/automation';
import { outreachSettings, type OutreachSettings } from '@hfos/core/addons/outreach/chat-read';
import { DAILY_STEPS, type DailyStep } from '@hfos/core/addons/outreach/limits';
import {
  firstSentence,
  HANDS_OFF_WORDS as H,
  handsOffOf,
  NETWORK_PAGE_WORDS as P,
  withHandsOff,
  type HandsOff,
} from '@hfos/core/addons/outreach/hands-off';
import {
  networkStatus,
  type NetworkStatus,
  type StatusLive,
} from '@hfos/core/addons/outreach/network-status';
import {
  dailyWordsOn,
  groupsChoiceOn,
  helpfulOn,
  NETWORK_WORDS as NW,
  networksOn,
  noRunnerWords,
  requestsChoiceOn,
  ticksOn,
  ticksShownOn,
  tidyChoiceOn,
  withNetwork,
} from '@hfos/core/addons/outreach/network-words';
import {
  isLooking,
  NETWORKS,
  networkLimitsNow,
  PLATFORMS,
  runsOnItsOwn,
  type Platform,
} from '@hfos/core/addons/outreach/networks';
import { askableOn, type AsksOutput } from '@hfos/core/addons/outreach/asks';
import { LIKE_YOURS_WORDS } from '@hfos/core/addons/outreach/like-yours';
import { OUTREACH_PAGES } from '@hfos/core/addons/outreach/pages';
import { checkCounts } from '@hfos/core/addons/outreach/profile-check';
import {
  profileWordsOn,
  READY_WORDS,
  tickCounts,
  type ReadinessOutput,
} from '@hfos/core/addons/outreach/readiness';
import { allowedOn, REPORT_WORDS } from '@hfos/core/addons/outreach/reports';
import { SETTINGS_WORDS } from '@hfos/core/addons/outreach/settings-parts';
import { OUTREACH_WORDS as W } from '@hfos/core/addons/outreach/words';
import * as React from 'react';
import { View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Text } from '@/components/ui/text';

import { AskButton, type AskActions } from './asks';
import { useAutosave, type Autosave, type SaveState } from './autosave';
import { Note } from './kit';
import { ProfileList, type ProfileProps } from './ready';
import { HandsOffPart, MoreSettings, NetworkStatusCard } from './settings-hands-off';
import {
  ExtensionTicks,
  NetworkModes,
  NetworkTicks,
  Section,
  Stepper,
  StepperRow,
  TeamHeading,
  Tick,
} from './settings-bits';

/**
 * A network's page of Settings on the phone (Chris, 2026-10-16: a page for each network, every change saved as it's
 * made): its switch for the person, On for you, and while it's on what the extension does there on its own, along the
 * way, Facebook's switches while the person uses it themselves (or, on another network, how Chrome lets the extension
 * on), their daily limits there as they stand, and their profile there (decision 80), on a network still looked at
 * too. For owners and admins, the team's say on it: whether the team may use it (Facebook always) and each person's
 * daily limits there. A network the business doesn't use says only why.
 */

/**
 * A network's status card at the top of its page (decision 170): its live view, how many things wait on the person
 * there under Needs you, and how many of Autopilot's people there wait for their OK.
 */
export interface NetworkHere {
  readonly live: StatusLive;
  readonly waiting: number;
  readonly people: number;
}

/** A network's training wheels: Facebook's, or another network's own. */
const wheelsOf = (automation: AutomationOutput, platform: Platform): WheelsState =>
  OTHER_PLATFORMS.includes(platform as OtherPlatform)
    ? automation.networkWheels[platform as OtherPlatform]
    : automation.wheels;

/** The person's own on one network: their part of their settings form. */
export function NetworkMine({
  platform,
  automation,
  form,
  manages,
  online,
  asks = null,
  askActions = null,
  profile = null,
  onLikeYours = null,
  here = null,
  onHandsOff = null,
  onAct = null,
  onToday = null,
}: {
  platform: Platform;
  automation: AutomationOutput;
  form: Autosave<AutomationSettings>;
  manages: boolean;
  online: boolean;
  /** On Instagram, opens Find people, where the accounts like yours are now (decision 128). */
  onLikeYours?: (() => void) | null;
  /** The person's own asks of their computer (Check LinkedIn) and the computer: null on someone else's settings. */
  asks?: AsksOutput | null;
  askActions?: AskActions | null;
  /** Their own profile on the network, read and checked (decision 80): null on someone else's settings. */
  profile?: ProfileProps | null;
  /** The status card's live view and what waits there (decision 170): null on someone else's, or when not had. */
  here?: NetworkHere | null;
  /** A level picked under How hands-off? (decision 170); without it, the form changes as any pick does. */
  onHandsOff?: ((level: HandsOff) => void) | null;
  /** The status card's button, and its Today. */
  onAct?: ((act: NonNullable<NetworkStatus['act']>) => void) | null;
  onToday?: (() => void) | null;
}) {
  const p = platform;
  const name = PLATFORMS[p];
  const testID = `settings-networks-${p}`;
  const value = form.value;
  const rules = automation.rules;
  const allowed = rules.networksAllowed;
  const may = allowed.includes(p);
  const on = may && networksOn(value, allowed).includes(p);
  const choices = choicesFor(value, p);
  const set = (change: Parameters<typeof withNetwork>[2]) =>
    form.change((v) => withNetwork(v, p, change));
  const wheels = wheelsOf(automation, p);
  // Half limits while they're new there (decision 96), none from a server before it.
  const fresh = automation.fresh?.[p] ?? NOT_FRESH;
  const limits = networkLimitsNow(
    p,
    halvedNow({ wheels, fresh, choices }),
    businessLimitsOn(rules, p),
  );
  const words = dailyWordsOn(p);
  const disabled = !online;
  const [allLimits, setAllLimits] = React.useState(false);
  const runs = runsOnItsOwn(p);
  const level = handsOffOf(choices);
  const piloted = choices.autopilot === true;
  const computer = asks?.computer ?? null;
  // Facebook's sites are the extension's own (decision 77): only another network waits for Chrome's Allow.
  const blocked = Boolean(p !== 'facebook' && computer && !allowedOn(computer.allowed, p));
  const status = here
    ? networkStatus({
        platform: p,
        live: here.live,
        level,
        waiting: here.waiting,
        people: here.people,
        chromeBlocked: blocked,
        now: Date.now(),
      })
    : null;
  const ticks = ticksOn(p);
  const requests = requestsChoiceOn(p);
  const groups = groupsChoiceOn(p);
  const tidy = tidyChoiceOn(p);
  const unfriends = tidy.options.some((o) => o.key === 'unfriend');
  const shownTicks = ticksShownOn(p).filter((k) => !(requests && k === 'confirmRequests'));
  const limitsLine = P.limitsLine(
    DAILY_STEPS.filter((s) => limits[s] > 0).map(
      (s) => `${limits[s].toLocaleString('en-US')} ${words[s].many}`,
    ),
  );
  const halved = wheels.on
    ? wheelsWords(wheels, choices.fullSpeed)
    : fresh.on && !choices.fullSpeed
      ? freshWords(fresh, p)
      : null;
  const working = networksOn(value, allowed);
  const everywhere = piloted && working.length > 1 && working.every((n) => autopilotOn(value, n));
  const pick = (l: HandsOff) =>
    onHandsOff ? onHandsOff(l) : form.change((v) => withHandsOff(v, p, l, rules).settings);
  return (
    <>
      <Card className="px-4 py-3.5">
        <Tick
          label={SETTINGS_WORDS.onForYou}
          checked={on}
          // The switch saves at once, as every change does, and the page's line says what it did.
          onChange={(next) =>
            form.change((v) => withNetwork(v, p, { on: next }), {
              said: NW.switched(name, next),
            })
          }
          disabled={!may || disabled}
          testID={`${testID}-on`}
        />
      </Card>
      {!may ? (
        <Note testID={`${testID}-not-allowed`}>{NW.notAllowed(name, manages)}</Note>
      ) : !on ? (
        <Note testID={`${testID}-off`}>{NW.off(name)}</Note>
      ) : isLooking(p) ? (
        // Still looked at (decision 78): nothing to choose yet, only Chrome's say and its Check.
        <>
          <Note testID={`${testID}-looking`}>{NW.looking(name)}</Note>
          <NetworkComputer
            platform={p}
            asks={asks}
            actions={askActions}
            profile={profile}
            testID={testID}
          />
        </>
      ) : (
        <>
          {status ? (
            <NetworkStatusCard
              status={status}
              onAct={onAct}
              onToday={onToday}
              testID={`${testID}-status`}
            />
          ) : blocked && computer ? (
            // No status card to say so: what to press in Chrome, on its own.
            <Card className="bg-warning-soft px-4 py-3" testID={`${testID}-chrome-blocked`}>
              <Text className="text-[13px] leading-[18px] text-warning-text">
                {REPORT_WORDS.notAllowed(computer.name, p)}
              </Text>
            </Card>
          ) : null}
          {runs ? (
            <HandsOffPart
              platform={p}
              level={level}
              onPick={pick}
              rules={rules}
              manages={manages}
              disabled={disabled}
              note={piloted && wheels.on ? H.wheels : everywhere ? P.wholeAutopilot : null}
              testID={`${testID}-hands-off`}
            />
          ) : (
            <Note testID={`${testID}-no-runner`}>{noRunnerWords(p)}</Note>
          )}
          {shownTicks.length || requests || groups || runs ? (
            <Section boxed title={P.whatItDoes} testID={`${testID}-does`}>
              <View className="gap-3">
                {shownTicks.map((k) => (
                  <Tick
                    key={k}
                    label={ticks[k][0]}
                    about={firstSentence(ticks[k][1])}
                    checked={choices[k]}
                    onChange={(next) => set({ [k]: next })}
                    disabled={disabled}
                    testID={`${testID}-${k}`}
                  />
                ))}
                {groups ? (
                  <Tick
                    label={P.joinGroups}
                    about={P.joinGroupsAbout}
                    checked={groupModeOf(choices) === 'join'}
                    onChange={(next) => set(groupModeChange(next ? 'join' : 'mine'))}
                    disabled={disabled}
                    testID={`${testID}-groups`}
                  />
                ) : null}
                {runs ? (
                  <Tick
                    label={tidy.options.find((o) => o.key === 'cancel')?.label ?? tidy.label}
                    about={firstSentence(tidy.about)}
                    checked={choices.tidy !== 'off'}
                    onChange={(next) =>
                      set({
                        tidy: next ? (choices.tidy === 'unfriend' ? 'unfriend' : 'cancel') : 'off',
                      })
                    }
                    disabled={disabled}
                    testID={`${testID}-tidy`}
                  />
                ) : null}
                {requests ? (
                  <Tick
                    label={P.answerRequests(NETWORKS[p].words.friendRequests)}
                    about={piloted ? P.piloted : P.answerRequestsAbout}
                    checked={choices.confirmRequests}
                    onChange={(next) => set(requestModeChange(next ? 'fits' : 'mine'))}
                    disabled={disabled || piloted}
                    testID={`${testID}-requests`}
                  />
                ) : null}
              </View>
            </Section>
          ) : null}
          {p === 'facebook' ? (
            <ExtensionTicks
              value={value}
              onChange={form.change}
              boxed
              disabled={disabled}
              testID={testID}
            />
          ) : null}
          <Section boxed title={P.limits} testID={`${testID}-limits`}>
            <Note testID={`${testID}-limits-line`}>
              {halved ? `${limitsLine} ${halved}` : limitsLine}
            </Note>
            {allLimits ? (
              <View className="flex-row flex-wrap gap-2">
                {DAILY_STEPS.map((step) => (
                  <View
                    key={step}
                    className="min-w-[96px] flex-1 gap-0.5 rounded-menu bg-card-2 px-3 py-2.5"
                    testID={`${testID}-limit-${step}`}
                  >
                    <Text className="text-xl font-semibold tabular-nums">
                      {limits[step].toLocaleString('en-US')}
                    </Text>
                    <Text className="text-[12.5px] leading-[16px] text-text-2">
                      {words[step].label}
                    </Text>
                  </View>
                ))}
              </View>
            ) : null}
            <Button
              size="sm"
              variant="ghost"
              className="self-start"
              onPress={() => setAllLimits((a) => !a)}
              testID={`${testID}-limits-all`}
            >
              {allLimits ? P.hideLimits : P.showLimits}
            </Button>
            <Tick
              label={P.fullSpeed}
              about={NW.fullSpeedAbout(name)}
              checked={choices.fullSpeed}
              onChange={(fullSpeed) => set({ fullSpeed })}
              disabled={disabled}
              testID={`${testID}-full-speed`}
            />
          </Section>
          {asks && askActions && profile?.readiness ? (
            <NetworkProfile
              platform={p}
              readiness={profile.readiness}
              onTick={profile.onTick}
              asks={asks}
              actions={askActions}
              testID={`${testID}-profile`}
            />
          ) : null}
          <MoreSettings name={name} helpful={helpfulOn(p)} testID={`${testID}-more`}>
            {runs ? (
              <NetworkModes
                platform={p}
                value={choices}
                onChange={set}
                sendingAllowed={rules.sendingAllowed}
                repliesAllowed={rules.repliesAllowed}
                postingAllowed={rules.postingAllowed}
                wheelsFrom={wheels.from}
                piloted={piloted}
                sendingPart={false}
                repliesAbout={P.repliesAbout}
                boxed={false}
                disabled={disabled}
                testID={testID}
              />
            ) : null}
            {runs && level === 'each' && rules.sendingAllowed.includes('approve_all') ? (
              <Tick
                label={P.messagesFirst}
                about={P.messagesFirstAbout}
                checked={choices.sending === 'approve_all'}
                onChange={(next) => set({ sending: next ? 'approve_all' : 'steps' })}
                disabled={disabled}
                testID={`${testID}-messages-first`}
              />
            ) : null}
            {requests && choices.confirmRequests ? (
              <NetworkTicks
                platform={p}
                value={choices}
                onChange={set}
                piloted={piloted}
                only="requests"
                title={P.howItAnswers(NETWORKS[p].words.friendRequests)}
                boxed={false}
                disabled={disabled}
                testID={testID}
              />
            ) : null}
            {runs && unfriends && choices.tidy !== 'off' ? (
              <Tick
                label={P.unfriend}
                about={P.unfriendAbout}
                checked={choices.tidy === 'unfriend'}
                onChange={(next) => set({ tidy: next ? 'unfriend' : 'cancel' })}
                disabled={disabled}
                testID={`${testID}-unfriend`}
              />
            ) : null}
            <Tick
              label={NW.young(name)}
              about={NW.youngAbout(name)}
              checked={choices.young}
              onChange={(young) => set({ young })}
              disabled={disabled}
              testID={`${testID}-young`}
            />
            {p === 'instagram' && onLikeYours ? (
              <Section
                boxed={false}
                title={LIKE_YOURS_WORDS.title}
                about={LIKE_YOURS_WORDS.moved}
                testID={`${testID}-like-yours-moved`}
              >
                <Button
                  variant="secondary"
                  size="sm"
                  className="self-start"
                  onPress={onLikeYours}
                  testID={`${testID}-like-yours-open`}
                >
                  {OUTREACH_PAGES.find}
                </Button>
              </Section>
            ) : null}
            {asks && askActions && askableOn(p, 'checkup') ? (
              <Section
                boxed={false}
                title={REPORT_WORDS.checkupTitle(name)}
                about={firstSentence(REPORT_WORDS.checkupAbout(p))}
                testID={`${testID}-checkup`}
              >
                <AskButton
                  asks={asks}
                  ask={{ kind: 'checkup' }}
                  platform={p}
                  label={REPORT_WORDS.checkupTitle(name)}
                  actions={askActions}
                  testID={`${testID}-checkup-ask`}
                />
              </Section>
            ) : null}
          </MoreSettings>
        </>
      )}
    </>
  );
}

/**
 * The person's computer on a network (decisions 74 and 77): off Facebook, what to press when Chrome hasn't let the
 * extension on it (Facebook's sites are the extension's own); their profile there, which it reads and the AI checks
 * (decision 80); and Check LinkedIn or Check Facebook, which reads the network's main pages, tries each step up to its
 * last press, and sends a note of each.
 */
function NetworkComputer({
  platform,
  asks,
  actions,
  profile,
  testID,
}: {
  platform: Platform;
  asks: AsksOutput | null;
  actions: AskActions | null;
  profile: ProfileProps | null;
  testID: string;
}) {
  const name = PLATFORMS[platform];
  const computer = asks?.computer ?? null;
  return (
    <>
      {platform === 'facebook' ? null : computer && !allowedOn(computer.allowed, platform) ? (
        <Card className="bg-warning-soft px-4 py-3" testID={`${testID}-chrome-blocked`}>
          <Text className="text-[13px] leading-[18px] text-warning-text">
            {REPORT_WORDS.notAllowed(computer.name, platform)}
          </Text>
        </Card>
      ) : (
        <Note testID={`${testID}-chrome`}>{SETTINGS_WORDS.builtIn(name)}</Note>
      )}
      {asks && actions && profile?.readiness ? (
        <NetworkProfile
          platform={platform}
          readiness={profile.readiness}
          onTick={profile.onTick}
          asks={asks}
          actions={actions}
          testID={`${testID}-profile`}
        />
      ) : null}
      {asks && actions && askableOn(platform, 'checkup') ? (
        <Section
          boxed
          title={REPORT_WORDS.checkupTitle(name)}
          about={REPORT_WORDS.checkupAbout(platform)}
          testID={`${testID}-checkup`}
        >
          <AskButton
            asks={asks}
            ask={{ kind: 'checkup' }}
            platform={platform}
            label={REPORT_WORDS.checkupTitle(name)}
            actions={actions}
            testID={`${testID}-checkup-ask`}
          />
        </Section>
      ) : null}
    </>
  );
}

/**
 * Your profile on the network (decision 80): how far it is, and Get ready's list to read it, see the AI's check and put
 * its words in. What the computer reads or puts in shows once that ask is done.
 */
function NetworkProfile({
  platform,
  readiness,
  onTick,
  asks,
  actions,
  testID,
}: {
  platform: Platform;
  readiness: ReadinessOutput;
  onTick: ProfileProps['onTick'];
  asks: AsksOutput;
  actions: AskActions;
  testID: string;
}) {
  const [open, setOpen] = React.useState(false);
  const P = profileWordsOn(platform);
  const live = readiness.offer?.version ?? null;
  const check = checkCounts(readiness.profileCheck, live) ? readiness.profileCheck : null;
  const right = P.items.filter(
    (i) => tickCounts(readiness.profile[i.item], live) || check?.items[i.item]?.ok === true,
  ).length;
  return (
    <Section
      boxed
      title={SETTINGS_WORDS.yourProfile(PLATFORMS[platform])}
      about={P.hint}
      testID={testID}
    >
      <Note testID={`${testID}-state`}>
        {check || right ? SETTINGS_WORDS.profileRight(right, P.items.length) : P.notRead}
      </Note>
      {open ? (
        <ProfileList readiness={readiness} asks={asks} actions={actions} onTick={onTick} />
      ) : (
        <Button
          variant={check ? 'secondary' : 'primary'}
          size="md"
          className="self-start"
          onPress={() => setOpen(true)}
          testID={`${testID}-open`}
        >
          {READY_WORDS.items.profile.go}
        </Button>
      )}
    </Section>
  );
}

/** The team's say on one network: whether they may use it, and each person's daily limits there. */
export interface NetworkTeamDraft {
  readonly allowed: boolean;
  readonly limits: Partial<Record<DailyStep, number>>;
}

export const networkTeamOf = (saved: unknown, platform: Platform): NetworkTeamDraft => {
  const rules = outreachSettings(saved).rules;
  return {
    allowed: rules.networksAllowed.includes(platform),
    limits: businessLimitsOn(rules, platform),
  };
};

/**
 * The team's say put on the business's rules as they're kept now, so a save here never undoes another network's, or
 * General's, saved meanwhile.
 */
export const withNetworkTeam =
  (platform: Platform, draft: NetworkTeamDraft) =>
  (now: OutreachSettings): Partial<OutreachSettings> => {
    const others = now.rules.networksAllowed.filter((n) => n !== platform);
    return {
      rules: {
        ...now.rules,
        networksAllowed: draft.allowed ? [...others, platform] : others,
        ...(platform === 'facebook'
          ? { dailyLimits: draft.limits }
          : { networkLimits: { ...now.rules.networkLimits, [platform]: draft.limits } }),
      },
    };
  };

/** For your team on a network, for owners and admins: saved as each change is made, the limits after a pause. */
export function NetworkTeam({
  platform,
  business,
  online,
  onSave,
  onState,
}: {
  platform: Platform;
  business: Readonly<Record<string, unknown>>;
  online: boolean;
  onSave: (edit: (now: OutreachSettings) => Partial<OutreachSettings>) => Promise<string | null>;
  /** Where its saving stands, for the page's line. */
  onState: (state: SaveState) => void;
}) {
  const p = platform;
  const name = PLATFORMS[p];
  const team = useAutosave(
    networkTeamOf(business, p),
    (draft) => onSave(withNetworkTeam(p, draft)),
    onState,
  );
  const draft = team.value;
  // Facebook is always allowed (`BusinessRules.networksAllowed`).
  const always = p === 'facebook';
  const allowed = always || draft.allowed;
  const words = dailyWordsOn(p);
  const disabled = !online;
  return (
    <>
      <TeamHeading title={SETTINGS_WORDS.teamOn(name)} />
      <Card className="gap-3 px-4 py-4">
        <Tick
          label={SETTINGS_WORDS.teamMay(name)}
          about={always ? NW.alwaysAllowed : SETTINGS_WORDS.teamMayAbout(name)}
          checked={allowed}
          onChange={(on) => team.change((d) => ({ ...d, allowed: on }))}
          disabled={always || disabled}
          testID={`settings-rules-network-${p}`}
        />
      </Card>
      {allowed && !isLooking(p) ? (
        <Section boxed title={W.sections.limits} about={NW.limitsAbout(name)}>
          <View className="gap-2">
            {DAILY_STEPS.map((step) => {
              // Each at most the network's starting limit.
              const most = NETWORKS[p].dailyLimits[step];
              const now = draft.limits[step] ?? most;
              const by = (n: number) =>
                team.change(
                  (d) => {
                    const was = d.limits[step] ?? most;
                    return {
                      ...d,
                      limits: { ...d.limits, [step]: Math.max(0, Math.min(most, was + n)) },
                    };
                  },
                  { later: true },
                );
              return (
                <StepperRow key={step} label={words[step].label}>
                  <Stepper
                    words={now.toLocaleString('en-US')}
                    onDown={now > 0 && !disabled ? () => by(-1) : null}
                    onUp={now < most && !disabled ? () => by(1) : null}
                    testID={`settings-rules-${p}-limit-${step}`}
                  />
                </StepperRow>
              );
            })}
          </View>
        </Section>
      ) : null}
    </>
  );
}
