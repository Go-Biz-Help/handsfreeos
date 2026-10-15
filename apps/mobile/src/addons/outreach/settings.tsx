import {
  type BusinessRules,
  hourWords,
  PUSH_MODE_KEYS,
  PUSH_MODES,
  POSTING_MODE_KEYS,
  POSTING_MODES,
  type PostingMode,
  REPLY_MODE_KEYS,
  REPLY_MODES,
  SENDING_MODE_KEYS,
  SENDING_MODES,
  WEEKDAY_WORDS,
  WHEELS_START_WORDS,
  wheelsMatter,
  wheelsWords,
  type AutomationOutput,
  type AutomationPeopleOutput,
  type AutomationSettings,
  type ReplyMode,
  type SendingMode,
} from '@hfos/core/addons/outreach/automation';
import {
  CONTACTS_FROM_CHATS,
  CONTACTS_FROM_CHATS_WORDS,
  extensionLinkProblem,
  outreachSettings,
  settingsToSave,
  type OutreachSettings,
} from '@hfos/core/addons/outreach/chat-read';
import { DAILY_LIMITS, DAILY_STEPS, DAILY_WORDS } from '@hfos/core/addons/outreach/limits';
import { SETUP_WORDS } from '@hfos/core/addons/outreach/setup';
import { VOICE_WORDS, voiceSample, type Voice } from '@hfos/core/addons/outreach/voice';
import { OUTREACH_WORDS as W } from '@hfos/core/addons/outreach/words';
import * as React from 'react';
import { Pressable, View } from 'react-native';

import { change, ChangeError } from '@/changes';
import { BookOpen, Check, Minus, Plus, Radar } from '@/components/icons';
import { List, ListRow } from '@/components/shell/list';
import { Screen } from '@/components/shell/screen';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { api, errorMessage, unwrap } from '@/lib/api';
import { cn } from '@/lib/utils';

import { ChatBubbles } from './chat-bubbles';
import {
  NeedsSignal,
  Note,
  openOutreach,
  Part,
  useOutreachAnswer,
  useOutreachContext,
} from './kit';

const VOICE_KEYS = [
  'shorthand',
  'acronyms',
  'emoji',
  'split',
] as const satisfies readonly (keyof Voice)[];

/**
 * Social Outreach's settings on the phone (decision 44), as the web's Settings tab: the person's own (what the
 * extension does on its own, its switches, how their phone hears what waits, their working hours), and for owners and
 * admins, anyone's, picked under Settings for, and the business's (what people may pick, daily limits, where a new
 * person starts, who goes in Contacts, the morning push and the weekly report). The extension follows a save within
 * seconds. It needs signal.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const failed = (e: unknown) => (e instanceof ChangeError ? e.message : errorMessage(e));
const L = SETUP_WORDS.link;

/** The business's Social Outreach settings an owner or admin changes here. */
export interface BusinessDraft {
  readonly rules: BusinessRules;
  readonly contactsFromChats: OutreachSettings['contactsFromChats'];
  readonly cancelRequestsAfterWeeks: number;
  readonly morningPushHour: number | null;
  readonly weeklyReport: boolean;
}

export const businessDraftOf = (saved: unknown): BusinessDraft => {
  const s = outreachSettings(saved);
  return {
    rules: s.rules,
    contactsFromChats: s.contactsFromChats,
    cancelRequestsAfterWeeks: s.cancelRequestsAfterWeeks,
    morningPushHour: s.morningPushHour,
    weeklyReport: s.weeklyReport,
  };
};

