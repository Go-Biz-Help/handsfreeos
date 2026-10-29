'use client';
/**
 * Social Outreach's settings forms (docs/outreach.md, decisions 37 to 40 and 73): every setting lives in HandsFreeOS,
 * never in the browser extension, which loads them when the person signs in and follows each change within seconds.
 *
 * The pieces here are controlled: they show a value and hand each change on. The Settings tab's pages
 * (./settings-page.tsx) put them in cards and save each change as it's made; the setup (./setup-steps.tsx and
 * ./setup-network.tsx) uses them saved with its own buttons:
 *
 * - **A network's choices** (`NetworkModes`, `NetworkTicks`): what the extension does there on its own, in its words.
 *   The setup asks Sending as cards of its own and folds the rest under More choices.
 * - **The person's own** (`VoicePart`, `HoursPart`, `PushesPart`, `ExtensionTicks`), and `ChoicesForm`, all of them
 *   with Facebook's choices, for where a new person starts.
 * - **The networks the person works** (`NetworksPart`), on the Settings tab.
 * - **The business's rules** (`AllowedPicks`, `LimitsFields`, `DefaultsFold`), and `RulesForm`, all of them with the
 *   networks the team may use, for the setup's rules step when they're changed.
 */
import {
  BusinessRules,
  choicesFor,
  hoursProblem,
  hourWords,
  OTHER_PLATFORMS,
  PUSH_MODE_KEYS,
  PUSH_MODES,
  REPLY_MODE_KEYS,
  REPLY_MODES,
  POSTING_MODE_KEYS,
  POSTING_MODES,
  type PostingMode,
  requestModeChange,
  requestModeOf,
  SENDING_MODE_KEYS,
  SENDING_MODES,
  WEEKDAY_WORDS,
  WHEELS_START_WORDS,
  wheelsMatter,
  wheelsWords,
  type AutomationSettings,
  type NetworkChoices,
  type OtherPlatform,
  type ReplyMode,
  type SendingMode,
  type WheelsState,
} from '@hfos/core/addons/outreach/automation';
import { outreachSettings, settingsToSave } from '@hfos/core/addons/outreach/chat-read';
import { VOICE_WORDS, voiceSample, type Voice } from '@hfos/core/addons/outreach/voice';
import { DAILY_LIMITS, DAILY_STEPS, DAILY_WORDS } from '@hfos/core/addons/outreach/limits';
import {
  dailyWordsOn,
  helpfulOn,
  NETWORK_WORDS as NW,
  networksOn,
  noRunnerWords,
  onItsOwnAbout,
  postingAboutOn,
  requestsChoiceOn,
  sendingModesOn,
  ticksOn,
  ticksShownOn,
  tidyChoiceOn,
  withNetwork,
} from '@hfos/core/addons/outreach/network-words';
import {
  isLooking,
  NETWORKS,
  type Platform,
  PLATFORM_KEYS,
  PLATFORMS,
  runsOnItsOwn,
  WORKING_PLATFORMS,
} from '@hfos/core/addons/outreach/networks';
import { acceptedPushWords } from '@hfos/core/addons/outreach/alerts';
import { HELPFUL_MODES_ON, helpfulHowOn } from '@hfos/core/addons/outreach/helpful';
import { dayReportWords } from '@hfos/core/addons/outreach/tracking';
import { OUTREACH_WORDS as W } from '@hfos/core/addons/outreach/words';
import { SETUP_WORDS } from '@hfos/core/addons/outreach/setup';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { RadioCard } from '@/components/ui/radio-card';
import { Switch } from '@/components/ui/switch';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { ChatBubbles } from './chat-bubbles';
import type { Automation } from './types';
import { useAct } from './use-act';

const VOICE_KEYS = [
  'shorthand',
  'acronyms',
  'emoji',
  'split',
] as const satisfies readonly (keyof Voice)[];

export const select =
  'h-8 rounded-control border border-border-strong bg-card px-2 text-[13px] max-md:h-11';

/**
 * A part of a form: its title and a line about it. As a `card`, one of the Settings pages' cards (the design's "Social
 * Outreach settings by platform"), with a badge beside its title when it's for owners and admins.
 */
