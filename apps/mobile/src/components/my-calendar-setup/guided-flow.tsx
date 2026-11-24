import {
  GUIDED_SETUP_WORDS as G,
  MY_CALENDAR_SETUP_WORDS as W,
  addDays,
  fmtDateShort,
  formatClock,
  formatHours,
  guidedSetupSavedWhen,
  localDateOf,
  minutesToClock,
  myCalendarDoneChips,
  myCalendarSavedTimeOff,
  myCalendarSetupAnswersOf,
  myCalendarSetupFirstProblem,
  myCalendarSetupLines,
  myCalendarSetupProblems,
  myCalendarSetupQuestions,
  myCalendarSetupScreen,
  myCalendarSetupStart,
  myCalendarTimeOffLabel,
  myCalendarTimeOffProblem,
  myCalendarToConnect,
  myCalendarZone,
  parseClock,
  providerName,
  zoneChoices,
  zonePickLabel,
  type MyCalendarProvider,
  type MyCalendarSetupAnswers,
  type MyCalendarSetupContext,
  type MyCalendarSetupScreen,
  type MyCalendarTimeOffDraft,
} from '@hfos/core';
import * as WebBrowser from 'expo-web-browser';
import * as React from 'react';
import { AppState, Pressable, View, type ScrollView } from 'react-native';

import { HoursField } from '@/components/ai-setup/hours';
import { Chips } from '@/components/calendar/chips';
import {
  ChoiceTile,
  Choices,
  GuidedFooter,
  GuidedNote,
  GuidedPage,
  useGuidedDraft,
  WelcomeBack,
} from '@/components/guided-setup/frame';
import {
  CalendarDays,
  CalendarOff,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  Clock,
  Plus,
  Trash,
  Video,
} from '@/components/icons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { FieldError, Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { errorMessage } from '@/lib/api';
import { useNetwork } from '@/lib/network';
import { openWeb } from '@/lib/open-web';
import { cn } from '@/lib/utils';
import { ONBOARDING_SETUP_PHONE_WORDS as P } from '@/onboarding-setup/words';
import {
  NotInThisBuild,
  type MyCalendarGuidedDraft,
  type MyCalendarSetupCalls,
} from '@/my-calendar-setup/calls';

/**
 * A sign-in (Google's, Microsoft's or Zoom's) in the phone's browser over the app: closing it comes straight back
 * here, and coming back some other way (the app switcher) looks again too. Without a worker in this build, the web
 * finishes it.
 */
export function useSignIn(workspaceId: string, onBack: () => Promise<void>) {
  const { online } = useNetwork();
  const [busy, setBusy] = React.useState(false);
  const away = React.useRef(false);
  React.useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active' && away.current) {
        away.current = false;
        void onBack();
      }
    });
    return () => sub.remove();
  }, [onBack]);
  const signIn = React.useCallback(
    async (start: () => Promise<string>) => {
      if (!online) return toast.error(P.needsSignal);
      setBusy(true);
      try {
        const url = await start();
        away.current = true;
        await WebBrowser.openBrowserAsync(url);
        away.current = false;
        await onBack();
      } catch (e) {
        if (e instanceof NotInThisBuild) void openWeb(`/onboarding/${workspaceId}/my-calendar`);
        else toast.error(errorMessage(e));
      } finally {
        setBusy(false);
      }
    },
    [online, onBack, workspaceId],
  );
  return { signIn, busy };
}

const LUNCH_STARTS = ['11:00', '11:30', '12:00', '12:30', '13:00'];
const LUNCH_LENGTHS = [30, 45, 60];

/**
 * The guided My calendar setup on the phone (the owner, 24 Nov 2026, M4 a: in the same build as the web), as the
 * web's components/my-calendar-setup/my-calendar-setup-flow.tsx at phone size: the same questions one a screen, then
 * Check it over, where saving (my_calendar_setup.save) opens Google's or Microsoft's sign-in in the phone's browser
 * over the app; back here, Done. "Something else, or none" saves and goes to Done. The answers are saved as they are
 * given, so the web and the phone pick up each other's. Time off for part of a day is added on the web; here it's
 * whole days.
 */