export function SettingsScreen({ whose }: { whose?: string }) {
  const ctx = useOutreachContext();
  const ws = ctx.workspaceId;
  const [userId, setUserId] = React.useState<string | null>(
    ctx.manages && whose && UUID.test(whose) ? whose.toLowerCase() : null,
  );
  const mine = !userId || userId === ctx.userId;
  const automation = useOutreachAnswer(
    async () =>
      unwrap(
        await api.POST('/v1/queries/outreach.automation', {
          body: { workspaceId: ws, ...(mine ? {} : { userId: userId! }) },
        }),
      ),
    `automation:${ws}:${userId ?? 'me'}`,
    W.rows.settings,
  );
  const people = useOutreachAnswer(
    ctx.manages
      ? async () =>
          unwrap(
            await api.POST('/v1/queries/outreach.automation.people', { body: { workspaceId: ws } }),
          )
      : null,
    `automation-people:${ws}`,
    W.rows.settings,
  );
  const business = useOutreachAnswer(
    ctx.manages
      ? async () =>
          unwrap(
            await api.POST('/v1/queries/addon.settings', {
              body: { workspaceId: ws, addonId: 'outreach' },
            }),
          ).settings
      : null,
    `outreach-business:${ws}`,
    W.rows.settings,
  );
  return (
    <SettingsBody
      automation={automation.data}
      error={automation.error}
      mine={mine}
      people={ctx.manages ? people.data : null}
      business={ctx.manages ? business.data : null}
      manages={ctx.manages}
      online={ctx.online}
      onRetry={automation.reload}
      onWhose={(id) => setUserId(id === ctx.userId ? null : id)}
      onOpen={(view) => openOutreach(ws, view)}
      onSaveMine={async (settings) => {
        try {
          await change('outreach.automation.save', {
            workspaceId: ws,
            ...(mine ? {} : { userId: userId! }),
            settings,
          });
          toast.show(W.savedFollows);
          automation.reload();
          people.reload();
          return null;
        } catch (e) {
          return failed(e);
        }
      }}
      onSaveBusiness={async (changes, said) => {
        try {
          // What's kept now, so a setting this screen doesn't show stays as it is; read as it's checked, so a stored
          // link that stopped passing doesn't refuse the save.
          const kept =
            unwrap(
              await api.POST('/v1/queries/addon.settings', {
                body: { workspaceId: ws, addonId: 'outreach' },
              }),
            ).settings ?? {};
          await change('addon.save_settings', {
            workspaceId: ws,
            addonId: 'outreach',
            settings: settingsToSave(kept, changes),
          });
          toast.show(said ?? W.savedForEveryone);
          business.reload();
          automation.reload();
          return null;
        } catch (e) {
          return failed(e);
        }
      }}
    />
  );
}

