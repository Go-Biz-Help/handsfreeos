'use client';
/**
 * The guided My calendar setup on the web (the owner, 24 Nov 2026: M1 a, M2 a, M3 a, M4 a): Getting started's
 * Connect your calendar opens it, and so does Settings → My calendar until it's set up (Start), and after it (Change,
 * Go through the questions again). Up to five questions on a page of their own (which calendar, when customers can
 * book you, time off, where your day starts, Zoom), then Check it over, where "Save and connect Google Calendar" (or
 * Outlook) saves them (my_calendar_setup.save) and opens the calendar's own sign-in, which comes back to Done
 * (MyCalendarSetupDone, through setup-return.ts). "Something else, or none" saves and goes straight to Done. Every
 * answer is saved as it's given (guided_setup.save_draft, the person's own), so leaving and coming back opens on the
 * same question with the same answers.
 *
 * Where the answers start, what is wrong with one, the hours they make and every line are core's
 * (guided-setup/my-calendar.ts), shared with the phone.
 */
import {
  GUIDED_SETUP_WORDS as G,
  MY_CALENDAR_SETUP_WORDS as W,
  guidedSetupSavedWhen,
  localDateOf,
  myCalendarDoneChips,
  myCalendarSavedTimeOff,
  myCalendarSetupAnswersOf,
  myCalendarSetupFirstProblem,
  myCalendarSetupLines,
  myCalendarSetupProblems,
  myCalendarSetupQuestionOf,
  myCalendarSetupQuestions,
  myCalendarSetupScreen,
  myCalendarSetupStart,
  myCalendarTimeOffLabel,
  myCalendarTimeOffProblem,
  myCalendarToConnect,
  myCalendarZone,
  providerName,
  TIME_OPTIONS,
  minutesToClock,
  parseClock,
  formatHours,
  zonePickLabel,
  type MyCalendarProvider,
  type MyCalendarSetupAnswers,
  type MyCalendarSetupContext,
  type MyCalendarSetupQuestion,
  type MyCalendarSetupScreen,
  type MyCalendarTimeOffDraft,
} from '@hfos/core';
import {
  CalendarDays,
  CalendarOff,
  CircleAlert,
  CircleCheck,
  Clock,
  EyeOff,
  MapPin,
  Plus,
  Trash2,
  Video,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { ZoneOptions } from '@/components/calendar/zone-field';
import { AddressInput } from '@/components/calendars/address-input';
import { WeeklyHoursEditor } from '@/components/calendars/weekly-hours';
import { Callout } from '@/components/crm/chips';
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
import { connectCalendar, ProviderMark } from '@/components/settings/calendar-connection-card';
import { connectZoom } from '@/components/settings/meeting-connection-card';
import { Badge } from '@/components/ui/badge';
import { Button, ButtonLink } from '@/components/ui/button';
import { Field, FieldError } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { apiBrowser, ApiError, errorMessage, unwrap } from '@/lib/api/client';
import { keepSetupReturn } from '@/lib/setup-return';
import { cn, relativeTime } from '@/lib/utils';

const settingsOf = (workspaceId: string) => `/app/w/${workspaceId}/settings/my-calendar`;

/** Where the setup was opened from: Getting started on Home (`?from=home`), or Settings. */
export type MyCalendarSetupFrom = 'home' | 'settings';

/** Where Finish later and Done go back to. */
const homeOf = (workspaceId: string, from: MyCalendarSetupFrom) =>
  from === 'home' ? `/app/w/${workspaceId}` : settingsOf(workspaceId);

/** Done, with where it was opened from and whether Zoom comes next. */
const doneOf = (workspaceId: string, from: MyCalendarSetupFrom, zoom: boolean) =>
  `/onboarding/${workspaceId}/my-calendar?step=done${from === 'home' ? '&from=home' : ''}${zoom ? '&zoom=1' : ''}`;

type Problems = Partial<Record<keyof MyCalendarSetupAnswers, string>>;

const problemsOf = (
  q: MyCalendarSetupScreen,
  a: MyCalendarSetupAnswers,
  ctx: MyCalendarSetupContext,
): Problems =>
  Object.fromEntries(myCalendarSetupProblems(q, a, ctx).map((p) => [p.path, p.message]));

/** Notes the way back to Done, then the calendar's own sign-in. */
async function signIn(
  workspaceId: string,
  provider: MyCalendarProvider,
  from: MyCalendarSetupFrom,
  zoom: boolean,
) {
  keepSetupReturn(workspaceId, 'my_calendar', doneOf(workspaceId, from, zoom));
  await connectCalendar(workspaceId, provider);
}

const ICON = 'h-[18px] w-[18px] text-text-2';

export function MyCalendarSetupFlow({
  workspaceId,
  businessName,
  email,
  firstName,
  ctx,
  draft,
  at,
  from = 'settings',
}: {
  workspaceId: string;
  businessName: string;
  /** Who's signed in, under the card. */
  email: string;
  firstName: string | null;
  ctx: MyCalendarSetupContext;
  /** The answers as they were left (guided_setup.get_draft, the person's own). */
  draft: { readonly answers: Record<string, unknown> | null; readonly savedAt: string | null };
  /** `?at=`: Settings' Change opens that question, and Next goes to Check it over. */
  at: MyCalendarSetupScreen | null;
  /** `?from=home`: Getting started on Home opened it, so Finish later and Done go Home. */
  from?: MyCalendarSetupFrom;
}) {
  const router = useRouter();
  const home = homeOf(workspaceId, from);
  const questions = myCalendarSetupQuestions(ctx);
  const [first] = useState(() => {
    const start = myCalendarSetupStart(ctx);
    // A Change from Settings starts from what's set now.
    const kept = !at && draft.answers ? myCalendarSetupAnswersOf(draft.answers, start) : null;
    return { answers: kept ?? start, kept: !!kept };
  });
  const [answers, setAnswers] = useState<MyCalendarSetupAnswers>(first.answers);
  const [screen, setScreen] = useState<MyCalendarSetupScreen>(() => {
    const saved = myCalendarSetupScreen.safeParse(first.kept ? draft.answers?.['at'] : at);
    return saved.success && (saved.data === 'review' || questions.includes(saved.data))
      ? saved.data
      : 'calendar';
  });
  const [problems, setProblems] = useState<Problems>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [done, setDone] = useState(false);
  /** Check it over's Change (and Settings'): Next goes straight back there. */
  const [returnTo, setReturnTo] = useState<MyCalendarSetupScreen | null>(at ? 'review' : null);
  const [welcome, setWelcome] = useState(
    () => first.kept && !!draft.savedAt && Date.now() - Date.parse(draft.savedAt) > 10 * 60_000,
  );
  const [startingOver, setStartingOver] = useState(false);
  const top = useRef<HTMLDivElement>(null);

  const saving = useGuidedDraft(
    workspaceId,
    'my_calendar',
    done ? null : { ...answers, at: screen },
    { hadDraft: first.kept },
  );

  const set = (patch: Partial<MyCalendarSetupAnswers>) => {
    setAnswers((now) => ({ ...now, ...patch }));
    setProblems({});
    setError(null);
  };

  const go = (to: MyCalendarSetupScreen) => {
    setScreen(to);
    setProblems({});
    setError(null);
    setWelcome(false);
    top.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const i = screen === 'review' ? questions.length : Math.max(0, questions.indexOf(screen));

  function next() {
    if (screen === 'review') return;
    const found = problemsOf(screen, answers, ctx);
    if (Object.keys(found).length) return setProblems(found);
    if (returnTo) {
      setReturnTo(null);
      go('review');
      return;
    }
    go(questions[i + 1] ?? 'review');
  }

  const back = () => {
    setReturnTo(null);
    const before = screen === 'review' ? questions[questions.length - 1] : questions[i - 1];
    if (before) go(before);
  };

  const connect = myCalendarToConnect(answers, ctx);

  async function finish() {
    const wrong = myCalendarSetupFirstProblem(answers, ctx);
    if (wrong) {
      go(wrong);
      setProblems(problemsOf(wrong, answers, ctx));
      return;
    }
    setBusy(true);
    setError(null);
    let out: { connect: MyCalendarProvider | null; zoom: boolean };
    try {
      await saving.flush();
      out = unwrap(
        await apiBrowser().POST('/v1/commands/my_calendar_setup.save', {
          body: { workspaceId, answers },
        }),
      );
    } catch (e) {
      setBusy(false);
      // A refusal about one answer opens that question with the words under it.
      const hit = e instanceof ApiError ? refusalOf(e) : null;
      if (hit) {
        go(hit.question);
        setProblems({ [hit.field]: hit.message });
        return;
      }
      setError(errorMessage(e));
      return;
    }
    setDone(true);
    await saving.clear();
    if (!out.connect) {
      router.push(doneOf(workspaceId, from, out.zoom));
      router.refresh();
      return;
    }
    try {
      await signIn(workspaceId, out.connect, from, out.zoom);
    } catch (e) {
      // The answers are saved; only the sign-in didn't start. Done offers it again.
      toast.error(errorMessage(e));
      router.push(doneOf(workspaceId, from, out.zoom));
    }
  }

  async function leave(to = home) {
    setLeaving(true);
    await saving.flush();
    router.push(to);
    router.refresh();
  }

  async function startOver() {
    await saving.clear();
    saving.resume();
    setAnswers(myCalendarSetupStart(ctx));
    setStartingOver(false);
    setReturnTo(null);
    go('calendar');
  }

  const page = (children: ReactNode) => (
    <GuidedPage
      business={{ name: businessName, home: `/app/w/${workspaceId}` }}
      email={email}
      settingUp={W.settingUp(businessName)}
      saved={saving.state}
      onLeave={() => void leave()}
      leaving={leaving}
    >
      <div ref={top} className="w-full scroll-mt-20">
        {children}
      </div>
    </GuidedPage>
  );

  const lines = myCalendarSetupLines(answers, ctx);
  const steps: GuidedStep[] = lines.map((l) => {
    const n = questions.indexOf(l.key);
    return {
      key: l.id,
      label: l.label,
      value: l.value,
      state: n < i ? 'done' : n === i ? 'now' : 'todo',
    };
  });
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

  const card = (
    q: MyCalendarSetupQuestion,
    title: string,
    hint: string,
    children: ReactNode,
    only?: string,
  ) =>
    page(
      <GuidedCard
        screen={q}
        testId="my-calendar-setup"
        kicker={G.question(i + 1, questions.length)}
        title={title}
        hint={hint}
        banner={
          banner ??
          (only ? (
            <span className="self-start">
              <Badge variant="pending">{only}</Badge>
            </span>
          ) : null)
        }
        steps={steps}
        stepsTitle={W.soFar}
        stepsNote={
          !first.kept ? (
            <p
              className="px-2.5 text-[12.5px] text-text-3"
              data-testid="my-calendar-setup-started-from"
            >
              {ctx.weekly ? W.startedFromSaved : W.startedFrom}
            </p>
          ) : null
        }
        footer={
          <GuidedFooter
            onBack={i > 0 ? back : undefined}
            onNext={next}
            error={error}
            testId="my-calendar-setup"
            nextLabel={returnTo === 'review' || i === questions.length - 1 ? G.checkItOver : G.next}
          />
        }
      >
        {children}
      </GuidedCard>,
    );

  if (screen === 'review') {
    const name = connect ? providerName(connect) : null;
    return page(
      <GuidedCard
        screen="review"
        testId="my-calendar-setup"
        kicker={W.review.kicker}
        title={W.review.title}
        hint={`${name ? W.review.hintConnect(name) : W.review.hintSave} ${G.answersKept}`}
        banner={banner}
        aside={<p className="text-[12.5px] text-text-3">{W.review.aside}</p>}
        footer={
          <GuidedFooter
            onBack={back}
            onNext={() => void finish()}
            busy={busy}
            error={error}
            nextLabel={name ? W.review.saveConnect(name) : W.review.save}
            testId="my-calendar-setup"
          />
        }
      >
        <div className="overflow-hidden rounded-menu border border-border">
          {lines.map((l) => (
            <div
              key={l.id}
              className="flex items-start justify-between gap-4 border-b border-border px-4 py-3 last:border-b-0"
              data-testid={`my-calendar-review-${l.id}`}
            >
              <div className="flex min-w-0 flex-col gap-0.5">
                <div className="text-xs font-medium uppercase tracking-[0.04em] text-text-3">
                  {l.label}
                </div>
                <div className="break-words font-semibold">{l.value}</div>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setReturnTo('review');
                  go(l.key);
                }}
                data-testid={`my-calendar-review-change-${l.id}`}
              >
                {G.change}
              </Button>
            </div>
          ))}
        </div>
        {name ? <GuidedNote>{W.review.signInNote(name)}</GuidedNote> : null}
      </GuidedCard>,
    );
  }

  switch (screen) {
    case 'calendar': {
      const c = ctx.connection;
      const connected = (p: MyCalendarProvider) =>
        c && c.provider === p && c.status === 'active' ? (
          <Badge variant="ok">{W.calendar.connected}</Badge>
        ) : null;
      return card(
        'calendar',
        W.calendar.title,
        W.calendar.hint,
        <>
          <Choices label={W.calendar.title}>
            <ChoiceTile
              selected={answers.calendar === 'google'}
              onSelect={() => set({ calendar: 'google' })}
              icon={<ProviderMark provider="google" className="h-5 w-5" />}
              title={W.calendar.google}
              hint={
                <>
                  {W.calendar.googleHint} {connected('google')}
                </>
              }
              testId="my-calendar-setup-google"
            />
            <ChoiceTile
              selected={answers.calendar === 'microsoft'}
              onSelect={() => set({ calendar: 'microsoft' })}
              icon={<ProviderMark provider="microsoft" className="h-5 w-5" />}
              title={W.calendar.outlook}
              hint={
                <>
                  {W.calendar.outlookHint} {connected('microsoft')}
                </>
              }
              testId="my-calendar-setup-microsoft"
            />
            <ChoiceTile
              selected={answers.calendar === 'none'}
              onSelect={() => set({ calendar: 'none' })}
              icon={<CalendarOff className={ICON} strokeWidth={1.75} />}
              title={W.calendar.none}
              hint={W.calendar.noneHint}
              testId="my-calendar-setup-none"
            />
          </Choices>
          {problems.calendar ? <FieldError>{problems.calendar}</FieldError> : null}
          {answers.calendar !== 'none' ? (
            <div className="flex flex-col gap-2 rounded-menu bg-card-2 px-4 py-3.5 text-[13.5px] leading-snug">
              <span className="flex items-start gap-2.5">
                <EyeOff className="mt-0.5 h-4 w-4 flex-none text-text-2" strokeWidth={1.75} />
                <span>
                  <b className="font-semibold">{W.calendar.privacy}</b>
                  {W.calendar.privacyRest}
                </span>
              </span>
              <span className="flex items-start gap-2.5">
                <CalendarDays className="mt-0.5 h-4 w-4 flex-none text-text-2" strokeWidth={1.75} />
                <span>
                  <b className="font-semibold">{W.calendar.oneplace}</b>
                  {W.calendar.oneplaceRest}
                </span>
              </span>
            </div>
          ) : null}
          {answers.calendar !== 'none' ? (
            <GuidedNote>
              {answers.calendar
                ? W.calendar.note(providerName(answers.calendar))
                : W.calendar.noteAny}
            </GuidedNote>
          ) : null}
        </>,
      );
    }

    case 'hours': {
      const businessLine = formatHours(ctx.businessHours) || W.lines.noHours;
      return card(
        'hours',
        W.hours.title,
        W.hours.hint,
        <>
          <Choices label={W.hours.title}>
            <ChoiceTile
              selected={answers.hours === 'business'}
              onSelect={() => set({ hours: 'business' })}
              title={W.hours.business}
              best={W.hours.businessBadge}
              hint={W.hours.businessHint(businessLine)}
              testId="my-calendar-setup-hours-business"
            />
            <ChoiceTile
              selected={answers.hours === 'weekdays'}
              onSelect={() => set({ hours: 'weekdays' })}
              title={W.hours.weekdays}
              hint={W.hours.weekdaysHint}
              testId="my-calendar-setup-hours-weekdays"
            />
            <ChoiceTile
              selected={answers.hours === 'own'}
              onSelect={() => set({ hours: 'own' })}
              title={W.hours.own}
              hint={answers.hours === 'own' ? W.hours.ownOpenHint : W.hours.ownHint}
              testId="my-calendar-setup-hours-own"
            >
              <div className="rounded-menu border border-border bg-card px-3 py-1">
                <WeeklyHoursEditor
                  value={answers.ownHours}
                  onChange={(ownHours) => set({ ownHours })}
                  idPrefix="my-calendar-setup-own"
                />
              </div>
              <span className="text-[12.5px] text-text-3">{W.hours.ownTip}</span>
              {problems.ownHours ? <FieldError>{problems.ownHours}</FieldError> : null}
            </ChoiceTile>
          </Choices>
          {problems.hours ? <FieldError>{problems.hours}</FieldError> : null}
          {answers.hours !== 'own' ? (
            <div className="flex flex-col gap-2 rounded-menu border border-border px-4 py-3">
              <div className="flex flex-wrap items-center gap-3">
                <span className="flex min-w-[180px] flex-1 flex-col gap-0.5">
                  <span className="text-[14px] font-semibold">{W.hours.lunch}</span>
                  <span className="text-[13px] text-text-2">{W.hours.lunchHint}</span>
                </span>
                {answers.lunch ? (
                  <span className="flex items-center gap-2 text-[13px] text-text-2">
                    <ClockSelect
                      label={`${W.hours.lunch}, from`}
                      value={answers.lunchStart}
                      onChange={(lunchStart) => set({ lunchStart })}
                      testId="my-calendar-setup-lunch-start"
                    />
                    {W.hours.to}
                    <ClockSelect
                      label={`${W.hours.lunch}, to`}
                      value={answers.lunchEnd}
                      onChange={(lunchEnd) => set({ lunchEnd })}
                      testId="my-calendar-setup-lunch-end"
                    />
                  </span>
                ) : null}
                <Switch
                  checked={answers.lunch}
                  onChange={(lunch) => set({ lunch })}
                  label={W.hours.lunch}
                  testId="my-calendar-setup-lunch"
                />
              </div>
              {problems.lunchEnd ? <FieldError>{problems.lunchEnd}</FieldError> : null}
              {problems.lunchStart ? <FieldError>{problems.lunchStart}</FieldError> : null}
            </div>
          ) : (
            <GuidedNote>{W.hours.lunchOwn}</GuidedNote>
          )}
          <div className="flex flex-wrap items-center gap-3 rounded-menu border border-border px-4 py-3">
            <span className="flex min-w-[180px] flex-1 flex-col gap-0.5">
              <label htmlFor="my-calendar-setup-zone" className="text-[14px] font-semibold">
                {W.hours.zone}
              </label>
              <span className="text-[13px] text-text-2">{W.hours.zoneHint}</span>
            </span>
            <Select
              id="my-calendar-setup-zone"
              className="w-auto min-w-[240px]"
              value={answers.timezone ?? ''}
              onChange={(e) => set({ timezone: e.target.value || null })}
              data-testid="my-calendar-setup-zone"
            >
              <ZoneOptions
                calendarZone={ctx.businessZone}
                value={answers.timezone ?? ctx.businessZone}
                first={{ id: '', label: W.hours.sameZone(zonePickLabel(ctx.businessZone)) }}
              />
            </Select>
          </div>
        </>,
      );
    }

    case 'timeOff':
      return card(
        'timeOff',
        W.timeOff.title,
        W.timeOff.hint(
          answers.calendar && answers.calendar !== 'none' ? providerName(answers.calendar) : null,
        ),
        <TimeOffQuestion
          ctx={ctx}
          answers={answers}
          set={set}
          problem={problems.timeOff ?? null}
        />,
      );

    case 'dayStart':
      return card(
        'dayStart',
        W.dayStart.title,
        W.dayStart.hint,
        <>
          <Choices label={W.dayStart.title}>
            <ChoiceTile
              selected={answers.dayStart === 'business'}
              onSelect={() => set({ dayStart: 'business' })}
              title={W.dayStart.business}
              hint={W.dayStart.businessHint(ctx.businessAddress)}
              testId="my-calendar-setup-start-business"
            />
            <ChoiceTile
              selected={answers.dayStart === 'own'}
              onSelect={() => set({ dayStart: 'own' })}
              title={W.dayStart.own}
              hint={W.dayStart.ownHint}
              testId="my-calendar-setup-start-own"
            >
              <AddressInput
                id="my-calendar-setup-address"
                value={answers.address}
                onChange={(address) => set({ address })}
                onPick={(found) => {
                  if (found) set({ address: found.formatted });
                }}
                onFind={() => undefined}
              />
              <span className="text-[12.5px] text-text-3">{W.dayStart.pickHint}</span>
              {problems.address ? <FieldError>{problems.address}</FieldError> : null}
            </ChoiceTile>
          </Choices>
          <GuidedNote>
            <MapPin className="mr-1 inline h-3.5 w-3.5" strokeWidth={1.75} />
            {W.dayStart.note}
          </GuidedNote>
        </>,
        W.dayStart.only,
      );

    case 'zoom':
      return card(
        'zoom',
        W.zoom.title,
        W.zoom.hint,
        <>
          <Choices label={W.zoom.title}>
            <ChoiceTile
              selected={answers.zoom}
              onSelect={() => set({ zoom: true })}
              icon={<Video className={ICON} strokeWidth={1.75} />}
              title={W.zoom.yes}
              hint={W.zoom.yesHint(connect ? providerName(connect) : null)}
              testId="my-calendar-setup-zoom-yes"
            />
            <ChoiceTile
              selected={!answers.zoom}
              onSelect={() => set({ zoom: false })}
              icon={<Clock className={ICON} strokeWidth={1.75} />}
              title={W.zoom.notNow}
              hint={W.zoom.notNowHint}
              testId="my-calendar-setup-zoom-no"
            />
          </Choices>
          <GuidedNote>{W.zoom.note}</GuidedNote>
        </>,
        W.zoom.only,
      );
  }
}