export function MyCalendarGuidedFlow({
  workspaceId,
  businessName,
  firstName,
  ctx,
  draft,
  calls,
  onSaved,
  onClose,
}: {
  workspaceId: string;
  businessName: string;
  firstName: string | null;
  ctx: MyCalendarSetupContext;
  draft: MyCalendarGuidedDraft;
  calls: MyCalendarSetupCalls;
  /** Saved (and back from the calendar's sign-in, when there was one): on to Done. */
  onSaved: (zoom: boolean) => Promise<void>;
  onClose: () => void;
}) {
  const { online } = useNetwork();
  const questions = myCalendarSetupQuestions(ctx);
  const [first] = React.useState(() => {
    const start = myCalendarSetupStart(ctx);
    const kept = draft.answers ? myCalendarSetupAnswersOf(draft.answers, start) : null;
    return { answers: kept ?? start, kept: !!kept };
  });
  const [answers, setAnswers] = React.useState<MyCalendarSetupAnswers>(first.answers);
  const [screen, setScreen] = React.useState<MyCalendarSetupScreen>(() => {
    const saved = myCalendarSetupScreen.safeParse(first.kept ? draft.answers?.['at'] : null);
    const to = saved.success ? saved.data : null;
    return to === 'review' || (to && questions.includes(to)) ? to : 'calendar';
  });
  const [problems, setProblems] = React.useState<
    Partial<Record<keyof MyCalendarSetupAnswers, string>>
  >({});
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [done, setDone] = React.useState(false);
  const [leaving, setLeaving] = React.useState(false);
  const [returnTo, setReturnTo] = React.useState<MyCalendarSetupScreen | null>(null);
  const [welcome, setWelcome] = React.useState(
    () => first.kept && !!draft.savedAt && Date.now() - Date.parse(draft.savedAt) > 10 * 60_000,
  );
  const scroller = React.useRef<ScrollView>(null);
  const zoomNext = React.useRef(false);
  const back = React.useCallback(() => onSaved(zoomNext.current), [onSaved]);
  const { signIn, busy: signingIn } = useSignIn(workspaceId, back);

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
    scroller.current?.scrollTo({ y: 0, animated: false });
  };

  const i = screen === 'review' ? questions.length : Math.max(0, questions.indexOf(screen));

  function next() {
    if (screen === 'review') return;
    const found = myCalendarSetupProblems(screen, answers, ctx);
    if (found.length) {
      setProblems(Object.fromEntries(found.map((p) => [p.path, p.message])));
      return;
    }
    if (returnTo) {
      setReturnTo(null);
      go('review');
      return;
    }
    go(questions[i + 1] ?? 'review');
  }
  const goBack = () => {
    setReturnTo(null);
    const before = screen === 'review' ? questions[questions.length - 1] : questions[i - 1];
    if (before) go(before);
  };

  const connect = myCalendarToConnect(answers, ctx);

  async function finish() {
    const wrong = myCalendarSetupFirstProblem(answers, ctx);
    if (wrong) {
      go(wrong);
      setProblems(
        Object.fromEntries(
          myCalendarSetupProblems(wrong, answers, ctx).map((p) => [p.path, p.message]),
        ),
      );
      return;
    }
    if (!online) return setError(P.needsSignal);
    setBusy(true);
    setError(null);
    let out: { connect: MyCalendarProvider | null; zoom: boolean };
    try {
      await saving.flush();
      out = await calls.save(answers);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
      return;
    }
    setDone(true);
    await saving.clear();
    setBusy(false);
    zoomNext.current = out.zoom;
    const provider = out.connect;
    if (!provider) return void onSaved(out.zoom);
    await signIn(() => calls.signIn(provider));
  }

  async function leave() {
    setLeaving(true);
    await saving.flush();
    onClose();
  }

  async function startOver() {
    await saving.clear();
    saving.resume();
    setAnswers(myCalendarSetupStart(ctx));
    setReturnTo(null);
    go('calendar');
  }

  const lines = myCalendarSetupLines(answers, ctx);
  const when = draft.savedAt ? guidedSetupSavedWhen(draft.savedAt, new Date()) : null;
  const banner =
    welcome && when ? (
      <WelcomeBack
        line={`${G.welcomeBack(firstName, when)}${i > 0 && screen !== 'review' ? ` ${G.stoppedAt(i + 1)}` : ''}`}
        onStartOver={() => void startOver()}
      />
    ) : null;

  const page = (
    title: string,
    hint: string | undefined,
    children: React.ReactNode,
    footer: React.ReactNode,
  ) => (
    <GuidedPage
      screen={screen}
      testID="my-calendar-setup"
      kicker={screen === 'review' ? G.checkKicker : G.question(i + 1, questions.length)}
      settingUp={W.settingUp(businessName)}
      progress={{ at: i + 1, of: questions.length + 1 }}
      title={title}
      hint={hint}
      banner={banner}
      footer={footer}
      saved={saving.state}
      onLeave={() => void leave()}
      leaving={leaving}
      scroller={scroller}
    >
      {children}
    </GuidedPage>
  );
  const question = (title: string, hint: string, children: React.ReactNode) =>
    page(
      title,
      hint,
      children,
      <GuidedFooter
        onBack={i > 0 ? goBack : undefined}
        onNext={next}
        error={error}
        testID="my-calendar-setup"
        nextLabel={returnTo === 'review' || i === questions.length - 1 ? G.checkItOver : G.next}
      />,
    );

  if (screen === 'review') {
    const name = connect ? providerName(connect) : null;
    return page(
      W.review.title,
      `${name ? W.review.hintConnect(name) : W.review.hintSave} ${G.answersKept}`,
      <>
        <View className="overflow-hidden rounded-menu border border-border bg-card">
          {lines.map((l, at) => (
            <View
              key={l.id}
              className={cn('gap-1 px-4 py-3.5', at > 0 && 'border-t border-border')}
              testID={`my-calendar-review-${l.id}`}
            >
              <View className="flex-row items-center justify-between gap-3">
                <Text className="text-[11.5px] font-semibold uppercase tracking-[0.4px] text-text-3">
                  {l.label}
                </Text>
                <Pressable
                  role="button"
                  accessibilityLabel={`${G.change}: ${l.label}`}
                  onPress={() => {
                    setReturnTo('review');
                    go(l.key);
                  }}
                  hitSlop={{ top: 10, bottom: 10, left: 8, right: 8 }}
                  testID={`my-calendar-review-change-${l.id}`}
                >
                  <Text className="text-[14px] font-medium text-accent-text">{G.change}</Text>
                </Pressable>
              </View>
              <Text className="text-[15px] font-semibold">{l.value}</Text>
            </View>
          ))}
        </View>
        {name ? (
          <GuidedNote>
            <Text className="text-[13px] leading-[18px] text-text-2">
              {W.review.signInNote(name)}
            </Text>
            <Text className="text-[12.5px] leading-[17px] text-text-3">{W.phone.signInHint}</Text>
          </GuidedNote>
        ) : null}
      </>,
      <GuidedFooter
        onBack={goBack}
        onNext={() => void finish()}
        busy={busy || signingIn}
        error={error}
        nextLabel={name ? W.review.saveConnect(name) : W.review.save}
        testID="my-calendar-setup"
      />,
    );
  }

  switch (screen) {
    case 'calendar': {
      const c = ctx.connection;
      const tag = (p: MyCalendarProvider) =>
        c && c.provider === p && c.status === 'active' ? ` ${W.calendar.connected}.` : '';
      return question(
        W.calendar.title,
        W.calendar.hint,
        <>
          <Choices label={W.calendar.title}>
            <ChoiceTile
              selected={answers.calendar === 'google'}
              onSelect={() => set({ calendar: 'google' })}
              icon={CalendarDays}
              title={W.calendar.google}
              hint={`${W.calendar.googleHint}${tag('google')}`}
              testID="my-calendar-setup-google"
            />
            <ChoiceTile
              selected={answers.calendar === 'microsoft'}
              onSelect={() => set({ calendar: 'microsoft' })}
              icon={CalendarDays}
              title={W.calendar.outlook}
              hint={`${W.calendar.outlookHint}${tag('microsoft')}`}
              testID="my-calendar-setup-microsoft"
            />
            <ChoiceTile
              selected={answers.calendar === 'none'}
              onSelect={() => set({ calendar: 'none' })}
              icon={CalendarOff}
              title={W.calendar.none}
              hint={W.calendar.noneHint}
              testID="my-calendar-setup-none"
            />
          </Choices>
          {problems.calendar ? <FieldError>{problems.calendar}</FieldError> : null}
          {answers.calendar !== 'none' ? (
            <GuidedNote>
              <Text className="text-[13px] leading-[18px] text-text-2">
                <Text className="text-[13px] font-semibold">{W.calendar.privacy}</Text>
                {W.calendar.privacyRest}
              </Text>
              <Text className="text-[13px] leading-[18px] text-text-2">{W.calendar.notePhone}</Text>
            </GuidedNote>
          ) : null}
        </>,
      );
    }

    case 'hours': {
      const lunchLength = parseClock(answers.lunchEnd) - parseClock(answers.lunchStart);
      const starts = LUNCH_STARTS.includes(answers.lunchStart)
        ? LUNCH_STARTS
        : [...LUNCH_STARTS, answers.lunchStart].sort();
      const lengths = LUNCH_LENGTHS.includes(lunchLength)
        ? LUNCH_LENGTHS
        : [...LUNCH_LENGTHS, lunchLength].filter((m) => m > 0).sort((a, b) => a - b);
      const zones = [
        { value: '', label: W.hours.sameZone(zonePickLabel(ctx.businessZone)) },
        ...zoneChoices(ctx.businessZone, answers.timezone)
          .filter((z) => z.id !== ctx.businessZone)
          .map((z) => ({ value: z.id, label: z.label })),
      ];
      return question(
        W.hours.title,
        W.hours.hintPhone,
        <>
          <Choices label={W.hours.title}>
            <ChoiceTile
              selected={answers.hours === 'business'}
              onSelect={() => set({ hours: 'business' })}
              title={W.hours.business}
              best={W.hours.businessBadge}
              hint={formatHours(ctx.businessHours) || W.lines.noHours}
              testID="my-calendar-setup-hours-business"
            />
            <ChoiceTile
              selected={answers.hours === 'weekdays'}
              onSelect={() => set({ hours: 'weekdays' })}
              title={W.hours.weekdays}
              hint={W.hours.weekdaysHint}
              testID="my-calendar-setup-hours-weekdays"
            />
            <ChoiceTile
              selected={answers.hours === 'own'}
              onSelect={() => set({ hours: 'own' })}
              title={W.hours.own}
              hint={answers.hours === 'own' ? W.hours.ownOpenHint : W.hours.ownHint}
              testID="my-calendar-setup-hours-own"
            >
              <HoursField
                value={answers.ownHours}
                onChange={(ownHours) => set({ ownHours })}
                idPrefix="my-calendar-setup-own"
                {...(problems.ownHours ? { error: problems.ownHours } : {})}
              />
            </ChoiceTile>
          </Choices>
          {problems.hours ? <FieldError>{problems.hours}</FieldError> : null}
          {answers.hours !== 'own' ? (
            <View className="gap-3 rounded-menu border border-border bg-card px-4 py-3.5">
              <View className="flex-row items-center gap-3">
                <View className="min-w-0 flex-1 gap-0.5">
                  <Text className="text-[15px] font-semibold">{W.hours.lunch}</Text>
                  <Text className="text-[13px] leading-[18px] text-text-2">
                    {answers.lunch
                      ? `${formatClock(answers.lunchStart)} ${W.hours.to} ${formatClock(answers.lunchEnd)}`
                      : W.hours.lunchHint}
                  </Text>
                </View>
                <Switch
                  checked={answers.lunch}
                  onCheckedChange={(lunch) => set({ lunch })}
                  label={W.hours.lunch}
                  testID="my-calendar-setup-lunch"
                />
              </View>
              {answers.lunch ? (
                <>
                  <Chips
                    options={starts.map((s) => ({ value: s, label: formatClock(s) }))}
                    value={answers.lunchStart}
                    onChange={(s) =>
                      set({
                        lunchStart: s,
                        lunchEnd: minutesToClock(
                          Math.min(parseClock(s) + Math.max(lunchLength, 15), 1440),
                        ),
                      })
                    }
                    testID="my-calendar-setup-lunch-start"
                  />
                  <Chips
                    options={lengths.map((m) => ({
                      value: String(m),
                      label: m % 60 === 0 ? `${m / 60} hour` : `${m} minutes`,
                    }))}
                    value={String(lunchLength)}
                    onChange={(m) =>
                      set({
                        lunchEnd: minutesToClock(
                          Math.min(parseClock(answers.lunchStart) + Number(m), 1440),
                        ),
                      })
                    }
                    testID="my-calendar-setup-lunch-length"
                  />
                </>
              ) : null}
              {problems.lunchEnd ? <FieldError>{problems.lunchEnd}</FieldError> : null}
              {problems.lunchStart ? <FieldError>{problems.lunchStart}</FieldError> : null}
            </View>
          ) : (
            <Text className="text-[12.5px] leading-[17px] text-text-3">{W.hours.lunchOwn}</Text>
          )}
          <View className="gap-1.5">
            <Label>{W.hours.zone}</Label>
            <Chips
              options={zones}
              value={answers.timezone ?? ''}
              onChange={(z) => set({ timezone: z || null })}
              testID="my-calendar-setup-zone"
            />
            <Text className="text-[12.5px] leading-[17px] text-text-3">{W.hours.zoneHint}</Text>
          </View>
        </>,
      );
    }

    case 'timeOff':
      return question(
        W.timeOff.title,
        W.timeOff.hint(
          answers.calendar && answers.calendar !== 'none' ? providerName(answers.calendar) : null,
        ),
        <TimeOff ctx={ctx} answers={answers} set={set} problem={problems.timeOff ?? null} />,
      );

    case 'dayStart':
      return question(
        W.dayStart.title,
        W.dayStart.hint,
        <>
          <Badge variant="pending">{W.dayStart.only}</Badge>
          <Choices label={W.dayStart.title}>
            <ChoiceTile
              selected={answers.dayStart === 'business'}
              onSelect={() => set({ dayStart: 'business' })}
              title={W.dayStart.business}
              hint={W.dayStart.businessHint(ctx.businessAddress)}
              testID="my-calendar-setup-start-business"
            />
            <ChoiceTile
              selected={answers.dayStart === 'own'}
              onSelect={() => set({ dayStart: 'own' })}
              title={W.dayStart.own}
              hint={W.dayStart.ownHint}
              testID="my-calendar-setup-start-own"
            >
              <Input
                value={answers.address}
                onChangeText={(address) => set({ address })}
                placeholder={W.dayStart.placeholder}
                accessibilityLabel={W.dayStart.own}
                autoComplete="street-address"
                maxLength={300}
                invalid={!!problems.address}
                testID="my-calendar-setup-address"
              />
              {problems.address ? <FieldError>{problems.address}</FieldError> : null}
            </ChoiceTile>
          </Choices>
          <Text className="text-[12.5px] leading-[17px] text-text-3">{W.dayStart.note}</Text>
        </>,
      );

    case 'zoom':
      return question(
        W.zoom.title,
        W.zoom.hint,
        <>
          <Badge variant="pending">{W.zoom.only}</Badge>
          <Choices label={W.zoom.title}>
            <ChoiceTile
              selected={answers.zoom}
              onSelect={() => set({ zoom: true })}
              icon={Video}
              title={W.zoom.yes}
              hint={W.zoom.yesHint(connect ? providerName(connect) : null)}
              testID="my-calendar-setup-zoom-yes"
            />
            <ChoiceTile
              selected={!answers.zoom}
              onSelect={() => set({ zoom: false })}
              icon={Clock}
              title={W.zoom.notNow}
              hint={W.zoom.notNowHint}
              testID="my-calendar-setup-zoom-no"
            />
          </Choices>
          <Text className="text-[12.5px] leading-[17px] text-text-3">{W.zoom.note}</Text>
        </>,
      );
  }
}

