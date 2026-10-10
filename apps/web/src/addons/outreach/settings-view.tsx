'use client';
/**
 * Social Outreach's Settings tab (docs/outreach.md, decisions 37 to 40): every setting lives here, never in the
 * browser extension, which loads them when the person signs in and follows each change within seconds.
 *
 * - **My settings:** what the extension does for the person on its own, its switches, how their phone hears what
 *   waits, and their working hours (`outreach.automation.save`). Only the choices the business allows show.
 * - **Someone else's:** owners and admins pick a person to see or change theirs; the person sees who did.
 * - **Business settings:** owners and admins set the choices people may pick, daily limits under the starting ones,
 *   where a new person starts, and the business's other Social Outreach settings (`addon.save_settings`).
 */
import {
  BusinessRules,
  hourWords,
  PUSH_MODE_KEYS,
  PUSH_MODES,
  REPLY_MODE_KEYS,
  REPLY_MODES,
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
import { DAILY_LIMITS, DAILY_STEPS, DAILY_WORDS } from '@hfos/core/addons/outreach/limits';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { RadioCard } from '@/components/ui/radio-card';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { useLiveRefresh } from '@/lib/realtime/live-provider';
import { outreachHref } from './address';
import OutreachSettings from './settings';
import type { Automation, AutomationPeople } from './types';
import { useAct } from './use-act';

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
  timezone,
  testId,
}: {
  value: AutomationSettings;
  onChange: (next: AutomationSettings) => void;
  sendingAllowed: readonly SendingMode[];
  repliesAllowed: readonly ReplyMode[];
  timezone: string;
  testId: string;
}) {
  const set = (part: Partial<AutomationSettings>) => onChange({ ...value, ...part });
  const sending = SENDING_MODE_KEYS.filter((m) => sendingAllowed.includes(m));
  const replies = REPLY_MODE_KEYS.filter((m) => repliesAllowed.includes(m));
  const notAllowed = [
    ...SENDING_MODE_KEYS.filter((m) => !sendingAllowed.includes(m)).map((m) => SENDING_MODES[m]),
    ...REPLY_MODE_KEYS.filter((m) => !repliesAllowed.includes(m)).map((m) => REPLY_MODES[m]),
  ];
  const tick = (label: string, about: string, key: keyof AutomationSettings) => (
    <div>
      <Checkbox
        label={<span className="text-[14px]">{label}</span>}
        checked={value[key] === true}
        onChange={(e) => set({ [key]: e.target.checked })}
        data-testid={`${testId}-${key}`}
      />
      <span className="mt-0.5 block pl-7 text-[13px] text-text-2">{about}</span>
    </div>
  );
  return (
    <div className="space-y-5" data-testid={testId}>
      <Part
        title="What it does on its own"
        about="It keeps your daily limits, goes at a person’s pace, and stops for the day on any warning from Facebook."
      >
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
        title="Replies"
        about={
          value.sending === 'off'
            ? 'Replies go out only while it writes messages: pick what it does on its own first.'
            : 'A reply to someone who asks for you, sounds upset, or writes about a refund, a complaint or cancelling always waits for you, and your phone hears it.'
        }
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
      {notAllowed.length ? (
        <p className="text-[13px] text-text-2">
          Your business doesn’t allow: {notAllowed.join('; ')}. An owner or admin can change that
          under Business settings.
        </p>
      ) : null}
      <Part title="Along the way">
        {tick(
          'Like one of their posts a day before each friend request',
          'Facebook trusts a request more after a like.',
          'warmUp',
        )}
        {tick(
          'Confirm friend requests from people who fit a playbook',
          'The rest wait for you.',
          'confirmRequests',
        )}
        {tick(
          'Once a day, first: check friend requests, save group members, find posts and read my chats',
          'These fill the list it works from.',
          'collect',
        )}
      </Part>
      <Part
        title="The extension"
        about="What it does while you use Facebook yourself, on every computer you’re signed in on."
      >
        {tick(
          'Note my steps on Facebook',
          'Friend requests, likes, comments and messages you send yourself count toward your day.',
          'noting',
        )}
        {tick(
          'Read chats as I open them',
          'A chat you open in Messenger goes to the AI to read, for the Chats tab.',
          'readChats',
        )}
        {tick(
          'Look for posts as I scroll a group',
          'Posts worth a comment go on your list for today.',
          'markPosts',
        )}
      </Part>
      <Part
        title="Your phone and the extension"
        about="How you hear about messages and steps waiting for you."
      >
        <div role="radiogroup" aria-label="Pushes" className="flex flex-col gap-2">
          {PUSH_MODE_KEYS.map((m) => (
            <RadioCard
              key={m}
              selected={value.pushes === m}
              onSelect={() => set({ pushes: m })}
              title={PUSH_MODES[m]}
              description={m === 'bundled' ? 'The usual choice.' : undefined}
              testId={`${testId}-pushes-${m}`}
            />
          ))}
        </div>
        <p className="text-[13px] text-text-2">A reply handed over to you always comes at once.</p>
      </Part>
      <Part
        title="When"
        about={`On your business’s clock (${timezone}), at random times spread over the hours.`}
      >
        <p className="flex flex-wrap items-center gap-2 text-[13px]">
          From
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
          to
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
          Changed by {me.changedBy}.
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
            'Saved. The extension follows it in a few seconds.',
          )
        }
        data-testid="outreach-my-save"
      >
        Save
      </Button>
    </>
  );
}

