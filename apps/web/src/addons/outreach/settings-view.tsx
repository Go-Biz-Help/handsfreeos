'use client';
/**
 * Social Outreach's Settings tab (docs/outreach.md, decisions 37 to 40): every setting lives here, never in the
 * browser extension, which loads them when the person signs in and follows each change within seconds.
 *
 * - **My settings:** what the extension does for the person on its own, its switches, how their phone hears what
 *   waits, and their working hours (`outreach.automation.save`). Only the choices the business allows show.
 * - **Someone else's:** owners and admins pick a person to see or change theirs; the person sees who did.
 * - **Business settings:** owners and admins set the choices people may pick, daily limits under the starting ones,
 *   where a new person starts, where the team downloads the extension (./extension-link.tsx), and the business's
 *   other Social Outreach settings (`addon.save_settings`).
 * - **Set up again** opens Social Outreach's setup at its first step (./setup-view.tsx).
 */
import {
  BusinessRules,
  hourWords,
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
  type ReplyMode,
  type SendingMode,
} from '@hfos/core/addons/outreach/automation';
import { settingsToSave } from '@hfos/core/addons/outreach/chat-read';
import { VOICE_WORDS, voiceSample, type Voice } from '@hfos/core/addons/outreach/voice';
import { DAILY_LIMITS, DAILY_STEPS, DAILY_WORDS } from '@hfos/core/addons/outreach/limits';
import { OUTREACH_WORDS as W } from '@hfos/core/addons/outreach/words';
import { outreachSetupPath, SETUP_WORDS } from '@hfos/core/addons/outreach/setup';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button, ButtonLink } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { RadioCard } from '@/components/ui/radio-card';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { useLiveRefresh } from '@/lib/realtime/live-provider';
import { outreachHref } from './address';
import { ChatBubbles } from './chat-bubbles';
import { ExtensionLinkForm } from './extension-link';
import { StartFresh } from './start-fresh';
import OutreachBusinessSettings from './business-settings';
import type { Automation, AutomationPeople } from './types';
import { useAct } from './use-act';

const VOICE_KEYS = [
  'shorthand',
  'acronyms',
  'emoji',
  'split',
] as const satisfies readonly (keyof Voice)[];

const select =
  'h-8 rounded-control border border-border-strong bg-card px-2 text-[13px] max-md:h-11';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3 rounded-card border border-border bg-card p-4">
      <h2 className="text-[15px] font-semibold">{title}</h2>
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

/** The choices themselves: someone's own, or where a new person starts. */
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
  const sending = SENDING_MODE_KEYS.filter((m) => sendingAllowed.includes(m));
  const replies = REPLY_MODE_KEYS.filter((m) => repliesAllowed.includes(m));
  const posting = POSTING_MODE_KEYS.filter((m) => postingAllowed.includes(m));
  const notAllowed = [
    ...SENDING_MODE_KEYS.filter((m) => !sendingAllowed.includes(m)).map((m) => SENDING_MODES[m]),
    ...REPLY_MODE_KEYS.filter((m) => !repliesAllowed.includes(m)).map((m) => REPLY_MODES[m]),
    ...POSTING_MODE_KEYS.filter((m) => !postingAllowed.includes(m)).map((m) => POSTING_MODES[m]),
  ];
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
      <Part title={W.sections.onItsOwn} about={W.abouts.onItsOwn}>
        <div role="radiogroup" aria-label="Sending" className="flex flex-col gap-2">
          {sending.map((m) => (
            <RadioCard
              key={m}
              selected={value.sending === m}
              onSelect={() => set({ sending: m })}
              title={SENDING_MODES[m]}
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
              onSelect={() => set({ replies: m })}
              title={REPLY_MODES[m]}
              testId={`${testId}-replies-${m}`}
            />
          ))}
        </div>
      </Part>
      <Part title={W.sections.posting} about={W.abouts.posting}>
        <div role="radiogroup" aria-label="Helpful posts" className="flex flex-col gap-2">
          {posting.map((m) => (
            <RadioCard
              key={m}
              selected={value.posting === m}
              onSelect={() => set({ posting: m })}
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
      <Part title={W.sections.along}>
        {tick('warmUp')}
        {tick('confirmRequests')}
        {tick('collect')}
        {tick('joinGroups')}
        {tick('watchPosts')}
      </Part>
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

function MySettings({ workspaceId, me }: { workspaceId: string; me: Automation }) {
  const [value, setValue] = useState<AutomationSettings>(me.settings);
  const { busy, act } = useAct();
  const theirs = me.userId;
  return (
    <>
      {me.changedBy ? (
        <p className="text-[13px] text-text-2" data-testid="outreach-settings-changed-by">
          {W.changedBy(me.changedBy)}
        </p>
      ) : null}
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
        disabled={(same(value, me.settings) && me.saved) || busy !== null}
        onClick={() =>
          void act(
            'save',
            async () =>
              unwrap(
                await apiBrowser().POST('/v1/commands/outreach.automation.save', {
                  body: { workspaceId, userId: theirs, settings: value },
                }),
              ),
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
      <Part
        title={W.sections.defaults}
        about={`${W.abouts.defaults} Change anyone’s under Settings for, above.`}
      >
        <ChoicesForm
          value={rules.defaults}
          onChange={(defaults) => setRules({ ...rules, defaults })}
          sendingAllowed={rules.sendingAllowed}
          repliesAllowed={rules.repliesAllowed}
          postingAllowed={rules.postingAllowed}
          timezone={timezone}
          testId="outreach-defaults"
        />
      </Part>
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

export function SettingsView({
  workspaceId,
  me,
  mine,
  people,
  business,
  canStartFresh = false,
}: {
  workspaceId: string;
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
    <div className="max-w-2xl space-y-4" data-testid="outreach-settings-view">
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
      <Section title={mine ? W.mySettings : W.settingsOf(me.name)}>
        <MySettings
          // Saved somewhere else: the form starts again from what's kept.
          key={`${me.userId}:${JSON.stringify(me.settings)}:${me.changedBy ?? ''}`}
          workspaceId={workspaceId}
          me={me}
        />
      </Section>
      {business ? (
        <Section title={W.sections.business}>
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
      {canStartFresh && mine ? <StartFresh workspaceId={workspaceId} /> : null}
    </div>
  );
}