export function Part({
  title,
  about,
  card = false,
  badge,
  testId,
  children,
}: {
  title: string;
  about?: string;
  card?: boolean;
  badge?: string;
  testId?: string;
  children: React.ReactNode;
}) {
  if (card)
    return (
      <Card className="space-y-3.5 px-[22px] py-5 max-md:px-4 max-md:py-4" data-testid={testId}>
        <div>
          <div className="flex flex-wrap items-center gap-2.5">
            <h3 className="text-[16px] font-semibold tracking-tight">{title}</h3>
            {badge ? <Badge variant="owner">{badge}</Badge> : null}
          </div>
          {about ? <p className="mt-1 text-[13px] text-text-2">{about}</p> : null}
        </div>
        {children}
      </Card>
    );
  return (
    <div className="space-y-2" data-testid={testId}>
      <div>
        <h3 className="text-[14px] font-semibold">{title}</h3>
        {about ? <p className="text-[13px] text-text-2">{about}</p> : null}
      </div>
      {children}
    </div>
  );
}

/**
 * A setting that's on or off: a tick in a form saved with a button, or a switch on the Settings pages, where it saves
 * the moment it's flipped. Its words are `W.ticks`' own: what it does, and a line about it.
 */
export function Tick({
  words,
  checked,
  onChange,
  switches = false,
  testId,
}: {
  words: readonly [string, string];
  checked: boolean;
  onChange: (next: boolean) => void;
  switches?: boolean;
  testId: string;
}) {
  if (switches)
    return (
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="text-[14px] font-medium">{words[0]}</div>
          <div className="text-[13px] text-text-2">{words[1]}</div>
        </div>
        <Switch checked={checked} onChange={onChange} label={words[0]} testId={testId} />
      </div>
    );
  return (
    <div>
      <Checkbox
        label={<span className="text-[14px]">{words[0]}</span>}
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        data-testid={testId}
      />
      <span className="mt-0.5 block pl-7 text-[13px] text-text-2">{words[1]}</span>
    </div>
  );
}

/** What the business allows of a network's choices: the same on every network (decision 38). */
interface Allowed {
  readonly sendingAllowed: readonly SendingMode[];
  readonly repliesAllowed: readonly ReplyMode[];
  readonly postingAllowed?: readonly PostingMode[];
}

/**
 * What the extension does on its own on one network, in its words: Sending, Replies and helpful posts, only the
 * choices the business allows. With `wheelsStart` (training wheels not started there yet), a choice that would start
 * them says so before it's picked, since on the Settings pages it saves the moment it is.
 */
export function NetworkModes({
  platform,
  value,
  onChange,
  sendingAllowed,
  repliesAllowed,
  postingAllowed = POSTING_MODE_KEYS,
  card = false,
  wheelsStart = false,
  sendingPart = true,
  testId,
}: Allowed & {
  platform: Platform;
  value: NetworkChoices;
  onChange: (change: Partial<NetworkChoices>) => void;
  card?: boolean;
  wheelsStart?: boolean;
  /** Sending's own part: the setup asks it on its own, as cards, and folds the rest (decision 83). */
  sendingPart?: boolean;
  testId: string;
}) {
  const modes = sendingModesOn(platform);
  // Where the extension doesn't work the network yet, nothing goes on its own, and there's no helpful post on some.
  const runs = runsOnItsOwn(platform);
  const helpful = helpfulOn(platform);
  const sending = SENDING_MODE_KEYS.filter((m) => sendingAllowed.includes(m));
  const replies = REPLY_MODE_KEYS.filter((m) => repliesAllowed.includes(m));
  // Only the ways the network takes (decision 109): Instagram's goes up from the phone, Alignable's never on its own.
  const postingOn = HELPFUL_MODES_ON[platform];
  const posting = postingOn.filter((m) => postingAllowed.includes(m));
  const notAllowed = [
    ...(runs
      ? [
          ...SENDING_MODE_KEYS.filter((m) => !sendingAllowed.includes(m)).map((m) => modes[m]),
          ...REPLY_MODE_KEYS.filter((m) => !repliesAllowed.includes(m)).map((m) => REPLY_MODES[m]),
        ]
      : []),
    ...(helpful
      ? postingOn.filter((m) => !postingAllowed.includes(m)).map((m) => POSTING_MODES[m])
      : []),
  ];
  // Picking this one would start training wheels there: said beside it first.
  const starts = (choice: Pick<NetworkChoices, 'sending' | 'replies'>) =>
    wheelsStart && !wheelsMatter(value) && wheelsMatter(choice) ? WHEELS_START_WORDS : undefined;
  return (
    <>
      {sendingPart ? (
        <Part
          title={W.sections.onItsOwn}
          about={runs ? onItsOwnAbout(platform) : noRunnerWords(platform)}
          card={card}
          testId={`${testId}-on-its-own`}
        >
          {runs ? (
            <div role="radiogroup" aria-label="Sending" className="flex flex-col gap-2">
              {sending.map((m) => (
                <RadioCard
                  key={m}
                  selected={value.sending === m}
                  onSelect={() => onChange({ sending: m })}
                  title={modes[m]}
                  description={starts({ sending: m, replies: value.replies })}
                  testId={`${testId}-sending-${m}`}
                />
              ))}
            </div>
          ) : null}
        </Part>
      ) : null}
      {runs ? (
        <Part
          title={W.sections.replies}
          about={value.sending === 'off' ? W.abouts.repliesOff : W.abouts.replies}
          card={card}
        >
          <div role="radiogroup" aria-label="Replies" className="flex flex-col gap-2">
            {replies.map((m) => (
              <RadioCard
                key={m}
                selected={value.replies === m}
                onSelect={() => onChange({ replies: m })}
                title={REPLY_MODES[m]}
                description={starts({ sending: value.sending, replies: m })}
                testId={`${testId}-replies-${m}`}
              />
            ))}
          </div>
        </Part>
      ) : null}
      {helpful ? (
        <Part title={W.sections.posting} about={postingAboutOn(platform)} card={card}>
          <div role="radiogroup" aria-label="Helpful posts" className="flex flex-col gap-2">
            {posting.map((m) => (
              <RadioCard
                key={m}
                selected={helpfulHowOn(platform, value.posting) === m}
                onSelect={() => onChange({ posting: m })}
                title={POSTING_MODES[m]}
                description={m === 'after_ok' ? W.usual : undefined}
                testId={`${testId}-posting-${m}`}
              />
            ))}
          </div>
        </Part>
      ) : null}
      {notAllowed.length ? (
        <p className="text-[13px] text-text-2">{W.notAllowed(notAllowed)}</p>
      ) : null}
    </>
  );
}

