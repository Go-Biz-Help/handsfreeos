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
  CONTACT_AI_GUIDE_MAX,
  DEFAULT_FOLLOW_UP_LADDER_HOURS,
  DEFAULT_NUDGE_TEMPLATE,
  DEFAULT_INTAKE_MESSAGE,
  DEFAULT_MAINTENANCE_PLAN_TEMPLATE,
  DEFAULT_MAINTENANCE_TEMPLATE,
  DEFAULT_REENGAGE_TEMPLATE,
  intakeMessageProblem,
  maintenanceTemplateProblem,
  followUpLadderWords,
  guessStageRole,
  NUDGE_SAMPLE,
  STAGE_ROLE_LABELS,
  STAGE_ROLES,
  renderIntakeMessage,
  renderMaintenance,
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
  type RoleOverride,
} from '@hfos/core';
import { ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { useNow } from '@/components/calendar/appt';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/input';
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
  /** The business's forms (not archived), for "Intake questions". */
  readonly forms: readonly IntakeFormOption[];
}

/** A form "Intake questions" may send. Only a live one goes out. */
export interface IntakeFormOption {
  readonly id: string;
  readonly name: string;
  readonly status: 'draft' | 'live' | 'closed' | 'archived';
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

function IntakePanel({ env }: { env: PanelEnv }) {
  const intake = env.automations.intake;
  const live = env.forms.filter((f) => f.status === 'live');
  const chosen = env.forms.find((f) => f.id === intake.formId) ?? null;
  const [draft, setDraft] = useState(intake.message);
  const [error, setError] = useState<string | null>(null);
  const problem = intakeMessageProblem(draft);
  const dirty = draft.trim() !== intake.message;
  const preview = renderIntakeMessage(draft, {
    firstName: NUDGE_SAMPLE.firstName,
    businessName: env.businessName,
    link: 'https://…/f/your-form',
  });
  const formsHref = `/app/w/${env.workspaceId}/forms`;
  return (
    <>
      <Block>
        <Note>
          Right after a customer books their first visit, they get your intake form by text, or by
          email when they can’t be texted. It goes a couple of minutes after the booking
          confirmation, only when the customer is told about the booking, and never to a returning
          customer or someone who already filled it in.
        </Note>
      </Block>
      <Block title="The form">
        {live.length ? (
          <Select
            selectSize="sm"
            aria-label="Intake form"
            value={chosen?.id ?? ''}
            data-testid="intake-form"
            onChange={(e) => {
              const formId = e.target.value || null;
              const name = env.forms.find((f) => f.id === formId)?.name;
              void env.saveAutomations(
                (s) => ({ ...s, intake: { ...s.intake, formId } }),
                name ? `First-time customers get “${name}”.` : 'No intake form is sent.',
              );
            }}
          >
            <option value="">Pick a form…</option>
            {live.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </Select>
        ) : (
          <Note>
            You don’t have a live form yet. The “Before your first visit” starter in{' '}
            <Link href={formsHref} className={linkCls}>
              Forms
            </Link>{' '}
            is a good place to begin.
          </Note>
        )}
        {chosen && chosen.status !== 'live' ? (
          <p className="text-[12.5px] text-warning-text" data-testid="intake-form-not-live">
            “{chosen.name}” isn’t live, so nothing goes until it is.
          </p>
        ) : null}
        <Note>
          Change the questions in{' '}
          <Link href={formsHref} className={linkCls}>
            Forms
          </Link>
          .
        </Note>
      </Block>
      <Block title="The message">
        <Textarea
          aria-label="Intake message"
          value={draft}
          rows={3}
          onChange={(e) => {
            setDraft(e.target.value);
            setError(null);
          }}
          data-testid="intake-message"
        />
        <p className="text-[12.5px] text-text-3">
          Use {'{firstName}'}, {'{businessName}'} and {'{link}'}. The link is the form’s.
        </p>
        {problem || error ? (
          <p className="text-[12.5px] text-danger-text" data-testid="intake-message-error">
            {problem ?? error}
          </p>
        ) : null}
        <div className="rounded-[9px] bg-card-2 px-[11px] py-[9px] text-[13px] leading-[1.45]">
          <span className="text-text-3">What {NUDGE_SAMPLE.firstName} gets: </span>
          <span data-testid="intake-preview">{preview}</span>
        </div>
        <div className="flex gap-2">
          <Button
            size="sm"
            disabled={!dirty || !!problem}
            onClick={() =>
              void env.saveAutomations(
                (s) => ({ ...s, intake: { ...s.intake, message: draft.trim() } }),
                'Saved the intake message.',
                (e) => {
                  const f = fieldErrors(e);
                  setError(Object.values(f)[0] ?? 'That didn’t save.');
                },
              )
            }
            data-testid="intake-message-save"
          >
            Save
          </Button>
          {draft.trim() !== DEFAULT_INTAKE_MESSAGE ? (
            <Button size="sm" variant="ghost" onClick={() => setDraft(DEFAULT_INTAKE_MESSAGE)}>
              Use the standard wording
            </Button>
          ) : null}
        </div>
      </Block>
    </>
  );
}

// ---- Maintenance due ----

/** One maintenance wording: the box, its problems, a preview, and Save. */
function MaintenanceWording({ env, which }: { env: PanelEnv; which: 'template' | 'planTemplate' }) {
  const plan = which === 'planTemplate';
  const saved = env.automations.maintenance[which];
  const fallback = plan ? DEFAULT_MAINTENANCE_PLAN_TEMPLATE : DEFAULT_MAINTENANCE_TEMPLATE;
  const [draft, setDraft] = useState(saved);
  const [error, setError] = useState<string | null>(null);
  const problem = maintenanceTemplateProblem(draft, { plan });
  const preview = renderMaintenance(draft, {
    firstName: NUDGE_SAMPLE.firstName,
    businessName: env.businessName,
    service: 'AC tune-up',
    link: 'https://…/book/your-calendar',
    plan: plan ? 'Comfort Club' : null,
  });
  const id = plan ? 'maint-plan' : 'maint';
  return (
    <div className="flex flex-col gap-2">
      <Textarea
        aria-label={plan ? 'Maintenance message for plan members' : 'Maintenance message'}
        value={draft}
        rows={3}
        onChange={(e) => {
          setDraft(e.target.value);
          setError(null);
        }}
        data-testid={`${id}-message`}
      />
      <p className="text-[12.5px] text-text-3">
        Use {'{firstName}'}, {'{businessName}'}, {'{service}'}
        {plan ? <>, {'{plan}'}</> : null} and {'{link}'}. The link opens your booking page on that
        service.
      </p>
      {problem || error ? (
        <p className="text-[12.5px] text-danger-text" data-testid={`${id}-error`}>
          {problem ?? error}
        </p>
      ) : null}
      <div className="rounded-[9px] bg-card-2 px-[11px] py-[9px] text-[13px] leading-[1.45]">
        <span className="text-text-3">What {NUDGE_SAMPLE.firstName} gets: </span>
        <span data-testid={`${id}-preview`}>{preview}</span>
      </div>
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={draft.trim() === saved || !!problem}
          onClick={() =>
            void env.saveAutomations(
              (s) => ({ ...s, maintenance: { ...s.maintenance, [which]: draft.trim() } }),
              'Saved the maintenance message.',
              (e) => setError(Object.values(fieldErrors(e))[0] ?? 'That didn’t save.'),
            )
          }
          data-testid={`${id}-save`}
        >
          Save
        </Button>
        {draft.trim() !== fallback ? (
          <Button size="sm" variant="ghost" onClick={() => setDraft(fallback)}>
            Use the standard wording
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function MaintenancePanel({ env }: { env: PanelEnv }) {
  const m = env.automations.maintenance;
  const saveNumber = (key: 'leadDays' | 'secondAfterDays' | 'maxPerDay', n: number, done: string) =>
    void env.saveAutomations((s) => ({ ...s, maintenance: { ...s.maintenance, [key]: n } }), done);
  return (
    <>
      <Block>
        <Note>
          When a customer’s regular service comes round again, they get a text in your words with a
          link to book it. If they don’t book, a second text goes, and then a card on Home asks
          someone to call them. Booking it at any point stops the rest.
        </Note>
        <Note>
          How often comes from the service’s “Repeats every” in{' '}
          <Link href={`/app/w/${env.workspaceId}/settings/calendars/services`} className={linkCls}>
            Services
          </Link>
          , from a maintenance plan that covers it, or from a customer’s own schedule on their page.
          Only people who agreed to texts get one; STOP always wins.
        </Note>
      </Block>
      <Block title="When">
        <SetRow first center title="First text" description="Before the visit is due.">
          <NumberBox
            value={m.leadDays}
            min={0}
            max={60}
            unit="days before"
            label="Days before the visit is due"
            onCommit={(n) => saveNumber('leadDays', n, `The first text goes ${n} days before.`)}
            testId="maint-lead-days"
          />
        </SetRow>
        <SetRow
          center
          title="Second text, then a card"
          description="If they haven’t booked, after this long each time."
        >
          <NumberBox
            value={m.secondAfterDays}
            min={1}
            max={30}
            unit="days"
            label="Days between the texts, and before the card"
            onCommit={(n) => saveNumber('secondAfterDays', n, `${n} days between each step.`)}
            testId="maint-second-days"
          />
        </SetRow>
        <SetRow
          center
          title="At most a day"
          description="Customers already overdue go a few at a time, most overdue first."
        >
          <NumberBox
            value={m.maxPerDay}
            min={1}
            max={200}
            unit="texts"
            label="At most this many first reminders a day"
            onCommit={(n) => saveNumber('maxPerDay', n, `At most ${n} a day.`)}
            testId="maint-max-per-day"
          />
        </SetRow>
      </Block>
      <Block title="The message">
        <MaintenanceWording env={env} which="template" />
      </Block>
      <Block title="For customers on a maintenance plan">
        <MaintenanceWording env={env} which="planTemplate" />
      </Block>
    </>
  );
}

// ---- After the job ----

function ThankYouPanel({ env }: { env: PanelEnv }) {
  const ai = env.teammateName ?? 'Your AI teammate';
  return (
    <Block>
      <Note>
        Two hours after a job is marked done, {ai} texts the customer a short thank-you that
        mentions the job. It asks for nothing: no review, no payment. While it’s training, the
        thank-you waits in Approvals for you.
      </Note>
      <Note>
        It skips anyone someone already wrote to since the job, anyone who can’t be reached, and
        calendars with their own “job done” workflow. With no AI teammate switched on, or when
        someone on the team has their conversation, a card on Home reminds you to thank them
        instead.
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
        At 7 AM where the business is, everyone on the team gets one email: today’s jobs (with the
        ones not confirmed yet), who to call (follow-ups due, hot leads, quotes waiting on a yes,
        visits not confirmed), then whatever else needs them, urgent first. A member sees their own
        jobs and items and the ones nobody has taken; owners and admins see everything.
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

/**
 * "Move deals along for you": which of the business's open stages means what. Each shows its guess from the
 * name until someone picks, and a pick back to the guess goes back to following the name.
 */
function StagesPanel({ env }: { env: PanelEnv }) {
  const roles = env.automations.pipeline.roles;
  const openStages = env.pipelines
    .map((p) => ({ ...p, open: p.stages.filter((st) => st.kind === 'open') }))
    .filter((p) => p.open.length > 0);
  const choose = (stage: { id: string; name: string }, next: RoleOverride) => {
    const guess = guessStageRole(stage.name) ?? 'none';
    const words =
      next === 'none'
        ? `Deals won’t be moved into ${stage.name}.`
        : `${stage.name}: ${STAGE_ROLE_LABELS[next].toLowerCase()}.`;
    void env.saveAutomations((s) => {
      const nextRoles = { ...s.pipeline.roles };
      if (next === guess) delete nextRoles[stage.id];
      else nextRoles[stage.id] = next;
      return { ...s, pipeline: { ...s.pipeline, roles: nextRoles } };
    }, words);
  };
  return (
    <>
      <Block>
        <Note>
          A deal moves to the stage that matches what just happened, and its timeline says why. It
          only moves forward, and never out of won or lost. When the customer accepts a quote or the
          job is done, it moves to won.
        </Note>
        <Note>
          We guessed each stage from its name. Pick another where the guess is wrong, or “Nothing”
          for a stage deals should only reach by hand.
        </Note>
      </Block>
      <Block title="What each stage means">
        <div data-testid="stage-roles">
          {openStages.length ? (
            openStages.map((p) => (
              <div key={p.id}>
                <div className={`mb-1 mt-3 whitespace-nowrap ${heading}`}>{p.name}</div>
                {p.open.map((st) => {
                  const value = roles[st.id] ?? guessStageRole(st.name) ?? 'none';
                  return (
                    <div
                      key={st.id}
                      className="grid grid-cols-[minmax(0,1fr)_minmax(0,220px)] items-center gap-2.5 border-t border-border py-[7px] text-[13.5px]"
                    >
                      <span className="truncate">{st.name}</span>
                      <Select
                        selectSize="sm"
                        aria-label={`${p.name}, ${st.name}: what moves a deal here`}
                        value={value}
                        onChange={(e) => choose(st, e.target.value as RoleOverride)}
                        data-testid={`stage-role-${st.id}`}
                      >
                        {STAGE_ROLES.map((r) => (
                          <option key={r} value={r}>
                            {STAGE_ROLE_LABELS[r]}
                          </option>
                        ))}
                        <option value="none">Nothing</option>
                      </Select>
                    </div>
                  );
                })}
              </div>
            ))
          ) : (
            <Note>No pipeline has an open stage yet.</Note>
          )}
        </div>
      </Block>
    </>
  );
}

/** "6:00 PM" choices for the evening email, noon to 10 PM on the half hour. */
const EVENING_TIMES = Array.from({ length: 21 }, (_, i) => {
  const minutes = 12 * 60 + i * 30;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const value = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  const label = `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
  return { value, label };
});

function EveningPanel({ env }: { env: PanelEnv }) {
  const at = env.automations.briefings.eveningAt;
  return (
    <>
      <Block>
        <Note>
          Owners and admins get one email at the end of the day: the day in numbers (new leads and
          how many were reached, jobs booked, done and missed, money in, what the AI teammate did),
          today’s jobs nobody marked done, and what’s still open on Home.
        </Note>
        <Note>
          Anyone can turn off their own copy in{' '}
          <Link href={`/app/w/${env.workspaceId}/settings`} className={linkCls}>
            Account
          </Link>
          . This switch turns it off for everyone.
        </Note>
      </Block>
      <Block title="When">
        <SetRow first center title="Sends at" description="Where the business is.">
          <Select
            selectSize="sm"
            aria-label="When the evening email goes"
            value={at}
            onChange={(e) => {
              const next = e.target.value;
              const label = EVENING_TIMES.find((t) => t.value === next)?.label ?? next;
              void env.saveAutomations(
                (s) => ({ ...s, briefings: { ...s.briefings, eveningAt: next } }),
                `The end-of-day email goes at ${label}.`,
              );
            }}
            data-testid="evening-at"
          >
            {EVENING_TIMES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </Select>
        </SetRow>
      </Block>
    </>
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

// ---- The AI's tags and details (0107) ----

function AiTagsPanel({ env }: { env: PanelEnv }) {
  const guide = env.automations.contactAi.guide;
  const [draft, setDraft] = useState(guide);
  const [error, setError] = useState<string | null>(null);
  const dirty = draft.trim() !== guide;
  const tooLong = draft.trim().length > CONTACT_AI_GUIDE_MAX;
  return (
    <>
      <Block>
        <Note>
          A few minutes after a customer’s message, call, visit, deal, payment or form, the AI reads
          what the business knows about them and puts on the tags that fit, or takes off ones it put
          on that no longer do. A tag someone on your team put on stays. It looks at one customer at
          most every half hour.
        </Note>
        <Note>
          With “Keep contact details up to date” on, it also fills in or fixes their name, email,
          number and address when they tell you — only what they actually wrote or said, never from
          a website chat whose visitor didn’t prove who they are. An email or number it replaces
          stays on file as “Previous”.
        </Note>
        <Note>
          Every change is in the audit log as “HandsFreeOS AI”, with its reason. To go through
          everyone you already have, use{' '}
          <Link href={`/app/w/${env.workspaceId}/settings/tags`} className={linkCls}>
            Tags
          </Link>
          .
        </Note>
      </Block>
      <Block title="How you tag customers">
        <Textarea
          aria-label="How you tag customers"
          value={draft}
          rows={4}
          placeholder="VIP: has spent over $2,000 with us. Commercial: a business, not a home."
          onChange={(e) => {
            setDraft(e.target.value);
            setError(null);
          }}
          data-testid="ai-tags-guide"
        />
        <p className="text-[12.5px] text-text-3">
          In your own words. The AI reads it every time it looks at a customer’s tags.
        </p>
        {tooLong || error ? (
          <p className="text-[12.5px] text-danger-text">
            {tooLong ? `Keep it under ${CONTACT_AI_GUIDE_MAX} characters.` : error}
          </p>
        ) : null}
        <div className="flex gap-2">
          <Button
            size="sm"
            disabled={!dirty || tooLong}
            onClick={() =>
              void env.saveAutomations(
                (s) => ({ ...s, contactAi: { ...s.contactAi, guide: draft.trim() } }),
                'Saved how you tag customers.',
                (e) => {
                  const f = fieldErrors(e);
                  setError(Object.values(f)[0] ?? 'That didn’t save.');
                },
              )
            }
            data-testid="ai-tags-guide-save"
          >
            Save
          </Button>
        </div>
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
  intake: IntakePanel,
  maintenance: MaintenancePanel,
  thank_you: ThankYouPanel,
  invoices: InvoicesPanel,
  morning: MorningPanel,
  evening: EveningPanel,
  stages: StagesPanel,
  stale: StalePanel,
  estimates: EstimatesPanel,
  balance: BalancePanel,
  ai_tags: AiTagsPanel,
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
