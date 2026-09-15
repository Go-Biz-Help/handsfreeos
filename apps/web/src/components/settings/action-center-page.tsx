'use client';
/**
 * Settings → Action Center (design/m8/Settings.dc.html). Switches save the moment they're flipped, and numbers when
 * they're left. The left column is what Home looks for: the kinds and their thresholds, the typical job value, and
 * how long each stage may go without contact. The right is what HandsFreeOS does on its own: confirmation
 * requests, follow-ups in the business's own words (off until an owner reads them and chooses “Looks good, turn
 * on”), and replying C to confirm.
 */
import {
  AUTO_CANCEL_WINDOW_MINUTES,
  AUTO_RECENT_PERSON_HOURS,
  checkNudgeTemplate,
  DEFAULT_NUDGE_TEMPLATE,
  NUDGE_SAMPLE,
  renderNudge,
  shortBusinessName,
  smsSegments,
  type AttentionKind,
  type AttentionSettings,
  type NudgeCheckContext,
  type NudgePlaceholder,
  type NudgeProblemCode,
} from '@hfos/core';
import { AlertTriangle, Check, Lock, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { KindTile } from '@/components/attention/bits';
import { useNow } from '@/components/calendar/appt';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import { fieldErrors } from '@/lib/api/field-errors';
import type { Pipeline, Role } from '@/lib/api/types';
import { formatMoney, parseMoney } from '@/lib/format';
import { cn } from '@/lib/utils';
import { SetRow } from './set-row';

type Kinds = AttentionSettings['kinds'];

/** The kinds in the canvas's order, in its words. */
const KIND_ROWS: readonly {
  readonly kind: AttentionKind;
  readonly title: string;
  /** For the toasts: "HandsFreeOS stops looking for hot leads." */
  readonly noun: string;
}[] = [
  { kind: 'hot_lead', title: 'Hot leads', noun: 'hot leads' },
  { kind: 'unanswered_lead', title: 'Unanswered leads', noun: 'unanswered leads' },
  { kind: 'customer_waiting', title: 'Customers waiting', noun: 'customers waiting on a reply' },
  { kind: 'stale_opportunity', title: 'Gone quiet', noun: 'leads that went quiet' },
  { kind: 'missing_next_action', title: 'No next action', noun: 'leads with no next action' },
  { kind: 'unconfirmed_appointment', title: 'Not confirmed', noun: 'unconfirmed visits' },
  { kind: 'ai_approval', title: 'Approvals', noun: 'approvals' },
  { kind: 'overdue_task', title: 'Overdue tasks', noun: 'overdue tasks' },
];

/** The chips that put a placeholder in the wording, with the words the canvas gives them. */
const INSERTS: readonly (readonly [NudgePlaceholder, string])[] = [
  ['firstName', 'First name'],
  ['senderName', 'Your name'],
  ['businessName', 'Business name'],
  ['leadTitle', 'Lead title'],
  ['businessPhone', 'Business phone'],
];

/** The wording's box, which the Insert chips type into where the cursor was. */
const BOX_ID = 'nudge-template';
const sectionTitle = 'text-lg font-semibold leading-[1.3] tracking-[-0.005em]';
const sectionDesc = 'mt-1 text-[13px] text-text-2';

function Section({
  title,
  description,
  action,
  children,
  className,
  testId,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <Card className={cn('px-[22px] py-5', className)} data-testid={testId}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className={sectionTitle}>{title}</h2>
          {description ? <p className={cn(sectionDesc, 'max-w-[460px]')}>{description}</p> : null}
        </div>
        {action}
      </div>
      {children}
    </Card>
  );
}

/** A whole number that saves when it's left (or on Enter), and goes back if it's out of range. */
function NumberBox({
  value,
  min,
  max,
  unit,
  label,
  disabled,
  onCommit,
  className,
  testId,
}: {
  value: number;
  min: number;
  max: number;
  unit?: string;
  label: string;
  disabled?: boolean;
  onCommit: (next: number) => void;
  className?: string;
  testId?: string;
}) {
  const [text, setText] = useState(String(value));
  const [shown, setShown] = useState(value);
  if (shown !== value) {
    setShown(value);
    setText(String(value));
  }
  const commit = () => {
    const raw = text.trim();
    if (raw === String(value)) return;
    const n = Number(raw);
    if (!raw || !Number.isInteger(n) || n < min || n > max) {
      toast.error(`Use a whole number from ${min} to ${max}.`);
      setText(String(value));
      return;
    }
    onCommit(n);
  };
  return (
    <span className="flex items-center gap-1.5">
      <Input
        inputSize="sm"
        inputMode="numeric"
        aria-label={label}
        value={text}
        disabled={disabled}
        onChange={(e) => setText(e.target.value.replace(/[^0-9]/g, ''))}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            e.currentTarget.blur();
          }
        }}
        className={cn('w-16 px-2.5 tabular-nums', className)}
        data-testid={testId}
      />
      {unit ? <span className="text-xs text-text-3">{unit}</span> : null}
    </span>
  );
}