export function SettingsBody({
  automation,
  error,
  mine,
  people,
  business,
  manages,
  online,
  onRetry,
  onWhose,
  onSaveMine,
  onSaveBusiness,
  onOpen,
}: {
  automation: AutomationOutput | null;
  error: string | null;
  mine: boolean;
  people: AutomationPeopleOutput | null;
  /** The business's saved settings, for owners and admins. */
  business: Readonly<Record<string, unknown>> | null;
  manages: boolean;
  online: boolean;
  onRetry: () => void;
  onWhose: (userId: string) => void;
  onSaveMine: (settings: AutomationSettings) => Promise<string | null>;
  /** Saves some of the business's settings, the others kept as they are. */
  onSaveBusiness: (changes: Partial<OutreachSettings>, said?: string) => Promise<string | null>;
  /** Playbooks and the person's computer, beside the settings since the tabs went to four (decision 59). */
  onOpen?: (view: 'playbooks' | 'live') => void;
}) {
  if (!automation)
    return (
      <Screen title={W.rows.settings} leading="back" testID="outreach-settings">
        {error ? (
          <NeedsSignal words={error} onRetry={onRetry} testID="settings-needs-signal" />
        ) : null}
      </Screen>
    );
  return (
    <Screen title={W.rows.settings} leading="back" testID="outreach-settings">
      {onOpen ? (
        <List>
          <ListRow
            icon={BookOpen}
            label={W.settingsParts.playbooks}
            detail={W.rowDetails.playbooks}
            onPress={() => onOpen('playbooks')}
            testID="settings-open-playbooks"
          />
          <ListRow
            icon={Radar}
            label={W.settingsParts.computer}
            detail={W.rowDetails.live}
            onPress={() => onOpen('live')}
            testID="settings-open-computer"
          />
        </List>
      ) : null}
      <Note>{W.settingsIntro}</Note>
      {!online ? <NeedsSignal words={W.needsSignal(W.rows.settings)} /> : null}
      {people && people.people.length > 1 ? (
        <Part title={W.settingsFor} testID="settings-for">
          <List>
            {people.people.map((p) => (
              <ListRow
                key={p.userId}
                label={`${p.name}${p.saved ? '' : W.notSetYet}`}
                end={
                  p.userId === automation.userId ? (
                    <Icon as={Check} className="size-5 text-accent" />
                  ) : undefined
                }
                chevron={false}
                onPress={() => onWhose(p.userId)}
                testID="settings-for-person"
              />
            ))}
          </List>
        </Part>
      ) : null}
      <Part title={mine ? W.mySettings : W.settingsOf(automation.name)} testID="settings-mine">
        <MySettings
          // Saved somewhere else: the form starts again from what's kept.
          key={`${automation.userId}:${JSON.stringify(automation.settings)}:${automation.changedBy ?? ''}`}
          automation={automation}
          online={online}
          onSave={onSaveMine}
        />
      </Part>
      {manages && business ? (
        <Part title={W.sections.business} testID="settings-business">
          <BusinessSettings
            key={JSON.stringify(business)}
            saved={businessDraftOf(business)}
            timezone={automation.timezone}
            online={online}
            onSave={(draft) => onSaveBusiness(draft)}
          />
        </Part>
      ) : null}
      {manages && business ? (
        <Part title={L.title} about={L.about} testID="settings-extension-link">
          <ExtensionLink
            key={outreachSettings(business).extensionLink ?? ''}
            saved={outreachSettings(business).extensionLink ?? ''}
            online={online}
            onSave={(extensionLink) =>
              onSaveBusiness({ extensionLink }, extensionLink ? L.saved : L.removed)
            }
          />
        </Part>
      ) : !manages ? (
        <Note>{W.abouts.notOwner}</Note>
      ) : null}
    </Screen>
  );
}

function SaveButton({
  disabled,
  onSave,
  testID,
}: {
  disabled: boolean;
  onSave: () => Promise<string | null>;
  testID: string;
}) {
  const [busy, setBusy] = React.useState(false);
  const [problem, setProblem] = React.useState<string | null>(null);
  return (
    <View className="gap-2">
      {problem ? (
        <Text className="text-[13.5px] text-danger" testID={`${testID}-problem`}>
          {problem}
        </Text>
      ) : null}
      <Button
        loading={busy}
        disabled={disabled}
        onPress={async () => {
          setBusy(true);
          setProblem(await onSave());
          setBusy(false);
        }}
        testID={testID}
      >
        {W.save}
      </Button>
    </View>
  );
}

function MySettings({
  automation,
  online,
  onSave,
}: {
  automation: AutomationOutput;
  online: boolean;
  onSave: (settings: AutomationSettings) => Promise<string | null>;
}) {
  const [value, setValue] = React.useState<AutomationSettings>(automation.settings);
  return (
    <Card className="gap-4 px-4 py-4">
      {automation.changedBy ? (
        <Note testID="settings-changed-by">{W.changedBy(automation.changedBy)}</Note>
      ) : null}
      {automation.wheels.on ? <Note>{wheelsWords(automation.wheels)}</Note> : null}
      <ChoicesForm
        value={value}
        onChange={setValue}
        sendingAllowed={automation.rules.sendingAllowed}
        repliesAllowed={automation.rules.repliesAllowed}
        postingAllowed={automation.rules.postingAllowed}
        timezone={automation.timezone}
        testID="settings-my"
      />
      {wheelsMatter(value) && !automation.wheels.from ? <Note>{WHEELS_START_WORDS}</Note> : null}
      <SaveButton
        disabled={!online || (same(value, automation.settings) && automation.saved)}
        onSave={() => onSave(value)}
        testID="settings-my-save"
      />
    </Card>
  );
}

