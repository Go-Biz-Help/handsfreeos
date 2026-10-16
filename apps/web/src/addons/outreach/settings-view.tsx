'use client';
/**
 * Social Outreach's Settings tab (docs/outreach.md, decisions 37 to 40): every setting lives here, never in the
 * browser extension, which loads them when the person signs in and follows each change within seconds.
 *
 * - **My settings:** the networks the person works, each other network's own choices under it (the same choices as
 *   Facebook's, off to start), what the extension does for them on Facebook on its own, its switches, how their phone
 *   hears what waits, and their working hours (`outreach.automation.save`). Only the choices the business allows show;
 *   a network it doesn't allow says why, and who can change that. A network's switch saves at once, on its own (Chris,
 *   2026-10-16); everything else waits for Save.
 * - **Someone else's:** owners and admins pick a person to see or change theirs; the person sees who did.
 * - **Business settings:** owners and admins set the choices people may pick, the networks the team may use and
 *   each one's daily limits under its starting ones, where a new person starts, where the team downloads the extension (./extension-link.tsx), and the business's
 *   other Social Outreach settings (`addon.save_settings`).
 * - **Your computer:** the person's computers, to rename (./live-view.tsx); the one used last works.
 * - **Set up again** opens Social Outreach's setup at its first step (./setup-view.tsx).
 * - **Start fresh**, for owners (./start-fresh.tsx).
 *
 * Each part has an anchor the Settings tab's menu links to (./home.tsx, decision 59); Playbooks sit beside them there.
 */
import {
  BusinessRules,
  choicesFor,
  hourWords,
  OTHER_PLATFORMS,
  PUSH_MODE_KEYS,
  PUSH_MODES,
  REPLY_MODE_KEYS,
  REPLY_MODES,
  POSTING_MODE_KEYS,
  POSTING_MODES,
  type PostingMode,
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
import { settingsToSave } from '@hfos/core/addons/outreach/chat-read';
import { VOICE_WORDS, voiceSample, type Voice } from '@hfos/core/addons/outreach/voice';
import { DAILY_LIMITS, DAILY_STEPS, DAILY_WORDS } from '@hfos/core/addons/outreach/limits';
import {
  ALONG_TICKS,
  dailyWordsOn,
  NETWORK_WORDS as NW,
  networksOn,
  onItsOwnAbout,
  postingAboutOn,
  sendingModesOn,
  ticksOn,
  withNetwork,
} from '@hfos/core/addons/outreach/network-words';
import {
  NETWORKS,
  PLATFORM_KEYS,
  PLATFORMS,
  type Platform,
} from '@hfos/core/addons/outreach/networks';
import { dayReportWords } from '@hfos/core/addons/outreach/tracking';
import { OUTREACH_WORDS as W } from '@hfos/core/addons/outreach/words';
import { outreachSetupPath, SETUP_WORDS } from '@hfos/core/addons/outreach/setup';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button, ButtonLink } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { RadioCard } from '@/components/ui/radio-card';
import { Switch } from '@/components/ui/switch';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import { useLiveRefresh } from '@/lib/realtime/live-provider';
import { outreachHref } from './address';
import { ChatBubbles } from './chat-bubbles';
import { ExtensionDownload } from './extension-download';
import { ExtensionLinkForm } from './extension-link';
import { StartFresh } from './start-fresh';
import OutreachBusinessSettings from './business-settings';
import { ComputersCard, useServerNow } from './live-view';
import type { Automation, AutomationPeople, Live } from './types';
import { useAct } from './use-act';

const VOICE_KEYS = [
  'shorthand',
  'acronyms',
  'emoji',
  'split',
] as const satisfies readonly (keyof Voice)[];

const select =
  'h-8 rounded-control border border-border-strong bg-card px-2 text-[13px] max-md:h-11';

function Section({
  id,
  title,
  children,
}: {
  id?: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section
      id={id}
      className="scroll-mt-4 space-y-3 rounded-card border border-border bg-card p-5 shadow-1"
    >
      <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
      {children}
    </section>
  );
}