/** Dollars that save when they're left. `optional` lets it be emptied (the worked-out value then). */
function MoneyBox({
  cents,
  label,
  optional,
  placeholder,
  onCommit,
  testId,
}: {
  cents: number | null;
  label: string;
  optional?: boolean;
  placeholder?: string;
  onCommit: (next: number | null) => void;
  testId?: string;
}) {
  const shownText = cents === null ? '' : formatMoney(cents);
  const [text, setText] = useState(shownText);
  const [shown, setShown] = useState(shownText);
  if (shown !== shownText) {
    setShown(shownText);
    setText(shownText);
  }
  const commit = () => {
    const raw = text.trim();
    if (raw === shownText) return;
    if (!raw) {
      if (optional) onCommit(null);
      else setText(shownText);
      return;
    }
    const next = parseMoney(raw);
    if (next === null || next > 100_000_000_00) {
      toast.error('Use an amount in dollars, like $4,200.');
      setText(shownText);
      return;
    }
    setText(formatMoney(next));
    if (next !== cents) onCommit(next);
  };
  return (
    <Input
      inputSize="sm"
      inputMode="decimal"
      aria-label={label}
      value={text}
      placeholder={placeholder}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          e.currentTarget.blur();
        }
      }}
      className="w-24 px-2.5 tabular-nums max-md:w-28"
      data-testid={testId}
    />
  );
}

/** One line of the wording's checklist: a green tick, or an amber warning. */
function Check1({ ok, children, testId }: { ok: boolean; children: ReactNode; testId?: string }) {
  return (
    <span
      className="flex items-center gap-2 text-[13px] text-text-2"
      data-testid={testId}
      data-ok={ok}
    >
      {ok ? (
        <Check className="h-4 w-4 flex-none text-success-text" strokeWidth={2} aria-label="OK" />
      ) : (
        <AlertTriangle
          className="h-4 w-4 flex-none text-warning-text"
          strokeWidth={1.75}
          aria-label="Needs a change"
        />
      )}
      {children}
    </span>
  );
}

