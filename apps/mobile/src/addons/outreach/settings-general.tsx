import {
  autopilotOn,
  choicesFor,
  hourWords,
  hoursProblem,
  OTHER_PLATFORMS,
  POSTING_MODE_KEYS,
  POSTING_MODES,
  REPLY_MODE_KEYS,
  REPLY_MODES,
  SENDING_MODE_KEYS,
  SENDING_MODES,
  type AutomationOutput,
  type AutomationSettings,
  type BusinessRules,
  type NetworkChoices,
} from '@hfos/core/addons/outreach/automation';
import {
  CONTACTS_FROM_CHATS,
  CONTACTS_FROM_CHATS_WORDS,
  extensionLinkProblem,
  outreachSettings,
  type OutreachSettings,
} from '@hfos/core/addons/outreach/chat-read';
import type { CountryRule } from '@hfos/core/addons/outreach/countries';
import { AUTOPILOT_WORDS } from '@hfos/core/addons/outreach/autopilot';
import { FOUND_CHECKS, stepFoundChecks } from '@hfos/core/addons/outreach/finds';
import {
  handsOffEverywhere,
  HANDS_OFF_WORDS as H,
  withHandsOffEverywhere,
  type HandsOff,
} from '@hfos/core/addons/outreach/hands-off';
import { networksOn, withNetwork } from '@hfos/core/addons/outreach/network-words';
import { isLooking, runsOnItsOwn } from '@hfos/core/addons/outreach/networks';
import {
  handsOffGroups,
  levelsAllowed,
  SETTINGS_PAGE_WORDS as SP,
} from '@hfos/core/addons/outreach/settings-pages';
import { countryRuleWords } from '@hfos/core/addons/outreach/countries';
import { SETUP_WORDS } from '@hfos/core/addons/outreach/setup';
import { OUTREACH_WORDS as W } from '@hfos/core/addons/outreach/words';
import * as React from 'react';
import { View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';

import { useAutosave, type Autosave, type Edit, type SaveState } from './autosave';
import { countriesProblem, CountrySetting } from './country-setting';
import { Note } from './kit';
import { ChangeRow, HandsOffPart, MoreSettings, PickRow, RowsCard } from './settings-hands-off';
import {
  Choice,
  ExtensionTicks,
  NetworkModes,
  NetworkTicks,
  PhonePart,
  Stepper,
  Tick,
  VoicePart,
  WhenPart,
} from './settings-bits';

/**
 * General, the first page of Settings on the phone (Chris, 2026-10-16): the person's own on every network (how the AI
 * writes for them, their working hours, how their phone hears what waits), and for owners and admins, For your team:
 * what people may pick, where a new person starts, who from chats goes in Contacts, when friend requests are suggested
 * for cancelling, the morning push, the weekly report, which countries it reaches (decisions 61 and 86), and where the
 * team gets the extension. Each network's own, and its daily limits, are on that network's page. Everything saves as
 * it's made, but the link, which has its own button; Only these countries waits for a country to be picked.
 */

const L = SETUP_WORDS.link;

/** The person's own on every network: their part of their settings form. */
export function GeneralMine({
  automation,
  form,
  online,
  manages = false,
  onHandsOff = null,
}: {
  automation: AutomationOutput;
  form: Autosave<AutomationSettings>;
  online: boolean;
  /** An owner or admin: a level the business doesn't allow says they can change that on Team. */
  manages?: boolean;
  /** A level picked for every network at once (decision 170); without it, the form changes as any pick does. */
  onHandsOff?: ((level: HandsOff) => void) | null;
}) {
  const disabled = !online;
  const value = form.value;
  const rules = automation.rules;
  // The networks it works on its own for them, which the level sets.
  const networks = networksOn(value, rules.networksAllowed).filter(
    (p) => runsOnItsOwn(p) && !isLooking(p),
  );
  const wheels =
    (automation.wheels.on && autopilotOn(value, 'facebook')) ||
    OTHER_PLATFORMS.some(
      (p) => automation.networkWheels[p].on && value.networks[p].on && autopilotOn(value, p),
    );
  const pick = (level: HandsOff) =>
    onHandsOff
      ? onHandsOff(level)
      : form.change((v) => withHandsOffEverywhere(v, level, rules).settings);
  return (
    <>
      {/* How hands-off, on every network, first (decision 170): each network's page then picks its own. */}
      {networks.length ? (
        <HandsOffPart
          platform={null}
          level={handsOffEverywhere(value, networks)}
          onPick={pick}
          rules={rules}
          manages={manages}
          title={H.everywhereTitle}
          about={H.everywhereAbout}
          note={wheels ? H.wheels : null}
          disabled={disabled}
          testID="settings-my-hands-off"
        >
          {networks.length > 1 ? (
            <View className="rounded-menu bg-card-2 px-3" testID="settings-my-hands-off-networks">
              {handsOffGroups(value, networks).map((g, i) => (
                <View
                  key={g.networks.join(',')}
                  className={cn(
                    'flex-row flex-wrap items-center justify-between gap-x-3 py-2',
                    i > 0 && 'border-t border-border',
                  )}
                  testID="settings-my-hands-off-group"
                >
                  <Text className="text-[13.5px] font-semibold">{SP.groupNetworks(g)}</Text>
                  <Text className="text-[13.5px] text-text-2">{SP.groupLine(g)}</Text>
                </View>
              ))}
            </View>
          ) : null}
        </HandsOffPart>
      ) : null}
      <VoicePart
        value={form.value}
        onChange={form.change}
        boxed
        disabled={disabled}
        testID="settings-my"
      />
      {/* Working hours as a row that says how they stand, set under Change (decision 170, part 2). */}
      <RowsCard testID="settings-my-rows">
        <ChangeRow
          title={SP.hours}
          about={SP.hoursAbout(value.hours)}
          open={hoursProblem(value.hours) !== null}
          testID="settings-my-hours"
        >
          <WhenPart
            value={form.value}
            onChange={form.change}
            timezone={automation.timezone}
            boxed={false}
            disabled={disabled}
            testID="settings-my"
          />
        </ChangeRow>
      </RowsCard>
      <PhonePart
        value={form.value}
        onChange={form.change}
        boxed
        disabled={disabled}
        testID="settings-my"
      />
      {automation.changedBy ? (
        <Note testID="settings-changed-by">{W.changedBy(automation.changedBy)}</Note>
      ) : null}
    </>
  );
}

/** What General's For your team changes of the business's Social Outreach settings. */
export interface TeamDraft {
  readonly sendingAllowed: BusinessRules['sendingAllowed'];
  readonly repliesAllowed: BusinessRules['repliesAllowed'];
  readonly postingAllowed: BusinessRules['postingAllowed'];
  readonly autopilotAllowed: BusinessRules['autopilotAllowed'];
  readonly defaults: AutomationSettings;
  readonly contactsFromChats: OutreachSettings['contactsFromChats'];
  readonly cancelRequestsAfterWeeks: number;
  readonly foundChecksPerDay: number;
  readonly morningPushHour: number | null;
  readonly weeklyReport: boolean;
  readonly countries: CountryRule;
}

export const teamDraftOf = (saved: unknown): TeamDraft => {
  const s = outreachSettings(saved);
  return {
    sendingAllowed: s.rules.sendingAllowed,
    repliesAllowed: s.rules.repliesAllowed,
    postingAllowed: s.rules.postingAllowed,
    autopilotAllowed: s.rules.autopilotAllowed,
    defaults: s.rules.defaults,
    contactsFromChats: s.contactsFromChats,
    cancelRequestsAfterWeeks: s.cancelRequestsAfterWeeks,
    foundChecksPerDay: s.foundChecksPerDay,
    morningPushHour: s.morningPushHour,
    weeklyReport: s.weeklyReport,
    countries: s.countries,
  };
};

/**
 * The draft put on the business's settings as they're kept now: each network's say (allowed, limits) stays as its own
 * page saved it.
 */
export const withTeam =
  (draft: TeamDraft) =>
  (now: OutreachSettings): Partial<OutreachSettings> => ({
    contactsFromChats: draft.contactsFromChats,
    cancelRequestsAfterWeeks: draft.cancelRequestsAfterWeeks,
    foundChecksPerDay: draft.foundChecksPerDay,
    morningPushHour: draft.morningPushHour,
    weeklyReport: draft.weeklyReport,
    countries: draft.countries,
    rules: {
      ...now.rules,
      sendingAllowed: draft.sendingAllowed,
      repliesAllowed: draft.repliesAllowed,
      postingAllowed: draft.postingAllowed,
      autopilotAllowed: draft.autopilotAllowed,
      defaults: draft.defaults,
    },
  });

const toggle = <T extends string>(list: readonly T[], item: T, on: boolean): T[] =>
  on ? [...list, item] : list.filter((x) => x !== item);

/** For your team on General, for owners and admins. */
export function GeneralTeam({
  business,
  timezone,
  online,
  onSave,
  onState,
  countryLists,
}: {
  business: Readonly<Record<string, unknown>>;
  timezone: string;
  online: boolean;
  onSave: (edit: (now: OutreachSettings) => Partial<OutreachSettings>) => Promise<string | null>;
  /** Where its saving stands, for the page's line. */
  onState: (state: SaveState) => void;
  /** Under the country setting: the rows to the lists it makes. */
  countryLists?: React.ReactNode;
}) {
  const team = useAutosave(
    teamDraftOf(business),
    (draft) => onSave(withTeam(draft)),
    onState,
    // Only these countries, with none picked yet, waits for one.
    (draft) => countriesProblem(draft.countries) !== null,
  );
  const d = team.value;
  const set = (part: Partial<TeamDraft>, later = false) =>
    team.change((v) => ({ ...v, ...part }), { later });
  const disabled = !online;
  const link = outreachSettings(business).extensionLink ?? '';
  return (
    <>
      {/* What people may pick and where a new person starts, each a row behind Change (decision 170, part 2). */}
      <RowsCard title={SP.picks} testID="settings-team-picks">
        <ChangeRow
          title={SP.mayGo}
          about={SP.mayGoLine(levelsAllowed(d))}
          testID="settings-team-may-go"
        >
          <Note>{W.abouts.allowed}</Note>
          <View className="gap-3">
            {SENDING_MODE_KEYS.filter((m) => m !== 'off').map((m) => (
              <Tick
                key={m}
                label={SENDING_MODES[m]}
                checked={d.sendingAllowed.includes(m)}
                onChange={(on) => set({ sendingAllowed: toggle(d.sendingAllowed, m, on) })}
                disabled={disabled}
                testID={`settings-rules-sending-${m}`}
              />
            ))}
            {REPLY_MODE_KEYS.filter((m) => m !== 'draft').map((m) => (
              <Tick
                key={m}
                label={REPLY_MODES[m]}
                checked={d.repliesAllowed.includes(m)}
                onChange={(on) => set({ repliesAllowed: toggle(d.repliesAllowed, m, on) })}
                disabled={disabled}
                testID={`settings-rules-replies-${m}`}
              />
            ))}
            {POSTING_MODE_KEYS.filter((m) => m !== 'copy').map((m) => (
              <Tick
                key={m}
                label={POSTING_MODES[m]}
                checked={d.postingAllowed.includes(m)}
                onChange={(on) => set({ postingAllowed: toggle(d.postingAllowed, m, on) })}
                disabled={disabled}
                testID={`settings-rules-posting-${m}`}
              />
            ))}
            <Tick
              label={AUTOPILOT_WORDS.allow}
              about={AUTOPILOT_WORDS.allowAbout}
              checked={d.autopilotAllowed}
              onChange={(on) => set({ autopilotAllowed: on })}
              disabled={disabled}
              testID="settings-rules-autopilot"
            />
          </View>
        </ChangeRow>
        <ChangeRow
          title={SP.starts}
          about={SP.startsLine(d.defaults)}
          testID="settings-defaults-part"
        >
          <Defaults
            value={d}
            onChange={(change, options) =>
              team.change((v) => ({ ...v, defaults: change(v.defaults) }), options)
            }
            timezone={timezone}
            disabled={disabled}
          />
        </ChangeRow>
      </RowsCard>
      {/* The business's own settings, as short picks with the choice showing. */}
      <RowsCard title={SP.wholeBusiness} testID="settings-team-business">
        <ChangeRow
          title={SP.countries}
          about={countryRuleWords(d.countries)}
          open={countriesProblem(d.countries) !== null}
          testID="settings-countries-row"
        >
          <CountrySetting
            value={d.countries}
            onChange={(countries) => set({ countries })}
            disabled={disabled}
          >
            {countryLists}
          </CountrySetting>
        </ChangeRow>
        <ChangeRow
          title={SP.contacts}
          about={SP.contactsShort[d.contactsFromChats]}
          testID="settings-contacts-row"
        >
          <Note>{W.abouts.contacts}</Note>
          {CONTACTS_FROM_CHATS.map((k) => (
            <Choice
              key={k}
              label={CONTACTS_FROM_CHATS_WORDS[k]}
              about={k === 'tagged' ? W.usual : undefined}
              selected={d.contactsFromChats === k}
              onPress={() => set({ contactsFromChats: k })}
              disabled={disabled}
              testID={`settings-contacts-${k}`}
            />
          ))}
        </ChangeRow>
        <PickRow title={SP.warmUp} about={SP.warmUpAbout} testID="settings-cancel-weeks-row">
          <Stepper
            words={W.weeks(d.cancelRequestsAfterWeeks)}
            onDown={
              d.cancelRequestsAfterWeeks > 1 && !disabled
                ? () => set({ cancelRequestsAfterWeeks: d.cancelRequestsAfterWeeks - 1 }, true)
                : null
            }
            onUp={
              d.cancelRequestsAfterWeeks < 12 && !disabled
                ? () => set({ cancelRequestsAfterWeeks: d.cancelRequestsAfterWeeks + 1 }, true)
                : null
            }
            testID="settings-cancel-weeks"
          />
        </PickRow>
        <PickRow title={SP.morning} about={SP.morningAbout} testID="settings-morning-row">
          <Stepper
            words={d.morningPushHour === null ? W.off : hourWords(d.morningPushHour)}
            // Off sits between 11 PM and midnight.
            onDown={
              disabled
                ? null
                : () =>
                    set(
                      {
                        morningPushHour:
                          d.morningPushHour === null
                            ? 23
                            : d.morningPushHour > 0
                              ? d.morningPushHour - 1
                              : null,
                      },
                      true,
                    )
            }
            onUp={
              disabled
                ? null
                : () =>
                    set(
                      {
                        morningPushHour:
                          d.morningPushHour === null
                            ? 0
                            : d.morningPushHour < 23
                              ? d.morningPushHour + 1
                              : null,
                      },
                      true,
                    )
            }
            testID="settings-morning"
          />
        </PickRow>
        <View className="py-3">
          <Tick
            label={SP.weekly}
            about={SP.weeklyAbout}
            checked={d.weeklyReport}
            onChange={(on) => set({ weeklyReport: on })}
            disabled={disabled}
            testID="settings-weekly"
          />
        </View>
        <ChangeRow
          title={SP.extension}
          about={link ? SP.extensionTheirs : SP.extensionOurs}
          testID="settings-extension-link"
        >
          <Note>{L.about}</Note>
          <ExtensionLink
            saved={link}
            online={online}
            onSave={(extensionLink) => onSave(() => ({ extensionLink }))}
          />
        </ChangeRow>
      </RowsCard>
      <MoreSettings about={SP.moreAbout} testID="settings-team-more">
        <PickRow
          title={W.sections.foundChecks}
          about={W.abouts.foundChecks}
          testID="settings-found-checks-row"
        >
          <Stepper
            words={W.aDay(d.foundChecksPerDay)}
            onDown={
              d.foundChecksPerDay > FOUND_CHECKS.least && !disabled
                ? () => set({ foundChecksPerDay: stepFoundChecks(d.foundChecksPerDay, -1) }, true)
                : null
            }
            onUp={
              d.foundChecksPerDay < FOUND_CHECKS.most && !disabled
                ? () => set({ foundChecksPerDay: stepFoundChecks(d.foundChecksPerDay, 1) }, true)
                : null
            }
            testID="settings-found-checks"
          />
        </PickRow>
      </MoreSettings>
    </>
  );
}

/**
 * Where a new person starts (`rules.defaults`): the same choices as each person's, Facebook's and You's, opened from
 * its row on Team (decisions 59 and 170), and saved with the rest of the team's.
 */
function Defaults({
  value,
  onChange,
  timezone,
  disabled,
}: {
  value: TeamDraft;
  onChange: Edit<AutomationSettings>;
  timezone: string;
  disabled: boolean;
}) {
  const defaults = value.defaults;
  const facebook = choicesFor(defaults, 'facebook');
  const set = (change: Partial<NetworkChoices>) =>
    onChange((v) => withNetwork(v, 'facebook', change));
  return (
    <View className="gap-5" testID="settings-defaults">
      <Note>{W.abouts.defaults}</Note>
      <NetworkModes
        platform="facebook"
        value={facebook}
        onChange={set}
        sendingAllowed={value.sendingAllowed}
        repliesAllowed={value.repliesAllowed}
        postingAllowed={value.postingAllowed}
        boxed={false}
        disabled={disabled}
        testID="settings-defaults"
      />
      <NetworkTicks
        platform="facebook"
        value={facebook}
        onChange={set}
        boxed={false}
        disabled={disabled}
        testID="settings-defaults"
      />
      <ExtensionTicks
        value={defaults}
        onChange={onChange}
        boxed={false}
        disabled={disabled}
        testID="settings-defaults"
      />
      <VoicePart
        value={defaults}
        onChange={onChange}
        boxed={false}
        disabled={disabled}
        testID="settings-defaults"
      />
      <WhenPart
        value={defaults}
        onChange={onChange}
        timezone={timezone}
        boxed={false}
        disabled={disabled}
        testID="settings-defaults"
      />
      <PhonePart
        value={defaults}
        onChange={onChange}
        boxed={false}
        disabled={disabled}
        testID="settings-defaults"
      />
    </View>
  );
}

/**
 * Where the team downloads the extension (`extensionLink`, decision 45), as the web's box: checked as the save checks
 * it, so a link that won't pass says why before anything is sent. Empty takes the link off. Typing a link isn't saved
 * at each letter: it has its own button.
 */
function ExtensionLink({
  saved,
  online,
  onSave,
}: {
  saved: string;
  online: boolean;
  onSave: (link: string | null) => Promise<string | null>;
}) {
  const [link, setLink] = React.useState(saved);
  const [said, setSaid] = React.useState<{ ok: boolean; words: string } | null>(null);
  const [busy, setBusy] = React.useState(false);
  // Saved again, here or somewhere else: the box follows it, unless something else is typed in it.
  const [seen, setSeen] = React.useState(saved);
  if (saved !== seen) {
    setSeen(saved);
    if (link.trim() === seen) setLink(saved);
  }
  return (
    <Card className="gap-2 px-4 py-4">
      <Text className="text-[14px] font-medium">{L.label}</Text>
      <Input
        value={link}
        placeholder="https://"
        keyboardType="url"
        autoCapitalize="none"
        autoCorrect={false}
        maxLength={500}
        invalid={said?.ok === false}
        onChangeText={(t) => {
          setLink(t);
          setSaid(null);
        }}
        testID="settings-extension-link-input"
      />
      {said ? (
        <Text
          className={said.ok ? 'text-[13.5px] text-success-text' : 'text-[13.5px] text-danger'}
          testID={`settings-extension-link-${said.ok ? 'saved' : 'problem'}`}
        >
          {said.words}
        </Text>
      ) : null}
      <Button
        loading={busy}
        disabled={!online || link.trim() === saved}
        onPress={async () => {
          const wrong = extensionLinkProblem(link);
          if (wrong) {
            setSaid({ ok: false, words: wrong });
            return;
          }
          const next = link.trim() || null;
          setBusy(true);
          const problem = await onSave(next);
          setBusy(false);
          setSaid(
            problem
              ? { ok: false, words: problem }
              : { ok: true, words: next ? L.saved : L.removed },
          );
        }}
        testID="settings-extension-link-save"
      >
        {W.save}
      </Button>
    </Card>
  );
}