function Part({
  title,
  about,
  children,
}: {
  title: string;
  about?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <div>
        <h3 className="text-[14px] font-semibold">{title}</h3>
        {about ? <p className="text-[13px] text-text-2">{about}</p> : null}
      </div>
      {children}
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
 * choices the business allows. Facebook's in the form below Networks; any other network's under its switch.
 */
export function NetworkModes({
  platform,
  value,
  onChange,
  sendingAllowed,
  repliesAllowed,
  postingAllowed = POSTING_MODE_KEYS,
  testId,
}: Allowed & {
  platform: Platform;
  value: NetworkChoices;
  onChange: (change: Partial<NetworkChoices>) => void;
  testId: string;
}) {
  const modes = sendingModesOn(platform);
  const sending = SENDING_MODE_KEYS.filter((m) => sendingAllowed.includes(m));
  const replies = REPLY_MODE_KEYS.filter((m) => repliesAllowed.includes(m));
  const posting = POSTING_MODE_KEYS.filter((m) => postingAllowed.includes(m));
  const notAllowed = [
    ...SENDING_MODE_KEYS.filter((m) => !sendingAllowed.includes(m)).map((m) => modes[m]),
    ...REPLY_MODE_KEYS.filter((m) => !repliesAllowed.includes(m)).map((m) => REPLY_MODES[m]),
    ...POSTING_MODE_KEYS.filter((m) => !postingAllowed.includes(m)).map((m) => POSTING_MODES[m]),
  ];
  return (
    <>
      <Part title={W.sections.onItsOwn} about={onItsOwnAbout(platform)}>
        <div role="radiogroup" aria-label="Sending" className="flex flex-col gap-2">
          {sending.map((m) => (
            <RadioCard
              key={m}
              selected={value.sending === m}
              onSelect={() => onChange({ sending: m })}
              title={modes[m]}
              testId={`${testId}-sending-${m}`}
            />
          ))}
        </div>
      </Part>
      <Part
        title={W.sections.replies}
        about={value.sending === 'off' ? W.abouts.repliesOff : W.abouts.replies}
      >
        <div role="radiogroup" aria-label="Replies" className="flex flex-col gap-2">
          {replies.map((m) => (
            <RadioCard
              key={m}
              selected={value.replies === m}
              onSelect={() => onChange({ replies: m })}
              title={REPLY_MODES[m]}
              testId={`${testId}-replies-${m}`}
            />
          ))}
        </div>
      </Part>
      <Part title={W.sections.posting} about={postingAboutOn(platform)}>
        <div role="radiogroup" aria-label="Helpful posts" className="flex flex-col gap-2">
          {posting.map((m) => (
            <RadioCard
              key={m}
              selected={value.posting === m}
              onSelect={() => onChange({ posting: m })}
              title={POSTING_MODES[m]}
              description={m === 'after_ok' ? W.usual : undefined}
              testId={`${testId}-posting-${m}`}
            />
          ))}
        </div>
      </Part>
      {notAllowed.length ? (
        <p className="text-[13px] text-text-2">{W.notAllowed(notAllowed)}</p>
      ) : null}
    </>
  );
}

/** Along the way on one network, in its words: liking first, confirming requests, the once-a-day jobs, and more. */
export function NetworkTicks({
  platform,
  value,
  onChange,
  testId,
}: {
  platform: Platform;
  value: NetworkChoices;
  onChange: (change: Partial<NetworkChoices>) => void;
  testId: string;
}) {
  const ticks = ticksOn(platform);
  return (
    <Part title={W.sections.along}>
      {ALONG_TICKS.map((key) => (
        <div key={key}>
          <Checkbox
            label={<span className="text-[14px]">{ticks[key][0]}</span>}
            checked={value[key]}
            onChange={(e) => onChange({ [key]: e.target.checked })}
            data-testid={`${testId}-${key}`}
          />
          <span className="mt-0.5 block pl-7 text-[13px] text-text-2">{ticks[key][1]}</span>
        </div>
      ))}
    </Part>
  );
}

/**
 * The choices themselves: someone's own, or where a new person starts. Facebook's, and what's theirs on every network
 * (the voice, the extension's switches, the pushes and the hours).
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
  const set = (part: Partial<AutomationSettings>) => onChange({ ...value, ...part });
  const facebook = choicesFor(value, 'facebook');
  const setFacebook = (change: Partial<NetworkChoices>) =>
    onChange(withNetwork(value, 'facebook', change));
  const tick = (key: keyof typeof W.ticks & keyof AutomationSettings) => (
    <div>
      <Checkbox
        label={<span className="text-[14px]">{W.ticks[key][0]}</span>}
        checked={value[key] === true}
        onChange={(e) => set({ [key]: e.target.checked })}
        data-testid={`${testId}-${key}`}
      />
      <span className="mt-0.5 block pl-7 text-[13px] text-text-2">{W.ticks[key][1]}</span>
    </div>
  );
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
      <Part title={VOICE_WORDS.title} about={VOICE_WORDS.note}>
        {VOICE_KEYS.map((key) => (
          <Checkbox
            key={key}
            label={<span className="text-[14px]">{VOICE_WORDS[key]}</span>}
            checked={value.voice[key]}
            onChange={(e) => set({ voice: { ...value.voice, [key]: e.target.checked } })}
            data-testid={`${testId}-voice-${key}`}
          />
        ))}
        <ChatBubbles
          bubbles={voiceSample(value.voice).map((text) => ({ fromMe: true, text }))}
          label="How a message from you might read"
          testId={`${testId}-voice-sample`}
        />
      </Part>
      <NetworkTicks platform="facebook" value={facebook} onChange={setFacebook} testId={testId} />
      <Part title={W.sections.extension} about={W.abouts.extension}>
        {tick('noting')}
        {tick('readChats')}
        {tick('markPosts')}
      </Part>
      <Part title={W.sections.pushes} about={W.abouts.pushes}>
        <div role="radiogroup" aria-label="Pushes" className="flex flex-col gap-2">
          {PUSH_MODE_KEYS.map((m) => (
            <RadioCard
              key={m}
              selected={value.pushes === m}
              onSelect={() => set({ pushes: m })}
              title={PUSH_MODES[m]}
              description={m === 'bundled' ? W.usual : undefined}
              testId={`${testId}-pushes-${m}`}
            />
          ))}
        </div>
        <p className="text-[13px] text-text-2">{W.abouts.pushesAlways}</p>
        <div className="border-t border-border pt-3">{tick('dayReport')}</div>
        {value.dayReport ? (
          <PushSample
            title={dayReportSample.title}
            body={dayReportSample.body}
            testId={`${testId}-day-report-sample`}
          />
        ) : null}
        <p className="text-[12.5px] text-text-3">{W.abouts.weekReview}</p>
      </Part>
      <Part title={W.sections.when} about={W.abouts.when(timezone)}>
        <p className="flex flex-wrap items-center gap-2 text-[13px]">
          {W.from}
          <select
            className={select}
            value={value.hours.start}
            onChange={(e) => set({ hours: { ...value.hours, start: Number(e.target.value) } })}
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
            onChange={(e) => set({ hours: { ...value.hours, end: Number(e.target.value) } })}
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
                set({ hours: { ...value.hours, days: days.sort((a, b) => a - b) } });
              }}
            />
          ))}
        </div>
      </Part>
    </div>
  );
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** A network's training wheels, as the settings show them: Facebook's, or another network's own. */
const wheelsOf = (me: Automation, platform: Platform): WheelsState =>
  OTHER_PLATFORMS.includes(platform as OtherPlatform)
    ? me.networkWheels[platform as OtherPlatform]
    : me.wheels;

/** Beside a network's switch once its save is done: that it's saved, or the server's words. */
export interface SwitchSaid {
  readonly platform: Platform;
  readonly ok: boolean;
  readonly words: string;
}

/**
 * The networks the person works (Chris: each person turns networks on, inside what the business allows), each with its
 * switch. Under any other network, its own choices, the same as Facebook's and off to start, and its own training
 * wheels; Facebook's choices are the form below. A network the business doesn't use says why, and who can change that.
 */
export function NetworksPart({
  value,
  onChange,
  me,
  manages,
  choices = true,
  onSwitch,
  switching = null,
  saving = false,
  said = null,
  testId,
}: {
  value: AutomationSettings;
  onChange: (next: AutomationSettings) => void;
  /** Whose they are, with what the business allows and each network's training wheels. */
  me: Automation;
  /** An owner or admin, who can allow a network under Business settings. */
  manages: boolean;
  /** Each other network's choices under its switch: the setup's step has the switches alone. */
  choices?: boolean;
  /**
   * My settings: a network's switch saves at once, on its own (Chris, 2026-10-16), so flipping one calls this instead
   * of only changing the form. The setup's step leaves it out: its Next saves.
   */
  onSwitch?: (platform: Platform, on: boolean) => void;
  /** The network whose switch is saving. */
  switching?: Platform | null;
  /** A save is running: every switch waits for it, so one never undoes another. */
  saving?: boolean;
  /** Beside a switch, once its save is done. */
  said?: SwitchSaid | null;
  testId: string;
}) {
  const allowed = me.rules.networksAllowed;
  return (
    <Part title={NW.title} about={NW.about}>
      <ul className="divide-y divide-border rounded-card border border-border" data-testid={testId}>
        {PLATFORM_KEYS.map((p) => {
          const name = PLATFORMS[p];
          const may = allowed.includes(p);
          const on = may && networksOn(value, allowed).includes(p);
          const network = choicesFor(value, p);
          const set = (change: Partial<NetworkChoices>) => onChange(withNetwork(value, p, change));
          const wheels = wheelsOf(me, p);
          // Facebook's choices are the settings' own, in the form below.
          const own = !OTHER_PLATFORMS.includes(p as OtherPlatform);
          return (
            <li key={p} className="space-y-3 p-3.5" data-testid={`${testId}-${p}`}>
              <div className="flex items-center justify-between gap-3">
                <span className="text-[14px] font-semibold">{name}</span>
                <Switch
                  checked={on}
                  onChange={(next) => (onSwitch ? onSwitch(p, next) : set({ on: next }))}
                  label={name}
                  disabled={!may || saving}
                  busy={switching === p}
                  testId={`${testId}-${p}-on`}
                />
              </div>
              {said?.platform === p ? (
                <p
                  role={said.ok ? 'status' : 'alert'}
                  className={`text-[13px] ${said.ok ? 'text-success-text' : 'text-danger-text'}`}
                  data-testid={`${testId}-${p}-${said.ok ? 'saved' : 'problem'}`}
                >
                  {said.words}
                </p>
              ) : null}
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

function MySettings({
  workspaceId,
  me,
  manages,
}: {
  workspaceId: string;
  me: Automation;
  manages: boolean;
}) {
  const router = useRouter();
  const [value, setValue] = useState<AutomationSettings>(me.settings);
  // The page's copy of what's kept. A network's switch saves on it, so the form's other edits never go with the switch;
  // after it, the next switch and Save start from what the switch kept.
  const [saved, setSaved] = useState<AutomationSettings>(me.settings);
  const [kept, setKept] = useState<AutomationSettings>(me.settings);
  const [switching, setSwitching] = useState<{
    platform: Platform;
    next: AutomationSettings;
  } | null>(null);
  const [said, setSaid] = useState<SwitchSaid | null>(null);
  const { busy, act } = useAct();
  const theirs = me.userId;
  // The page drawn again with what's kept. Saved somewhere else (Save, another screen, an owner): the form starts again
  // from it. A switch's own save coming back leaves the form's other edits as they are.
  if (!same(kept, me.settings)) {
    setKept(me.settings);
    setSaved(me.settings);
    if (!same(me.settings, saved) && !same(me.settings, switching?.next)) setValue(me.settings);
  }
  /** A network's switch saves at once: only that change, on what's kept (Chris, 2026-10-16). */
  const flip = async (platform: Platform, on: boolean) => {
    const next = withNetwork(saved, platform, { on });
    setValue((v) => withNetwork(v, platform, { on }));
    setSwitching({ platform, next });
    setSaid(null);
    try {
      const out = unwrap(
        await apiBrowser().POST('/v1/commands/outreach.automation.save', {
          body: { workspaceId, userId: theirs, settings: next },
        }),
      );
      setSaved(out.settings);
      setSaid({ platform, ok: true, words: NW.switched(PLATFORMS[platform], on) });
      router.refresh();
    } catch (e) {
      // Put back as it was, saying why in the server's words.
      setValue((v) => withNetwork(v, platform, { on: !on }));
      setSaid({ platform, ok: false, words: errorMessage(e) });
    } finally {
      setSwitching(null);
    }
  };
  return (
    <>
      {me.changedBy ? (
        <p className="text-[13px] text-text-2" data-testid="outreach-settings-changed-by">
          {W.changedBy(me.changedBy)}
        </p>
      ) : null}
      <NetworksPart
        value={value}
        onChange={setValue}
        me={me}
        manages={manages}
        onSwitch={(platform, on) => void flip(platform, on)}
        switching={switching?.platform ?? null}
        saving={switching !== null || busy !== null}
        said={said}
        testId="outreach-my-networks"
      />
      {me.wheels.on ? (
        <p className="text-[13px] text-warning-text">{wheelsWords(me.wheels)}</p>
      ) : null}
      <ChoicesForm
        value={value}
        onChange={setValue}
        sendingAllowed={me.rules.sendingAllowed}
        repliesAllowed={me.rules.repliesAllowed}
        postingAllowed={me.rules.postingAllowed}
        timezone={me.timezone}
        testId="outreach-my"
      />
      {wheelsMatter(value) && !me.wheels.from ? (
        <p className="text-[13px] text-text-2">{WHEELS_START_WORDS}</p>
      ) : null}
      <Button
        size="sm"
        disabled={(same(value, saved) && me.saved) || busy !== null || switching !== null}
        onClick={() =>
          void act(
            'save',
            async () => {
              const out = unwrap(
                await apiBrowser().POST('/v1/commands/outreach.automation.save', {
                  body: { workspaceId, userId: theirs, settings: value },
                }),
              );
              // What's kept now, at once: the next switch starts from it.
              setSaved(out.settings);
              setValue(out.settings);
            },
            W.savedFollows,
          )
        }
        data-testid="outreach-my-save"
      >
        {W.save}
      </Button>
    </>
  );
}

/**
 * The business's rules for everyone's choices. In the setup (`carryOn`), its button moves on: saving first when
 * anything changed, else keeping them as they are.
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
  const toggle = <T extends string>(list: readonly T[], item: T, on: boolean) =>
    on ? [...list, item] : list.filter((x) => x !== item);
  return (
    <div className="space-y-5" data-testid="outreach-rules">
      <Part title={W.sections.allowed} about={W.abouts.allowed}>
        {SENDING_MODE_KEYS.filter((m) => m !== 'off').map((m) => (
          <Checkbox
            key={m}
            label={SENDING_MODES[m]}
            checked={rules.sendingAllowed.includes(m)}
            onChange={(e) =>
              setRules({
                ...rules,
                sendingAllowed: toggle(rules.sendingAllowed, m, e.target.checked),
              })
            }
            data-testid={`outreach-rules-sending-${m}`}
          />
        ))}
        {REPLY_MODE_KEYS.filter((m) => m !== 'draft').map((m) => (
          <Checkbox
            key={m}
            label={REPLY_MODES[m]}
            checked={rules.repliesAllowed.includes(m)}
            onChange={(e) =>
              setRules({
                ...rules,
                repliesAllowed: toggle(rules.repliesAllowed, m, e.target.checked),
              })
            }
            data-testid={`outreach-rules-replies-${m}`}
          />
        ))}
        {POSTING_MODE_KEYS.filter((m) => m !== 'copy').map((m) => (
          <Checkbox
            key={m}
            label={POSTING_MODES[m]}
            checked={rules.postingAllowed.includes(m)}
            onChange={(e) =>
              setRules({
                ...rules,
                postingAllowed: toggle(rules.postingAllowed, m, e.target.checked),
              })
            }
            data-testid={`outreach-rules-posting-${m}`}
          />
        ))}
      </Part>
      <Part title={W.sections.limits} about={W.abouts.limits}>
        <div className="grid grid-cols-2 gap-3 max-md:grid-cols-1">
          {DAILY_STEPS.map((step) => (
            <label key={step} className="flex items-center justify-between gap-2 text-[13px]">
              {DAILY_WORDS[step].label}
              <input
                type="number"
                min={0}
                max={DAILY_LIMITS[step]}
                className={`${select} w-20`}
                value={rules.dailyLimits[step] ?? DAILY_LIMITS[step]}
                onChange={(e) => {
                  const n = Math.max(0, Math.min(DAILY_LIMITS[step], Number(e.target.value) || 0));
                  setRules({ ...rules, dailyLimits: { ...rules.dailyLimits, [step]: n } });
                }}
                data-testid={`outreach-rules-limit-${step}`}
              />
            </label>
          ))}
        </div>
      </Part>
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
      {OTHER_PLATFORMS.filter((p) => rules.networksAllowed.includes(p)).map((p) => {
        const words = dailyWordsOn(p);
        const kept = rules.networkLimits[p] ?? {};
        return (
          <Part key={p} title={NW.limitsOn(PLATFORMS[p])} about={NW.limitsAbout(PLATFORMS[p])}>
            <div className="grid grid-cols-2 gap-3 max-md:grid-cols-1">
              {DAILY_STEPS.map((step) => {
                const most = NETWORKS[p].dailyLimits[step];
                return (
                  <label key={step} className="flex items-center justify-between gap-2 text-[13px]">
                    {words[step].label}
                    <input
                      type="number"
                      min={0}
                      max={most}
                      className={`${select} w-20`}
                      value={kept[step] ?? most}
                      onChange={(e) => {
                        const n = Math.max(0, Math.min(most, Number(e.target.value) || 0));
                        setRules({
                          ...rules,
                          networkLimits: { ...rules.networkLimits, [p]: { ...kept, [step]: n } },
                        });
                      }}
                      data-testid={`outreach-rules-${p}-limit-${step}`}
                    />
                  </label>
                );
              })}
            </div>
          </Part>
        );
      })}
      {/* Folded: it's the same form as each person's, and rarely changed (decision 59). */}
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
            onChange={(defaults) => setRules({ ...rules, defaults })}
            sendingAllowed={rules.sendingAllowed}
            repliesAllowed={rules.repliesAllowed}
            postingAllowed={rules.postingAllowed}
            timezone={timezone}
            testId="outreach-defaults"
          />
        </div>
      </details>
      <Button
        size={carryOn ? 'lg' : 'sm'}
        disabled={(!carryOn && same(rules, now)) || busy !== null || carryingOn}
        loading={busy === 'rules'}
        onClick={() => {
          if (carryOn && same(rules, now)) return carryOn();
          void act(
            'rules',
            async () =>
              unwrap(
                await apiBrowser().POST('/v1/commands/addon.save_settings', {
                  body: {
                    workspaceId,
                    addonId: 'outreach',
                    settings: settingsToSave(settings, { rules }),
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

/** The person's computers, to rename; or how to get one going. */
function ComputerPart({ workspaceId, live }: { workspaceId: string; live: Live }) {
  const now = useServerNow(live.now);
  return live.computers.length ? (
    <ComputersCard workspaceId={workspaceId} live={live} now={now} bare />
  ) : (
    <p className="text-[13px] text-text-2">{W.noComputer}</p>
  );
}

export function SettingsView({
  workspaceId,
  me,
  mine,
  people,
  business,
  canStartFresh = false,
  live = null,
  extensionLink = null,
}: {
  workspaceId: string;
  /** The business's own link to the extension's zip, when it gave one: else HandsFreeOS's own. */
  extensionLink?: string | null;
  /** The person's computers: null when they couldn't be had. */
  live?: Live | null;
  /** An owner, who may erase everything and start fresh (`addons.purge`). */
  canStartFresh?: boolean;
  /** Whether they're the person's own. */
  mine: boolean;
  /** Whose settings are shown: the person's own, or someone else's for an owner or admin. */
  me: Automation;
  /** Everyone who uses Social Outreach, for owners and admins. */
  people: AutomationPeople | null;
  /** The business's Social Outreach settings, for owners and admins. */
  business: Readonly<Record<string, unknown>> | null;
}) {
  const router = useRouter();
  // A change made elsewhere (the person on another screen, or an owner) shows here too.
  useLiveRefresh(['outreach_automation', 'addon']);
  return (
    <div className="max-w-3xl space-y-5" data-testid="outreach-settings-view">
      <p className="text-[13px] text-text-2">{W.settingsIntro}</p>
      {people ? (
        <label className="flex flex-wrap items-center gap-2 text-[13px]">
          <span className="font-semibold">{W.settingsFor}</span>
          <select
            className={select}
            value={me.userId}
            onChange={(e) =>
              router.push(outreachHref(workspaceId, { view: 'settings', for: e.target.value }))
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
      <Section id="mine" title={mine ? W.mySettings : W.settingsOf(me.name)}>
        <MySettings
          // A form for each person. Saved somewhere else, it starts again from what's kept by itself, so a network
          // switch's own save doesn't lose the form's other edits.
          key={me.userId}
          workspaceId={workspaceId}
          me={me}
          manages={business !== null}
        />
      </Section>
      {business ? (
        <Section id="business" title={W.sections.business}>
          <RulesForm
            key={JSON.stringify(business.rules ?? null)}
            workspaceId={workspaceId}
            settings={business}
            timezone={me.timezone}
          />
          <hr className="border-border" />
          <ExtensionLinkForm
            key={String(business.extensionLink ?? '')}
            workspaceId={workspaceId}
            settings={business}
          />
          <hr className="border-border" />
          <OutreachBusinessSettings
            workspaceId={workspaceId}
            settings={business}
            mySettings={{}}
            saveSettings={async (settings) => {
              unwrap(
                await apiBrowser().POST('/v1/commands/addon.save_settings', {
                  body: { workspaceId, addonId: 'outreach', settings },
                }),
              );
              router.refresh();
            }}
            saveMySettings={async () => {}}
          />
        </Section>
      ) : (
        <p className="text-[13px] text-text-2">
          {W.abouts.notOwner}{' '}
          <Link className="underline" href={outreachHref(workspaceId, { view: 'today' })}>
            Back to Today
          </Link>
        </p>
      )}
      {mine ? (
        <Section id="computer" title={W.settingsParts.computer}>
          {live ? <ComputerPart workspaceId={workspaceId} live={live} /> : null}
          <ExtensionDownload link={extensionLink} folded />
        </Section>
      ) : null}
      {canStartFresh && mine ? (
        <div id="fresh" className="scroll-mt-4">
          <StartFresh workspaceId={workspaceId} />
        </div>
      ) : null}
    </div>
  );
}

/** How the day's report reads on a phone, from a made-up day. */
const dayReportSample = dayReportWords({ messages: 14, positive: 2, booked: 1 }, 15);

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