/** A refusal from saving about one answer: its question, its field and its words. */
function refusalOf(e: ApiError): {
  question: MyCalendarSetupQuestion;
  field: keyof MyCalendarSetupAnswers;
  message: string;
} | null {
  if (e.code !== 'validation' || !Array.isArray(e.details)) return null;
  for (const d of e.details as { path?: unknown; message?: unknown }[]) {
    const path = Array.isArray(d.path) ? d.path.join('.') : String(d.path ?? '');
    const question = myCalendarSetupQuestionOf(path);
    const field = path.split('.').filter((p) => p !== 'answers')[0] as keyof MyCalendarSetupAnswers;
    if (question && typeof d.message === 'string') return { question, field, message: d.message };
  }
  return null;
}

/** A time of day, every 15 minutes. */
function ClockSelect({
  label,
  value,
  onChange,
  testId,
}: {
  label: string;
  value: string;
  onChange: (clock: string) => void;
  testId: string;
}) {
  return (
    <Select
      selectSize="sm"
      className="h-[32px] w-[112px] text-[13px]"
      aria-label={label}
      value={String(parseClock(value))}
      onChange={(e) => onChange(minutesToClock(Number(e.target.value)))}
      data-testid={testId}
    >
      {TIME_OPTIONS.map(([m, text]) => (
        <option key={m} value={m}>
          {text}
        </option>
      ))}
    </Select>
  );
}