/** A day, moved a day or a week at a time. */
function DayPick({
  label,
  value,
  onChange,
  min,
  testID,
}: {
  label: string;
  value: string;
  onChange: (date: string) => void;
  min?: string;
  testID: string;
}) {
  const move = (days: number) => {
    const to = addDays(value, days);
    onChange(min && to < min ? min : to);
  };
  return (
    <View className="gap-1.5">
      <Label>{label}</Label>
      <View className="flex-row items-center gap-1.5">
        <Button
          variant="secondary"
          size="sm"
          onPress={() => move(-7)}
          accessibilityLabel={`${label}: a week earlier`}
          testID={`${testID}-week-back`}
        >
          −7
        </Button>
        <Pressable
          role="button"
          accessibilityLabel={`${label}: a day earlier`}
          onPress={() => move(-1)}
          hitSlop={8}
          className="size-9 items-center justify-center rounded-control"
          testID={`${testID}-back`}
        >
          <Icon as={ChevronLeft} className="size-5 text-text-2" />
        </Pressable>
        <Text
          className="min-w-[104px] flex-1 text-center text-[15px] font-semibold"
          testID={testID}
        >
          {fmtDateShort(value)}
        </Text>
        <Pressable
          role="button"
          accessibilityLabel={`${label}: a day later`}
          onPress={() => move(1)}
          hitSlop={8}
          className="size-9 items-center justify-center rounded-control"
          testID={`${testID}-next`}
        >
          <Icon as={ChevronRight} className="size-5 text-text-2" />
        </Pressable>
        <Button
          variant="secondary"
          size="sm"
          onPress={() => move(7)}
          accessibilityLabel={`${label}: a week later`}
          testID={`${testID}-week-next`}
        >
          +7
        </Button>
      </View>
    </View>
  );
}