/** One choice of several, ticked when it's the one. */
function Choice({
  label,
  about,
  selected,
  onPress,
  testID,
}: {
  label: string;
  about?: string;
  selected: boolean;
  onPress: () => void;
  testID?: string;
}) {
  return (
    <Pressable
      role="radio"
      aria-checked={selected}
      onPress={onPress}
      className={cn(
        'flex-row items-start gap-3 rounded-menu border px-3 py-2.5',
        selected ? 'border-accent bg-accent-soft' : 'border-border-strong bg-card',
      )}
      testID={testID}
    >
      <View className="flex-1 gap-0.5">
        <Text className="text-[14.5px] leading-[20px]">{label}</Text>
        {about ? <Note>{about}</Note> : null}
      </View>
      {selected ? <Icon as={Check} className="size-5 text-accent" /> : null}
    </Pressable>
  );
}

/** A switch with its words, and a line under them. */
function Tick({
  label,
  about,
  checked,
  onChange,
  testID,
}: {
  label: string;
  about?: string;
  checked: boolean;
  onChange: (on: boolean) => void;
  testID?: string;
}) {
  return (
    <View className="flex-row items-center gap-3">
      <View className="flex-1 gap-0.5">
        <Text className="text-[14.5px] leading-[20px]">{label}</Text>
        {about ? <Note>{about}</Note> : null}
      </View>
      <Switch label={label} checked={checked} onCheckedChange={onChange} testID={testID} />
    </View>
  );
}

/** A number of something, a step at a time: the hours, the weeks. */
function Stepper({
  words,
  onDown,
  onUp,
  testID,
}: {
  words: string;
  onDown: (() => void) | null;
  onUp: (() => void) | null;
  testID?: string;
}) {
  return (
    <View className="flex-row items-center gap-2" testID={testID}>
      <Button
        size="sm"
        variant="secondary"
        icon={Minus}
        disabled={!onDown}
        onPress={() => onDown?.()}
        accessibilityLabel="Less"
        testID={testID && `${testID}-down`}
      />
      <Text className="min-w-[84px] text-center text-[14.5px]" testID={testID && `${testID}-value`}>
        {words}
      </Text>
      <Button
        size="sm"
        variant="secondary"
        icon={Plus}
        disabled={!onUp}
        onPress={() => onUp?.()}
        accessibilityLabel="More"
        testID={testID && `${testID}-up`}
      />
    </View>
  );
}

const TICKS = {
  along: ['warmUp', 'confirmRequests', 'collect', 'joinGroups', 'watchPosts'],
  extension: ['noting', 'readChats', 'markPosts'],
} as const;