/**
 * Along the way on one network, in its words: liking first, confirming requests, the once-a-day jobs, and more. Where
 * the extension answers the requests the person gets (Facebook's), how it answers them, in place of a tick
 * (decision 121).
 */
export function NetworkTicks({
  platform,
  value,
  onChange,
  card = false,
  testId,
}: {
  platform: Platform;
  value: NetworkChoices;
  onChange: (change: Partial<NetworkChoices>) => void;
  card?: boolean;
  testId: string;
}) {
  const ticks = ticksOn(platform);
  // None on a network whose runner reads none yet.
  const shown = ticksShownOn(platform);
  const requests = requestsChoiceOn(platform);
  if (!shown.length && !requests) return null;
  const answering = requestModeOf(value);
  return (
    <>
      {shown.length ? (
        <Part title={W.sections.along} card={card}>
          {shown.map((key) => (
            <Tick
              key={key}
              words={ticks[key]}
              checked={value[key]}
              onChange={(on) => onChange({ [key]: on })}
              testId={`${testId}-${key}`}
            />
          ))}
        </Part>
      ) : null}
      {requests ? (
        <Part
          title={requests.label}
          about={requests.about}
          card={card}
          testId={`${testId}-requests`}
        >
          <div role="radiogroup" aria-label={requests.label} className="flex flex-col gap-2">
            {requests.options.map((o) => (
              <RadioCard
                key={o.key}
                selected={answering === o.key}
                onSelect={() => onChange(requestModeChange(o.key))}
                title={o.label}
                description={o.note ?? undefined}
                testId={`${testId}-requests-${o.key}`}
              />
            ))}
          </div>
        </Part>
      ) : null}
    </>
  );
}

/**
 * Tidying up on its own on one network (decision 98), in its words: only who the person ticks, the old requests, or on
 * Facebook those and friends to unfriend. Only where the extension works on its own.
 */
export function NetworkTidy({
  platform,
  value,
  onChange,
  card = false,
  testId,
}: {
  platform: Platform;
  value: NetworkChoices;
  onChange: (change: Partial<NetworkChoices>) => void;
  card?: boolean;
  testId: string;
}) {
  if (!runsOnItsOwn(platform)) return null;
  const choice = tidyChoiceOn(platform);
  // A server from before it says nothing: old requests, as it starts.
  const picked = value.tidy ?? 'cancel';
  return (
    <Part title={choice.label} about={choice.about} card={card} testId={`${testId}-tidy`}>
      <div role="radiogroup" aria-label={choice.label} className="flex flex-col gap-2">
        {choice.options.map((o) => (
          <RadioCard
            key={o.key}
            selected={picked === o.key}
            onSelect={() => onChange({ tidy: o.key })}
            title={o.label}
            testId={`${testId}-tidy-${o.key}`}
          />
        ))}
      </div>
    </Part>
  );
}

