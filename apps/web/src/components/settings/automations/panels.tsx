'use client';
/**
 * Settings → Automations' Adjust panels: the timing, thresholds and wording behind each automation. Most of them
 * are the Action Center's settings (design/m8/Settings.dc.html), moved here when that page became part of
 * Automations, with the same test ids so what the tests pinned still holds.
 *
 * Each panel saves the moment something changes, through the settings document it belongs to.
 */
import {
  AUTO_CANCEL_WINDOW_MINUTES,
  AUTO_RECENT_PERSON_HOURS,
  checkNudgeTemplate,
  DEFAULT_FOLLOW_UP_LADDER_HOURS,
  DEFAULT_NUDGE_TEMPLATE,
  DEFAULT_REENGAGE_TEMPLATE,
  followUpLadderWords,
  NUDGE_SAMPLE,
  renderNudge,
  shortBusinessName,
  smsSegments,
  type AdjustPanel,
  type AttentionKind,
  type AttentionSettings,
  type AutomationSettings,
  type NudgeCheckContext,
  type NudgePlaceholder,
  type NudgeProblemCode,
} from '@hfos/core';
import { ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { useNow } from '@/components/calendar/appt';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { fieldErrors } from '@/lib/api/field-errors';
import type { Pipeline, Role } from '@/lib/api/types';
import { formatMoney } from '@/lib/format';
import { SetRow } from '../set-row';
import { Check1, MoneyBox, NumberBox, tomorrowLabel } from './inputs';

type Save<T> = (
  change: (s: T) => T,
  done?: string,
  onError?: (e: unknown) => void,
) => Promise<boolean>;
type SaveAttention = Save<AttentionSettings>;

/** The AI teammate's follow-up settings, as its config holds them. */
export interface FollowUpView {
  readonly enabled: boolean;
  readonly ladderHours: readonly number[];
  readonly monthlyForMonths: number;
}

/** What every panel may need: the business, the Action Center's settings and how to save them. */
export interface PanelEnv {
  readonly workspaceId: string;
  readonly role: Role;
  readonly businessName: string;
  readonly attention: AttentionSettings;
  readonly saveAttention: SaveAttention;
  readonly automations: AutomationSettings;
  readonly saveAutomations: Save<AutomationSettings>;
  /** The AI teammate's follow-ups, or null with no teammate yet. */
  readonly followUp: FollowUpView | null;
  /** Saves a change to them in the teammate's settings. */
  readonly saveFollowUp: (patch: Partial<FollowUpView>, done: string) => Promise<boolean>;
  /** What HandsFreeOS works out for a lead with no value, when the business hasn't set its own. */
  readonly workedOut: number;
  readonly typicalFrom: 'won_median' | 'default';
  readonly pipelines: readonly Pipeline[];
  /** Texting & calls' reply time: a customer waiting this long opens an item. */
  readonly replyMinutes: number;
  /** The business's own number, links and addresses: the only ones the wording may give. */
  readonly check: NudgeCheckContext;
  /** The preview's {senderName}: the person reading. */
  readonly senderName: string;
  readonly teammateName: string | null;
}

const heading = 'text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3';
const linkCls = 'text-accent-text hover:underline';

function Note({ children }: { children: ReactNode }) {
  return <p className="text-[13px] leading-[1.5] text-text-2">{children}</p>;
}

function Block({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 border-t border-border pt-4 first:border-t-0 first:pt-0">
      {title ? <h3 className={heading}>{title}</h3> : null}
      {children}
    </div>
  );
}

function SafetyNote({ env }: { env: PanelEnv }) {
  const ai = env.teammateName ?? 'your AI teammate';
  return (
    <div className="mt-1.5 flex items-start gap-2 rounded-[9px] bg-card-2 px-[11px] py-[9px] text-[12.5px] leading-[1.45] text-text-2">
      <ShieldCheck className="mt-px h-4 w-4 flex-none" strokeWidth={1.75} aria-hidden />
      <span>
        Every automatic message waits {AUTO_CANCEL_WINDOW_MINUTES} minutes so you can cancel,
        follows texting consent and quiet hours, goes once per item and never within{' '}
        {env.attention.nudge.cooldownDays} days of another. It skips anyone your team or {ai} is
        talking with, anyone with a draft waiting or in a workflow, and anyone a person messaged in
        the last {Math.round(AUTO_RECENT_PERSON_HOURS / 24)} days. STOP always wins.
      </span>
    </div>
  );
}

/** One Action Center kind's own switch, inside a row that covers more than one. */
function KindSwitch({
  env,
  kind,
  title,
  description,
  noun,
  children,
}: {
  env: PanelEnv;
  kind: AttentionKind;
  title: string;
  description: ReactNode;
  noun: string;
  children?: ReactNode;
}) {
  const on = env.attention.kinds[kind];
  return (
    <SetRow
      title={title}
      description={description}
      body={children ? <div className="mt-1.5">{children}</div> : null}
    >
      <Switch
        checked={on}
        label={`Look for ${noun}`}
        onChange={(next) =>
          void env.saveAttention(
            (s) => ({ ...s, kinds: { ...s.kinds, [kind]: next } }),
            next
              ? `HandsFreeOS looks for ${noun} again.`
              : `HandsFreeOS stops looking for ${noun}. Their cards leave Home within the hour.`,
          )
        }
        testId={`ac-kind-switch-${kind}`}
      />
    </SetRow>
  );
}

// ---- Leads ----

function NewLeadPanel({ env }: { env: PanelEnv }) {
  const ai = env.teammateName ?? 'Your AI teammate';
  return (
    <Block>
      <Note>
        {ai} sends the first message a minute after a new lead or form comes in, whatever hours it
        works: a text when they agreed to texts, otherwise an email. How soon, and by text or email,
        is set on{' '}
        <Link href={`/app/w/${env.workspaceId}/ai-team`} className={linkCls}>
          AI teammate
        </Link>
        .
      </Note>
      <Note>
        At night it still texts someone who came in on their own within 15 minutes of them getting
        in touch. Anyone later waits until quiet hours end. While {ai} is training, each greeting
        waits for you to approve it.
      </Note>
    </Block>
  );
}

function HotLeadPanel({ env }: { env: PanelEnv }) {
  const s = env.attention;
  const on = s.kinds.hot_lead;
  const ai = env.teammateName ?? 'your AI teammate';
  return (
    <>
      <Block>
        <Note>
          A lead waiting on you with a strong sign, like qualified by {ai} or asking to book, or two
          smaller signs. It goes to the top of Home, and you get an email and a push when it has
          waited too long.
        </Note>
      </Block>
      <Block title="Timing and value">
        <SetRow first center title="Urgent after" description="How long a hot lead may wait.">
          <NumberBox
            value={s.hot.urgentAfterMinutes}
            min={1}
            max={240}
            unit="min"
            label="A hot lead is urgent after this many minutes"
            disabled={!on}
            onCommit={(n) =>
              void env.saveAttention(
                (x) => ({ ...x, hot: { ...x.hot, urgentAfterMinutes: n } }),
                `A hot lead is urgent after ${n} min.`,
              )
            }
            testId="ac-threshold-hot_lead"
          />
        </SetRow>
        <SetRow
          center
          title="A big job starts at"
          description="One of the smaller signs of a hot lead."
        >
          <MoneyBox
            cents={s.hot.minValueCents}
            label="A big job starts at"
            onCommit={(cents) =>
              void env.saveAttention(
                (x) => ({ ...x, hot: { ...x.hot, minValueCents: cents ?? 0 } }),
                `A big job starts at ${formatMoney(cents ?? 0)}.`,
              )
            }
            testId="ac-big-job"
          />
        </SetRow>
        <TypicalValueRow env={env} />
      </Block>
    </>
  );
}

function TypicalValueRow({ env }: { env: PanelEnv }) {
  const s = env.attention;
  return (
    <SetRow
      center
      title="When a lead has no value, use"
      description={
        s.typicalJobValueCents !== null
          ? `Cards show it as “About ${formatMoney(s.typicalJobValueCents)}”, and it never counts toward $ affected. Empty it to use the middle of the leads you won in the last year.`
          : env.typicalFrom === 'won_median'
            ? `The middle of the leads you won in the last year. Cards show it as “About ${formatMoney(env.workedOut)}”, and it never counts toward $ affected.`
            : `You haven’t won a lead in the last year, so cards show “About ${formatMoney(env.workedOut)}”. It never counts toward $ affected.`
      }
    >
      <MoneyBox
        cents={s.typicalJobValueCents}
        optional
        placeholder={formatMoney(env.workedOut)}
        label="Typical job value"
        onCommit={(cents) =>
          void env.saveAttention(
            (x) => ({ ...x, typicalJobValueCents: cents }),
            cents === null
              ? 'Leads with no value use the middle of the leads you won.'
              : `Leads with no value count as about ${formatMoney(cents)}.`,
          )
        }
        testId="ac-typical-value"
      />
    </SetRow>
  );
}

function UnansweredPanel({ env }: { env: PanelEnv }) {
  const s = env.attention;
  return (
    <Block title="What it looks for">
      <KindSwitch
        env={env}
        kind="unanswered_lead"
        title="New leads nobody answered"
        noun="unanswered leads"
        description="Only open hours count."
      >
        <NumberBox
          value={s.unanswered.afterOpenMinutes}
          min={1}
          max={480}
          unit="min"
          label="A new lead shows after this many open-hours minutes"
          disabled={!s.kinds.unanswered_lead}
          onCommit={(n) =>
            void env.saveAttention(
              (x) => ({ ...x, unanswered: { afterOpenMinutes: n } }),
              `Unanswered leads show after ${n} min of open hours.`,
            )
          }
          testId="ac-threshold-unanswered_lead"
        />
      </KindSwitch>
      <KindSwitch
        env={env}
        kind="customer_waiting"
        title="Customers waiting on a reply"
        noun="customers waiting on a reply"
        description={
          <>
            After {env.replyMinutes ? `${env.replyMinutes} min` : 'no time at all'}. The time is set
            in{' '}
            <Link href={`/app/w/${env.workspaceId}/settings/texting`} className={linkCls}>
              Texting &amp; calls
            </Link>
            .
          </>
        }
      />
    </Block>
  );
}

/** Hours as the ladder's boxes show them: whole days as days, anything else as hours. */
const stepOf = (h: number): { value: number; unit: 'hours' | 'days' } =>
  h % 24 === 0 ? { value: h / 24, unit: 'days' } : { value: h, unit: 'hours' };

function FollowUpsPanel({ env }: { env: PanelEnv }) {
  const ai = env.teammateName ?? 'Your AI teammate';
  const f = env.followUp;
  const ladder = f?.ladderHours ?? DEFAULT_FOLLOW_UP_LADDER_HOURS;
  /** A step changed: the ladder must still go forward, one after the other. */
  function setStep(i: number, hours: number) {
    const next = ladder.map((h, j) => (j === i ? hours : h));
    if (next.some((h, j) => j > 0 && h <= next[j - 1]!)) {
      toast.error('Each follow-up has to come after the one before.');
      return;
    }
    void env.saveFollowUp({ ladderHours: next }, `Follow-ups: ${followUpLadderWords(next)}.`);
  }
  return (
    <>
      <Block>
        <Note>
          When a customer stops replying to {ai}, it follows up on this schedule, counted from the
          message they didn’t answer. It stops the moment they reply, book, say no, their lead is
          won or lost, or they text STOP.
        </Note>
        <Note>
          Leads a person is handling get their own follow-up text in your words: see Stale
          opportunities.
        </Note>
      </Block>
      {f ? (
        <Block title="When they go">
          <p className="text-xs text-text-3" data-testid="followup-ladder-words">
            {followUpLadderWords(ladder)}, then once a month for {f.monthlyForMonths}{' '}
            {f.monthlyForMonths === 1 ? 'month' : 'months'}.
          </p>
          <div className="mt-2 grid grid-cols-1 gap-x-4 sm:grid-cols-2">
            {ladder.map((h, i) => {
              const s = stepOf(h);
              // Each step stays between its neighbours, so the box itself refuses one that would jump the queue.
              const prev = ladder[i - 1] ?? 0;
              const next = ladder[i + 1] ?? Number.POSITIVE_INFINITY;
              const min =
                s.unit === 'days' ? Math.max(1, Math.floor(prev / 24) + 1) : Math.max(1, prev + 1);
              const max =
                s.unit === 'days'
                  ? Math.min(365, Math.ceil(next / 24) - 1)
                  : Math.min(72, next - 1);
              return (
                <SetRow key={i} center first={i === 0} title={`Follow-up ${i + 1}`}>
                  <span className="flex items-center gap-1.5">
                    <span className="text-xs text-text-3">after</span>
                    <NumberBox
                      value={s.value}
                      min={min}
                      max={Math.max(min, max)}
                      unit={s.unit}
                      label={`Follow-up ${i + 1} goes this long after the unanswered message`}
                      onCommit={(n) => setStep(i, s.unit === 'days' ? n * 24 : n)}
                      testId={`followup-step-${i}`}
                    />
                  </span>
                </SetRow>
              );
            })}
          </div>
          <SetRow
            center
            title="Then once a month for"
            description="0 stops after the last follow-up above."
          >
            <NumberBox
              value={f.monthlyForMonths}
              min={0}
              max={12}
              unit="months"
              label="Then once a month for this many months"
              onCommit={(n) =>
                void env.saveFollowUp(
                  { monthlyForMonths: n },
                  n === 0 ? 'No monthly follow-ups.' : `Then monthly for ${n} months.`,
                )
              }
              testId="followup-monthly"
            />
          </SetRow>
          <div className="flex justify-end">
            <Button
              variant="ghost"
              size="sm"
              disabled={
                ladder.join() === DEFAULT_FOLLOW_UP_LADDER_HOURS.join() && f.monthlyForMonths === 6
              }
              onClick={() =>
                void env.saveFollowUp(
                  { ladderHours: [...DEFAULT_FOLLOW_UP_LADDER_HOURS], monthlyForMonths: 6 },
                  'The schedule is back to the original.',
                )
              }
              data-testid="followup-reset"
            >
              Reset
            </Button>
          </div>
        </Block>
      ) : (
        <Block>
          <Note>
            Set up your{' '}
            <Link href={`/app/w/${env.workspaceId}/ai-team`} className={linkCls}>
              AI teammate
            </Link>{' '}
            to change when follow-ups go.
          </Note>
        </Block>
      )}
    </>
  );
}

function NeverRepliedPanel({ env }: { env: PanelEnv }) {
  const ai = env.teammateName ?? 'Your AI teammate';
  return (
    <Block>
      <Note>
        When someone fills in a form or gets in touch and never answers {ai}’s first message, it
        follows up on the same schedule as Follow-ups after silence. Each follow-up is written from
        what they asked for on the form, so it reads like a person remembered them.
      </Note>
    </Block>
  );
}

function ChaseTimesPanel({ env }: { env: PanelEnv }) {
  const ai = env.teammateName ?? 'Your AI teammate';
  return (
    <Block>
      <Note>
        When {ai} offered times and they went quiet, the first follow-up comes sooner: before the
        earliest of those times, but never within an hour of offering them. It checks which times
        are still open, offers those again, and finds new ones if they’ve all gone.
      </Note>
    </Block>
  );
}

// ---- Appointments ----

function DayBeforePanel({ env }: { env: PanelEnv }) {
  const replyC = env.attention.replyToConfirm;
  // Null while the server renders, so the sample's date only ever comes from the browser.
  const now = useNow();
  return (
    <>
      <Block>
        <Note>
          Reminders go the day before at 4 PM and 2 hours before, unless a calendar says otherwise.
          Change the times on each calendar in{' '}
          <Link href={`/app/w/${env.workspaceId}/settings/calendars`} className={linkCls}>
            Calendars
          </Link>
          . Texts wait for quiet hours to end, or go by email if that would be too late.
        </Note>
      </Block>
      <Block title="Reply C to confirm">
        <SetRow
          first
          title="Ask them to reply C"
          description="The day-before text ends with “Reply C to confirm.” While we’re waiting on an answer, YES confirms too."
        >
          <Switch
            checked={replyC}
            label="Reply C to confirm"
            onChange={(on) =>
              void env.saveAttention(
                (s) => ({ ...s, replyToConfirm: on }),
                on
                  ? 'Reminders end with “Reply C to confirm.” again.'
                  : 'Reminders won’t ask for a C. The Confirm button stays.',
              )
            }
            testId="ac-replyc-switch"
          />
        </SetRow>
        <div className="flex flex-col rounded-xl border border-border bg-card-2 px-4 py-3.5">
          <div
            className="max-w-[92%] self-end rounded-2xl rounded-br-[5px] bg-accent px-[13px] py-2.5 text-sm leading-[1.45] text-white [overflow-wrap:anywhere]"
            data-testid="ac-replyc-preview"
          >
            Reminder from {env.businessName}: your AC tune-up is tomorrow
            {now === null ? '' : `, ${tomorrowLabel(now)}`} at 10:00 AM. {env.senderName} is coming
            to 2210 Oak St.{replyC ? ' Reply C to confirm.' : ''}
          </div>
        </div>
        <p className="mt-1.5 text-[12.5px] text-text-3">
          Email reminders get a Confirm button instead.
        </p>
      </Block>
    </>
  );
}

function UnconfirmedPanel({ env }: { env: PanelEnv }) {
  const s = env.attention;
  return (
    <>
      <Block title="When it shows">
        <SetRow
          first
          center
          title="Visits that start within"
          description="A one-on-one visit the customer hasn’t confirmed shows on Home this long before it starts."
        >
          <NumberBox
            value={s.appointments.windowHours}
            min={1}
            max={168}
            unit="h"
            label="Visits that start within this many hours"
            disabled={!s.kinds.unconfirmed_appointment}
            onCommit={(n) =>
              void env.saveAttention(
                (x) => ({ ...x, appointments: { windowHours: n } }),
                `Unconfirmed visits show ${n} h before they start.`,
              )
            }
            testId="ac-threshold-unconfirmed_appointment"
          />
        </SetRow>
      </Block>
      <Block title="On its own">
        <SetRow
          first
          title="Ask customers to confirm visits"
          description="One text or email per visit, 1 to 2 days before. A reply of C, or the Confirm button, confirms it."
        >
          <Switch
            checked={s.auto.confirmRequests}
            label="Ask customers to confirm visits"
            onChange={(on) =>
              void env.saveAttention(
                (x) => ({ ...x, auto: { ...x.auto, confirmRequests: on } }),
                on
                  ? 'HandsFreeOS asks customers to confirm again.'
                  : 'HandsFreeOS won’t ask customers to confirm. Reminders still go.',
              )
            }
            testId="ac-confirm-switch"
          />
        </SetRow>
        <SafetyNote env={env} />
      </Block>
    </>
  );
}

function WaitlistPanel({ env }: { env: PanelEnv }) {
  return (
    <Block>
      <Note>
        When a one-on-one visit is cancelled or moved, the time is offered to the next person on
        that calendar’s waitlist whose window it fits. They get a text or email with a link to take
        it, and if they don’t, it goes to the next person. Offers never go during quiet hours.
      </Note>
      <Note>
        Each calendar turns its own waitlist on in{' '}
        <Link href={`/app/w/${env.workspaceId}/settings/calendars`} className={linkCls}>
          Calendars
        </Link>
        .
      </Note>
    </Block>
  );
}

// ---- Money ----

function InvoicesPanel({ env }: { env: PanelEnv }) {
  const s = env.attention;
  return (
    <>
      <Block>
        <Note>
          HandsFreeOS writes the follow-up from the invoice’s own figures and waits for a person to
          read it and press send. Money is never chased on its own.
        </Note>
        <Note>
          The reminders that go with every invoice (3 days before, on the day, then 3, 7 and 14 days
          after) are set in{' '}
          <Link href={`/app/w/${env.workspaceId}/settings/payments`} className={linkCls}>
            Payments
          </Link>
          .
        </Note>
      </Block>
      <Block title="When it shows">
        <SetRow
          first
          center
          title="Days after the due day"
          description="0 shows it the morning after it was due."
        >
          <NumberBox
            value={s.money.invoiceOverdueDays}
            min={0}
            max={60}
            unit="days"
            label="Show an unpaid invoice this many days after its due day"
            onCommit={(n) =>
              void env.saveAttention(
                (x) => ({ ...x, money: { ...x.money, invoiceOverdueDays: n } }),
                n === 0
                  ? 'Unpaid invoices show the morning after they’re due.'
                  : `Unpaid invoices show ${n} ${n === 1 ? 'day' : 'days'} after they’re due.`,
              )
            }
            testId="ac-invoice-days"
          />
        </SetRow>
        <SetRow
          center
          title="Ignore balances under"
          description="So a few dollars left on a bill doesn’t take up Home."
        >
          <MoneyBox
            cents={s.money.minBalanceCents}
            label="Ignore balances under"
            onCommit={(cents) =>
              void env.saveAttention(
                (x) => ({ ...x, money: { ...x.money, minBalanceCents: cents ?? 0 } }),
                `Balances under ${formatMoney(cents ?? 0)} won’t show.`,
              )
            }
            testId="ac-invoice-min"
          />
        </SetRow>
      </Block>
    </>
  );
}

function EstimatesPanel({ env }: { env: PanelEnv }) {
  const s = env.attention;
  return (
    <>
      <Block>
        <Note>
          Every estimate already gets one check-in on day three. If there’s still no answer, it
          shows on Home with a follow-up written for a person to send.
        </Note>
      </Block>
      <Block title="When it shows">
        <SetRow first center title="Days after it went out">
          <NumberBox
            value={s.money.estimateWaitingDays}
            min={1}
            max={60}
            unit="days"
            label="Show an estimate with no answer this many days after it went out"
            onCommit={(n) =>
              void env.saveAttention(
                (x) => ({ ...x, money: { ...x.money, estimateWaitingDays: n } }),
                `Estimates with no answer show after ${n} ${n === 1 ? 'day' : 'days'}.`,
              )
            }
            testId="ac-estimate-days"
          />
        </SetRow>
      </Block>
    </>
  );
}

function BalancePanel({ env }: { env: PanelEnv }) {
  return (
    <Block>
      <Note>
        Shows when your balance is near the point it tops up at, and only when there’s something to
        do about it: with a card on file and automatic top-up on, it fixes itself. An empty balance
        or a declined card always shows. See{' '}
        <Link href={`/app/w/${env.workspaceId}/settings/usage`} className={linkCls}>
          Usage &amp; balance
        </Link>
        .
      </Note>
    </Block>
  );
}

// ---- Briefings ----

function MorningPanel({ env }: { env: PanelEnv }) {
  return (
    <Block>
      <Note>
        At 7 AM where the business is, everyone on the team gets one email about what needs them,
        urgent first, and only when there’s something. A member sees their own items and the ones
        nobody has taken; owners and admins see everything.
      </Note>
      <Note>
        Anyone can turn off their own copy in{' '}
        <Link href={`/app/w/${env.workspaceId}/settings`} className={linkCls}>
          Account
        </Link>
        . This switch turns it off for the whole team.
      </Note>
    </Block>
  );
}

// ---- Wording in the business's own words: the stale-lead follow-up, and re-engaging dead leads ----

/** The chips that put a placeholder in the wording, with the words the canvas gives them. */
const INSERTS: readonly (readonly [NudgePlaceholder, string])[] = [
  ['firstName', 'First name'],
  ['senderName', 'Your name'],
  ['businessName', 'Business name'],
  ['leadTitle', 'Lead title'],
  ['businessPhone', 'Business phone'],
];

/**
 * A message in the business's own words, with its live preview and checks, and "Looks good, turn on" for an
 * owner: nothing in these words goes out until an owner has read them (Chris's rule for automatic messages).
 * Test ids start with `prefix`, so the stale follow-up keeps the Action Center's (`ac-…`).
 */
function WordingEditor({
  env,
  prefix,
  label,
  template,
  defaultTemplate,
  sampleLeadTitle,
  on,
  reviewed,
  noun,
  onNote,
  saveTemplate,
  lookGood,
}: {
  env: PanelEnv;
  prefix: string;
  /** "Follow-up wording": the box's name, for screen readers. */
  label: string;
  /** What's saved now. */
  template: string;
  defaultTemplate: string;
  sampleLeadTitle: string;
  on: boolean;
  reviewed: boolean;
  /** "follow-ups", "re-engage texts": what turning it on turns on. */
  noun: string;
  /** Under the On badge, once it's on. */
  onNote: string;
  saveTemplate: (text: string, done: string, onError: (e: unknown) => void) => Promise<boolean>;
  lookGood: (text: string, onError: (e: unknown) => void) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState(template);
  const [templateError, setTemplateError] = useState<string | null>(null);
  const [turningOn, setTurningOn] = useState(false);
  const [turnedOnNow, setTurnedOnNow] = useState(false);
  const boxId = `${prefix}-wording-box`;
  const owner = env.role === 'owner';
  const onError = (e: unknown) => {
    const f = fieldErrors(e);
    const wording = f.template ?? Object.entries(f).find(([k]) => k.endsWith('template'))?.[1];
    if (wording) setTemplateError(wording);
  };

  const phone = env.check.businessPhone?.trim() || NUDGE_SAMPLE.businessPhone;
  const preview = renderNudge(draft, {
    firstName: NUDGE_SAMPLE.firstName,
    businessName: env.businessName,
    leadTitle: sampleLeadTitle,
    senderName: env.senderName,
    businessPhone: phone,
  }).text;
  const verdict = checkNudgeTemplate(draft, env.check);
  const has = (code: NudgeProblemCode) => verdict.problems.some((p) => p.code === code);
  const segments = smsSegments(preview);
  const dirty = draft.trim() !== template;
  const short = shortBusinessName(env.businessName);

  async function saveWording(): Promise<boolean> {
    if (!dirty) return true;
    if (!verdict.ok) return false;
    setTemplateError(null);
    return saveTemplate(draft.trim(), 'Wording saved.', onError);
  }

  function insert(name: NudgePlaceholder) {
    const el = document.getElementById(boxId) as HTMLTextAreaElement | null;
    const token = `{${name}}`;
    const start = el?.selectionStart ?? draft.length;
    const end = el?.selectionEnd ?? draft.length;
    const before = draft.slice(0, start);
    const after = draft.slice(end);
    const pad = before && !/\s$/.test(before) ? ' ' : '';
    setDraft(`${before}${pad}${token}${after}`);
    setTemplateError(null);
    const at = before.length + pad.length + token.length;
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(at, at);
    });
  }

  async function turnOn() {
    if (!verdict.ok) return;
    setTurningOn(true);
    const ok = await lookGood(draft.trim(), onError);
    setTurningOn(false);
    if (ok) setTurnedOnNow(true);
  }

  return (
    <>
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs text-text-3">
          Plain words, no prices and no links. It goes from your business number.
        </p>
        <Button
          variant="ghost"
          size="sm"
          disabled={draft === defaultTemplate}
          onClick={() => {
            setDraft(defaultTemplate);
            setTemplateError(null);
            void saveTemplate(defaultTemplate, 'The wording is back to the original.', onError);
          }}
          data-testid={`${prefix}-reset`}
        >
          Reset
        </Button>
      </div>
      <div id={`${prefix}-wording`} className="scroll-mt-24" />
      <Textarea
        id={boxId}
        aria-label={label}
        value={draft}
        maxLength={480}
        invalid={!verdict.ok || !!templateError}
        onChange={(e) => {
          setDraft(e.target.value);
          setTemplateError(null);
        }}
        onBlur={() => void saveWording()}
        className="mt-2 min-h-[92px] rounded-[10px] px-[11px] py-[9px] text-[13.5px] leading-[1.65] max-md:min-h-[128px]"
        data-testid={`${prefix}-template`}
      />
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <span className="text-xs text-text-3">Insert:</span>
        {INSERTS.map(([name, chip]) => (
          <button
            key={name}
            type="button"
            // Keeps the cursor in the box, so the slot lands where it was.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => insert(name)}
            className="inline-flex h-[26px] items-center rounded-full border border-border-strong bg-card px-[9px] text-xs font-medium text-text-2 hover:bg-card-2"
            data-testid={`${prefix}-insert-${name}`}
          >
            {chip}
          </button>
        ))}
      </div>
      <div className="mt-3.5 flex flex-col gap-1.5">
        <span className={heading}>Preview for {NUDGE_SAMPLE.firstName}</span>
        <div className="flex flex-col rounded-xl border border-border bg-card-2 px-4 py-3.5">
          {preview ? (
            <div
              className="max-w-[92%] self-end rounded-2xl rounded-br-[5px] bg-accent px-[13px] py-2.5 text-sm leading-[1.45] text-white [overflow-wrap:anywhere]"
              data-testid={`${prefix}-preview`}
            >
              {preview}
            </div>
          ) : (
            <span className="text-[13px] text-text-3" data-testid={`${prefix}-preview`}>
              Nothing to send yet.
            </span>
          )}
        </div>
      </div>
      <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1.5" data-testid={`${prefix}-checks`}>
        <Check1 ok={!has('money')} testId={`${prefix}-check-money`}>
          No prices or amounts
        </Check1>
        <Check1 ok={!has('link')} testId={`${prefix}-check-link`}>
          No links
        </Check1>
        <Check1 ok={!has('length') && !has('empty')} testId={`${prefix}-check-length`}>
          {segments.units} characters · {segments.segments || 1}{' '}
          {segments.segments > 1 ? 'texts' : 'text'}
        </Check1>
      </div>
      {verdict.problems.length || templateError ? (
        <ul
          role="alert"
          className="mt-2 flex flex-col gap-1 text-[12.5px] text-warning-text"
          data-testid={`${prefix}-problems`}
        >
          {verdict.problems.map((p) => (
            <li key={p.message}>{p.message}</li>
          ))}
          {templateError && !verdict.problems.some((p) => p.message === templateError) ? (
            <li>{templateError}</li>
          ) : null}
        </ul>
      ) : null}
      <div className="mt-4 flex flex-wrap items-center gap-2.5 border-t border-border pt-3.5">
        {on ? (
          <>
            <Badge variant="ok" data-testid={`${prefix}-on`}>
              On
            </Badge>
            <span className="text-xs text-text-3">
              {turnedOnNow ? `Turned on by ${env.senderName} just now. ${onNote}` : onNote}
            </span>
          </>
        ) : owner ? (
          <>
            <Button
              onClick={() => void turnOn()}
              loading={turningOn}
              disabled={!verdict.ok}
              data-testid={`${prefix}-look-good`}
            >
              Looks good, turn on
            </Button>
            <span className="text-xs text-text-3">
              Turns on {noun} for all of {short}. Only owners see this button.
            </span>
          </>
        ) : (
          <span className="text-xs text-text-3" data-testid={`${prefix}-owner-only`}>
            {reviewed
              ? `${noun[0]!.toUpperCase()}${noun.slice(1)} are off. Turn them on above.`
              : `An owner turns ${noun} on after reading the wording.`}
          </span>
        )}
      </div>
    </>
  );
}