/** The choices themselves: someone's own, or where a new person starts. */
export function ChoicesForm({
  value,
  onChange,
  sendingAllowed,
  repliesAllowed,
  postingAllowed = POSTING_MODE_KEYS,
  timezone,
  testID,
}: {
  value: AutomationSettings;
  onChange: (next: AutomationSettings) => void;
  sendingAllowed: readonly SendingMode[];
  repliesAllowed: readonly ReplyMode[];
  postingAllowed?: readonly PostingMode[];
  timezone: string;
  testID: string;
}) {
  const set = (part: Partial<AutomationSettings>) => onChange({ ...value, ...part });
  const sending = SENDING_MODE_KEYS.filter((m) => sendingAllowed.includes(m));
  const replies = REPLY_MODE_KEYS.filter((m) => repliesAllowed.includes(m));
  const posting = POSTING_MODE_KEYS.filter((m) => postingAllowed.includes(m));
  const notAllowed = [
    ...SENDING_MODE_KEYS.filter((m) => !sendingAllowed.includes(m)).map((m) => SENDING_MODES[m]),
    ...REPLY_MODE_KEYS.filter((m) => !repliesAllowed.includes(m)).map((m) => REPLY_MODES[m]),
    ...POSTING_MODE_KEYS.filter((m) => !postingAllowed.includes(m)).map((m) => POSTING_MODES[m]),
  ];
  const hours = value.hours;
  return (
    <View className="gap-5" testID={testID}>
      <Part title={W.sections.onItsOwn} about={W.abouts.onItsOwn}>
        {sending.map((m) => (
          <Choice
            key={m}
            label={SENDING_MODES[m]}
            selected={value.sending === m}
            onPress={() => set({ sending: m })}
            testID={`${testID}-sending-${m}`}
          />
        ))}
      </Part>
      <Part
        title={W.sections.replies}
        about={value.sending === 'off' ? W.abouts.repliesOff : W.abouts.replies}
      >
        {replies.map((m) => (
          <Choice
            key={m}
            label={REPLY_MODES[m]}
            selected={value.replies === m}
            onPress={() => set({ replies: m })}
            testID={`${testID}-replies-${m}`}
          />
        ))}
      </Part>
      <Part title={W.sections.posting} about={W.abouts.posting}>
        {posting.map((m) => (
          <Choice
            key={m}
            label={POSTING_MODES[m]}
            about={m === 'after_ok' ? W.usual : undefined}
            selected={value.posting === m}
            onPress={() => set({ posting: m })}
            testID={`${testID}-posting-${m}`}
          />
        ))}
      </Part>
      {notAllowed.length ? <Note>{W.notAllowed(notAllowed)}</Note> : null}
      <Part title={VOICE_WORDS.title} about={VOICE_WORDS.note}>
        {VOICE_KEYS.map((k) => (
          <Tick
            key={k}
            label={VOICE_WORDS[k]}
            checked={value.voice[k]}
            onChange={(on) => set({ voice: { ...value.voice, [k]: on } })}
            testID={`${testID}-voice-${k}`}
          />
        ))}
        <ChatBubbles
          bubbles={voiceSample(value.voice).map((text) => ({ fromMe: true, text }))}
          label="How a message from you might read"
          testID={`${testID}-voice-sample`}
        />
      </Part>
      <Part title={W.sections.along}>
        {TICKS.along.map((k) => (
          <Tick
            key={k}
            label={W.ticks[k][0]}
            about={W.ticks[k][1]}
            checked={value[k]}
            onChange={(on) => set({ [k]: on })}
            testID={`${testID}-${k}`}
          />
        ))}
      </Part>
      <Part title={W.sections.extension} about={W.abouts.extension}>
        {TICKS.extension.map((k) => (
          <Tick
            key={k}
            label={W.ticks[k][0]}
            about={W.ticks[k][1]}
            checked={value[k]}
            onChange={(on) => set({ [k]: on })}
            testID={`${testID}-${k}`}
          />
        ))}
      </Part>
      <Part title={W.sections.pushes} about={W.abouts.pushes}>
        {PUSH_MODE_KEYS.map((m) => (
          <Choice
            key={m}
            label={PUSH_MODES[m]}
            about={m === 'bundled' ? W.usual : undefined}
            selected={value.pushes === m}
            onPress={() => set({ pushes: m })}
            testID={`${testID}-pushes-${m}`}
          />
        ))}
        <Note>{W.abouts.pushesAlways}</Note>
        <Tick
          label={W.ticks.dayReport[0]}
          about={W.ticks.dayReport[1]}
          checked={value.dayReport}
          onChange={(on) => set({ dayReport: on })}
          testID={`${testID}-dayReport`}
        />
        <Note>{W.abouts.weekReview}</Note>
      </Part>
      <Part title={W.sections.when} about={W.abouts.when(timezone)}>
        <View className="gap-2">
          <View className="flex-row items-center justify-between">
            <Text className="text-[14px]">{W.from}</Text>
            <Stepper
              words={hourWords(hours.start)}
              onDown={
                hours.start > 0 ? () => set({ hours: { ...hours, start: hours.start - 1 } }) : null
              }
              onUp={
                hours.start < hours.end - 1
                  ? () => set({ hours: { ...hours, start: hours.start + 1 } })
                  : null
              }
              testID={`${testID}-start`}
            />
          </View>
          <View className="flex-row items-center justify-between">
            <Text className="text-[14px]">{W.to}</Text>
            <Stepper
              words={hourWords(hours.end)}
              onDown={
                hours.end > hours.start + 1
                  ? () => set({ hours: { ...hours, end: hours.end - 1 } })
                  : null
              }
              onUp={hours.end < 24 ? () => set({ hours: { ...hours, end: hours.end + 1 } }) : null}
              testID={`${testID}-end`}
            />
          </View>
          <View className="flex-row flex-wrap gap-1.5">
            {WEEKDAY_WORDS.map((word, day) => {
              const on = hours.days.includes(day);
              return (
                <Button
                  key={word}
                  size="sm"
                  variant={on ? 'primary' : 'secondary'}
                  disabled={on && hours.days.length === 1}
                  onPress={() =>
                    set({
                      hours: {
                        ...hours,
                        days: on
                          ? hours.days.filter((d) => d !== day)
                          : [...hours.days, day].sort((a, b) => a - b),
                      },
                    })
                  }
                  testID={`${testID}-day-${day}`}
                >
                  {word}
                </Button>
              );
            })}
          </View>
        </View>
      </Part>
    </View>
  );
}