/** Question 3: time off still coming up, each with remove, and Add time off. Nothing is saved until Check it over. */
function TimeOffQuestion({
  ctx,
  answers,
  set,
  problem,
}: {
  ctx: MyCalendarSetupContext;
  answers: MyCalendarSetupAnswers;
  set: (patch: Partial<MyCalendarSetupAnswers>) => void;
  problem: string | null;
}) {
  const zone = myCalendarZone(ctx, answers);
  const today = localDateOf(Date.now(), zone);
  const [form, setForm] = useState({
    allDay: true,
    startDate: today,
    endDate: today,
    start: '09:00',
    end: '12:00',
    note: '',
  });
  const [wrong, setWrong] = useState<string | null>(null);
  const keptSaved = ctx.timeOff.filter((t) => !answers.removeTimeOff.includes(t.id));
  const rows: { key: string; label: string; allDay: boolean; remove: () => void }[] = [
    ...keptSaved.map((t) => {
      const shown = myCalendarSavedTimeOff(t, zone);
      return {
        key: t.id,
        label: myCalendarTimeOffLabel(shown),
        allDay: t.allDay,
        remove: () => set({ removeTimeOff: [...answers.removeTimeOff, t.id] }),
      };
    }),
    ...answers.timeOff.map((t) => ({
      key: t.key,
      label: myCalendarTimeOffLabel(t),
      allDay: t.allDay,
      remove: () => set({ timeOff: answers.timeOff.filter((x) => x.key !== t.key) }),
    })),
  ];

  function add() {
    const t: MyCalendarTimeOffDraft = {
      key: Math.random().toString(36).slice(2, 10),
      allDay: form.allDay,
      startDate: form.startDate,
      endDate: form.allDay ? form.endDate : form.startDate,
      start: form.start,
      end: form.end,
      note: form.note.trim(),
    };
    const p = myCalendarTimeOffProblem(t);
    if (p) return setWrong(p);
    setWrong(null);
    set({ timeOff: [...answers.timeOff, t] });
    setForm((f) => ({ ...f, note: '' }));
  }

  return (
    <>
      {rows.length ? (
        <ul
          className="overflow-hidden rounded-menu border border-border"
          data-testid="my-calendar-setup-time-off"
        >
          {rows.map((r, n) => (
            <li
              key={r.key}
              className={cn('flex items-center gap-3 px-4 py-3', n > 0 && 'border-t border-border')}
            >
              <CalendarOff className={cn(ICON, 'flex-none')} strokeWidth={1.75} />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-[14px] font-semibold">{r.label}</span>
                {r.allDay ? (
                  <span className="text-[12.5px] text-text-3">{W.timeOff.allDayTag}</span>
                ) : null}
              </span>
              <Button
                variant="ghost"
                size="sm"
                aria-label={W.timeOff.remove(r.label)}
                onClick={r.remove}
              >
                <Trash2 className="h-4 w-4" strokeWidth={1.75} />
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[13.5px] text-text-2">{W.timeOff.none}</p>
      )}
      <div className="flex flex-col gap-3 rounded-menu bg-card-2 px-4 py-3.5">
        <div className="flex items-center justify-between gap-3">
          <span className="text-[14px] font-semibold">{W.timeOff.add}</span>
          <span className="flex items-center gap-2 text-[13px] text-text-2">
            {W.timeOff.allDay}
            <Switch
              checked={form.allDay}
              onChange={(allDay) => setForm((f) => ({ ...f, allDay }))}
              label={W.timeOff.allDay}
              testId="my-calendar-setup-off-all-day"
            />
          </span>
        </div>
        <div className="flex flex-wrap gap-3">
          {form.allDay ? (
            <>
              <Field label={W.timeOff.from} htmlFor="my-off-from" className="min-w-[150px] flex-1">
                <Input
                  id="my-off-from"
                  type="date"
                  value={form.startDate}
                  onChange={(e) => {
                    const v = e.target.value;
                    setForm((f) => ({
                      ...f,
                      startDate: v,
                      endDate: v > f.endDate ? v : f.endDate,
                    }));
                  }}
                  data-testid="my-calendar-setup-off-from"
                />
              </Field>
              <Field label={W.timeOff.to} htmlFor="my-off-to" className="min-w-[150px] flex-1">
                <Input
                  id="my-off-to"
                  type="date"
                  min={form.startDate}
                  value={form.endDate}
                  onChange={(e) => setForm((f) => ({ ...f, endDate: e.target.value }))}
                  data-testid="my-calendar-setup-off-to"
                />
              </Field>
            </>
          ) : (
            <>
              <Field label={W.timeOff.day} htmlFor="my-off-day" className="min-w-[150px] flex-1">
                <Input
                  id="my-off-day"
                  type="date"
                  value={form.startDate}
                  onChange={(e) => {
                    const v = e.target.value;
                    setForm((f) => ({ ...f, startDate: v, endDate: v }));
                  }}
                  data-testid="my-calendar-setup-off-day"
                />
              </Field>
              <Field label={W.timeOff.startTime} htmlFor="my-off-start">
                <ClockSelect
                  label={W.timeOff.startTime}
                  value={form.start}
                  onChange={(start) => setForm((f) => ({ ...f, start }))}
                  testId="my-calendar-setup-off-start"
                />
              </Field>
              <Field label={W.timeOff.endTime} htmlFor="my-off-end">
                <ClockSelect
                  label={W.timeOff.endTime}
                  value={form.end}
                  onChange={(end) => setForm((f) => ({ ...f, end }))}
                  testId="my-calendar-setup-off-end"
                />
              </Field>
            </>
          )}
          <Field label={W.timeOff.note} htmlFor="my-off-note" className="min-w-[180px] flex-[2]">
            <Input
              id="my-off-note"
              value={form.note}
              maxLength={500}
              placeholder={W.timeOff.notePlaceholder}
              onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))}
              data-testid="my-calendar-setup-off-note"
            />
          </Field>
        </div>
        <div>
          <Button variant="secondary" onClick={add} data-testid="my-calendar-setup-off-add">
            <Plus className="h-4 w-4" strokeWidth={1.75} />
            {W.timeOff.addButton}
          </Button>
        </div>
        {wrong ? <FieldError>{wrong}</FieldError> : null}
      </div>
      {problem ? <FieldError>{problem}</FieldError> : null}
      <GuidedNote>{W.timeOff.tip}</GuidedNote>
    </>
  );
}