/** "Wed, Sep 23": tomorrow, for the reminder's sample (in the browser, so the server's zone never shows). */
function tomorrowLabel(now: number): string {
  const d = new Date(now + 86_400_000);
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

export function ActionCenterSettings({
  workspaceId,
  role,
  businessName,
  initial,
  workedOut,
  typicalFrom,
  pipelines,
  replyMinutes,
  check,
  senderName,
  teammateName,
}: {
  workspaceId: string;
  role: Role;
  businessName: string;
  initial: AttentionSettings;
  /** What HandsFreeOS works out for a lead with no value, when the business hasn't set its own. */
  workedOut: number;
  typicalFrom: 'won_median' | 'default';
  pipelines: readonly Pipeline[];
  /** Texting & calls' reply time: a customer waiting this long opens an item. */
  replyMinutes: number;
  /** The business's own number, links and addresses: the only ones the wording may give. */
  check: NudgeCheckContext;
  /** The preview's {senderName}: the person reading. */
  senderName: string;
  teammateName: string | null;
}) {
  const [settings, setSettings] = useState<AttentionSettings>(initial);
  const [draft, setDraft] = useState(initial.nudge.template);
  const [templateError, setTemplateError] = useState<string | null>(null);
  const [turningOn, setTurningOn] = useState(false);
  const [turnedOnNow, setTurnedOnNow] = useState(false);
  const latest = useRef(initial);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const owner = role === 'owner';
  const ai = teammateName ?? 'your AI teammate';

  /**
   * Saves the whole settings document, one save at a time: what's on screen changes at once, and goes back if the
   * server says no. The server's answer (it stamps "Looks good, turn on") replaces it.
   */
  function save(
    change: (s: AttentionSettings) => AttentionSettings,
    done?: string,
  ): Promise<boolean> {
    const before = latest.current;
    const next = change(before);
    latest.current = next;
    setSettings(next);
    const run = queue.current.then(async () => {
      try {
        const out = unwrap(
          await apiBrowser().POST('/v1/commands/attention.save_settings', {
            body: { workspaceId, settings: next },
          }),
        );
        if (latest.current === next) {
          latest.current = out.settings;
          setSettings(out.settings);
        }
        if (done) toast.success(done);
        return true;
      } catch (e) {
        if (latest.current === next) {
          latest.current = before;
          setSettings(before);
        }
        const wording = fieldErrors(e).template;
        if (wording) setTemplateError(wording);
        toast.error(errorMessage(e));
        return false;
      }
    });
    queue.current = run;
    return run;
  }

  const setKind = (kind: AttentionKind, on: boolean, noun: string) =>
    void save(
      (s) => ({ ...s, kinds: { ...s.kinds, [kind]: on } as Kinds }),
      on
        ? `HandsFreeOS looks for ${noun} again.`
        : `HandsFreeOS stops looking for ${noun}. Their cards leave Home within the hour.`,
    );

  // ---- The wording ----
  const phone = check.businessPhone?.trim() || NUDGE_SAMPLE.businessPhone;
  const preview = renderNudge(draft, {
    firstName: NUDGE_SAMPLE.firstName,
    businessName,
    leadTitle: NUDGE_SAMPLE.leadTitle,
    senderName,
    businessPhone: phone,
  }).text;
  const verdict = checkNudgeTemplate(draft, check);
  const has = (code: NudgeProblemCode) => verdict.problems.some((p) => p.code === code);
  const segments = smsSegments(preview);
  const reviewed = settings.auto.nudgeReviewedAt !== null;
  const nudgesOn = settings.auto.nudges && reviewed;
  const dirty = draft.trim() !== settings.nudge.template;

  async function saveWording(): Promise<boolean> {
    if (!dirty) return true;
    if (!verdict.ok) return false;
    const text = draft.trim();
    setTemplateError(null);
    const ok = await save(
      (s) => ({ ...s, nudge: { ...s.nudge, template: text } }),
      'Wording saved.',
    );
    return ok;
  }

  function insert(name: NudgePlaceholder) {
    const el = document.getElementById(BOX_ID) as HTMLTextAreaElement | null;
    const token = `{${name}}`;
    const start = el?.selectionStart ?? draft.length;
    const end = el?.selectionEnd ?? draft.length;
    const before = draft.slice(0, start);
    const after = draft.slice(end);
    const pad = before && !/\s$/.test(before) ? ' ' : '';
    const next = `${before}${pad}${token}${after}`;
    setDraft(next);
    setTemplateError(null);
    const at = before.length + pad.length + token.length;
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(at, at);
    });
  }

  async function lookGood() {
    if (!verdict.ok) return;
    setTurningOn(true);
    const text = draft.trim();
    const ok = await save(
      (s) => ({
        ...s,
        nudge: { ...s.nudge, template: text },
        auto: {
          ...s.auto,
          nudges: true,
          nudgeReviewedAt: s.auto.nudgeReviewedAt ?? new Date().toISOString(),
        },
      }),
      `Follow-ups are on. The first ones go after the ${AUTO_CANCEL_WINDOW_MINUTES}-minute wait.`,
    );
    setTurningOn(false);
    if (ok) setTurnedOnNow(true);
  }

  function toggleNudges(on: boolean) {
    if (on && !reviewed) {
      toast('Read the wording first, then use Looks good, turn on.');
      document.getElementById('nudge-wording')?.scrollIntoView({ behavior: 'smooth' });
      return;
    }
    setTurnedOnNow(false);
    void save(
      (s) => ({ ...s, auto: { ...s.auto, nudges: on } }),
      on
        ? `Follow-ups are on. The first ones go after the ${AUTO_CANCEL_WINDOW_MINUTES}-minute wait.`
        : 'Follow-ups are off. Nothing waiting will go.',
    );
  }

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
  const openStages = pipelines
    .map((p) => ({ ...p, open: p.stages.filter((st) => st.kind === 'open') }))
    .filter((p) => p.open.length > 0);

  const threshold = (kind: AttentionKind, on: boolean): ReactNode => {
    switch (kind) {
      case 'hot_lead':
        return (
          <NumberBox
            value={settings.hot.urgentAfterMinutes}
            min={1}
            max={240}
            unit="min"
            label="A hot lead is urgent after this many minutes"
            disabled={!on}
            onCommit={(n) =>
              void save(
                (s) => ({ ...s, hot: { ...s.hot, urgentAfterMinutes: n } }),
                `A hot lead is urgent after ${n} min.`,
              )
            }
            testId="ac-threshold-hot_lead"
          />
        );
      case 'unanswered_lead':
        return (
          <NumberBox
            value={settings.unanswered.afterOpenMinutes}
            min={1}
            max={480}
            unit="min"
            label="A new lead shows after this many open-hours minutes"
            disabled={!on}
            onCommit={(n) =>
              void save(
                (s) => ({ ...s, unanswered: { afterOpenMinutes: n } }),
                `Unanswered leads show after ${n} min of open hours.`,
              )
            }
            testId="ac-threshold-unanswered_lead"
          />
        );
      case 'customer_waiting':
        return (
          <span className="whitespace-nowrap text-xs text-text-3">
            {replyMinutes ? `${replyMinutes} min` : 'Right away'}
          </span>
        );
      case 'stale_opportunity':
        return <span className="whitespace-nowrap text-xs text-text-3">By stage</span>;
      case 'unconfirmed_appointment':
        return (
          <NumberBox
            value={settings.appointments.windowHours}
            min={1}
            max={168}
            unit="h"
            label="Visits that start within this many hours"
            disabled={!on}
            onCommit={(n) =>
              void save(
                (s) => ({ ...s, appointments: { windowHours: n } }),
                `Unconfirmed visits show ${n} h before they start.`,
              )
            }
            testId="ac-threshold-unconfirmed_appointment"
          />
        );
      case 'ai_approval':
        return (
          <span className="inline-flex items-center gap-1 whitespace-nowrap text-[11.5px] font-medium text-text-3">
            <Lock className="h-3 w-3" strokeWidth={1.75} aria-hidden />
            Always on
          </span>
        );
      default:
        return null;
    }
  };

  const kindDescription = (kind: AttentionKind): ReactNode => {
    switch (kind) {
      case 'hot_lead':
        return `Waiting on you, with a strong sign like qualified by ${ai} or asking to book, or two smaller signs.`;
      case 'unanswered_lead':
        return 'A new lead nobody has answered. Only open hours count.';
      case 'customer_waiting':
        return (
          <>
            A customer’s message with no reply. The time is set in{' '}
            <Link
              href={`/app/w/${workspaceId}/settings/texting`}
              className="text-accent-text hover:underline"
            >
              Texting &amp; calls
            </Link>
            .
          </>
        );
      case 'stale_opportunity':
        return 'No contact for longer than its stage allows. See below.';
      case 'missing_next_action':
        return 'An open lead with nothing planned.';
      case 'unconfirmed_appointment':
        return 'Appointments that start within this many hours.';
      case 'ai_approval':
        return `${teammateName ? `${teammateName}’s` : 'AI teammate'} drafts and workflow approvals. Only people who can decide see them.`;
      case 'overdue_task':
        return 'Tasks past their due time.';
    }
  };

  const replyC = settings.replyToConfirm;
  const short = shortBusinessName(businessName);
  // Null while the server renders, so the sample's date only ever comes from the browser.
  const now = useNow();

  return (
    <div
      className="grid grid-cols-1 items-start gap-5 xl:grid-cols-2"
      data-testid="action-center-settings"
    >
      <div className="flex min-w-0 flex-col gap-5">
        <Section
          title="What to look for"
          description="Turn a kind off and its cards leave Home at the next check, within the hour."
          className="pb-2"
          testId="ac-kinds"
        >
          <div className="mt-2.5">
            {KIND_ROWS.map(({ kind, title, noun }) => {
              const locked = kind === 'ai_approval';
              const on = locked || settings.kinds[kind];
              const extra = threshold(kind, on);
              return (
                <div
                  key={kind}
                  className="grid grid-cols-[30px_minmax(0,1fr)_40px] items-center gap-3 border-t border-border py-[11px]"
                  data-testid={`ac-kind-${kind}`}
                >
                  <KindTile kind={kind} size="sm" />
                  <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="text-[13px] font-medium">{title}</span>
                      <span className="text-xs text-text-3">{kindDescription(kind)}</span>
                    </span>
                    {extra ? <span className="flex-none">{extra}</span> : null}
                  </div>
                  <span className="flex justify-end">
                    <Switch
                      checked={on}
                      disabled={locked}
                      label={locked ? `${title} are always on` : `Look for ${noun}`}
                      onChange={(next) => setKind(kind, next, noun)}
                      testId={`ac-kind-switch-${kind}`}
                    />
                  </span>
                </div>
              );
            })}
          </div>
        </Section>

        <Section title="Typical job value" testId="ac-values">
          <SetRow
            first
            center
            className="pt-3.5"
            title="When a lead has no value, use"
            description={
              settings.typicalJobValueCents !== null
                ? `Cards show it as “About ${formatMoney(settings.typicalJobValueCents)}”, and it never counts toward $ affected. Empty it to use the middle of the leads you won in the last year.`
                : typicalFrom === 'won_median'
                  ? `The middle of the leads you won in the last year. Cards show it as “About ${formatMoney(workedOut)}”, and it never counts toward $ affected.`
                  : `You haven’t won a lead in the last year, so cards show “About ${formatMoney(workedOut)}”. It never counts toward $ affected.`
            }
          >
            <MoneyBox
              cents={settings.typicalJobValueCents}
              optional
              placeholder={formatMoney(workedOut)}
              label="Typical job value"
              onCommit={(cents) =>
                void save(
                  (s) => ({ ...s, typicalJobValueCents: cents }),
                  cents === null
                    ? 'Leads with no value use the middle of the leads you won.'
                    : `Leads with no value count as about ${formatMoney(cents)}.`,
                )
              }
              testId="ac-typical-value"
            />
          </SetRow>
          <SetRow
            center
            className="pb-0"
            title="A big job starts at"
            description="One of the smaller signs of a hot lead."
          >
            <MoneyBox
              cents={settings.hot.minValueCents}
              label="A big job starts at"
              onCommit={(cents) =>
                void save(
                  (s) => ({ ...s, hot: { ...s.hot, minValueCents: cents ?? 0 } }),
                  `A big job starts at ${formatMoney(cents ?? 0)}.`,
                )
              }
              testId="ac-big-job"
            />
          </SetRow>
        </Section>

        <Section
          title="Gone quiet after"
          description="Days with no text, email, call, chat or visit, either way. Missed calls don’t count."
          testId="ac-stale"
        >
          {openStages.length ? (
            openStages.map((p) => (
              <div key={p.id}>
                <div className="mb-1 mt-3 whitespace-nowrap text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3">
                  {p.name}
                </div>
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
          <p className="mt-1.5 text-[12.5px] text-text-3">Won and lost stages never go quiet.</p>
        </Section>
      </div>

      <div className="flex min-w-0 flex-col gap-5">
        <Section
          title="What HandsFreeOS does on its own"
          description="Only these two. Everything else asks first, and approvals always wait for a person."
          testId="ac-auto"
        >
          <div className="mt-2">
            <SetRow
              title="Ask customers to confirm visits"
              description="One text or email per visit, 1 to 2 days before. A reply of C, or the Confirm button, confirms it."
            >
              <Switch
                checked={settings.auto.confirmRequests}
                label="Ask customers to confirm visits"
                onChange={(on) =>
                  void save(
                    (s) => ({ ...s, auto: { ...s.auto, confirmRequests: on } }),
                    on
                      ? 'HandsFreeOS asks customers to confirm again.'
                      : 'HandsFreeOS won’t ask customers to confirm. Reminders still go.',
                  )
                }
                testId="ac-confirm-switch"
              />
            </SetRow>
            <SetRow
              title={
                <span className="flex flex-wrap items-center gap-2">
                  Follow up on leads that went quiet
                  {reviewed ? null : (
                    <Badge variant="pending" data-testid="ac-nudge-badge">
                      Off until an owner reads the wording
                    </Badge>
                  )}
                </span>
              }
              description="One follow-up per lead, in the words below."
            >
              <Switch
                checked={nudgesOn}
                label="Follow up on leads that went quiet"
                onChange={toggleNudges}
                testId="ac-nudge-switch"
              />
            </SetRow>
          </div>
          <div className="mt-1.5 flex items-start gap-2 rounded-[9px] bg-card-2 px-[11px] py-[9px] text-[12.5px] leading-[1.45] text-text-2">
            <ShieldCheck className="mt-px h-4 w-4 flex-none" strokeWidth={1.75} aria-hidden />
            <span>
              Every automatic message waits {AUTO_CANCEL_WINDOW_MINUTES} minutes so you can cancel,
              follows texting consent and quiet hours, goes once per item and never within{' '}
              {settings.nudge.cooldownDays} days of another. It skips anyone your team or {ai} is
              talking with, anyone with a draft waiting or in a workflow, and anyone a person
              messaged in the last {Math.round(AUTO_RECENT_PERSON_HOURS / 24)} days. STOP always
              wins.
            </span>
          </div>
        </Section>

        <Section
          title="Follow-up wording"
          description="Plain words, no prices and no links. It goes from your business number."
          testId="ac-wording"
          action={
            <Button
              variant="ghost"
              size="sm"
              disabled={draft === DEFAULT_NUDGE_TEMPLATE}
              onClick={() => {
                setDraft(DEFAULT_NUDGE_TEMPLATE);
                setTemplateError(null);
                void save(
                  (s) => ({ ...s, nudge: { ...s.nudge, template: DEFAULT_NUDGE_TEMPLATE } }),
                  'The wording is back to the original.',
                );
              }}
              data-testid="ac-reset"
            >
              Reset
            </Button>
          }
        >
          <div id="nudge-wording" className="scroll-mt-24" />
          <Textarea
            id={BOX_ID}
            aria-label="Follow-up wording"
            value={draft}
            maxLength={480}
            invalid={!verdict.ok || !!templateError}
            onChange={(e) => {
              setDraft(e.target.value);
              setTemplateError(null);
            }}
            onBlur={() => void saveWording()}
            className="mt-3 min-h-[92px] rounded-[10px] px-[11px] py-[9px] text-[13.5px] leading-[1.65] max-md:min-h-[128px]"
            data-testid="ac-template"
          />
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-text-3">Insert:</span>
            {INSERTS.map(([name, label]) => (
              <button
                key={name}
                type="button"
                // Keeps the cursor in the box, so the slot lands where it was.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => insert(name)}
                className="inline-flex h-[26px] items-center rounded-full border border-border-strong bg-card px-[9px] text-xs font-medium text-text-2 hover:bg-card-2"
                data-testid={`ac-insert-${name}`}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="mt-3.5 flex flex-col gap-1.5">
            <span className="text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3">
              Preview for {NUDGE_SAMPLE.firstName}
            </span>
            <div className="flex flex-col rounded-xl border border-border bg-card-2 px-4 py-3.5">
              {preview ? (
                <div
                  className="max-w-[92%] self-end rounded-2xl rounded-br-[5px] bg-accent px-[13px] py-2.5 text-sm leading-[1.45] text-white [overflow-wrap:anywhere]"
                  data-testid="ac-preview"
                >
                  {preview}
                </div>
              ) : (
                <span className="text-[13px] text-text-3" data-testid="ac-preview">
                  Nothing to send yet.
                </span>
              )}
            </div>
          </div>
          <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1.5" data-testid="ac-checks">
            <Check1 ok={!has('money')} testId="ac-check-money">
              No prices or amounts
            </Check1>
            <Check1 ok={!has('link')} testId="ac-check-link">
              No links
            </Check1>
            <Check1 ok={!has('length') && !has('empty')} testId="ac-check-length">
              {segments.units} characters · {segments.segments || 1}{' '}
              {segments.segments > 1 ? 'texts' : 'text'}
            </Check1>
          </div>
          {verdict.problems.length || templateError ? (
            <ul
              role="alert"
              className="mt-2 flex flex-col gap-1 text-[12.5px] text-warning-text"
              data-testid="ac-problems"
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
            {nudgesOn ? (
              <>
                <Badge variant="ok" data-testid="ac-nudge-on">
                  On
                </Badge>
                <span className="text-xs text-text-3">
                  {turnedOnNow
                    ? `Turned on by ${senderName} just now. The first ones go after the ${AUTO_CANCEL_WINDOW_MINUTES}-minute wait.`
                    : `Each follow-up waits ${AUTO_CANCEL_WINDOW_MINUTES} minutes, so you can cancel it on Home.`}
                </span>
              </>
            ) : owner ? (
              <>
                <Button
                  onClick={() => void lookGood()}
                  loading={turningOn}
                  disabled={!verdict.ok}
                  data-testid="ac-look-good"
                >
                  Looks good, turn on
                </Button>
                <span className="text-xs text-text-3">
                  Turns on follow-ups for all of {short}. Only owners see this button.
                </span>
              </>
            ) : (
              <span className="text-xs text-text-3" data-testid="ac-owner-only">
                {reviewed
                  ? 'Follow-ups are off. Turn them on above.'
                  : 'An owner turns follow-ups on after reading the wording.'}
              </span>
            )}
          </div>
        </Section>

        <Section
          title="Reply C to confirm"
          description="The day-before reminder text ends with “Reply C to confirm.” While we’re waiting on an answer, YES confirms too."
          testId="ac-reply-c"
          action={
            <Switch
              checked={replyC}
              label="Reply C to confirm"
              onChange={(on) =>
                void save(
                  (s) => ({ ...s, replyToConfirm: on }),
                  on
                    ? 'Reminders end with “Reply C to confirm.” again.'
                    : 'Reminders won’t ask for a C. The Confirm button stays.',
                )
              }
              testId="ac-replyc-switch"
            />
          }
        >
          <div className="mt-3 flex flex-col rounded-xl border border-border bg-card-2 px-4 py-3.5">
            <div
              className="max-w-[92%] self-end rounded-2xl rounded-br-[5px] bg-accent px-[13px] py-2.5 text-sm leading-[1.45] text-white [overflow-wrap:anywhere]"
              data-testid="ac-replyc-preview"
            >
              Reminder from {businessName}: your AC tune-up is tomorrow
              {now === null ? '' : `, ${tomorrowLabel(now)}`} at 10:00 AM. {senderName} is coming to
              2210 Oak St.{replyC ? ' Reply C to confirm.' : ''}
            </div>
          </div>
          <p className="mt-1.5 text-[12.5px] text-text-3">
            Email reminders get a Confirm button instead.
          </p>
        </Section>
      </div>
    </div>
  );
}