/** The person's own on every network: one part of their settings, changed as a whole. */
interface Own {
  value: AutomationSettings;
  onChange: (next: AutomationSettings) => void;
  card?: boolean;
  testId: string;
}

/** How the AI writes for them (decision 53), with a sample of how a message from them reads. */
export function VoicePart({ value, onChange, card = false, testId }: Own) {
  return (
    <Part title={VOICE_WORDS.title} about={VOICE_WORDS.note} card={card}>
      {VOICE_KEYS.map((key) => (
        <Checkbox
          key={key}
          label={<span className="text-[14px]">{VOICE_WORDS[key]}</span>}
          checked={value.voice[key]}
          onChange={(e) =>
            onChange({ ...value, voice: { ...value.voice, [key]: e.target.checked } })
          }
          data-testid={`${testId}-voice-${key}`}
        />
      ))}
      <ChatBubbles
        bubbles={voiceSample(value.voice).map((text) => ({ fromMe: true, text }))}
        label="How a message from you might read"
        testId={`${testId}-voice-sample`}
      />
    </Part>
  );
}

/** What the extension does while they use Facebook themselves: its three switches (decision 37). */
export function ExtensionTicks({
  value,
  onChange,
  card = false,
  switches = false,
  testId,
}: Own & { switches?: boolean }) {
  return (
    <Part title={W.sections.extension} about={W.abouts.extension} card={card}>
      {(['noting', 'readChats', 'markPosts'] as const).map((key) => (
        <Tick
          key={key}
          words={W.ticks[key]}
          checked={value[key]}
          onChange={(on) => onChange({ ...value, [key]: on })}
          switches={switches}
          testId={`${testId}-${key}`}
        />
      ))}
    </Part>
  );
}

/**
 * How their phone and the extension tell them what waits (decision 40), the day's report (decision 70), and a push when
 * someone accepts (decision 101, off to start).
 */
export function PushesPart({
  value,
  onChange,
  card = false,
  switches = false,
  testId,
}: Own & { switches?: boolean }) {
  return (
    <Part title={W.sections.pushes} about={W.abouts.pushes} card={card}>
      <div role="radiogroup" aria-label="Pushes" className="flex flex-col gap-2">
        {PUSH_MODE_KEYS.map((m) => (
          <RadioCard
            key={m}
            selected={value.pushes === m}
            onSelect={() => onChange({ ...value, pushes: m })}
            title={PUSH_MODES[m]}
            description={m === 'bundled' ? W.usual : undefined}
            testId={`${testId}-pushes-${m}`}
          />
        ))}
      </div>
      <p className="text-[13px] text-text-2">{W.abouts.pushesAlways}</p>
      <div className="border-t border-border pt-3">
        <Tick
          words={W.ticks.dayReport}
          checked={value.dayReport}
          onChange={(dayReport) => onChange({ ...value, dayReport })}
          switches={switches}
          testId={`${testId}-dayReport`}
        />
      </div>
      {value.dayReport ? (
        <PushSample
          title={dayReportSample.title}
          body={dayReportSample.body}
          testId={`${testId}-day-report-sample`}
        />
      ) : null}
      <p className="text-[12.5px] text-text-3">{W.abouts.weekReview}</p>
      <div className="border-t border-border pt-3">
        <Tick
          words={W.ticks.acceptedPush}
          checked={value.acceptedPush}
          onChange={(acceptedPush) => onChange({ ...value, acceptedPush })}
          switches={switches}
          testId={`${testId}-acceptedPush`}
        />
      </div>
      {value.acceptedPush ? (
        <PushSample
          title={acceptedSample.title}
          body={acceptedSample.body}
          testId={`${testId}-accepted-sample`}
        />
      ) : null}
    </Part>
  );
}