// ---------- Done ----------

const RESULT: Record<string, { tone: 'info' | 'danger'; text: string }> = {
  cancelled: { tone: 'info', text: 'Sign-in cancelled. Nothing was connected.' },
  missing_permissions: {
    tone: 'danger',
    text: 'Some permissions were left unticked, so it didn’t connect. Try again and allow everything asked.',
  },
  failed: { tone: 'danger', text: 'That calendar didn’t connect. Try again in a minute.' },
};
const MEETING_RESULT: Record<string, { tone: 'info' | 'danger'; text: string }> = {
  cancelled: { tone: 'info', text: 'Sign-in cancelled. Zoom wasn’t connected.' },
  missing_permissions: {
    tone: 'danger',
    text: 'Zoom didn’t give all the permissions HandsFreeOS needs, so it didn’t connect. Try again and allow everything asked.',
  },
  failed: { tone: 'danger', text: 'Zoom didn’t connect. Try again in a minute.' },
};

/**
 * Done: where Google's or Microsoft's sign-in (and Zoom's) comes back to, and where "Something else, or none" lands.
 * What's connected, with when busy times were last checked; what was set, as chips; Connect Zoom when it was asked
 * for and isn't connected; and the way back.
 */
export function MyCalendarSetupDone({
  workspaceId,
  businessName,
  email,
  ctx,
  result,
  meetingResult,
  zoom,
  from = 'settings',
}: {
  workspaceId: string;
  businessName: string;
  email: string;
  ctx: MyCalendarSetupContext;
  /** `?calendar=`: what the calendar's sign-in came back with. */
  result: string | null;
  /** `?meeting=`: what Zoom's sign-in came back with. */
  meetingResult: string | null;
  /** `?zoom=1`: they asked to connect Zoom next. */
  zoom: boolean;
  from?: MyCalendarSetupFrom;
}) {
  const router = useRouter();
  const home = homeOf(workspaceId, from);
  const [busy, setBusy] = useState<'calendar' | 'zoom' | null>(null);
  const c = ctx.connection;
  const live = !!c && c.status === 'active';
  const failed =
    result && result !== 'connected' && !live ? (RESULT[result] ?? RESULT.failed!) : null;
  const zoomFailed =
    meetingResult && meetingResult !== 'connected'
      ? (MEETING_RESULT[meetingResult] ?? MEETING_RESULT.failed!)
      : null;
  const zoomLive = ctx.meeting?.status === 'active';
  const chips = myCalendarDoneChips(ctx);
  // A sign-in that just finished is checking busy times: look again in a moment.
  useEffect(() => {
    if (!live || c?.busySyncedAt) return;
    const timer = setTimeout(() => router.refresh(), 8000);
    return () => clearTimeout(timer);
  }, [live, c?.busySyncedAt, router]);
  const told = useRef(false);
  useEffect(() => {
    if (told.current || meetingResult !== 'connected') return;
    told.current = true;
    toast.success(W.done.zoomDone);
  }, [meetingResult]);

  async function run(what: 'calendar' | 'zoom', job: () => Promise<void>) {
    setBusy(what);
    try {
      await job();
    } catch (e) {
      setBusy(null);
      toast.error(errorMessage(e));
    }
  }
  const tryCalendar = (p: MyCalendarProvider) =>
    void run('calendar', () => signIn(workspaceId, p, from, zoom));
  const tryZoom = () =>
    void run('zoom', async () => {
      keepSetupReturn(workspaceId, 'my_calendar', doneOf(workspaceId, from, true));
      await connectZoom(workspaceId);
    });

  const title = live ? W.done.title : W.done.titleSaved;
  const hint = live ? W.done.hint(providerName(c!.provider)) : W.done.hintNone;
  return (
    <GuidedPage
      business={{ name: businessName, home: `/app/w/${workspaceId}` }}
      email={email}
      settingUp={W.settingUp(businessName)}
      saved="idle"
      onLeave={() => router.push(home)}
      leaveLabel={G.close}
    >
      <GuidedCard
        screen="done"
        testId="my-calendar-done"
        kicker=""
        title={title}
        hint={hint}
        banner={
          failed ? (
            <Callout tone={failed.tone} icon={CircleAlert} data-testid="my-calendar-done-failed">
              {failed.text}
            </Callout>
          ) : zoomFailed ? (
            <Callout tone={zoomFailed.tone} icon={CircleAlert}>
              {zoomFailed.text}
            </Callout>
          ) : null
        }
        footer={
          <div className="mt-auto flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
            <span className="text-[13px] text-text-2">{W.done.change}</span>
            <ButtonLink href={home} size="lg" data-testid="my-calendar-done-back">
              {from === 'home' ? W.done.backHome : W.done.backSettings}
            </ButtonLink>
          </div>
        }
      >
        {c ? (
          <div
            role="status"
            className="flex flex-wrap items-center gap-3 rounded-menu border border-border px-4 py-3"
            data-testid="my-calendar-done-connection"
          >
            <ProviderMark provider={c.provider} className="h-6 w-6" />
            <span className="flex min-w-[180px] flex-1 flex-col">
              <span className="text-[14.5px] font-semibold">
                {c.accountEmail ?? providerName(c.provider)}
              </span>
              <span className="text-[12.5px] text-text-3">
                {!live
                  ? W.done.notYetHint(providerName(c.provider))
                  : c.busySyncedAt
                    ? W.done.checkedAt(relativeTime(c.busySyncedAt))
                    : W.done.checking}
              </span>
            </span>
            {live ? (
              <Badge variant="ok">{W.done.connectedBadge}</Badge>
            ) : (
              <Button
                size="sm"
                loading={busy === 'calendar'}
                onClick={() => tryCalendar(c.provider)}
              >
                {W.done.tryAgain(providerName(c.provider))}
              </Button>
            )}
          </div>
        ) : failed ? (
          <div className="flex flex-wrap gap-2">
            {(['google', 'microsoft'] as const).map((p) => (
              <Button
                key={p}
                variant="secondary"
                loading={busy === 'calendar'}
                onClick={() => tryCalendar(p)}
                data-testid={`my-calendar-done-try-${p}`}
              >
                <ProviderMark provider={p} className="h-4 w-4" />
                {W.done.tryAgain(providerName(p))}
              </Button>
            ))}
          </div>
        ) : null}
        <div className="flex flex-wrap gap-2" data-testid="my-calendar-done-chips">
          {chips.map((chip) => (
            <span
              key={chip}
              className="inline-flex items-center gap-1.5 rounded-full bg-card-2 px-2.5 py-1 text-[12.5px] font-medium"
            >
              <CircleCheck className="h-3.5 w-3.5 text-success-text" strokeWidth={2.25} />
              {chip}
            </span>
          ))}
        </div>
        {zoom && !zoomLive ? (
          <div
            className="flex flex-wrap items-center gap-3 rounded-menu bg-card-2 px-4 py-3"
            data-testid="my-calendar-done-zoom"
          >
            <Video className={cn(ICON, 'flex-none')} strokeWidth={1.75} />
            <span className="min-w-[200px] flex-1 text-[13.5px]">
              <b className="font-semibold">{W.done.zoomTitle}</b>
              {W.done.zoomRest}
            </span>
            <Button size="sm" loading={busy === 'zoom'} onClick={tryZoom}>
              {W.done.zoomButton}
            </Button>
          </div>
        ) : null}
      </GuidedCard>
    </GuidedPage>
  );
}