/** Question 3 on the phone: time off still coming up, each with remove, and whole days to add. */
function TimeOff({
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
  const [from, setFrom] = React.useState(today);
  const [to, setTo] = React.useState(today);
  const [note, setNote] = React.useState('');
  const [wrong, setWrong] = React.useState<string | null>(null);
  const rows = [
    ...ctx.timeOff
      .filter((t) => !answers.removeTimeOff.includes(t.id))
      .map((t) => ({
        key: t.id,
        label: myCalendarTimeOffLabel(myCalendarSavedTimeOff(t, zone)),
        remove: () => set({ removeTimeOff: [...answers.removeTimeOff, t.id] }),
      })),
    ...answers.timeOff.map((t) => ({
      key: t.key,
      label: myCalendarTimeOffLabel(t),
      remove: () => set({ timeOff: answers.timeOff.filter((x) => x.key !== t.key) }),
    })),
  ];
  const add = () => {
    const t: MyCalendarTimeOffDraft = {
      key: Math.random().toString(36).slice(2, 10),
      allDay: true,
      startDate: from,
      endDate: to,
      start: '09:00',
      end: '17:00',
      note: note.trim(),
    };
    const p = myCalendarTimeOffProblem(t);
    if (p) return setWrong(p);
    setWrong(null);
    set({ timeOff: [...answers.timeOff, t] });
    setNote('');
  };
  return (
    <>
      {rows.length ? (
        <View
          className="overflow-hidden rounded-menu border border-border bg-card"
          testID="my-calendar-setup-time-off"
        >
          {rows.map((r, n) => (
            <View
              key={r.key}
              className={cn(
                'flex-row items-center gap-3 px-4 py-3',
                n > 0 && 'border-t border-border',
              )}
            >
              <Icon as={CalendarOff} className="size-[18px] text-text-2" />
              <Text className="min-w-0 flex-1 text-[15px] font-semibold">{r.label}</Text>
              <Pressable
                role="button"
                accessibilityLabel={W.timeOff.remove(r.label)}
                onPress={r.remove}
                hitSlop={8}
                className="size-9 items-center justify-center rounded-control"
              >
                <Icon as={Trash} className="size-[18px] text-text-2" />
              </Pressable>
            </View>
          ))}
        </View>
      ) : (
        <Text className="text-[14px] text-text-2">{W.timeOff.none}</Text>
      )}
      <View className="gap-3 rounded-menu bg-card-2 px-4 py-3.5">
        <Text className="text-[15px] font-semibold">{W.timeOff.add}</Text>
        <DayPick
          label={W.timeOff.from}
          value={from}
          onChange={(d) => {
            setFrom(d);
            if (d > to) setTo(d);
          }}
          testID="my-calendar-setup-off-from"
        />
        <DayPick
          label={W.timeOff.to}
          value={to}
          min={from}
          onChange={setTo}
          testID="my-calendar-setup-off-to"
        />
        <View className="gap-1.5">
          <Label>{W.timeOff.note}</Label>
          <Input
            value={note}
            onChangeText={setNote}
            placeholder={W.timeOff.notePlaceholder}
            accessibilityLabel={W.timeOff.note}
            maxLength={500}
            testID="my-calendar-setup-off-note"
          />
        </View>
        <Button
          variant="secondary"
          icon={Plus}
          className="self-start"
          onPress={add}
          testID="my-calendar-setup-off-add"
        >
          {W.timeOff.addButton}
        </Button>
        {wrong ? <FieldError>{wrong}</FieldError> : null}
      </View>
      {problem ? <FieldError>{problem}</FieldError> : null}
      <Text className="text-[12.5px] leading-[17px] text-text-3">{W.timeOff.tip}</Text>
    </>
  );
}

/**
 * Done on the phone: what's connected, with when busy times were last checked (Connect again when the sign-in didn't
 * finish); what was set, as chips; Connect Zoom when it was asked for and isn't connected; and Close.
 */
export function MyCalendarPhoneDone({
  workspaceId,
  ctx,
  zoom,
  calls,
  onBack,
  onAgain,
  onClose,
}: {
  workspaceId: string;
  ctx: MyCalendarSetupContext;
  /** They asked to connect Zoom next. */
  zoom: boolean;
  calls: MyCalendarSetupCalls;
  /** Back from a sign-in: look again. */
  onBack: () => Promise<void>;
  /**
   * Opened from Settings once it's set up, rather than at the end of the questions: it says what's set now, with Go
   * through the questions again.
   */
  onAgain?: (() => void) | undefined;
  onClose: () => void;
}) {
  const { signIn, busy } = useSignIn(workspaceId, onBack);
  const c = ctx.connection;
  const live = !!c && c.status === 'active';
  const zoomLive = ctx.meeting?.status === 'active';
  return (
    <GuidedPage
      screen={onAgain ? 'overview' : 'done'}
      testID="my-calendar-done"
      kicker={W.phone.row}
      progress={null}
      title={onAgain ? W.summary.answers : live ? W.done.title : W.done.titleSaved}
      hint={
        onAgain ? W.summary.lead : live ? W.done.hint(providerName(c!.provider)) : W.done.hintNone
      }
      saved="idle"
      onLeave={onClose}
      leaveLabel={G.close}
      footer={
        <View className="gap-2.5">
          {onAgain ? (
            <Button variant="secondary" onPress={onAgain} testID="my-calendar-again">
              {W.summary.again}
            </Button>
          ) : null}
          <Button onPress={onClose} testID="my-calendar-done-close">
            {G.close}
          </Button>
        </View>
      }
    >
      {c ? (
        <View
          className="flex-row items-center gap-3 rounded-menu border border-border bg-card px-4 py-3.5"
          testID="my-calendar-done-connection"
        >
          <Icon
            as={live ? CircleCheck : CircleAlert}
            className={cn('size-5', live ? 'text-success-text' : 'text-warning-text')}
          />
          <View className="min-w-0 flex-1 gap-0.5">
            <Text className="text-[15px] font-semibold">
              {c.accountEmail ?? providerName(c.provider)}
            </Text>
            <Text className="text-[13px] leading-[18px] text-text-2">
              {!live
                ? W.done.notYetHint(providerName(c.provider))
                : c.busySyncedAt
                  ? W.done.checked
                  : W.done.checking}
            </Text>
          </View>
          {live ? <Badge variant="ok">{W.done.connectedBadge}</Badge> : null}
        </View>
      ) : null}
      {c && !live ? (
        <Button
          variant="secondary"
          loading={busy}
          onPress={() => void signIn(() => calls.signIn(c.provider))}
          testID="my-calendar-done-try"
        >
          {W.done.tryAgain(providerName(c.provider))}
        </Button>
      ) : null}
      {!c && onAgain ? (
        <Text className="text-[13.5px] leading-[19px] text-text-2" testID="my-calendar-done-none">
          {W.summary.noCalendarHint}
        </Text>
      ) : null}
      <View className="flex-row flex-wrap gap-2" testID="my-calendar-done-chips">
        {myCalendarDoneChips(ctx).map((chip) => (
          <View
            key={chip}
            className="flex-row items-center gap-1.5 rounded-full bg-card-2 px-2.5 py-1"
          >
            <Icon as={CircleCheck} className="size-3.5 text-success-text" />
            <Text className="text-[12.5px] font-medium">{chip}</Text>
          </View>
        ))}
      </View>
      {zoom && !zoomLive ? (
        <View className="gap-2.5 rounded-menu bg-card-2 px-4 py-3.5" testID="my-calendar-done-zoom">
          <Text className="text-[13.5px] leading-[19px]">
            <Text className="text-[13.5px] font-semibold">{W.done.zoomTitle}</Text>
            {W.done.zoomRest}
          </Text>
          <Button
            icon={Video}
            className="self-start"
            loading={busy}
            onPress={() => void signIn(calls.zoomSignIn)}
            testID="my-calendar-done-zoom-connect"
          >
            {W.done.zoomButton}
          </Button>
        </View>
      ) : null}
      {onAgain ? null : (
        <Text className="text-[13px] leading-[18px] text-text-2">{W.done.change}</Text>
      )}
    </GuidedPage>
  );
}
