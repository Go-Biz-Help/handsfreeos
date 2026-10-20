import {
  hourWords,
  POSTING_MODE_KEYS,
  POSTING_MODES,
  PUSH_MODE_KEYS,
  PUSH_MODES,
  REPLY_MODE_KEYS,
  REPLY_MODES,
  SENDING_MODE_KEYS,
  WEEKDAY_WORDS,
  WHEELS_START_WORDS,
  wheelsMatter,
  type AutomationSettings,
  type NetworkChoices,
  type PostingMode,
  type ReplyMode,
  type SendingMode,
} from '@hfos/core/addons/outreach/automation';
import {
  helpfulOn,
  noRunnerWords,
  onItsOwnAbout,
  postingAboutOn,
  sendingModesOn,
  ticksOn,
  ticksShownOn,
} from '@hfos/core/addons/outreach/network-words';
import { runsOnItsOwn, type Platform } from '@hfos/core/addons/outreach/networks';
import { SETTINGS_WORDS } from '@hfos/core/addons/outreach/settings-parts';
import { VOICE_WORDS, voiceSample, type Voice } from '@hfos/core/addons/outreach/voice';
import { OUTREACH_WORDS as W } from '@hfos/core/addons/outreach/words';
import * as React from 'react';
import { Pressable, View } from 'react-native';

import { Check, Minus, Plus } from '@/components/icons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';

import type { Edit, SaveState } from './autosave';
import { ChatBubbles } from './chat-bubbles';
import { Note, Part } from './kit';

/**
 * What Settings' pages share on the phone: the controls (a choice, a switch, a stepper), the line that says how the
 * saving goes, and the parts of the person's choices, each drawn on a card of its own on a page, or plain inside one
 * where a new person starts. Every control changes its form through an `Edit`, which saves it (./autosave.ts).
 */

const VOICE_KEYS = [
  'shorthand',
  'acronyms',
  'emoji',
  'split',
] as const satisfies readonly (keyof Voice)[];

/** The extension's switches while the person uses Facebook themselves. */
const EXTENSION_TICKS = ['noting', 'readChats', 'markPosts'] as const;

/** How the saving goes, under what it saves: `idle` is what it says before any change. */
export function SaveLine({
  state,
  idle,
  testID,
}: {
  state: SaveState;
  idle?: string;
  testID: string;
}) {
  const [kind, words, tone] =
    state.kind === 'saving'
      ? ['saving', SETTINGS_WORDS.saving, 'text-text-3']
      : state.kind === 'saved'
        ? ['saved', state.words ?? SETTINGS_WORDS.saved, 'text-success-text']
        : state.kind === 'failed'
          ? ['problem', state.words, 'text-danger']
          : ['autosaves', idle, 'text-text-3'];
  if (!words) return null;
  return (
    <Text
      className={cn('px-1 text-[13px] leading-[18px]', tone)}
      accessibilityLiveRegion="polite"
      testID={`${testID}-${kind}`}
    >
      {words}
    </Text>
  );
}

/** A part of a page: on a card of its own, or plain inside one (where a new person starts). */
export function Section({
  boxed,
  title,
  about,
  children,
  testID,
}: {
  boxed: boolean;
  title: string;
  about?: string | null;
  children?: React.ReactNode;
  testID?: string;
}) {
  const part = (
    <Part title={title} about={about} testID={testID}>
      {children}
    </Part>
  );
  return boxed ? <Card className="px-4 py-4">{part}</Card> : part;
}

/** For your team: the heading of the business's part, for owners and admins. */
export function TeamHeading({ title, about }: { title: string; about?: string }) {
  return (
    <View className="gap-1 px-1 pt-3">
      <View className="flex-row flex-wrap items-center gap-2">
        <Text className="text-[17px] font-semibold">{title}</Text>
        <Badge variant="admin">{SETTINGS_WORDS.teamWho}</Badge>
      </View>
      {about ? <Note>{about}</Note> : null}
    </View>
  );
}