function RulesForm({
  workspaceId,
  settings,
  timezone,
}: {
  workspaceId: string;
  settings: Readonly<Record<string, unknown>>;
  timezone: string;
}) {
  const kept = BusinessRules.safeParse(settings.rules ?? {});
  const now = kept.success ? kept.data : BusinessRules.parse({});
  const [rules, setRules] = useState(now);
  const { busy, act } = useAct();
  const toggle = <T extends string>(list: readonly T[], item: T, on: boolean) =>
    on ? [...list, item] : list.filter((x) => x !== item);
  return (
    <div className="space-y-5" data-testid="outreach-rules">
      <Part
        title="What people may pick"
        about="Doing everything themselves, and every reply waiting, are always allowed. Someone whose choice you stop allowing steps back to the nearest one you do."
      >
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
      </Part>
      <Part
        title="Daily limits for each person"
        about="Up to the starting limits, which keep a Facebook account safe. Halved for a week after a warning, and on training wheels."
      >
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
        title="Where a new person starts"
        about="Until they save their own. Change anyone’s under Settings for, above."
      >
        <ChoicesForm
          value={rules.defaults}
          onChange={(defaults) => setRules({ ...rules, defaults })}
          sendingAllowed={rules.sendingAllowed}
          repliesAllowed={rules.repliesAllowed}
          timezone={timezone}
          testId="outreach-defaults"
        />
      </Part>
      <Button
        size="sm"
        disabled={same(rules, now) || busy !== null}
        onClick={() =>
          void act(
            'rules',
            async () =>
              unwrap(
                await apiBrowser().POST('/v1/commands/addon.save_settings', {
                  body: { workspaceId, addonId: 'outreach', settings: { ...settings, rules } },
                }),
              ),
            'Saved for everyone.',
          )
        }
        data-testid="outreach-rules-save"
      >
        Save
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
}: {
  workspaceId: string;
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
      <p className="text-[13px] text-text-2">
        Everything the browser extension does is set here. It follows a change within a few seconds
        on every computer you’re signed in on.
      </p>
      {people ? (
        <label className="flex flex-wrap items-center gap-2 text-[13px]">
          <span className="font-semibold">Settings for</span>
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
                {p.saved ? '' : ' (not set yet)'}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <Section title={mine ? 'My settings' : `Settings for ${me.name}`}>
        <MySettings
          // Saved somewhere else: the form starts again from what's kept.
          key={`${me.userId}:${JSON.stringify(me.settings)}:${me.changedBy ?? ''}`}
          workspaceId={workspaceId}
          me={me}
        />
      </Section>
      {business ? (
        <Section title="Business settings">
          <RulesForm
            key={JSON.stringify(business.rules ?? null)}
            workspaceId={workspaceId}
            settings={business}
            timezone={me.timezone}
          />
          <hr className="border-border" />
          <OutreachSettings
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
          An owner or admin of this business sets the choices you may pick and your daily limits.{' '}
          <Link className="underline" href={outreachHref(workspaceId, { view: 'today' })}>
            Back to Today
          </Link>
        </p>
      )}
    </div>
  );
}
