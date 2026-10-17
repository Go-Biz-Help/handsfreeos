import {
  businessLimitsOn,
  choicesFor,
  OTHER_PLATFORMS,
  wheelsWords,
  type AutomationOutput,
  type AutomationSettings,
  type OtherPlatform,
  type WheelsState,
} from '@hfos/core/addons/outreach/automation';
import { outreachSettings, type OutreachSettings } from '@hfos/core/addons/outreach/chat-read';
import { DAILY_STEPS, type DailyStep } from '@hfos/core/addons/outreach/limits';
import {
  dailyWordsOn,
  NETWORK_WORDS as NW,
  networksOn,
  withNetwork,
} from '@hfos/core/addons/outreach/network-words';
import {
  isLooking,
  NETWORKS,
  networkLimitsNow,
  PLATFORMS,
  type Platform,
} from '@hfos/core/addons/outreach/networks';
import { askableOn, type AsksOutput } from '@hfos/core/addons/outreach/asks';
import { allowedOn, REPORT_WORDS } from '@hfos/core/addons/outreach/reports';
import { SETTINGS_WORDS } from '@hfos/core/addons/outreach/settings-parts';
import { OUTREACH_WORDS as W } from '@hfos/core/addons/outreach/words';
import * as React from 'react';
import { View } from 'react-native';

import { Card } from '@/components/ui/card';
import { Text } from '@/components/ui/text';

import { AskButton, type AskActions } from './asks';
import { useAutosave, type Autosave, type SaveState } from './autosave';
import { Note } from './kit';
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
 * on), and their daily limits there as they stand. For owners and admins, the team's say on it: whether the team may
 * use it (Facebook always) and each person's daily limits there. A network the business doesn't use says only why.
 */

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
}: {
  platform: Platform;
  automation: AutomationOutput;
  form: Autosave<AutomationSettings>;
  manages: boolean;
  online: boolean;
  /** The person's own asks of their computer (Check LinkedIn) and the computer: null on someone else's settings. */
  asks?: AsksOutput | null;
  askActions?: AskActions | null;
}) {
  const p = platform;
  const name = PLATFORMS[p];
  const testID = `settings-networks-${p}`;
  const value = form.value;
  const allowed = automation.rules.networksAllowed;
  const may = allowed.includes(p);
  const on = may && networksOn(value, allowed).includes(p);
  const choices = choicesFor(value, p);
  const set = (change: Parameters<typeof withNetwork>[2]) =>
    form.change((v) => withNetwork(v, p, change));
  const wheels = wheelsOf(automation, p);
  const limits = networkLimitsNow(p, wheels.on, businessLimitsOn(automation.rules, p));
  const words = dailyWordsOn(p);
  const disabled = !online;
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
      ) : (
        <>
          {wheels.on && !isLooking(p) ? (
            <Note testID={`${testID}-wheels`}>{wheelsWords(wheels)}</Note>
          ) : null}
          <NetworkComputer platform={p} asks={asks} actions={askActions} testID={testID} />
          {isLooking(p) ? (
            // Still looked at (decision 78): nothing to choose yet, only Chrome's say and its Check.
            <Note testID={`${testID}-looking`}>{NW.looking(name)}</Note>
          ) : (
            <>
              <NetworkModes
                platform={p}
                value={choices}
                onChange={set}
                sendingAllowed={automation.rules.sendingAllowed}
                repliesAllowed={automation.rules.repliesAllowed}
                postingAllowed={automation.rules.postingAllowed}
                wheelsFrom={wheels.from}
                boxed
                disabled={disabled}
                testID={testID}
              />
              <NetworkTicks
                platform={p}
                value={choices}
                onChange={set}
                boxed
                disabled={disabled}
                testID={testID}
              />
              {p === 'facebook' ? (
                <ExtensionTicks
                  value={value}
                  onChange={form.change}
                  boxed
                  disabled={disabled}
                  testID={testID}
                />
              ) : null}
              <Section
                boxed
                title={SETTINGS_WORDS.yourLimits(name)}
                about={NW.limitsAbout(name)}
                testID={`${testID}-limits`}
              >
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
              </Section>
            </>
          )}
        </>
      )}
    </>
  );
}

/**
 * The person's computer on a network (decisions 74 and 77): off Facebook, what to press when Chrome hasn't let the
 * extension on it (Facebook's sites are the extension's own); and Check LinkedIn or Check Facebook, which reads the
 * network's main pages, tries each step up to its last press, and sends a note of each.
 */
function NetworkComputer({
  platform,
  asks,
  actions,
  testID,
}: {
  platform: Platform;
  asks: AsksOutput | null;
  actions: AskActions | null;
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
        <Note testID={`${testID}-chrome`}>{SETTINGS_WORDS.allowInChrome(name)}</Note>
      )}
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