function StalePanel({ env }: { env: PanelEnv }) {
  const settings = env.attention;
  const save = (
    change: (s: AttentionSettings) => AttentionSettings,
    done?: string,
    onError?: (e: unknown) => void,
  ) => env.saveAttention(change, done, onError);

  // ---- Gone quiet, by stage ----
  const staleOf = (stageId: string) => settings.stale.stageDays[stageId] ?? settings.stale.days;
  const setStale = (stage: { id: string; name: string }, days: number) =>
    void save(
      (s) => {
        const stageDays = { ...s.stale.stageDays };
        if (days === s.stale.days) delete stageDays[stage.id];
        else stageDays[stage.id] = days;
        return { ...s, stale: { ...s.stale, stageDays } };
      },
      `${stage.name} goes quiet after ${days} ${days === 1 ? 'day' : 'days'}.`,
    );
  const openStages = env.pipelines
    .map((p) => ({ ...p, open: p.stages.filter((st) => st.kind === 'open') }))
    .filter((p) => p.open.length > 0);

  const reviewed = settings.auto.nudgeReviewedAt !== null;
  const nudgesOn = settings.auto.nudges && reviewed;
  const firstOnes = `The first ones go after the ${AUTO_CANCEL_WINDOW_MINUTES}-minute wait.`;

  function toggleNudges(on: boolean) {
    if (on && !reviewed) {
      toast('Read the wording first, then use Looks good, turn on.');
      document.getElementById('ac-wording')?.scrollIntoView({ behavior: 'smooth' });
      return;
    }
    void save(
      (s) => ({ ...s, auto: { ...s.auto, nudges: on } }),
      on ? `Follow-ups are on. ${firstOnes}` : 'Follow-ups are off. Nothing waiting will go.',
    );
  }

  return (
    <>
      <Block title="Gone quiet after">
        <p className="text-xs text-text-3">
          Days with no text, email, call, chat or visit, either way. Missed calls don’t count.
        </p>
        <div data-testid="ac-stale">
          {openStages.length ? (
            openStages.map((p) => (
              <div key={p.id}>
                <div className={`mb-1 mt-3 whitespace-nowrap ${heading}`}>{p.name}</div>
                {p.open.map((st) => (
                  <div
                    key={st.id}
                    className="grid grid-cols-[minmax(0,1fr)_96px] items-center gap-2.5 border-t border-border py-[7px] text-[13.5px]"
                  >
                    <span className="truncate">{st.name}</span>
                    <NumberBox
                      value={staleOf(st.id)}
                      min={1}
                      max={365}
                      unit="days"
                      label={`${p.name}, ${st.name}: gone quiet after this many days`}
                      className="w-14"
                      onCommit={(n) => setStale(st, n)}
                      testId={`ac-stale-${st.id}`}
                    />
                  </div>
                ))}
              </div>
            ))
          ) : (
            <div className="mt-3 grid grid-cols-[minmax(0,1fr)_96px] items-center gap-2.5 border-t border-border py-[7px] text-[13.5px]">
              <span>Every stage</span>
              <NumberBox
                value={settings.stale.days}
                min={1}
                max={365}
                unit="days"
                label="Gone quiet after this many days"
                className="w-14"
                onCommit={(n) =>
                  void save(
                    (s) => ({ ...s, stale: { ...s.stale, days: n } }),
                    `Leads go quiet after ${n} days.`,
                  )
                }
              />
            </div>
          )}
        </div>
        <p className="mt-1.5 text-[12.5px] text-text-3">Won and lost stages never go quiet.</p>
      </Block>

      <Block title="Follow up on its own">
        <SetRow
          first
          title={
            <span className="flex flex-wrap items-center gap-2">
              Text leads that went quiet
              {reviewed ? null : (
                <Badge variant="pending" data-testid="ac-nudge-badge">
                  Off until an owner reads the wording
                </Badge>
              )}
            </span>
          }
          description="One follow-up per lead, in the words below. It also goes when a lead’s planned follow-up is overdue."
        >
          <Switch
            checked={nudgesOn}
            label="Follow up on leads that went quiet"
            onChange={toggleNudges}
            testId="ac-nudge-switch"
          />
        </SetRow>
        <SafetyNote env={env} />
      </Block>

      <Block title="Follow-up wording">
        <WordingEditor
          env={env}
          prefix="ac"
          label="Follow-up wording"
          template={settings.nudge.template}
          defaultTemplate={DEFAULT_NUDGE_TEMPLATE}
          sampleLeadTitle={NUDGE_SAMPLE.leadTitle}
          on={nudgesOn}
          reviewed={reviewed}
          noun="follow-ups"
          onNote={`Each follow-up waits ${AUTO_CANCEL_WINDOW_MINUTES} minutes, so you can cancel it on Home.`}
          saveTemplate={(text, done, onError) =>
            save((s) => ({ ...s, nudge: { ...s.nudge, template: text } }), done, onError)
          }
          lookGood={(text, onError) =>
            save(
              (s) => ({
                ...s,
                nudge: { ...s.nudge, template: text },
                auto: {
                  ...s.auto,
                  nudges: true,
                  nudgeReviewedAt: s.auto.nudgeReviewedAt ?? new Date().toISOString(),
                },
              }),
              `Follow-ups are on. ${firstOnes}`,
              onError,
            )
          }
        />
      </Block>
    </>
  );
}