/** Their working hours (decision 28), on the business's clock. */
export function HoursPart({
  value,
  onChange,
  timezone,
  card = false,
  testId,
}: Own & { timezone: string }) {
  const hours = (change: Partial<AutomationSettings['hours']>) =>
    onChange({ ...value, hours: { ...value.hours, ...change } });
  // Caught halfway, say a start moved past the end: why they can't be kept yet. Settings wait for it to clear.
  const problem = hoursProblem(value.hours);
  return (
    <Part title={W.sections.when} about={W.abouts.when(timezone)} card={card}>
      <p className="flex flex-wrap items-center gap-2 text-[13px]">
        {W.from}
        <select
          className={select}
          value={value.hours.start}
          onChange={(e) => hours({ start: Number(e.target.value) })}
          aria-label="Starts"
          data-testid={`${testId}-start`}
        >
          {Array.from({ length: 24 }, (_, h) => (
            <option key={h} value={h}>
              {hourWords(h)}
            </option>
          ))}
        </select>
        {W.to}
        <select
          className={select}
          value={value.hours.end}
          onChange={(e) => hours({ end: Number(e.target.value) })}
          aria-label="Ends"
          data-testid={`${testId}-end`}
        >
          {Array.from({ length: 24 }, (_, i) => i + 1).map((h) => (
            <option key={h} value={h}>
              {h === 24 ? 'midnight' : hourWords(h)}
            </option>
          ))}
        </select>
      </p>
      <div className="flex flex-wrap gap-3">
        {WEEKDAY_WORDS.map((word, day) => (
          <Checkbox
            key={word}
            label={word}
            checked={value.hours.days.includes(day)}
            onChange={(e) => {
              const days = e.target.checked
                ? [...value.hours.days, day]
                : value.hours.days.filter((d) => d !== day);
              hours({ days: days.sort((a, b) => a - b) });
            }}
          />
        ))}
      </div>
      {problem ? (
        <p
          role="alert"
          className="text-[13px] text-danger-text"
          data-testid={`${testId}-hours-problem`}
        >
          {problem}
        </p>
      ) : null}
    </Part>
  );
}

/**
 * The choices themselves, in one form: someone's own in the setup, or where a new person starts. Facebook's, and
 * what's theirs on every network (the voice, the extension's switches, the pushes and the hours).
 */