/** One choice of several, ticked when it's the one. */
export function Choice({
  label,
  about,
  selected,
  onPress,
  disabled = false,
  testID,
}: {
  label: string;
  about?: string;
  selected: boolean;
  onPress: () => void;
  disabled?: boolean;
  testID?: string;
}) {
  return (
    <Pressable
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onPress={onPress}
      className={cn(
        'flex-row items-start gap-3 rounded-menu border px-3 py-2.5',
        selected ? 'border-accent bg-accent-soft' : 'border-border-strong bg-card',
        disabled && 'opacity-50',
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
export function Tick({
  label,
  about,
  checked,
  onChange,
  disabled = false,
  testID,
}: {
  label: string;
  about?: string;
  checked: boolean;
  onChange: (on: boolean) => void;
  disabled?: boolean;
  testID?: string;
}) {
  return (
    <View className="flex-row items-center gap-3">
      <View className="flex-1 gap-0.5">
        <Text className="text-[14.5px] leading-[20px]">{label}</Text>
        {about ? <Note>{about}</Note> : null}
      </View>
      <Switch
        label={label}
        checked={checked}
        onCheckedChange={onChange}
        disabled={disabled}
        testID={testID}
      />
    </View>
  );
}

/** A number of something, a step at a time: the hours, the weeks, a daily limit. */
export function Stepper({
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

/** A stepper with its words before it, on one line. */
export function StepperRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View className="flex-row items-center justify-between gap-3">
      <Text className="flex-1 text-[14px]">{label}</Text>
      {children}
    </View>
  );
}

/** What the business allows of a network's choices: the same on every network (decision 38). */
export interface Allowed {
  readonly sendingAllowed: readonly SendingMode[];
  readonly repliesAllowed: readonly ReplyMode[];
  readonly postingAllowed?: readonly PostingMode[];
}

/**
 * What the extension does on its own on one network, in its words: Sending, Replies and helpful posts, only the
 * choices the business allows. A choice that starts the network's training wheels says so beside it, until they've
 * started (`wheelsFrom`): they start as soon as it's picked, since it saves at once. None for where a new person starts.
 */
export function NetworkModes({
  platform,
  value,
  onChange,
  sendingAllowed,
  repliesAllowed,
  postingAllowed = POSTING_MODE_KEYS,
  wheelsFrom,
  boxed,
  disabled,
  testID,
}: Allowed & {
  platform: Platform;
  value: NetworkChoices;
  onChange: (change: Partial<NetworkChoices>) => void;
  /** When the network's training wheels started; undefined where they don't apply. */
  wheelsFrom?: string | null;
  boxed: boolean;
  disabled: boolean;
  testID: string;
}) {
  const modes = sendingModesOn(platform);
  // Where the extension doesn't work the network yet, nothing goes on its own, and there's no helpful post on some.
  const runs = runsOnItsOwn(platform);
  const helpful = helpfulOn(platform);
  const sending = runs ? SENDING_MODE_KEYS.filter((m) => sendingAllowed.includes(m)) : [];
  const replies = REPLY_MODE_KEYS.filter((m) => repliesAllowed.includes(m));
  const posting = POSTING_MODE_KEYS.filter((m) => postingAllowed.includes(m));
  const notAllowed = [
    ...(runs
      ? [
          ...SENDING_MODE_KEYS.filter((m) => !sendingAllowed.includes(m)).map((m) => modes[m]),
          ...REPLY_MODE_KEYS.filter((m) => !repliesAllowed.includes(m)).map((m) => REPLY_MODES[m]),
        ]
      : []),
    ...(helpful
      ? POSTING_MODE_KEYS.filter((m) => !postingAllowed.includes(m)).map((m) => POSTING_MODES[m])
      : []),
  ];
  const starts = (next: Pick<NetworkChoices, 'sending' | 'replies'>) =>
    wheelsFrom === null && wheelsMatter(next) ? WHEELS_START_WORDS : undefined;
  return (
    <>
      <Section
        boxed={boxed}
        title={W.sections.onItsOwn}
        about={runs ? onItsOwnAbout(platform) : noRunnerWords(platform)}
        testID={`${testID}-on-its-own`}
      >
        {sending.map((m) => (
          <Choice
            key={m}
            label={modes[m]}
            about={starts({ sending: m, replies: value.replies })}
            selected={value.sending === m}
            onPress={() => onChange({ sending: m })}
            disabled={disabled}
            testID={`${testID}-sending-${m}`}
          />
        ))}
      </Section>
      {runs ? (
        <Section
          boxed={boxed}
          title={W.sections.replies}
          about={value.sending === 'off' ? W.abouts.repliesOff : W.abouts.replies}
        >
          {replies.map((m) => (
            <Choice
              key={m}
              label={REPLY_MODES[m]}
              about={starts({ sending: value.sending, replies: m })}
              selected={value.replies === m}
              onPress={() => onChange({ replies: m })}
              disabled={disabled}
              testID={`${testID}-replies-${m}`}
            />
          ))}
        </Section>
      ) : null}
      {helpful ? (
        <Section boxed={boxed} title={W.sections.posting} about={postingAboutOn(platform)}>
          {posting.map((m) => (
            <Choice
              key={m}
              label={POSTING_MODES[m]}
              about={m === 'after_ok' ? W.usual : undefined}
              selected={value.posting === m}
              onPress={() => onChange({ posting: m })}
              disabled={disabled}
              testID={`${testID}-posting-${m}`}
            />
          ))}
        </Section>
      ) : null}
      {notAllowed.length ? <Note>{W.notAllowed(notAllowed)}</Note> : null}
    </>
  );
}

/** Along the way on one network, in its words: liking first, confirming requests, the once-a-day jobs, and more. */
export function NetworkTicks({
  platform,
  value,
  onChange,
  boxed,
  disabled,
  testID,
}: {
  platform: Platform;
  value: NetworkChoices;
  onChange: (change: Partial<NetworkChoices>) => void;
  boxed: boolean;
  disabled: boolean;
  testID: string;
}) {
  const ticks = ticksOn(platform);
  // None on a network whose runner reads none yet.
  const shown = ticksShownOn(platform);
  if (!shown.length) return null;
  return (
    <Section boxed={boxed} title={W.sections.along}>
      <View className="gap-3">
        {shown.map((k) => (
          <Tick
            key={k}
            label={ticks[k][0]}
            about={ticks[k][1]}
            checked={value[k]}
            onChange={(on) => onChange({ [k]: on })}
            disabled={disabled}
            testID={`${testID}-${k}`}
          />
        ))}
      </View>
    </Section>
  );
}

/** What the extension does while the person uses Facebook themselves: Facebook's alone. */
export function ExtensionTicks({
  value,
  onChange,
  boxed,
  disabled,
  testID,
}: {
  value: AutomationSettings;
  onChange: Edit<AutomationSettings>;
  boxed: boolean;
  disabled: boolean;
  testID: string;
}) {
  return (
    <Section boxed={boxed} title={W.sections.extension} about={W.abouts.extension}>
      <View className="gap-3">
        {EXTENSION_TICKS.map((k) => (
          <Tick
            key={k}
            label={W.ticks[k][0]}
            about={W.ticks[k][1]}
            checked={value[k]}
            onChange={(on) => onChange((v) => ({ ...v, [k]: on }))}
            disabled={disabled}
            testID={`${testID}-${k}`}
          />
        ))}
      </View>
    </Section>
  );
}

/** How the AI writes for the person, with a made-up message in that voice. */
export function VoicePart({
  value,
  onChange,
  boxed,
  disabled,
  testID,
}: {
  value: AutomationSettings;
  onChange: Edit<AutomationSettings>;
  boxed: boolean;
  disabled: boolean;
  testID: string;
}) {
  return (
    <Section boxed={boxed} title={VOICE_WORDS.title} about={VOICE_WORDS.note}>
      <View className="gap-3">
        {VOICE_KEYS.map((k) => (
          <Tick
            key={k}
            label={VOICE_WORDS[k]}
            checked={value.voice[k]}
            onChange={(on) => onChange((v) => ({ ...v, voice: { ...v.voice, [k]: on } }))}
            disabled={disabled}
            testID={`${testID}-voice-${k}`}
          />
        ))}
        <ChatBubbles
          bubbles={voiceSample(value.voice).map((text) => ({ fromMe: true, text }))}
          label="How a message from you might read"
          testID={`${testID}-voice-sample`}
        />
      </View>
    </Section>
  );
}

/** The working hours, on the business's clock: the hours save after a pause, a day at once. */
export function WhenPart({
  value,
  onChange,
  timezone,
  boxed,
  disabled,
  testID,
}: {
  value: AutomationSettings;
  onChange: Edit<AutomationSettings>;
  timezone: string;
  boxed: boolean;
  disabled: boolean;
  testID: string;
}) {
  const hours = value.hours;
  const setHours = (part: Partial<AutomationSettings['hours']>, later = true) =>
    onChange((v) => ({ ...v, hours: { ...v.hours, ...part } }), { later });
  const may = (ok: boolean, then: () => void) => (ok && !disabled ? then : null);
  return (
    <Section boxed={boxed} title={W.sections.when} about={W.abouts.when(timezone)}>
      <View className="gap-2">
        <StepperRow label={W.from}>
          <Stepper
            words={hourWords(hours.start)}
            onDown={may(hours.start > 0, () => setHours({ start: hours.start - 1 }))}
            onUp={may(hours.start < hours.end - 1, () => setHours({ start: hours.start + 1 }))}
            testID={`${testID}-start`}
          />
        </StepperRow>
        <StepperRow label={W.to}>
          <Stepper
            words={hourWords(hours.end)}
            onDown={may(hours.end > hours.start + 1, () => setHours({ end: hours.end - 1 }))}
            onUp={may(hours.end < 24, () => setHours({ end: hours.end + 1 }))}
            testID={`${testID}-end`}
          />
        </StepperRow>
        <View className="flex-row flex-wrap gap-1.5">
          {WEEKDAY_WORDS.map((word, day) => {
            const on = hours.days.includes(day);
            return (
              <Button
                key={word}
                size="sm"
                variant={on ? 'primary' : 'secondary'}
                disabled={disabled || (on && hours.days.length === 1)}
                onPress={() =>
                  setHours(
                    {
                      days: on
                        ? hours.days.filter((d) => d !== day)
                        : [...hours.days, day].sort((a, b) => a - b),
                    },
                    false,
                  )
                }
                testID={`${testID}-day-${day}`}
              >
                {word}
              </Button>
            );
          })}
        </View>
      </View>
    </Section>
  );
}

/** How the person's phone hears what waits for them, and their numbers. */
export function PhonePart({
  value,
  onChange,
  boxed,
  disabled,
  testID,
}: {
  value: AutomationSettings;
  onChange: Edit<AutomationSettings>;
  boxed: boolean;
  disabled: boolean;
  testID: string;
}) {
  return (
    <Section boxed={boxed} title={W.sections.pushes} about={W.abouts.pushes}>
      {PUSH_MODE_KEYS.map((m) => (
        <Choice
          key={m}
          label={PUSH_MODES[m]}
          about={m === 'bundled' ? W.usual : undefined}
          selected={value.pushes === m}
          onPress={() => onChange((v) => ({ ...v, pushes: m }))}
          disabled={disabled}
          testID={`${testID}-pushes-${m}`}
        />
      ))}
      <Note>{W.abouts.pushesAlways}</Note>
      <Tick
        label={W.ticks.dayReport[0]}
        about={W.ticks.dayReport[1]}
        checked={value.dayReport}
        onChange={(on) => onChange((v) => ({ ...v, dayReport: on }))}
        disabled={disabled}
        testID={`${testID}-dayReport`}
      />
      <Note>{W.abouts.weekReview}</Note>
    </Section>
  );
}