// ---- Re-engage dead leads ----

function ReengagePanel({ env }: { env: PanelEnv }) {
  const a = env.automations;
  const r = a.reengage;
  const reviewed = r.reviewedAt !== null;
  const on = a.switches.reengage && reviewed;
  const saveNumber = (key: 'afterDays' | 'maxPerDay' | 'cooldownDays', n: number, done: string) =>
    void env.saveAutomations((s) => ({ ...s, reengage: { ...s.reengage, [key]: n } }), done);
  return (
    <>
      <Block>
        <Note>
          Once a day at 10 AM, one text in your words to open leads nobody has been in touch with
          for a while. Only people who agreed to texts, never anyone who texted STOP, and never
          anyone your team or AI teammate has talked to since. Lost leads are left alone. A reply
          lands in your inbox like any other.
        </Note>
      </Block>
      <Block title="Who and how many">
        <SetRow
          first
          center
          title="Gone cold after"
          description="No message either way for this long."
        >
          <NumberBox
            value={r.afterDays}
            min={30}
            max={730}
            unit="days"
            label="A lead has gone cold after this many days"
            onCommit={(n) => saveNumber('afterDays', n, `Leads count as cold after ${n} days.`)}
            testId="re-after-days"
          />
        </SetRow>
        <SetRow center title="At most a day" description="So a long list doesn't all go at once.">
          <NumberBox
            value={r.maxPerDay}
            min={1}
            max={200}
            unit="texts"
            label="At most this many re-engage texts a day"
            onCommit={(n) => saveNumber('maxPerDay', n, `At most ${n} a day.`)}
            testId="re-max-per-day"
          />
        </SetRow>
        <SetRow
          center
          title="Not again for"
          description="Never to the same lead again within this long."
        >
          <NumberBox
            value={r.cooldownDays}
            min={30}
            max={730}
            unit="days"
            label="Not to the same lead again for this many days"
            onCommit={(n) => saveNumber('cooldownDays', n, `Not again for ${n} days.`)}
            testId="re-cooldown-days"
          />
        </SetRow>
      </Block>
      <Block title="The message">
        <WordingEditor
          env={env}
          prefix="re"
          label="Re-engage wording"
          template={r.template}
          defaultTemplate={DEFAULT_REENGAGE_TEMPLATE}
          sampleLeadTitle={NUDGE_SAMPLE.leadTitle}
          on={on}
          reviewed={reviewed}
          noun="re-engage texts"
          onNote="The next ones go at 10 AM."
          saveTemplate={(text, done, onError) =>
            env.saveAutomations(
              (s) => ({ ...s, reengage: { ...s.reengage, template: text } }),
              done,
              onError,
            )
          }
          lookGood={(text, onError) =>
            env.saveAutomations(
              (s) => ({
                ...s,
                switches: { ...s.switches, reengage: true },
                reengage: {
                  ...s.reengage,
                  template: text,
                  reviewedAt: s.reengage.reviewedAt ?? new Date().toISOString(),
                },
              }),
              'Re-engaging dead leads is on. The first texts go at 10 AM.',
              onError,
            )
          }
        />
      </Block>
    </>
  );
}

const PANELS: Readonly<Record<AdjustPanel, (props: { env: PanelEnv }) => ReactNode>> = {
  new_lead: NewLeadPanel,
  hot_lead: HotLeadPanel,
  unanswered: UnansweredPanel,
  follow_ups: FollowUpsPanel,
  never_replied: NeverRepliedPanel,
  chase_times: ChaseTimesPanel,
  reengage: ReengagePanel,
  day_before: DayBeforePanel,
  unconfirmed: UnconfirmedPanel,
  waitlist: WaitlistPanel,
  invoices: InvoicesPanel,
  morning: MorningPanel,
  stale: StalePanel,
  estimates: EstimatesPanel,
  balance: BalancePanel,
};

/** One automation's Adjust panel. */
export function AdjustPanelView({ panel, env }: { panel: AdjustPanel; env: PanelEnv }) {
  const Panel = PANELS[panel];
  return (
    <div className="flex flex-col gap-4" data-testid={`adjust-${panel}`}>
      <Panel env={env} />
    </div>
  );
}