export function ChoicesForm({
  value,
  onChange,
  sendingAllowed,
  repliesAllowed,
  postingAllowed = POSTING_MODE_KEYS,
  timezone,
  testId,
}: {
  value: AutomationSettings;
  onChange: (next: AutomationSettings) => void;
  sendingAllowed: readonly SendingMode[];
  repliesAllowed: readonly ReplyMode[];
  postingAllowed?: readonly PostingMode[];
  timezone: string;
  testId: string;
}) {
  const facebook = choicesFor(value, 'facebook');
  const setFacebook = (change: Partial<NetworkChoices>) =>
    onChange(withNetwork(value, 'facebook', change));
  return (
    <div className="space-y-5" data-testid={testId}>
      <NetworkModes
        platform="facebook"
        value={facebook}
        onChange={setFacebook}
        sendingAllowed={sendingAllowed}
        repliesAllowed={repliesAllowed}
        postingAllowed={postingAllowed}
        testId={testId}
      />
      <VoicePart value={value} onChange={onChange} testId={testId} />
      <NetworkTicks platform="facebook" value={facebook} onChange={setFacebook} testId={testId} />
      <ExtensionTicks value={value} onChange={onChange} testId={testId} />
      <PushesPart value={value} onChange={onChange} testId={testId} />
      <HoursPart value={value} onChange={onChange} timezone={timezone} testId={testId} />
    </div>
  );
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** A network's training wheels, as the settings show them: Facebook's, or another network's own. */
export const wheelsOf = (me: Automation, platform: Platform): WheelsState =>
  OTHER_PLATFORMS.includes(platform as OtherPlatform)
    ? me.networkWheels[platform as OtherPlatform]
    : me.wheels;

/**
 * The networks the person works (Chris: each person turns networks on, inside what the business allows), each with its
 * switch, for the setup's networks step. Under any other network, its own choices, the same as Facebook's and off to
 * start, and its own training wheels; Facebook's choices are the setup's next step. A network the business doesn't use
 * says why, and who can change that.
 */
export function NetworksPart({
  value,
  onChange,
  me,
  manages,
  choices = true,
  testId,
}: {
  value: AutomationSettings;
  onChange: (next: AutomationSettings) => void;
  /** Whose they are, with what the business allows and each network's training wheels. */
  me: Automation;
  /** An owner or admin, who can allow a network on its page in Settings. */
  manages: boolean;
  /** Each other network's choices under its switch. */
  choices?: boolean;
  testId: string;
}) {
  const allowed = me.rules.networksAllowed;
  return (
    <Part title={NW.title} about={NW.about}>
      <ul className="divide-y divide-border rounded-card border border-border" data-testid={testId}>
        {/* A network still looked at (decision 78) is turned on from its own page, for its Check. */}
        {WORKING_PLATFORMS.map((p) => {
          const name = PLATFORMS[p];
          const may = allowed.includes(p);
          const on = may && networksOn(value, allowed).includes(p);
          const network = choicesFor(value, p);
          const set = (change: Partial<NetworkChoices>) => onChange(withNetwork(value, p, change));
          const wheels = wheelsOf(me, p);
          // Facebook's choices are the settings' own, in the setup's next step.
          const own = !OTHER_PLATFORMS.includes(p as OtherPlatform);
          return (
            <li key={p} className="space-y-3 p-3.5" data-testid={`${testId}-${p}`}>
              <div className="flex items-center justify-between gap-3">
                <span className="text-[14px] font-semibold">{name}</span>
                <Switch
                  checked={on}
                  onChange={(next) => set({ on: next })}
                  label={name}
                  disabled={!may}
                  testId={`${testId}-${p}-on`}
                />
              </div>
              {!may ? (
                <p className="text-[13px] text-text-2" data-testid={`${testId}-${p}-not-allowed`}>
                  {NW.notAllowed(name, manages)}
                </p>
              ) : !on ? (
                <p className="text-[13px] text-text-3">{NW.off(name)}</p>
              ) : own ? (
                choices ? (
                  <p className="text-[13px] text-text-2">{NW.facebookChoices}</p>
                ) : null
              ) : choices ? (
                <div className="space-y-5 border-t border-border pt-3">
                  <div>
                    <h3 className="text-[14px] font-semibold">{NW.choicesOn(name)}</h3>
                    <p className="text-[13px] text-text-2">{NW.choicesAbout(name)}</p>
                  </div>
                  {wheels.on ? (
                    <p
                      className="text-[13px] text-warning-text"
                      data-testid={`${testId}-${p}-wheels`}
                    >
                      {wheelsWords(wheels)}
                    </p>
                  ) : null}
                  <NetworkModes
                    platform={p}
                    value={network}
                    onChange={set}
                    sendingAllowed={me.rules.sendingAllowed}
                    repliesAllowed={me.rules.repliesAllowed}
                    postingAllowed={me.rules.postingAllowed}
                    testId={`${testId}-${p}`}
                  />
                  <NetworkTicks
                    platform={p}
                    value={network}
                    onChange={set}
                    testId={`${testId}-${p}`}
                  />
                  {wheelsMatter(network) && !wheels.from ? (
                    <p className="text-[13px] text-text-2">{WHEELS_START_WORDS}</p>
                  ) : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </Part>
  );
}

const toggle = <T extends string>(list: readonly T[], item: T, on: boolean) =>
  on ? [...list, item] : list.filter((x) => x !== item);

/**
 * The choices people may pick (decision 38), by what they're about: doing everything themselves, and every reply
 * waiting, are always allowed, and so is copying a helpful post.
 */
export function AllowedPicks({
  rules,
  onChange,
}: {
  rules: BusinessRules;
  onChange: (next: BusinessRules) => void;
}) {
  return (
    <Part title={W.sections.allowed} about={W.abouts.allowed}>
      <div className="grid gap-x-4 gap-y-3 sm:grid-cols-3">
        <div className="min-w-0 space-y-2">
          <p className="text-[12.5px] text-text-3">{W.sections.onItsOwn}</p>
          {SENDING_MODE_KEYS.filter((m) => m !== 'off').map((m) => (
            <Checkbox
              key={m}
              label={SENDING_MODES[m]}
              checked={rules.sendingAllowed.includes(m)}
              onChange={(e) =>
                onChange({
                  ...rules,
                  sendingAllowed: toggle(rules.sendingAllowed, m, e.target.checked),
                })
              }
              data-testid={`outreach-rules-sending-${m}`}
            />
          ))}
        </div>
        <div className="min-w-0 space-y-2">
          <p className="text-[12.5px] text-text-3">{W.sections.replies}</p>
          {REPLY_MODE_KEYS.filter((m) => m !== 'draft').map((m) => (
            <Checkbox
              key={m}
              label={REPLY_MODES[m]}
              checked={rules.repliesAllowed.includes(m)}
              onChange={(e) =>
                onChange({
                  ...rules,
                  repliesAllowed: toggle(rules.repliesAllowed, m, e.target.checked),
                })
              }
              data-testid={`outreach-rules-replies-${m}`}
            />
          ))}
        </div>
        <div className="min-w-0 space-y-2">
          <p className="text-[12.5px] text-text-3">{W.sections.posting}</p>
          {POSTING_MODE_KEYS.filter((m) => m !== 'copy').map((m) => (
            <Checkbox
              key={m}
              label={POSTING_MODES[m]}
              checked={rules.postingAllowed.includes(m)}
              onChange={(e) =>
                onChange({
                  ...rules,
                  postingAllowed: toggle(rules.postingAllowed, m, e.target.checked),
                })
              }
              data-testid={`outreach-rules-posting-${m}`}
            />
          ))}
        </div>
      </div>
    </Part>
  );
}

/**
 * A network's daily limits for each person, each at most its starting one: Facebook's in `dailyLimits`, any other's
 * in `networkLimits`. A number typed is handed on as `typed`, so the Settings pages save it after a pause, and at once
 * on `onBlur`.
 */
export function LimitsFields({
  platform,
  rules,
  onChange,
  onBlur,
  title,
}: {
  platform: Platform;
  rules: BusinessRules;
  onChange: (next: BusinessRules, typed: boolean) => void;
  onBlur?: () => void;
  /** Its heading, when not the setup's. */
  title?: string;
}) {
  const own = !OTHER_PLATFORMS.includes(platform as OtherPlatform);
  const name = PLATFORMS[platform];
  const words = own ? DAILY_WORDS : dailyWordsOn(platform);
  const kept = own ? rules.dailyLimits : (rules.networkLimits[platform as OtherPlatform] ?? {});
  const set = (step: (typeof DAILY_STEPS)[number], n: number) =>
    onChange(
      own
        ? { ...rules, dailyLimits: { ...rules.dailyLimits, [step]: n } }
        : {
            ...rules,
            networkLimits: { ...rules.networkLimits, [platform]: { ...kept, [step]: n } },
          },
      true,
    );
  return (
    <Part
      title={title ?? (own ? W.sections.limits : NW.limitsOn(name))}
      about={own ? W.abouts.limits : NW.limitsAbout(name)}
    >
      <div className="grid grid-cols-2 gap-3 max-md:grid-cols-1">
        {DAILY_STEPS.map((step) => {
          const most = own ? DAILY_LIMITS[step] : NETWORKS[platform].dailyLimits[step];
          return (
            <label key={step} className="flex items-center justify-between gap-2 text-[13px]">
              {words[step].label}
              <input
                type="number"
                min={0}
                max={most}
                className={`${select} w-20`}
                value={kept[step] ?? most}
                onChange={(e) =>
                  set(step, Math.max(0, Math.min(most, Number(e.target.value) || 0)))
                }
                onBlur={onBlur}
                data-testid={
                  own ? `outreach-rules-limit-${step}` : `outreach-rules-${platform}-limit-${step}`
                }
              />
            </label>
          );
        })}
      </div>
    </Part>
  );
}

/** Where a new person starts, folded: it's the same form as each person's, and rarely changed (decision 59). */
export function DefaultsFold({
  rules,
  onChange,
  timezone,
}: {
  rules: BusinessRules;
  onChange: (next: BusinessRules) => void;
  timezone: string;
}) {
  return (
    <details
      className="group rounded-menu border border-border"
      data-testid="outreach-defaults-part"
    >
      <summary className="flex cursor-pointer list-none items-start justify-between gap-3 rounded-menu p-3.5 [&::-webkit-details-marker]:hidden">
        <span className="min-w-0">
          <span className="block text-[14px] font-semibold">{W.sections.defaults}</span>
          <span className="mt-0.5 block text-[13px] text-text-2">
            {SENDING_MODES[rules.defaults.sending]} · {REPLY_MODES[rules.defaults.replies]}
          </span>
        </span>
        <span className="flex-none text-[13px] font-medium text-accent-text group-open:hidden">
          {W.change}
        </span>
      </summary>
      <div className="border-t border-border p-3.5">
        <p className="mb-4 text-[13px] text-text-2">
          {`${W.abouts.defaults} Change anyone’s under Settings for, above.`}
        </p>
        <ChoicesForm
          value={rules.defaults}
          onChange={(defaults) => onChange({ ...rules, defaults })}
          sendingAllowed={rules.sendingAllowed}
          repliesAllowed={rules.repliesAllowed}
          postingAllowed={rules.postingAllowed}
          timezone={timezone}
          testId="outreach-defaults"
        />
      </div>
    </details>
  );
}

/**
 * The business's rules for everyone's choices, in one form for the setup's rules step (`carryOn`): its button moves
 * on, saving first when anything changed, else keeping them as they are.
 */
export function RulesForm({
  workspaceId,
  settings,
  timezone,
  carryOn,
  carryingOn = false,
}: {
  workspaceId: string;
  settings: Readonly<Record<string, unknown>>;
  timezone: string;
  carryOn?: () => void;
  /** The setup is saving where they got to and moving on: pressing again would save twice. */
  carryingOn?: boolean;
}) {
  const kept = BusinessRules.safeParse(settings.rules ?? {});
  const now = kept.success ? kept.data : BusinessRules.parse({});
  const [rules, setRules] = useState(now);
  const { busy, act } = useAct();
  return (
    <div className="space-y-5" data-testid="outreach-rules">
      <AllowedPicks rules={rules} onChange={setRules} />
      <LimitsFields platform="facebook" rules={rules} onChange={setRules} />
      <Part title={NW.allowedTitle} about={NW.allowedAbout}>
        {PLATFORM_KEYS.map((p) => {
          // Facebook is always allowed (`BusinessRules.networksAllowed`).
          const always = !OTHER_PLATFORMS.includes(p as OtherPlatform);
          return (
            <Checkbox
              key={p}
              label={always ? `${PLATFORMS[p]} · ${NW.alwaysAllowed}` : PLATFORMS[p]}
              checked={always || rules.networksAllowed.includes(p)}
              disabled={always}
              onChange={(e) =>
                setRules({
                  ...rules,
                  networksAllowed: toggle(rules.networksAllowed, p, e.target.checked),
                })
              }
              data-testid={`outreach-rules-network-${p}`}
            />
          );
        })}
      </Part>
      {OTHER_PLATFORMS.filter((p) => rules.networksAllowed.includes(p) && !isLooking(p)).map(
        (p) => (
          <LimitsFields key={p} platform={p} rules={rules} onChange={setRules} />
        ),
      )}
      <DefaultsFold rules={rules} onChange={setRules} timezone={timezone} />
      <Button
        size={carryOn ? 'lg' : 'sm'}
        disabled={(!carryOn && same(rules, now)) || busy !== null || carryingOn}
        loading={busy === 'rules'}
        onClick={() => {
          // Kept as they are once already: nothing to save. The setup's first keep is saved, so its step ticks.
          if (carryOn && same(rules, now) && outreachSettings(settings).rulesKept) return carryOn();
          void act(
            'rules',
            async () =>
              unwrap(
                await apiBrowser().POST('/v1/commands/addon.save_settings', {
                  body: {
                    workspaceId,
                    addonId: 'outreach',
                    settings: settingsToSave(
                      settings,
                      carryOn ? { rules, rulesKept: true } : { rules },
                    ),
                  },
                }),
              ),
            W.savedForEveryone,
          ).then((ok) => {
            if (ok) carryOn?.();
          });
        }}
        data-testid="outreach-rules-save"
      >
        {carryOn ? (same(rules, now) ? SETUP_WORDS.keepRules : SETUP_WORDS.saveRules) : W.save}
      </Button>
    </div>
  );
}

/** How the day's report reads on a phone, from a made-up day. */
const dayReportSample = dayReportWords({ messages: 14, positive: 2, booked: 1 }, 15);
const acceptedSample = acceptedPushWords(['Dana Reyes'], 'facebook');

/** A push as it shows on a phone: the add-on's name, its title and its words. */
function PushSample({ title, body, testId }: { title: string; body: string; testId: string }) {
  return (
    <div
      className="grid max-w-[420px] grid-cols-[36px_minmax(0,1fr)] gap-2.5 rounded-[14px] border border-border bg-card-2 px-3.5 py-3"
      aria-label="How it reads on your phone"
      data-testid={testId}
    >
      <span
        className="inline-flex h-9 w-9 items-center justify-center rounded-[9px] bg-accent text-[13px] font-bold text-white"
        aria-hidden="true"
      >
        HF
      </span>
      <div className="min-w-0 text-[13px]">
        <div className="text-[12px] font-semibold text-text-2">{W.title}</div>
        <div className="font-semibold">{title}</div>
        <div>{body}</div>
      </div>
    </div>
  );
}
