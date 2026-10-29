import {
  choicesFor,
  hourWords,
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
import { FOUND_CHECKS, stepFoundChecks } from '@hfos/core/addons/outreach/finds';
import { withNetwork } from '@hfos/core/addons/outreach/network-words';
import { SETTINGS_WORDS } from '@hfos/core/addons/outreach/settings-parts';
import { SETUP_WORDS } from '@hfos/core/addons/outreach/setup';
import { OUTREACH_WORDS as W } from '@hfos/core/addons/outreach/words';
import * as React from 'react';
import { Pressable, View } from 'react-native';

import { ChevronDown, ChevronRight } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Text } from '@/components/ui/text';

import { useAutosave, type Autosave, type Edit, type SaveState } from './autosave';
import { countriesProblem, CountrySetting } from './country-setting';
import { Note, Part } from './kit';
import {
  Choice,
  ExtensionTicks,
  NetworkModes,
  NetworkTicks,
  PhonePart,
  Section,
  Stepper,
  TeamHeading,
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
}: {
  automation: AutomationOutput;
  form: Autosave<AutomationSettings>;
  online: boolean;
}) {
  const disabled = !online;
  return (
    <>
      <VoicePart
        value={form.value}
        onChange={form.change}
        boxed
        disabled={disabled}
        testID="settings-my"
      />
      <WhenPart
        value={form.value}
        onChange={form.change}
        timezone={automation.timezone}
        boxed
        disabled={disabled}
        testID="settings-my"
      />
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
      <TeamHeading title={SETTINGS_WORDS.team} about={SETTINGS_WORDS.teamAbout} />
      <Section boxed title={W.sections.allowed} about={W.abouts.allowed}>
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
        </View>
      </Section>
      <Defaults
        value={d}
        onChange={(change, options) =>
          team.change((v) => ({ ...v, defaults: change(v.defaults) }), options)
        }
        timezone={timezone}
        disabled={disabled}
      />
      <Section boxed title={W.sections.contacts} about={W.abouts.contacts}>
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
      </Section>
      <Section boxed title={W.sections.cancelAfter} about={W.abouts.cancelAfter}>
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
      </Section>
      <Section boxed title={W.sections.foundChecks} about={W.abouts.foundChecks}>
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
      </Section>
      <Section boxed title={W.sections.morning} about={W.abouts.morning}>
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
      </Section>
      <Card className="px-4 py-4">
        <Tick
          label={W.sections.weekly}
          about={W.abouts.weekly}
          checked={d.weeklyReport}
          onChange={(on) => set({ weeklyReport: on })}
          disabled={disabled}
          testID="settings-weekly"
        />
      </Card>
      <CountrySetting
        value={d.countries}
        onChange={(countries) => set({ countries })}
        disabled={disabled}
      >
        {countryLists}
      </CountrySetting>
      <Part title={L.title} about={L.about} testID="settings-extension-link">
        <ExtensionLink
          saved={link}
          online={online}
          onSave={(extensionLink) => onSave(() => ({ extensionLink }))}
        />
      </Part>
    </>
  );
}

/**
 * Where a new person starts (`rules.defaults`): the same choices as each person's, Facebook's and General's, folded to
 * a line until changed (decision 59), and saved with the rest of For your team.
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
  const [open, setOpen] = React.useState(false);
  const defaults = value.defaults;
  const facebook = choicesFor(defaults, 'facebook');
  const set = (change: Partial<NetworkChoices>) =>
    onChange((v) => withNetwork(v, 'facebook', change));
  return (
    <Card className="gap-4 px-4 py-4" testID="settings-defaults-part">
      <Pressable
        role="button"
        aria-expanded={open}
        onPress={() => setOpen((o) => !o)}
        className="flex-row items-start gap-3"
        testID="settings-defaults-open"
      >
        <View className="flex-1 gap-0.5">
          <Text className="text-[15px] font-semibold">{W.sections.defaults}</Text>
          <Note>{`${SENDING_MODES[defaults.sending]} · ${REPLY_MODES[defaults.replies]}`}</Note>
        </View>
        {open ? null : <Text className="text-[13px] font-medium text-accent-text">{W.change}</Text>}
        <Icon as={open ? ChevronDown : ChevronRight} className="size-4 text-text-3" />
      </Pressable>
      {open ? (
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
      ) : null}
    </Card>
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
