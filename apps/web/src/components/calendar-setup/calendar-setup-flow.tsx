'use client';
/**
 * The guided calendar setup on the web (the owner, 22 Nov 2026, picks C1 a to C4 b): New calendar in Settings →
 * Calendars opens it. Seven questions on a page of their own (what customers book, who does the work, what it is and
 * how long, when, where, what customers hear, and paying), then Check it over, where Make this calendar makes it
 * (calendar_setup.save). Every answer is saved as it's given (guided_setup.save_draft), so leaving and coming back
 * opens on the same question with the same answers. Start from scratch and the skip link open every setting instead.
 *
 * Which questions a kind asks, what is wrong with an answer, the lines beside the questions and the settings the
 * answers become are core's (guided-setup/calendar.ts), shared with the phone.
 */
import {
  CALENDAR_SETUP_CHANGE_HOURS,
  CALENDAR_SETUP_DAYS_AHEAD,
  CALENDAR_SETUP_DEPOSIT_PERCENTS,
  CALENDAR_SETUP_FIRST_KINDS,
  CALENDAR_SETUP_GAPS,
  CALENDAR_SETUP_LENGTHS,
  CALENDAR_SETUP_MAX_ASK,
  CALENDAR_SETUP_MAX_DATES,
  CALENDAR_SETUP_MAX_REMINDERS,
  CALENDAR_SETUP_MORE_KINDS,
  CALENDAR_SETUP_NOTICE,
  CALENDAR_SETUP_REMIND_BEFORE,
  CALENDAR_SETUP_TRAVEL,
  CALENDAR_SETUP_WORDS as W,
  calendarSetupAnswersOf,
  calendarSetupChangeLabel,
  calendarSetupChecks,
  calendarSetupDaysAheadLabel,
  calendarSetupGapLabel,
  calendarSetupGoesOut,
  calendarSetupKind,
  calendarSetupLength,
  calendarSetupLines,
  calendarSetupNoticeLabel,
  calendarSetupPersonHours,
  calendarSetupProblems,
  calendarSetupQuestions,
  calendarSetupReminderLabel,
  calendarSetupStart,
  calendarSetupWhat,
  formatClock,
  GUIDED_SETUP_WORDS as G,
  guidedSetupSavedWhen,
  money,
  parseMoney,
  type CalendarSetupAnswers,
  type CalendarSetupContext,
  type CalendarSetupKind,
  type CalendarSetupQuestion,
  type CalendarSetupScreen,
  type CalendarSetupService,
  type LocationKind,
  type Reminder,
} from '@hfos/core';
import {
  CalendarCheck,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  Clock,
  Code2,
  Copy,
  Plus,
  Trash2,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { Callout } from '@/components/crm/chips';
import { CalendarEmbed } from '@/components/calendars/embed-dialog';
import { WeeklyHoursEditor } from '@/components/calendars/weekly-hours';
import {
  ChoiceTile,
  Choices,
  GuidedCard,
  GuidedFooter,
  GuidedNote,
  GuidedPage,
  useGuidedDraft,
  WelcomeBack,
  type GuidedStep,
} from '@/components/guided-setup/frame';
import { Button, ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { copyText } from '@/components/ui/copy-field';
import { FieldError, Label } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { CalendarDetail } from '@/lib/api/types';
import { usePublicOrigin } from '@/lib/use-origin';
import { cn } from '@/lib/utils';

const PLACES: readonly LocationKind[] = [
  'business',
  'customer_address',
  'phone',
  'virtual',
  'meetup',
];
const DAY_BEFORE_TIMES = ['08:00', '10:00', '12:00', '14:00', '16:00', '18:00', '20:00'];

export function CalendarSetupFlow({
  workspaceId,
  email,
  firstName,
  ctx,
  draft,
}: {
  workspaceId: string;
  /** Who's signed in, under the card. */
  email: string;
  firstName: string | null;
  ctx: CalendarSetupContext;
  /** The answers as they were left (guided_setup.get_draft). */
  draft: { readonly answers: Record<string, unknown> | null; readonly savedAt: string | null };
}) {
  const router = useRouter();
  const calendars = `/app/w/${workspaceId}/settings/calendars`;
  const [first] = useState(() => {
    const kind = (draft.answers?.['kind'] as CalendarSetupKind | null | undefined) ?? null;
    const start = calendarSetupStart(kind, ctx);
    const kept = draft.answers ? calendarSetupAnswersOf(draft.answers, start, ctx) : null;
    return { answers: kept ?? start, kept: !!kept };
  });
  const [answers, setAnswers] = useState<CalendarSetupAnswers>(first.answers);
  const questions = calendarSetupQuestions(answers);
  const [screen, setScreen] = useState<CalendarSetupScreen>(() => {
    const at = first.kept ? (draft.answers?.['at'] as CalendarSetupScreen | undefined) : null;
    const asked = calendarSetupQuestions(first.answers);
    return at === 'review' || (at && asked.includes(at)) ? at : 'kind';
  });
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [needsAccount, setNeedsAccount] = useState(false);
  const [busy, setBusy] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [done, setDone] = useState(false);
  /** Check it over's Change: Next goes straight back there, not through every question again. */
  const [returnTo, setReturnTo] = useState<CalendarSetupScreen | null>(null);
  const [welcome, setWelcome] = useState(
    () => first.kept && !!draft.savedAt && Date.now() - Date.parse(draft.savedAt) > 10 * 60_000,
  );
  const [startingOver, setStartingOver] = useState(false);
  const top = useRef<HTMLDivElement>(null);

  const saving = useGuidedDraft(workspaceId, 'calendar', done ? null : { ...answers, at: screen }, {
    hadDraft: first.kept,
  });

  const set = (patch: Partial<CalendarSetupAnswers>) => {
    setAnswers((now) => ({ ...now, ...patch }));
    setProblems({});
    setError(null);
    setNeedsAccount(false);
  };

  /** A new kind starts its own way, keeping what doesn't depend on the kind (services, messages, paying). */
  const pickKind = (kind: CalendarSetupKind) => {
    setAnswers((now) => {
      const start = calendarSetupStart(kind, ctx);
      const before = now.kind ? calendarSetupKind(now.kind).name : '';
      const typed = now.name.trim() && now.name !== before;
      if (!now.kind) return { ...start, name: typed ? now.name : start.name };
      return {
        ...now,
        kind,
        name: typed ? now.name : start.name,
        people: start.people,
        assignment: start.assignment,
        what: start.what,
        seats: start.seats,
        places: start.places,
        hours: start.hours,
        dates: start.dates,
      };
    });
    setProblems({});
    setError(null);
  };

  const go = (to: CalendarSetupScreen) => {
    setScreen(to);
    setProblems({});
    setError(null);
    setNeedsAccount(false);
    setWelcome(false);
    top.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const i = screen === 'review' ? questions.length : Math.max(0, questions.indexOf(screen));
  const shape = answers.kind ? calendarSetupKind(answers.kind) : null;

  const problemsOn = (q: CalendarSetupQuestion) =>
    calendarSetupProblems(answers, ctx).filter((p) => p.screen === q);

  function next() {
    if (screen === 'review') return;
    if (screen === 'kind' && answers.kind === 'scratch') return void finish();
    const found = problemsOn(screen);
    if (found.length) {
      setProblems(Object.fromEntries(found.map((p) => [p.field, p.message])));
      setNeedsAccount(found.some((p) => p.rule === 'needs_payment_account'));
      return;
    }
    const after = questions[i + 1];
    if (returnTo || !after) {
      setReturnTo(null);
      go('review');
      return;
    }
    go(after);
  }

  const back = () => {
    setReturnTo(null);
    const before = screen === 'review' ? questions[questions.length - 1] : questions[i - 1];
    if (before) go(before);
  };

  async function finish() {
    const all = calendarSetupProblems(answers, ctx);
    const wrong = all[0];
    if (wrong) {
      go(wrong.screen);
      setProblems(
        Object.fromEntries(
          all.filter((p) => p.screen === wrong.screen).map((p) => [p.field, p.message]),
        ),
      );
      setNeedsAccount(wrong.rule === 'needs_payment_account');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await saving.flush();
      const out = unwrap(
        await apiBrowser().POST('/v1/commands/calendar_setup.save', {
          body: { workspaceId, answers },
        }),
      );
      setDone(true);
      await saving.clear();
      if (answers.kind === 'scratch') {
        router.push(`${calendars}/${out.calendarId}/all`);
        return;
      }
      const missed = out.dates.filter((d) => !d.published).length;
      router.push(
        `/onboarding/${workspaceId}/calendar?made=${out.calendarId}${answers.open ? '&open=1' : ''}${missed ? `&missed=${missed}` : ''}`,
      );
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  async function leave() {
    setLeaving(true);
    await saving.flush();
    router.push(calendars);
    router.refresh();
  }

  async function startOver() {
    await saving.clear();
    saving.resume();
    setAnswers(calendarSetupStart(null, ctx));
    setStartingOver(false);
    setReturnTo(null);
    go('kind');
  }

  const page = (children: ReactNode) => (
    <GuidedPage
      business={{ name: ctx.businessName, home: `/app/w/${workspaceId}` }}
      email={email}
      settingUp={W.settingUp(ctx.businessName)}
      saved={saving.state}
      onLeave={() => void leave()}
      leaving={leaving}
    >
      <div ref={top} className="w-full scroll-mt-20">
        {children}
      </div>
    </GuidedPage>
  );

  const lines = calendarSetupLines(answers, ctx);
  const steps: GuidedStep[] = lines.map((l, at) => ({
    key: l.key,
    label: l.label,
    value: l.value,
    state: at < i ? 'done' : at === i ? 'now' : 'todo',
  }));
  const when = draft.savedAt ? guidedSetupSavedWhen(draft.savedAt, new Date()) : null;
  const banner =
    welcome && when ? (
      startingOver ? (
        <div
          className="flex flex-wrap items-center justify-between gap-2 rounded-menu bg-card-2 px-3.5 py-3 text-[13.5px]"
          role="alertdialog"
          aria-label={G.startOver}
        >
          <span>{G.startOverConfirm}</span>
          <span className="flex gap-2">
            <Button size="sm" variant="secondary" onClick={() => setStartingOver(false)}>
              Keep my answers
            </Button>
            <Button size="sm" onClick={() => void startOver()} data-testid="guided-start-over-yes">
              {G.startOver}
            </Button>
          </span>
        </div>
      ) : (
        <WelcomeBack
          line={`${G.welcomeBack(firstName, when)}${i > 0 && screen !== 'review' ? ` ${G.stoppedAt(i + 1)}` : ''}`}
          onStartOver={() => setStartingOver(true)}
        />
      )
    ) : null;

  const many = questions.length > 1;
  const position = many ? G.question(i + 1, questions.length) : W.pageTitle;
  const footer = (nextLabel?: string) => (
    <GuidedFooter
      onBack={i > 0 ? back : undefined}
      onNext={next}
      busy={busy}
      error={needsAccount ? null : (error ?? null)}
      testId="calendar-setup"
      nextLabel={
        nextLabel ??
        (returnTo === 'review' || (!returnTo && i === questions.length - 1)
          ? G.checkItOver
          : G.next)
      }
    />
  );
  const card = (
    q: CalendarSetupQuestion,
    title: string,
    hint: string,
    children: ReactNode,
    opts: { nextLabel?: string } = {},
  ) =>
    page(
      <GuidedCard
        screen={q}
        testId="calendar-setup"
        kicker={position}
        title={title}
        hint={hint}
        banner={banner}
        steps={steps}
        stepsTitle={W.soFar}
        footer={footer(opts.nextLabel)}
      >
        {children}
      </GuidedCard>,
    );

  if (screen === 'review') {
    const checks = calendarSetupChecks(answers, ctx);
    return page(
      <GuidedCard
        screen="review"
        testId="calendar-setup"
        kicker={G.checkKicker}
        title={W.review.title}
        hint={`${W.review.hint} ${G.answersKept}`}
        banner={banner}
        aside={
          <>
            <div className="text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3">
              {W.review.next}
            </div>
            <ol className="flex flex-col gap-3">
              {W.review.nextLines.map((line, at) => (
                <li key={line} className="flex items-start gap-2.5">
                  <span
                    aria-hidden
                    className="mt-px inline-flex h-5 w-5 flex-none items-center justify-center rounded-full border border-border-strong text-[11px] font-semibold text-text-2"
                  >
                    {at + 1}
                  </span>
                  <span className="text-[13px] text-text-2">{line}</span>
                </li>
              ))}
            </ol>
          </>
        }
        footer={
          <GuidedFooter
            onBack={back}
            onNext={() => void finish()}
            busy={busy}
            error={error}
            nextIcon={false}
            nextLabel={W.review.make}
            testId="calendar-setup"
          />
        }
      >
        <div className="overflow-hidden rounded-menu border border-border">
          {lines.map((l) => (
            <div
              key={l.key}
              className="flex items-start justify-between gap-4 border-b border-border px-4 py-3 last:border-b-0"
              data-testid={`calendar-review-${l.key}`}
            >
              <div className="flex min-w-0 flex-col gap-0.5">
                <div className="text-xs font-medium uppercase tracking-[0.04em] text-text-3">
                  {l.label}
                </div>
                <div className="break-words font-semibold">{l.value ?? '—'}</div>
                {l.detail ? <div className="text-[13px] text-text-2">{l.detail}</div> : null}
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setReturnTo('review');
                  go(l.key);
                }}
                data-testid={`calendar-review-change-${l.key}`}
              >
                {G.change}
              </Button>
            </div>
          ))}
        </div>
        {checks.length ? (
          <div className="flex flex-col gap-2" data-testid="calendar-review-checks">
            <div className="text-[13.5px] font-semibold">{W.review.toCheck(checks.length)}</div>
            {checks.map((c) => (
              <Callout
                key={c.key}
                tone="warning"
                icon={CircleAlert}
                action={
                  c.userId && answers.people.length > 1 ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => set({ people: answers.people.filter((u) => u !== c.userId) })}
                    >
                      {W.review.takeOff(
                        ctx.people.find((p) => p.userId === c.userId)?.me
                          ? 'yourself'
                          : (ctx.people.find((p) => p.userId === c.userId)?.name.split(/\s+/)[0] ??
                              'them'),
                      )}
                    </Button>
                  ) : undefined
                }
              >
                <div className="font-semibold">{c.title}</div>
                <div>{c.detail}</div>
              </Callout>
            ))}
          </div>
        ) : null}
        <div className="flex flex-col gap-1">
          <Checkbox
            label={W.review.open}
            checked={answers.open}
            onChange={(e) => set({ open: e.target.checked })}
            data-testid="calendar-review-open"
          />
          <span className="pl-[28px] text-[13px] text-text-2">{W.review.openHint}</span>
        </div>
      </GuidedCard>,
    );
  }

  const p = problems;
  switch (screen) {
    case 'kind':
      return card(
        'kind',
        W.kind.title,
        W.kind.hint,
        <KindQuestion
          answers={answers}
          pickKind={pickKind}
          set={set}
          problems={p}
          skipHref={`${calendars}/new`}
        />,
        answers.kind === 'scratch' ? { nextLabel: W.kind.scratchNext } : {},
      );
    case 'who':
      return card(
        'who',
        W.who.title[shape?.who ?? 'pick'],
        W.who.hint[shape?.who ?? 'pick'],
        <WhoQuestion
          answers={answers}
          set={set}
          problems={p}
          ctx={ctx}
          workspaceId={workspaceId}
        />,
      );
    case 'what': {
      const what = calendarSetupWhat(answers);
      return card(
        'what',
        W.what[what].title,
        W.what[what].hint,
        <WhatQuestion answers={answers} set={set} problems={p} ctx={ctx} />,
      );
    }
    case 'when':
      return card(
        'when',
        shape?.when === 'dates' ? W.when.datesTitle : W.when.title,
        shape?.when === 'dates' ? W.when.datesHint : '',
        <WhenQuestion answers={answers} set={set} problems={p} />,
      );
    case 'where':
      return card(
        'where',
        shape?.where === 'visit' ? W.where.visitTitle : W.where.title,
        shape?.where === 'visit' ? W.where.visitHint : W.where.hint,
        <WhereQuestion
          answers={answers}
          set={set}
          problems={p}
          ctx={ctx}
          workspaceId={workspaceId}
        />,
      );
    case 'remind':
      return card(
        'remind',
        W.remind.title,
        W.remind.hint,
        <RemindQuestion answers={answers} set={set} problems={p} ctx={ctx} />,
      );
    case 'pay':
      return card(
        'pay',
        W.pay.title,
        '',
        <PayQuestion
          answers={answers}
          set={set}
          problems={p}
          ctx={ctx}
          workspaceId={workspaceId}
          needsAccount={needsAccount}
        />,
      );
  }
}

// ---- The questions ----

interface Q {
  answers: CalendarSetupAnswers;
  set: (patch: Partial<CalendarSetupAnswers>) => void;
  problems: Record<string, string>;
}

function Problem({ children }: { children: ReactNode }) {
  return <FieldError>{children}</FieldError>;
}

function KindQuestion({
  answers,
  pickKind,
  set,
  problems,
  skipHref,
}: Omit<Q, 'set'> & {
  pickKind: (k: CalendarSetupKind) => void;
  set: Q['set'];
  skipHref: string;
}) {
  const [more, setMore] = useState(
    () => !!answers.kind && CALENDAR_SETUP_MORE_KINDS.includes(answers.kind),
  );
  const kinds = more
    ? [...CALENDAR_SETUP_FIRST_KINDS, ...CALENDAR_SETUP_MORE_KINDS]
    : CALENDAR_SETUP_FIRST_KINDS;
  return (
    <>
      <Choices label={W.kind.title}>
        {kinds.map((k) => (
          <ChoiceTile
            key={k}
            selected={answers.kind === k}
            onSelect={() => pickKind(k)}
            title={W.kinds[k].title}
            hint={W.kinds[k].hint}
            testId={`calendar-kind-${k}`}
          />
        ))}
      </Choices>
      <Button
        variant="secondary"
        onClick={() => setMore((m) => !m)}
        className="self-start"
        data-testid="calendar-kind-more"
      >
        {more ? W.kind.fewer : W.kind.more}
        {more ? (
          <ChevronUp className="h-4 w-4" strokeWidth={1.75} />
        ) : (
          <ChevronDown className="h-4 w-4" strokeWidth={1.75} />
        )}
      </Button>
      {problems['kind'] ? <Problem>{problems['kind']}</Problem> : null}
      {answers.kind ? (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="calendar-name">{W.kind.name}</Label>
          <Input
            id="calendar-name"
            value={answers.name}
            maxLength={120}
            invalid={!!problems['name']}
            onChange={(e) => set({ name: e.target.value })}
            data-testid="calendar-name"
          />
          {problems['name'] ? (
            <Problem>{problems['name']}</Problem>
          ) : (
            <span className="text-[13px] text-text-2">{W.kind.nameHint}</span>
          )}
        </div>
      ) : null}
      <Link
        href={skipHref}
        className="self-start text-[13.5px] font-medium text-accent-text hover:underline"
        data-testid="calendar-setup-skip"
      >
        {W.skip}
      </Link>
    </>
  );
}

function WhoQuestion({
  answers,
  set,
  problems,
  ctx,
  workspaceId,
}: Q & { ctx: CalendarSetupContext; workspaceId: string }) {
  const shape = calendarSetupKind(answers.kind!);
  const toggle = (userId: string, on: boolean) =>
    set({
      people: on
        ? ctx.people
            .filter((p) => p.userId === userId || answers.people.includes(p.userId))
            .map((p) => p.userId)
        : answers.people.filter((u) => u !== userId),
    });
  return (
    <>
      {ctx.people.length ? (
        <div
          className="overflow-hidden rounded-menu border border-border"
          data-testid="calendar-who"
        >
          {ctx.people.map((person) => (
            <label
              key={person.userId}
              className="flex cursor-pointer items-start gap-3 border-b border-border px-3.5 py-3 last:border-b-0 hover:bg-card-2"
            >
              <input
                type="checkbox"
                className="mt-0.5 h-[18px] w-[18px] flex-none cursor-pointer rounded-[5px] border border-border-strong accent-accent"
                checked={answers.people.includes(person.userId)}
                onChange={(e) => toggle(person.userId, e.target.checked)}
                data-testid={`calendar-who-${person.userId}`}
              />
              <span className="flex min-w-0 flex-col">
                <span className="font-medium">
                  {person.name}
                  {person.me ? <span className="text-text-3"> · {W.who.you}</span> : null}
                </span>
                <span className="text-[13px] text-text-2">{calendarSetupPersonHours(person)}</span>
              </span>
            </label>
          ))}
        </div>
      ) : null}
      {problems['people'] ? <Problem>{problems['people']}</Problem> : null}
      <Link
        href={`/app/w/${workspaceId}/members`}
        className="inline-flex items-center gap-1.5 self-start text-[13.5px] font-medium text-accent-text hover:underline"
      >
        <Plus className="h-4 w-4" strokeWidth={1.75} />
        {W.who.invite}
      </Link>
      {shape.who === 'pick' && answers.people.length > 1 ? (
        <div className="flex flex-col gap-2.5">
          <div className="text-[14.5px] font-semibold">{W.who.assignTitle}</div>
          <Choices label={W.who.assignTitle}>
            {(['first_available', 'round_robin', 'customer_choice', 'collective'] as const).map(
              (k) => (
                <ChoiceTile
                  key={k}
                  selected={answers.assignment === k}
                  onSelect={() => set({ assignment: k })}
                  title={W.assignment[k].title}
                  hint={W.assignment[k].hint}
                  best={k === 'first_available' ? W.best : undefined}
                  testId={`calendar-assign-${k}`}
                />
              ),
            )}
          </Choices>
        </div>
      ) : null}
    </>
  );
}

function lengthOptions(current: number) {
  const list = [...new Set([...CALENDAR_SETUP_LENGTHS, current])].sort((a, b) => a - b);
  return list.map((m) => (
    <option key={m} value={m}>
      {calendarSetupLength(m)}
    </option>
  ));
}

/** A price typed in dollars, kept as cents once it reads as one. */
function PriceInput({
  cents,
  onChange,
  id,
  invalid,
  testId,
}: {
  cents: number | null;
  onChange: (cents: number | null) => void;
  id: string;
  invalid?: boolean;
  testId?: string;
}) {
  const shown = (c: number | null) => (c === null ? '' : money(c).replace(/^\$/, ''));
  const [text, setText] = useState(shown(cents));
  return (
    <div className="relative">
      <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-sm text-text-3">
        $
      </span>
      <Input
        id={id}
        inputMode="decimal"
        className="pl-6"
        value={text}
        invalid={invalid}
        placeholder="0"
        onChange={(e) => {
          setText(e.target.value);
          const t = e.target.value.trim();
          onChange(t ? parseMoney(t) : null);
        }}
        onBlur={() => setText(shown(cents))}
        data-testid={testId}
      />
    </div>
  );
}

function WhatQuestion({ answers, set, problems, ctx }: Q & { ctx: CalendarSetupContext }) {
  const what = calendarSetupWhat(answers);
  const shape = calendarSetupKind(answers.kind!);
  const switchable = shape.what === 'services' || shape.what === 'length';
  const picked = ctx.people.filter((p) => answers.people.includes(p.userId));
  const setRow = (key: string, patch: Partial<CalendarSetupService>) =>
    set({ services: answers.services.map((s) => (s.key === key ? { ...s, ...patch } : s)) });

  if (what === 'services')
    return (
      <>
        <div className="flex flex-col gap-2.5" data-testid="calendar-services">
          {answers.services.map((s, at) => {
            const known = s.id ? ctx.services.find((c) => c.id === s.id) : null;
            const several = !!known && known.lengths.length > 1;
            const staff = s.userIds.length ? s.userIds : picked.map((x) => x.userId);
            return (
              <div
                key={s.key}
                className={cn(
                  'flex flex-col gap-3 rounded-menu border p-3.5',
                  s.on ? 'border-accent bg-accent-soft/40' : 'border-border bg-card',
                )}
                data-testid={`calendar-service-${at}`}
              >
                <div className="flex items-center gap-3">
                  <input
                    type="checkbox"
                    aria-label={s.name || W.what.newName}
                    className="h-[18px] w-[18px] flex-none cursor-pointer rounded-[5px] border border-border-strong accent-accent"
                    checked={s.on}
                    onChange={(e) => setRow(s.key, { on: e.target.checked })}
                    data-testid={`calendar-service-on-${at}`}
                  />
                  {s.id ? (
                    <span className="flex-1 font-semibold">{s.name}</span>
                  ) : (
                    <Input
                      aria-label={W.what.newName}
                      placeholder={W.what.newName}
                      value={s.name}
                      maxLength={120}
                      invalid={!!problems[`services.${at}.name`]}
                      onChange={(e) => setRow(s.key, { name: e.target.value })}
                      className="flex-1"
                      data-testid={`calendar-service-name-${at}`}
                    />
                  )}
                  {!s.id ? (
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={W.what.remove}
                      onClick={() =>
                        set({ services: answers.services.filter((x) => x.key !== s.key) })
                      }
                    >
                      <Trash2 className="h-4 w-4" strokeWidth={1.5} />
                    </Button>
                  ) : null}
                </div>
                {problems[`services.${at}.name`] ? (
                  <Problem>{problems[`services.${at}.name`]}</Problem>
                ) : null}
                {s.on ? (
                  <div className="grid grid-cols-1 gap-3 pl-[30px] sm:grid-cols-2">
                    <div className="flex flex-col gap-1">
                      <Label htmlFor={`svc-len-${at}`}>{W.what.takes}</Label>
                      {several ? (
                        <span className="text-[13px] text-text-2">
                          {W.what.severalLengths(
                            known!.lengths.map(calendarSetupLength).join(', '),
                          )}
                        </span>
                      ) : (
                        <Select
                          id={`svc-len-${at}`}
                          value={s.minutes}
                          onChange={(e) => setRow(s.key, { minutes: Number(e.target.value) })}
                          data-testid={`calendar-service-minutes-${at}`}
                        >
                          {lengthOptions(s.minutes)}
                        </Select>
                      )}
                    </div>
                    <div className="flex flex-col gap-1">
                      <Label htmlFor={`svc-price-${at}`}>{W.what.price}</Label>
                      <PriceInput
                        id={`svc-price-${at}`}
                        cents={s.priceCents}
                        onChange={(priceCents) => setRow(s.key, { priceCents })}
                        testId={`calendar-service-price-${at}`}
                      />
                    </div>
                    {picked.length > 1 ? (
                      <div className="flex flex-col gap-1.5 sm:col-span-2">
                        <span className="text-[13px] font-medium">{W.what.whoDoes}</span>
                        <div className="flex flex-wrap gap-x-4 gap-y-2">
                          {picked.map((person) => (
                            <Checkbox
                              key={person.userId}
                              label={person.me ? W.who.you : person.name.split(/\s+/)[0]!}
                              checked={staff.includes(person.userId)}
                              onChange={(e) => {
                                const nextStaff = e.target.checked
                                  ? [...staff, person.userId]
                                  : staff.filter((u) => u !== person.userId);
                                // Everyone ticked is the same as everyone: kept as no list.
                                setRow(s.key, {
                                  userIds: nextStaff.length === picked.length ? [] : nextStaff,
                                });
                              }}
                            />
                          ))}
                        </div>
                        {problems[`services.${at}.userIds`] ? (
                          <Problem>{problems[`services.${at}.userIds`]}</Problem>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
        {problems['services'] ? <Problem>{problems['services']}</Problem> : null}
        <Button
          variant="secondary"
          className="self-start"
          onClick={() =>
            set({
              services: [
                ...answers.services,
                {
                  key: `new-${Date.now().toString(36)}`,
                  id: null,
                  name: '',
                  on: true,
                  minutes: 60,
                  priceCents: null,
                  userIds: [],
                },
              ],
            })
          }
          data-testid="calendar-service-add"
        >
          <Plus className="h-4 w-4" strokeWidth={1.75} />
          {W.what.add}
        </Button>
        <button
          type="button"
          className="self-start text-[13.5px] font-medium text-accent-text hover:underline"
          onClick={() => set({ what: 'length' })}
          data-testid="calendar-what-switch"
        >
          {W.what.toLength}
        </button>
      </>
    );

  if (what === 'resource')
    return (
      <>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="calendar-resource">{W.what.resourcePick}</Label>
          <Select
            id="calendar-resource"
            value={answers.resource.id ?? 'new'}
            onChange={(e) =>
              set({
                resource: {
                  id: e.target.value === 'new' ? null : e.target.value,
                  name: answers.resource.name,
                },
              })
            }
            data-testid="calendar-resource"
          >
            {ctx.resources.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
            <option value="new">{W.what.resourceNew}</option>
          </Select>
        </div>
        {!answers.resource.id ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="calendar-resource-name">{W.what.resourceName}</Label>
            <Input
              id="calendar-resource-name"
              value={answers.resource.name}
              maxLength={120}
              invalid={!!problems['resource']}
              onChange={(e) => set({ resource: { id: null, name: e.target.value } })}
              data-testid="calendar-resource-name"
            />
          </div>
        ) : null}
        {problems['resource'] ? <Problem>{problems['resource']}</Problem> : null}
        <LengthField answers={answers} set={set} />
      </>
    );

  return (
    <>
      <LengthField answers={answers} set={set} />
      {what === 'seats' ? (
        <div className="flex max-w-[240px] flex-col gap-1.5">
          <Label htmlFor="calendar-seats">{W.what.seatsLabel}</Label>
          <Input
            id="calendar-seats"
            type="number"
            min={1}
            max={500}
            value={answers.seats}
            onChange={(e) =>
              set({ seats: Math.min(500, Math.max(1, Math.round(Number(e.target.value) || 1))) })
            }
            data-testid="calendar-seats"
          />
        </div>
      ) : null}
      {switchable ? (
        <button
          type="button"
          className="self-start text-[13.5px] font-medium text-accent-text hover:underline"
          onClick={() => set({ what: 'services' })}
          data-testid="calendar-what-switch"
        >
          {W.what.toServices}
        </button>
      ) : null}
    </>
  );
}

function LengthField({ answers, set }: Pick<Q, 'answers' | 'set'>) {
  return (
    <div className="flex max-w-[240px] flex-col gap-1.5">
      <Label htmlFor="calendar-minutes">{W.what.lengthLabel}</Label>
      <Select
        id="calendar-minutes"
        value={answers.minutes}
        onChange={(e) => set({ minutes: Number(e.target.value) })}
        data-testid="calendar-minutes"
      >
        {lengthOptions(answers.minutes)}
      </Select>
    </div>
  );
}

function WhenQuestion({ answers, set, problems }: Q) {
  const shape = calendarSetupKind(answers.kind!);
  if (shape.when === 'dates') {
    const setDate = (at: number, patch: Partial<{ date: string; time: string }>) =>
      set({ dates: answers.dates.map((d, j) => (j === at ? { ...d, ...patch } : d)) });
    return (
      <>
        <div className="flex flex-col gap-2" data-testid="calendar-dates">
          {answers.dates.map((d, at) => (
            <div key={at} className="flex flex-col gap-1">
              <div className="flex flex-wrap items-end gap-2">
                <div className="flex flex-col gap-1">
                  <Label htmlFor={`date-${at}`}>{W.when.date}</Label>
                  <Input
                    id={`date-${at}`}
                    type="date"
                    value={d.date}
                    invalid={!!problems[`dates.${at}`]}
                    onChange={(e) => setDate(at, { date: e.target.value })}
                    data-testid={`calendar-date-${at}`}
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <Label htmlFor={`time-${at}`}>{W.when.time}</Label>
                  <Input
                    id={`time-${at}`}
                    type="time"
                    value={d.time}
                    invalid={!!problems[`dates.${at}`]}
                    onChange={(e) => setDate(at, { time: e.target.value })}
                    data-testid={`calendar-time-${at}`}
                  />
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Remove this date"
                  onClick={() => set({ dates: answers.dates.filter((_, j) => j !== at) })}
                >
                  <Trash2 className="h-4 w-4" strokeWidth={1.5} />
                </Button>
              </div>
              {problems[`dates.${at}`] ? <Problem>{problems[`dates.${at}`]}</Problem> : null}
            </div>
          ))}
        </div>
        {answers.dates.length < CALENDAR_SETUP_MAX_DATES ? (
          <Button
            variant="secondary"
            className="self-start"
            onClick={() => set({ dates: [...answers.dates, { date: '', time: '18:00' }] })}
            data-testid="calendar-date-add"
          >
            <Plus className="h-4 w-4" strokeWidth={1.75} />
            {W.when.addDate}
          </Button>
        ) : null}
        <LengthNote answers={answers} />
      </>
    );
  }
  const own = answers.hours === 'own' || shape.who === null;
  return (
    <>
      {shape.who ? (
        <Choices label={W.when.title}>
          <ChoiceTile
            selected={answers.hours === 'people'}
            onSelect={() => set({ hours: 'people' })}
            title={W.when.people.title}
            hint={W.when.people.hint}
            best={W.best}
            testId="calendar-hours-people"
          />
          <ChoiceTile
            selected={answers.hours === 'own'}
            onSelect={() => set({ hours: 'own' })}
            title={W.when.own.title}
            hint={W.when.own.hint}
            testId="calendar-hours-own"
          />
        </Choices>
      ) : (
        <div className="text-[14.5px] font-semibold">{W.when.roomHours}</div>
      )}
      {own ? (
        <div className="rounded-menu border border-border p-3">
          <WeeklyHoursEditor
            value={answers.ownHours}
            onChange={(ownHours) => set({ ownHours })}
            idPrefix="calendar-own-hours"
          />
        </div>
      ) : null}
      {problems['ownHours'] || Object.keys(problems).some((k) => k.startsWith('ownHours.')) ? (
        <Problem>
          {problems['ownHours'] ??
            Object.entries(problems).find(([k]) => k.startsWith('ownHours.'))?.[1]}
        </Problem>
      ) : null}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <PickField
          id="calendar-notice"
          label={W.when.notice}
          value={answers.noticeMinutes}
          options={CALENDAR_SETUP_NOTICE}
          labelOf={calendarSetupNoticeLabel}
          onChange={(noticeMinutes) => set({ noticeMinutes })}
        />
        <PickField
          id="calendar-days-ahead"
          label={W.when.daysAhead}
          value={answers.daysAhead}
          options={CALENDAR_SETUP_DAYS_AHEAD}
          labelOf={calendarSetupDaysAheadLabel}
          onChange={(daysAhead) => set({ daysAhead })}
        />
        <PickField
          id="calendar-gap"
          label={W.when.gap}
          value={answers.gapMinutes}
          options={CALENDAR_SETUP_GAPS}
          labelOf={calendarSetupGapLabel}
          onChange={(gapMinutes) => set({ gapMinutes })}
        />
      </div>
      {shape.who ? <GuidedNote>{W.when.connectNote}</GuidedNote> : null}
    </>
  );
}

/** An event's length, asked in question 3, said again beside its dates. */
function LengthNote({ answers }: { answers: CalendarSetupAnswers }) {
  return (
    <GuidedNote>
      <span className="inline-flex items-center gap-1.5">
        <Clock className="h-3.5 w-3.5" strokeWidth={1.75} />
        Each date runs {calendarSetupLength(answers.minutes)} and has{' '}
        {answers.seats === 1 ? '1 seat' : `${answers.seats} seats`}.
      </span>
    </GuidedNote>
  );
}

function PickField<T extends number>({
  id,
  label,
  value,
  options,
  labelOf,
  onChange,
}: {
  id: string;
  label: string;
  value: T;
  options: readonly T[];
  labelOf: (v: T) => string;
  onChange: (v: T) => void;
}) {
  const list = options.includes(value) ? options : [...options, value].sort((a, b) => a - b);
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Select
        id={id}
        value={value}
        onChange={(e) => onChange(Number(e.target.value) as T)}
        data-testid={id}
      >
        {list.map((o) => (
          <option key={o} value={o}>
            {labelOf(o)}
          </option>
        ))}
      </Select>
    </div>
  );
}

function WhereQuestion({
  answers,
  set,
  problems,
  ctx,
  workspaceId,
}: Q & { ctx: CalendarSetupContext; workspaceId: string }) {
  const shape = calendarSetupKind(answers.kind!);
  const goes = calendarSetupGoesOut(answers);
  const toggle = (kind: LocationKind, on: boolean) =>
    set({
      places: on
        ? PLACES.filter((k) => k === kind || answers.places.includes(k))
        : answers.places.filter((k) => k !== kind),
    });
  return (
    <>
      {shape.where === 'places' ? (
        <div className="flex flex-col gap-2.5" data-testid="calendar-places">
          {PLACES.map((kind) => {
            const on = answers.places.includes(kind);
            return (
              <div
                key={kind}
                className={cn(
                  'rounded-menu border',
                  on ? 'border-accent bg-accent-soft' : 'border-border bg-card',
                )}
              >
                <label className="flex cursor-pointer items-start gap-3 p-3.5">
                  <input
                    type="checkbox"
                    className="mt-0.5 h-[18px] w-[18px] flex-none cursor-pointer rounded-[5px] border border-border-strong accent-accent"
                    checked={on}
                    onChange={(e) => toggle(kind, e.target.checked)}
                    data-testid={`calendar-place-${kind}`}
                  />
                  <span className="flex flex-col">
                    <span className="font-semibold">{W.places[kind].title}</span>
                    <span className="text-[13.5px] text-text-2">{W.places[kind].hint}</span>
                  </span>
                </label>
                {on && kind === 'business' ? (
                  <div className="flex flex-col gap-1.5 px-3.5 pb-3.5 pl-[44px]">
                    <Label htmlFor="calendar-address">{W.where.address}</Label>
                    <Input
                      id="calendar-address"
                      value={answers.address}
                      maxLength={300}
                      invalid={!!problems['address']}
                      onChange={(e) => set({ address: e.target.value })}
                      data-testid="calendar-address"
                    />
                    {problems['address'] ? <Problem>{problems['address']}</Problem> : null}
                  </div>
                ) : null}
                {on && kind === 'virtual' ? (
                  <div className="flex flex-col gap-1.5 px-3.5 pb-3.5 pl-[44px]">
                    <Label htmlFor="calendar-meeting-url">{W.where.meetingUrl}</Label>
                    <Input
                      id="calendar-meeting-url"
                      value={answers.meetingUrl}
                      maxLength={500}
                      placeholder="https://"
                      invalid={!!problems['meetingUrl']}
                      onChange={(e) => set({ meetingUrl: e.target.value })}
                    />
                    {problems['meetingUrl'] ? (
                      <Problem>{problems['meetingUrl']}</Problem>
                    ) : (
                      <span className="text-[13px] text-text-2">{W.where.meetingUrlHint}</span>
                    )}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
      {problems['places'] ? <Problem>{problems['places']}</Problem> : null}
      {goes ? (
        <div className="flex flex-col gap-3">
          <Choices label={W.where.visitTitle}>
            <ChoiceTile
              selected={answers.areas === 'anywhere'}
              onSelect={() => set({ areas: 'anywhere' })}
              title={W.where.anywhere.title}
              hint={W.where.anywhere.hint}
              testId="calendar-areas-anywhere"
            />
            <ChoiceTile
              selected={answers.areas === 'areas'}
              onSelect={() => set({ areas: 'areas' })}
              title={W.where.areas.title}
              hint={W.where.areas.hint}
              testId="calendar-areas-areas"
            >
              {ctx.areas.length ? (
                ctx.areas.map((area) => (
                  <Checkbox
                    key={area.id}
                    label={
                      <span>
                        <span className="font-medium">{area.name}</span>
                        <span className="text-text-2"> · {area.covers}</span>
                      </span>
                    }
                    checked={answers.areaIds.includes(area.id)}
                    onChange={(e) =>
                      set({
                        areaIds: e.target.checked
                          ? [...answers.areaIds, area.id]
                          : answers.areaIds.filter((x) => x !== area.id),
                      })
                    }
                  />
                ))
              ) : (
                <span className="text-[13.5px] text-text-2">{W.where.noAreas}</span>
              )}
              <Link
                href={`/app/w/${workspaceId}/settings/calendars/territories`}
                className="inline-flex items-center gap-1.5 self-start text-[13.5px] font-medium text-accent-text hover:underline"
              >
                <Plus className="h-4 w-4" strokeWidth={1.75} />
                {W.where.addArea}
              </Link>
            </ChoiceTile>
          </Choices>
          {problems['areaIds'] ? <Problem>{problems['areaIds']}</Problem> : null}
          <div className="max-w-[320px]">
            <PickField
              id="calendar-travel"
              label={W.where.travel}
              value={answers.travelMinutes}
              options={CALENDAR_SETUP_TRAVEL}
              labelOf={calendarSetupGapLabel}
              onChange={(travelMinutes) => set({ travelMinutes })}
            />
            <span className="mt-1 block text-[13px] text-text-2">{W.where.travelHint}</span>
          </div>
          <div className="flex flex-col gap-1">
            <Checkbox
              label={W.where.drive}
              checked={answers.drive}
              onChange={(e) => set({ drive: e.target.checked })}
              data-testid="calendar-drive"
            />
            <span className="pl-[28px] text-[13px] text-text-2">{W.where.driveHint}</span>
          </div>
        </div>
      ) : null}
    </>
  );
}

const reminderValue = (r: Reminder) => (r.kind === 'day_before' ? 'day_before' : String(r.minutes));

function RemindQuestion({ answers, set, problems, ctx }: Q & { ctx: CalendarSetupContext }) {
  const setReminder = (at: number, r: Reminder) =>
    set({ reminders: answers.reminders.map((x, j) => (j === at ? r : x)) });
  const setAsk = (at: number, patch: Partial<CalendarSetupAnswers['ask'][number]>) =>
    set({ ask: answers.ask.map((q, j) => (j === at ? { ...q, ...patch } : q)) });
  return (
    <>
      <Checkbox
        label={W.remind.confirm}
        checked={answers.confirm}
        onChange={(e) => set({ confirm: e.target.checked })}
        data-testid="calendar-confirm"
      />
      <div className="flex flex-col gap-2">
        <span className="text-[14px] font-semibold">{W.remind.reminders}</span>
        {answers.reminders.map((r, at) => (
          <div
            key={at}
            className="flex flex-wrap items-center gap-2"
            data-testid={`calendar-reminder-${at}`}
          >
            <Select
              aria-label={calendarSetupReminderLabel(r)}
              value={reminderValue(r)}
              onChange={(e) =>
                setReminder(
                  at,
                  e.target.value === 'day_before'
                    ? { kind: 'day_before', at: '16:00' }
                    : { kind: 'before', minutes: Number(e.target.value) },
                )
              }
              className="w-auto"
            >
              <option value="day_before">The day before</option>
              {[
                ...new Set([
                  ...CALENDAR_SETUP_REMIND_BEFORE,
                  ...(r.kind === 'before' ? [r.minutes] : []),
                ]),
              ]
                .sort((a, b) => a - b)
                .map((m) => (
                  <option key={m} value={m}>
                    {calendarSetupReminderLabel({ kind: 'before', minutes: m })}
                  </option>
                ))}
            </Select>
            {r.kind === 'day_before' ? (
              <Select
                aria-label={W.remind.dayBefore}
                value={r.at}
                onChange={(e) => setReminder(at, { kind: 'day_before', at: e.target.value })}
                className="w-auto"
              >
                {[...new Set([...DAY_BEFORE_TIMES, r.at])].sort().map((t) => (
                  <option key={t} value={t}>
                    at {formatClock(t)}
                  </option>
                ))}
              </Select>
            ) : null}
            <Button
              variant="ghost"
              size="icon"
              aria-label="Remove this reminder"
              onClick={() => set({ reminders: answers.reminders.filter((_, j) => j !== at) })}
            >
              <Trash2 className="h-4 w-4" strokeWidth={1.5} />
            </Button>
          </div>
        ))}
        {answers.reminders.length < CALENDAR_SETUP_MAX_REMINDERS ? (
          <Button
            variant="secondary"
            size="sm"
            className="self-start"
            onClick={() =>
              set({ reminders: [...answers.reminders, { kind: 'before', minutes: 60 }] })
            }
            data-testid="calendar-reminder-add"
          >
            <Plus className="h-4 w-4" strokeWidth={1.75} />
            {W.remind.addReminder}
          </Button>
        ) : null}
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-[14px] font-semibold">{W.remind.sendBy}</span>
        <div className="flex flex-wrap gap-5">
          <Checkbox
            label={W.remind.text}
            checked={answers.byText}
            onChange={(e) => set({ byText: e.target.checked })}
            data-testid="calendar-by-text"
          />
          <Checkbox
            label={W.remind.email}
            checked={answers.byEmail}
            onChange={(e) => set({ byEmail: e.target.checked })}
            data-testid="calendar-by-email"
          />
        </div>
        {problems['channels'] ? <Problem>{problems['channels']}</Problem> : null}
        {answers.byText && !ctx.textingReady ? (
          <Callout tone="warning" icon={CircleAlert}>
            {W.remind.textsWait}
          </Callout>
        ) : null}
      </div>
      <div className="flex max-w-[360px] flex-col gap-1.5">
        <Label htmlFor="calendar-change">{W.remind.change}</Label>
        <Select
          id="calendar-change"
          value={answers.changeHours === null ? 'no' : String(answers.changeHours)}
          onChange={(e) =>
            set({ changeHours: e.target.value === 'no' ? null : Number(e.target.value) })
          }
          data-testid="calendar-change"
        >
          {CALENDAR_SETUP_CHANGE_HOURS.map((h) => (
            <option key={h} value={h}>
              {calendarSetupChangeLabel(h)}
            </option>
          ))}
          <option value="no">{calendarSetupChangeLabel(null)}</option>
        </Select>
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-[14px] font-semibold">{W.remind.ask}</span>
        <span className="-mt-1.5 text-[13px] text-text-2">{W.remind.askHint}</span>
        {answers.ask.map((q, at) => (
          <div key={q.id} className="flex flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <Input
                aria-label="Question"
                value={q.label}
                maxLength={200}
                placeholder={W.remind.askPlaceholder}
                invalid={!!problems[`ask.${at}`]}
                onChange={(e) => setAsk(at, { label: e.target.value })}
                className="min-w-[220px] flex-1"
                data-testid={`calendar-ask-${at}`}
              />
              <Checkbox
                label={W.remind.required}
                checked={q.required}
                onChange={(e) => setAsk(at, { required: e.target.checked })}
              />
              <Button
                variant="ghost"
                size="icon"
                aria-label="Remove this question"
                onClick={() => set({ ask: answers.ask.filter((_, j) => j !== at) })}
              >
                <Trash2 className="h-4 w-4" strokeWidth={1.5} />
              </Button>
            </div>
            {problems[`ask.${at}`] ? <Problem>{problems[`ask.${at}`]}</Problem> : null}
          </div>
        ))}
        {answers.ask.length < CALENDAR_SETUP_MAX_ASK ? (
          <Button
            variant="secondary"
            size="sm"
            className="self-start"
            onClick={() =>
              set({
                ask: [
                  ...answers.ask,
                  { id: `q${Date.now().toString(36)}`, label: '', required: false },
                ],
              })
            }
          >
            <Plus className="h-4 w-4" strokeWidth={1.75} />
            {W.remind.addAsk}
          </Button>
        ) : null}
      </div>
      <Checkbox
        label={W.remind.tellStaff}
        checked={answers.tellStaff}
        onChange={(e) => set({ tellStaff: e.target.checked })}
      />
    </>
  );
}

function depositTermsWords(ctx: CalendarSetupContext): string {
  const d = ctx.businessDeposit;
  return d.kind === 'amount' ? money(d.amountCents ?? 0) : `${(d.percentBp ?? 0) / 100}%`;
}

function PayQuestion({
  answers,
  set,
  problems,
  ctx,
  workspaceId,
  needsAccount,
}: Q & { ctx: CalendarSetupContext; workspaceId: string; needsAccount: boolean }) {
  const depositChoice =
    answers.deposit === 'business'
      ? 'business'
      : answers.deposit === 'amount'
        ? 'amount'
        : String(answers.depositPercent);
  return (
    <>
      <Choices label={W.pay.title}>
        <ChoiceTile
          selected={answers.pay === 'none'}
          onSelect={() => set({ pay: 'none' })}
          title={W.pay.none.title}
          hint={W.pay.none.hint}
          testId="calendar-pay-none"
        />
        <ChoiceTile
          selected={answers.pay === 'deposit'}
          onSelect={() => set({ pay: 'deposit' })}
          title={W.pay.deposit.title}
          hint={W.pay.deposit.hint}
          best={W.pay.deposit.badge}
          testId="calendar-pay-deposit"
        >
          <div className="flex max-w-[320px] flex-col gap-1.5">
            <Label htmlFor="calendar-deposit">{W.pay.howMuch}</Label>
            <Select
              id="calendar-deposit"
              value={depositChoice}
              onChange={(e) => {
                const v = e.target.value;
                if (v === 'business' || v === 'amount') set({ deposit: v });
                else set({ deposit: 'percent', depositPercent: Number(v) });
              }}
              data-testid="calendar-deposit"
            >
              {ctx.businessDeposit.kind !== 'none' ? (
                <option value="business">{W.pay.usual(depositTermsWords(ctx))}</option>
              ) : null}
              {CALENDAR_SETUP_DEPOSIT_PERCENTS.map((n) => (
                <option key={n} value={n}>
                  {W.pay.percent(n)}
                </option>
              ))}
              <option value="amount">{W.pay.amount}</option>
            </Select>
            {answers.deposit === 'amount' ? (
              <PriceInput
                id="calendar-deposit-amount"
                cents={answers.depositCents}
                onChange={(depositCents) => set({ depositCents })}
                invalid={!!problems['depositCents']}
                testId="calendar-deposit-amount"
              />
            ) : null}
            {problems['depositCents'] ? <Problem>{problems['depositCents']}</Problem> : null}
          </div>
        </ChoiceTile>
        <ChoiceTile
          selected={answers.pay === 'full'}
          onSelect={() => set({ pay: 'full' })}
          title={W.pay.full.title}
          hint={W.pay.full.hint}
          testId="calendar-pay-full"
        />
      </Choices>
      {needsAccount || (answers.pay !== 'none' && !ctx.paymentsReady) ? (
        <Callout
          tone={needsAccount ? 'danger' : 'warning'}
          icon={CircleAlert}
          data-testid="calendar-pay-connect"
          action={
            <ButtonLink href={`/app/w/${workspaceId}/settings/payments`} size="sm">
              {W.pay.connect}
            </ButtonLink>
          }
        >
          {W.pay.connectNote}
        </Callout>
      ) : null}
      {problems['pay'] && !needsAccount ? <Problem>{problems['pay']}</Problem> : null}
    </>
  );
}

// ---- Done ----

/** After Make this calendar: open or a draft, its link, and good next steps. */
export function CalendarSetupDone({
  workspaceId,
  businessName,
  email,
  calendar,
  brandedOrigin,
  meantToOpen,
  datesMissed,
}: {
  workspaceId: string;
  businessName: string;
  email: string;
  calendar: CalendarDetail;
  brandedOrigin: string | null;
  /** They ticked Open it for booking right away. */
  meantToOpen: boolean;
  /** Dates that couldn't be posted. */
  datesMissed: number;
}) {
  const router = useRouter();
  const origin = usePublicOrigin(brandedOrigin);
  const link = `${origin}${calendar.bookingPath ?? calendar.permanentPath}`;
  const open = calendar.status === 'active';
  const sessions = calendar.config.schedule.mode === 'sessions';
  const blocked = useMemo(
    () => calendar.issues.filter((x) => x.severity === 'error').map((x) => `${x.message}.`),
    [calendar.issues],
  );
  const base = `/app/w/${workspaceId}/settings`;
  return (
    <GuidedPage
      business={{ name: businessName, home: `/app/w/${workspaceId}` }}
      email={email}
      settingUp={W.settingUp(businessName)}
      saved="idle"
      onLeave={() => router.push(`${base}/calendars`)}
      leaveLabel={G.close}
    >
      <Card
        className="mx-auto flex w-full max-w-[760px] flex-col gap-6 rounded-dialog p-6 sm:p-8"
        data-testid="calendar-setup-done"
        data-status={calendar.status}
      >
        <div className="flex flex-col gap-3">
          <span
            className={cn(
              'inline-flex h-11 w-11 items-center justify-center rounded-full',
              open ? 'bg-success-soft text-success-text' : 'bg-card-2 text-text-2',
            )}
          >
            {open ? (
              <Check className="h-5 w-5" strokeWidth={2.5} />
            ) : (
              <CalendarCheck className="h-5 w-5" strokeWidth={1.75} />
            )}
          </span>
          <h1 className="text-[24px] font-semibold leading-tight tracking-[-0.015em]">
            {open ? W.done.open(calendar.name) : W.done.draft(calendar.name)}
          </h1>
          {!open ? <p className="text-[15px] text-text-2">{W.done.draftHint}</p> : null}
          {!open && meantToOpen && blocked.length ? (
            <Callout tone="warning" icon={CircleAlert} data-testid="calendar-setup-blocked">
              <div className="font-semibold">{W.done.blocked}</div>
              <ul className="list-disc pl-4">
                {blocked.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
            </Callout>
          ) : null}
          {datesMissed ? (
            <Callout tone="warning" icon={CircleAlert}>
              {datesMissed === 1
                ? 'One date couldn’t be posted. Add it again from Calendar.'
                : `${datesMissed} dates couldn’t be posted. Add them again from Calendar.`}
            </Callout>
          ) : null}
        </div>

        <div className="flex flex-col gap-2.5 rounded-menu bg-card-2 p-4">
          <div className="text-[13.5px] font-semibold">{W.done.link}</div>
          <div className="flex flex-wrap items-center gap-2">
            <span
              className="flex h-10 min-w-0 flex-1 basis-[260px] items-center truncate rounded-control border border-border-strong bg-card px-3 font-mono text-[13px]"
              data-testid="calendar-setup-link"
            >
              {link.replace(/^https?:\/\//, '')}
            </span>
            <Button variant="secondary" onClick={() => void copyText(link, W.done.copied)}>
              <Copy className="h-4 w-4" strokeWidth={1.75} />
              {W.done.copy}
            </Button>
            <a
              href={link}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-9 items-center rounded-control border border-border-strong bg-card px-3.5 text-sm font-medium shadow-1 hover:bg-card-2"
            >
              {W.done.see}
            </a>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <div className="text-[15px] font-semibold">{W.done.next}</div>
          {sessions ? (
            <NextStep
              icon={<CalendarDays className="h-[18px] w-[18px]" strokeWidth={1.75} />}
              title={W.done.dates.title}
              hint={W.done.dates.hint}
              action={
                <ButtonLink href={`/app/w/${workspaceId}/calendar`} size="sm">
                  {W.done.dates.button}
                </ButtonLink>
              }
            />
          ) : null}
          <NextStep
            icon={<Code2 className="h-[18px] w-[18px]" strokeWidth={1.75} />}
            title={W.done.website.title}
            hint={W.done.website.hint}
            action={
              <CalendarEmbed
                workspaceId={workspaceId}
                calendarId={calendar.id}
                calendarName={calendar.name}
                bookingUrl={calendar.bookingPath ? link : null}
                embedOrigins={calendar.embedOrigins}
                bookingSiteHref={`${base}/calendars/booking-site`}
              />
            }
          />
          {calendar.config.team.assignment !== 'none' ? (
            <NextStep
              icon={<CalendarCheck className="h-[18px] w-[18px]" strokeWidth={1.75} />}
              title={W.done.connect.title}
              hint={W.done.connect.hint}
              action={
                <ButtonLink href={`${base}/my-calendar`} size="sm">
                  {W.done.connect.button}
                </ButtonLink>
              }
            />
          ) : null}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
          <span className="text-[13.5px] text-text-2">{W.done.later(calendar.name)}</span>
          <span className="flex flex-wrap gap-2">
            <ButtonLink href={`/onboarding/${workspaceId}/calendar`}>{W.done.another}</ButtonLink>
            <ButtonLink
              href={`${base}/calendars/${calendar.id}`}
              variant="primary"
              data-testid="calendar-setup-open-card"
            >
              {W.done.settings}
            </ButtonLink>
          </span>
        </div>
      </Card>
    </GuidedPage>
  );
}

function NextStep({
  icon,
  title,
  hint,
  action,
}: {
  icon: ReactNode;
  title: string;
  hint: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3.5 gap-y-3 rounded-menu border border-border px-4 py-3.5">
      <span className="inline-flex h-9 w-9 flex-none items-center justify-center rounded-[9px] bg-card-2 text-text-2">
        {icon}
      </span>
      <span className="flex min-w-0 flex-1 basis-[240px] flex-col gap-0.5">
        <span className="text-[14.5px] font-semibold">{title}</span>
        <span className="text-[13.5px] text-text-2">{hint}</span>
      </span>
      {action}
    </div>
  );
}