const toggle = <T extends string>(list: readonly T[], item: T, on: boolean): T[] =>
  on ? [...list, item] : list.filter((x) => x !== item);

function BusinessSettings({
  saved,
  timezone,
  online,
  onSave,
}: {
  saved: BusinessDraft;
  timezone: string;
  online: boolean;
  onSave: (draft: BusinessDraft) => Promise<string | null>;
}) {
  const [draft, setDraft] = React.useState<BusinessDraft>(saved);
  const rules = draft.rules;
  const setRules = (part: Partial<BusinessRules>) =>
    setDraft((d) => ({ ...d, rules: { ...d.rules, ...part } }));
  return (
    <Card className="gap-5 px-4 py-4">
      <Part title={W.sections.allowed} about={W.abouts.allowed}>
        {SENDING_MODE_KEYS.filter((m) => m !== 'off').map((m) => (
          <Tick
            key={m}
            label={SENDING_MODES[m]}
            checked={rules.sendingAllowed.includes(m)}
            onChange={(on) => setRules({ sendingAllowed: toggle(rules.sendingAllowed, m, on) })}
            testID={`settings-rules-sending-${m}`}
          />
        ))}
        {REPLY_MODE_KEYS.filter((m) => m !== 'draft').map((m) => (
          <Tick
            key={m}
            label={REPLY_MODES[m]}
            checked={rules.repliesAllowed.includes(m)}
            onChange={(on) => setRules({ repliesAllowed: toggle(rules.repliesAllowed, m, on) })}
            testID={`settings-rules-replies-${m}`}
          />
        ))}
        {POSTING_MODE_KEYS.filter((m) => m !== 'copy').map((m) => (
          <Tick
            key={m}
            label={POSTING_MODES[m]}
            checked={rules.postingAllowed.includes(m)}
            onChange={(on) => setRules({ postingAllowed: toggle(rules.postingAllowed, m, on) })}
            testID={`settings-rules-posting-${m}`}
          />
        ))}
      </Part>
      <Part title={W.sections.limits} about={W.abouts.limits}>
        {DAILY_STEPS.map((step) => (
          <View key={step} className="flex-row items-center justify-between gap-3">
            <Text className="flex-1 text-[14px]">{DAILY_WORDS[step].label}</Text>
            <Input
              className="w-20"
              keyboardType="number-pad"
              value={String(rules.dailyLimits[step] ?? DAILY_LIMITS[step])}
              onChangeText={(t) => {
                const n = Math.max(0, Math.min(DAILY_LIMITS[step], Number(t) || 0));
                setRules({ dailyLimits: { ...rules.dailyLimits, [step]: n } });
              }}
              testID={`settings-rules-limit-${step}`}
            />
          </View>
        ))}
      </Part>
      <Part title={W.sections.defaults} about={W.abouts.defaults}>
        <ChoicesForm
          value={rules.defaults}
          onChange={(defaults) => setRules({ defaults })}
          sendingAllowed={rules.sendingAllowed}
          repliesAllowed={rules.repliesAllowed}
          postingAllowed={rules.postingAllowed}
          timezone={timezone}
          testID="settings-defaults"
        />
      </Part>
      <Part title={W.sections.contacts} about={W.abouts.contacts}>
        {CONTACTS_FROM_CHATS.map((k) => (
          <Choice
            key={k}
            label={CONTACTS_FROM_CHATS_WORDS[k]}
            about={k === 'tagged' ? W.usual : undefined}
            selected={draft.contactsFromChats === k}
            onPress={() => setDraft((d) => ({ ...d, contactsFromChats: k }))}
            testID={`settings-contacts-${k}`}
          />
        ))}
      </Part>
      <Part title={W.sections.cancelAfter} about={W.abouts.cancelAfter}>
        <Stepper
          words={W.weeks(draft.cancelRequestsAfterWeeks)}
          onDown={
            draft.cancelRequestsAfterWeeks > 1
              ? () =>
                  setDraft((d) => ({
                    ...d,
                    cancelRequestsAfterWeeks: d.cancelRequestsAfterWeeks - 1,
                  }))
              : null
          }
          onUp={
            draft.cancelRequestsAfterWeeks < 12
              ? () =>
                  setDraft((d) => ({
                    ...d,
                    cancelRequestsAfterWeeks: d.cancelRequestsAfterWeeks + 1,
                  }))
              : null
          }
          testID="settings-cancel-weeks"
        />
      </Part>
      <Part title={W.sections.morning} about={W.abouts.morning}>
        <Stepper
          words={draft.morningPushHour === null ? W.off : hourWords(draft.morningPushHour)}
          onDown={
            draft.morningPushHour === null
              ? () => setDraft((d) => ({ ...d, morningPushHour: 23 }))
              : () =>
                  setDraft((d) => ({
                    ...d,
                    morningPushHour: d.morningPushHour! > 0 ? d.morningPushHour! - 1 : null,
                  }))
          }
          onUp={
            draft.morningPushHour === null
              ? () => setDraft((d) => ({ ...d, morningPushHour: 0 }))
              : () =>
                  setDraft((d) => ({
                    ...d,
                    morningPushHour: d.morningPushHour! < 23 ? d.morningPushHour! + 1 : null,
                  }))
          }
          testID="settings-morning"
        />
      </Part>
      <Tick
        label={W.sections.weekly}
        about={W.abouts.weekly}
        checked={draft.weeklyReport}
        onChange={(on) => setDraft((d) => ({ ...d, weeklyReport: on }))}
        testID="settings-weekly"
      />
      <SaveButton
        disabled={!online || same(draft, saved)}
        onSave={() => onSave(draft)}
        testID="settings-business-save"
      />
    </Card>
  );
}

/**
 * Where the team downloads the extension (`extensionLink`, decision 45), as the web's Business settings box: checked as
 * the save checks it, so a link that won't pass says why before anything is sent. Empty takes the link off.
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
  const [problem, setProblem] = React.useState<string | null>(null);
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
        invalid={!!problem}
        onChangeText={(t) => {
          setLink(t);
          setProblem(null);
        }}
        testID="settings-extension-link-input"
      />
      {problem ? (
        <Text className="text-[13.5px] text-danger" testID="settings-extension-link-problem">
          {problem}
        </Text>
      ) : null}
      <SaveButton
        disabled={!online || link.trim() === saved}
        onSave={async () => {
          const wrong = extensionLinkProblem(link);
          if (wrong) {
            setProblem(wrong);
            return null;
          }
          return onSave(link.trim() || null);
        }}
        testID="settings-extension-link-save"
      />
    </Card>
  );
}
