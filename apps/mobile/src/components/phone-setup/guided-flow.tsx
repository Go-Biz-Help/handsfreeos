import {
  formatPhone,
  GUIDED_SETUP_WORDS as G,
  guidedSetupSavedWhen,
  LINK_WORDS,
  PHONE_SETUP_WORDS as W,
  phoneMissedNow,
  phoneMissedSummary,
  phoneRingSummary,
  phoneSetupAnswersFromNow,
  phoneSetupAnswersOf,
  phoneSetupFirstProblem,
  phoneSetupLines,
  phoneSetupNumberType,
  phoneSetupProblems,
  phoneSetupQuestions,
  phoneSetupSaveBody,
  phoneSetupStart,
  type PhoneSetupAnswers,
  type PhoneSetupContext,
  type PhoneSetupQuestion,
  type PhoneSetupScreen,
} from '@hfos/core';
import { router } from 'expo-router';
import * as React from 'react';
import { ActivityIndicator, Pressable, View, type ScrollView } from 'react-native';

import {
  ChoiceTile,
  Choices,
  GuidedFooter,
  GuidedNote,
  GuidedPage,
  useGuidedDraft,
  WelcomeBack,
} from '@/components/guided-setup/frame';
import { Check, CircleAlert, MessageCircle, Phone, PhoneCall } from '@/components/icons';
import { EmailMeALink, Note } from '@/components/onboarding-setup/screens';
import { businessHref } from '@/components/shell/business-context';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { FieldError } from '@/components/ui/label';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { api, errorMessage, unwrap } from '@/lib/api';
import { useNetwork } from '@/lib/network';
import { cn } from '@/lib/utils';
import { ONBOARDING_SETUP_PHONE_WORDS as P } from '@/onboarding-setup/words';
import type {
  PhoneGuidedDraft,
  PhoneNumberInfo,
  PhoneSetupCalls,
  PhoneSetupStatus,
} from '@/phone-setup/calls';
import { PHONE_SETUP_PHONE_WORDS as PW } from '@/phone-setup/words';
import { useColors } from '@/theme';

import { MissedEditor, QuietEditor, RingEditor } from './editors';
import { NumberPicker } from './number-picker';

/**
 * The guided phone number setup on the phone (the owner, 22 Nov 2026, "all your picks except 8b"), as the web's
 * components/phone-setup/phone-setup-flow.tsx at phone size: seven questions, one a screen, then Check it over, where
 * Get my number buys the number and sets everything the way they said (phone_setup.save). Every answer is saved as it
 * is given (guided_setup.save_draft), so leaving and coming back, here or on the web, opens on the same question with
 * the same answers. A number picked earlier that somebody else has since taken is said so, and they pick another.
 * With the number already there, the same questions open without the ones about getting it.
 *
 * What a phone leaves to a computer (HANDSFREEOS_ONBOARDING_QUICK_SETUP_IMPLEMENTATION_PLAN.md §8): moving a number
 * they already have, and getting approved to text, a long form. Each emails the person a link.
 *
 * Which questions a path asks, what is wrong with an answer, the lines on Check it over and every word are core's
 * (guided-setup/phone.ts), shared with the web.
 */

/** Why the number question is being asked again: the pick was taken, or buying it failed. */
type Lost = {
  readonly kind: 'gone' | 'failed';
  readonly display: string;
  readonly why: string | null;
};

/** How often where the number stands is asked while it's being bought. */
const GETTING_EVERY_MS = 3_000;

const byPath = (found: readonly { path: string; message: string }[]) =>
  Object.fromEntries(found.map((p) => [p.path, p.message]));

export function PhoneGuidedFlow({
  workspaceId,
  businessName,
  firstName,
  near,
  status: initial,
  draft,
  calls,
}: {
  workspaceId: string;
  businessName: string;
  firstName: string | null;
  /** The business's city and state, where local numbers are looked for first. */
  near: { readonly city: string; readonly state: string } | null;
  status: PhoneSetupStatus;
  /** The answers as they were left (guided_setup.get_draft). */
  draft: PhoneGuidedDraft;
  calls: PhoneSetupCalls;
}) {
  const { online } = useNetwork();
  const colors = useColors();
  const [status, setStatus] = React.useState(initial);
  const number = status.number;
  const usable =
    number && (number.status === 'active' || number.status === 'porting') ? number : null;
  // The path is the one the screen opened on: buying the number mid-way doesn't turn its questions into the others.
  const [mode] = React.useState<PhoneSetupContext['mode']>(usable ? 'again' : 'new');
  const ctx: PhoneSetupContext = React.useMemo(
    () => ({
      mode,
      businessName,
      teammate: status.teammate
        ? {
            name: status.teammate.name,
            on: status.teammate.on,
            canManage: status.teammate.canManage,
          }
        : null,
      // The carriers already have the registration, or approved it: wanting to text isn't a question any more.
      textingSettled:
        mode === 'again' &&
        !!usable &&
        (usable.status === 'active' ? status.nextStep : status.localRegistrationStep) !==
          'submit_registration',
      businessE164: mode === 'again' ? (usable?.e164 ?? null) : null,
    }),
    [mode, businessName, status.teammate, status.nextStep, status.localRegistrationStep, usable],
  );

  // What these answers start from, and the saved ones over them when they are for the same path.
  const [first] = React.useState(() => {
    const fresh = phoneSetupStart(ctx, near);
    const start: PhoneSetupAnswers = usable
      ? {
          ...fresh,
          ...phoneSetupAnswersFromNow({
            routing: usable.routing,
            settings: status.settings,
            teammate: status.teammate,
          }),
        }
      : fresh;
    const kept = draft.answers && draft.answers['mode'] === mode ? draft.answers : null;
    // The number this draft picked is the one that was just bought: nothing left to ask.
    const bought =
      !!usable && draft.answers?.['mode'] === 'new'
        ? phoneSetupAnswersOf(draft.answers, fresh).number?.e164 === usable.e164
        : false;
    const answers = kept ? phoneSetupAnswersOf(kept, start) : start;
    const failed =
      number?.status === 'failed' && answers.number?.e164 === number.e164
        ? ({ kind: 'failed', display: number.display, why: number.lastError } as const)
        : null;
    return {
      answers: failed ? { ...answers, number: null } : answers,
      kept: !!kept,
      bought,
      failed,
    };
  });
  const [answers, setAnswers] = React.useState<PhoneSetupAnswers>(first.answers);
  const questions = phoneSetupQuestions(answers, ctx);
  const [screen, setScreen] = React.useState<PhoneSetupScreen>(() => {
    if (first.failed) return 'number';
    const at = first.kept ? first.answers.at : null;
    const asked = phoneSetupQuestions(first.answers, ctx);
    return at === 'review' || (at && asked.includes(at)) ? at : asked[0]!;
  });
  const [view, setView] = React.useState<'questions' | 'getting' | 'done'>(
    number?.status === 'provisioning' ? 'getting' : first.bought ? 'done' : 'questions',
  );
  const [lost, setLost] = React.useState<Lost | null>(first.failed);
  const [problems, setProblems] = React.useState<Record<string, string>>({});
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [leaving, setLeaving] = React.useState(false);
  /**
   * Where Next goes back to after a detour: Check it over after its Change, or the question they were on when the
   * number they picked turned out to be taken. Not through every question again.
   */
  const [returnTo, setReturnTo] = React.useState<PhoneSetupScreen | null>(null);
  const [welcome, setWelcome] = React.useState(
    () =>
      first.kept &&
      !!draft.savedAt &&
      Date.now() - Date.parse(draft.savedAt) > 10 * 60_000 &&
      view === 'questions',
  );
  const scroller = React.useRef<ScrollView>(null);

  // Saved as they are given, with the path they belong to and the screen they were left on.
  const saving = useGuidedDraft(
    workspaceId,
    'phone',
    view === 'questions' ? { mode, ...answers, at: screen } : null,
    { hadDraft: first.kept },
  );

  const set = (patch: Partial<PhoneSetupAnswers>) => {
    setAnswers((now) => {
      let next = { ...now, ...patch };
      // Texting or the EIN answer decides the kind of number again, and a number of the other kind is put back.
      if ('texting' in patch || 'ein' in patch) next = { ...next, numberType: null };
      if (next.number && next.number.numberType !== phoneSetupNumberType(next))
        next = { ...next, number: null };
      return next;
    });
    setProblems({});
    setError(null);
  };

  const go = (to: PhoneSetupScreen) => {
    setScreen(to);
    setProblems({});
    setError(null);
    setWelcome(false);
    scroller.current?.scrollTo({ y: 0, animated: false });
  };

  // Coming back to a number picked earlier: still free? Asked once, on the way in.
  const checked = React.useRef(false);
  React.useEffect(() => {
    const picked = first.answers.number;
    if (checked.current || view !== 'questions' || mode !== 'new' || !first.kept || !picked) return;
    checked.current = true;
    // Where they had got to: past the number question, Next takes them back there once a new one is picked.
    const was = screen;
    const asked = phoneSetupQuestions(first.answers, ctx);
    const past = was === 'review' || asked.indexOf(was) > asked.indexOf('number');
    void calls.stillFree(picked.e164, picked.numberType).then((free) => {
      if (free !== false) return;
      setLost({ kind: 'gone', display: picked.display, why: null });
      setAnswers((now) => (now.number?.e164 === picked.e164 ? { ...now, number: null } : now));
      setReturnTo(past ? was : null);
      setScreen('number');
      setWelcome(false);
    });
  }, []);

  // While the number is being bought: where it stands, every few seconds (the phone has no live updates for it).
  React.useEffect(() => {
    if (view !== 'getting') return;
    let alive = true;
    const timer = setInterval(() => {
      void calls
        .status()
        .then((fresh) => {
          if (alive) setStatus(fresh);
        })
        .catch(() => {
          // No signal for a moment: the next look tries again.
        });
    }, GETTING_EVERY_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [view, calls]);
  // Bought: the answers are spent. Not bought: back to the number question, with why, and the answers still here.
  React.useEffect(() => {
    if (view !== 'getting' || !number) return;
    if (number.status === 'active') {
      setView('done');
      void saving.clear();
    } else if (number.status === 'failed') {
      saving.resume();
      setLost({ kind: 'failed', display: number.display, why: number.lastError });
      setAnswers((now) => ({ ...now, number: null }));
      setReturnTo('review');
      setScreen('number');
      setView('questions');
    }
  }, [view, number?.status]);
  // Opened on a number this draft already bought: the draft is spent.
  React.useEffect(() => {
    if (first.bought) void saving.clear();
  }, []);

  const i = screen === 'review' ? questions.length : Math.max(0, questions.indexOf(screen));

  /** "Yes, and I want to keep it": moving a number is done on a computer, so the link goes to their email. */
  async function sendMoveLink() {
    if (!online) {
      setError(P.needsSignal);
      return;
    }
    setBusy(true);
    try {
      await saving.flush();
      const out = unwrap(
        await api.POST('/v1/commands/onboarding.send_link', {
          body: { workspaceId, step: 'number' },
        }),
      );
      toast.show(out.sent ? LINK_WORDS.sent(out.email) : LINK_WORDS.alreadySent(out.email));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  function next() {
    if (screen === 'review') return;
    const found = phoneSetupProblems(screen, answers, ctx);
    if (found.length) {
      setProblems(byPath(found));
      return;
    }
    if (screen === 'have' && answers.have !== 'new') {
      void sendMoveLink();
      return;
    }
    if (screen === 'number') setLost(null);
    const after = questions[i + 1];
    if (returnTo || !after) {
      setReturnTo(null);
      // A changed answer can open a question that wasn't asked before (wanting to text asks about the EIN): that
      // one comes first, then back to where they were.
      const at = returnTo && returnTo !== 'review' ? questions.indexOf(returnTo) : -1;
      const before = at < 0 ? questions : questions.slice(0, at);
      const wrong = before.find((q) => phoneSetupProblems(q, answers, ctx).length > 0);
      go(wrong ?? (at < 0 ? 'review' : questions[at]!));
      return;
    }
    go(after);
  }

  const back = () => {
    setReturnTo(null);
    const before = screen === 'review' ? questions[questions.length - 1] : questions[i - 1];
    if (before) go(before);
  };

  const close = () => {
    if (router.canGoBack()) router.back();
    else router.replace(businessHref(workspaceId));
  };

  async function finish() {
    const wrong = phoneSetupFirstProblem(answers, ctx);
    const body = wrong ? null : phoneSetupSaveBody(answers, ctx, usable?.id ?? null);
    if (wrong || !body) {
      if (wrong) {
        go(wrong);
        setProblems(byPath(phoneSetupProblems(wrong, answers, ctx)));
      }
      return;
    }
    if (!online) {
      setError(P.needsSignal);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const picked = answers.number;
      if (mode === 'new' && picked) {
        const free = await calls.stillFree(picked.e164, picked.numberType);
        if (free === false) {
          setLost({ kind: 'gone', display: picked.display, why: null });
          setAnswers((now) => ({ ...now, number: null }));
          setReturnTo('review');
          go('number');
          return;
        }
      }
      await saving.flush();
      await calls.save(body);
      if (mode === 'new') {
        // The number is on its way: it shows as being bought until the carrier has it.
        setStatus(await calls.status());
        setView('getting');
        return;
      }
      await saving.clear();
      toast.show(PW.saved);
      close();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function leave() {
    setLeaving(true);
    if (view === 'questions') await saving.flush();
    close();
  }

  async function startOver() {
    await saving.clear();
    saving.resume();
    const fresh = phoneSetupStart(ctx, near);
    setAnswers(
      usable && mode === 'again'
        ? {
            ...fresh,
            ...phoneSetupAnswersFromNow({
              routing: usable.routing,
              settings: status.settings,
              teammate: status.teammate,
            }),
          }
        : fresh,
    );
    setLost(null);
    setReturnTo(null);
    go(phoneSetupQuestions(fresh, ctx)[0]!);
  }

  if (view === 'getting')
    return (
      <GuidedPage
        screen="getting"
        testID="phone-setup"
        kicker={W.stop}
        progress={null}
        title={W.getting.title(number?.display ?? answers.number?.display ?? 'your number')}
        hint={W.getting.hint}
        saved="idle"
        onLeave={close}
        footer={null}
      >
        <View className="items-center py-10" role="status" testID="phone-setup-getting">
          <ActivityIndicator color={colors.accent} />
        </View>
      </GuidedPage>
    );

  if (view === 'done' && usable)
    return (
      <PhoneGuidedDone workspaceId={workspaceId} status={status} number={usable} onClose={close} />
    );

  const lines = phoneSetupLines(answers, ctx);
  const when = draft.savedAt ? guidedSetupSavedWhen(draft.savedAt, new Date()) : null;
  const banner = (
    <>
      {welcome && when ? (
        <WelcomeBack
          line={`${G.welcomeBack(firstName, when)}${i > 0 && screen !== 'review' ? ` ${G.stoppedAt(i + 1)}` : ''}`}
          onStartOver={() => void startOver()}
        />
      ) : null}
      {lost && screen === 'number' ? (
        <View
          className="flex-row items-start gap-2.5 rounded-menu bg-warning-soft px-3.5 py-3"
          role="alert"
          testID={lost.kind === 'gone' ? 'number-gone' : 'number-failed'}
        >
          <Icon as={CircleAlert} className="mt-0.5 size-4 text-warning-text" />
          <View className="min-w-0 flex-1 gap-0.5">
            <Text className="text-[14px] font-semibold text-warning-text">
              {lost.kind === 'gone'
                ? W.number.goneTitle(lost.display)
                : W.number.failedTitle(lost.display)}
            </Text>
            <Text className="text-[13.5px] leading-[19px] text-warning-text">
              {lost.kind === 'gone' ? W.number.gone : W.number.failed(lost.why)}
            </Text>
          </View>
        </View>
      ) : null}
    </>
  );

  const page = (
    title: string,
    hint: string | undefined,
    children: React.ReactNode,
    footer: React.ReactNode,
  ) => (
    <GuidedPage
      screen={screen}
      testID="phone-setup"
      kicker={screen === 'review' ? G.checkKicker : G.question(i + 1, questions.length)}
      settingUp={W.stop}
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
  const question = (title: string, hint: string, children: React.ReactNode, nextLabel?: string) =>
    page(
      title,
      hint,
      children,
      <GuidedFooter
        onBack={i > 0 ? back : undefined}
        onNext={next}
        busy={busy}
        error={error}
        testID="phone-setup"
        nextLabel={
          nextLabel ??
          (returnTo === 'review' || (!returnTo && i === questions.length - 1)
            ? G.checkItOver
            : G.next)
        }
      />,
    );
  const editor = { answers, set, problems, ctx };

  if (screen === 'review') {
    const kind = phoneSetupNumberType(answers);
    const N = W.review.next;
    const happens: (readonly string[])[] = [
      ...(mode === 'new' ? [N.mine] : []),
      ...(ctx.textingSettled
        ? []
        : answers.texting
          ? [N.approval, kind === 'local' ? N.carriersLocal : N.carriersTollFree, N.on]
          : [N.callsOnly]),
    ];
    return page(
      W.review.title,
      `${mode === 'new' ? W.review.hintNew : W.review.hintAgain} ${G.answersKept}`,
      <>
        <View className="overflow-hidden rounded-menu border border-border bg-card">
          {lines
            .filter((l) => l.question !== 'have' && l.question !== 'ein')
            .map((l, at) => (
              <View
                key={l.question}
                className={cn('gap-1 px-4 py-3.5', at > 0 && 'border-t border-border')}
                testID={`review-${l.question}`}
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
                      go(l.question);
                    }}
                    hitSlop={{ top: 10, bottom: 10, left: 8, right: 8 }}
                    testID={`review-change-${l.question}`}
                  >
                    <Text className="text-[14px] font-medium text-accent-text">{G.change}</Text>
                  </Pressable>
                </View>
                <Text
                  className={cn(
                    l.question === 'number'
                      ? 'font-mono text-[17px] font-medium'
                      : 'text-[15px] font-semibold',
                  )}
                >
                  {l.value ?? ''}
                </Text>
                {l.sub ? (
                  <Text className="text-[13px] leading-[18px] text-text-2">{l.sub}</Text>
                ) : null}
              </View>
            ))}
        </View>
        {mode === 'new' ? (
          <GuidedNote>
            <Text className="text-[13.5px] font-medium">{W.review.setTitle}</Text>
            {W.review.set
              .filter((_, at) => answers.texting || at === 0)
              .map((line) => (
                <View key={line} className="flex-row items-start gap-2">
                  <Icon as={Check} className="mt-0.5 size-3.5 text-success" strokeWidth={2.5} />
                  <Text className="min-w-0 flex-1 text-[13px] leading-[18px] text-text-2">
                    {line}
                  </Text>
                </View>
              ))}
          </GuidedNote>
        ) : null}
        {happens.length ? (
          <View className="gap-3" testID="review-next">
            <Text className="text-[11.5px] font-semibold uppercase tracking-[0.4px] text-text-3">
              {W.review.nextTitle}
            </Text>
            {happens.map(([title, text], at) => (
              <View key={title} className="flex-row items-start gap-2.5">
                <View className="mt-px size-5 items-center justify-center rounded-full border border-border-strong">
                  <Text className="text-[11px] font-semibold text-text-2">{at + 1}</Text>
                </View>
                <View className="min-w-0 flex-1">
                  <Text className="text-[13.5px] font-medium">{title}</Text>
                  <Text className="text-[13px] leading-[18px] text-text-2">{text}</Text>
                </View>
              </View>
            ))}
          </View>
        ) : null}
      </>,
      <GuidedFooter
        onBack={back}
        onNext={() => void finish()}
        busy={busy}
        error={error}
        nextLabel={mode === 'new' ? W.review.finishNew : W.review.finishAgain}
        testID="phone-setup"
      />,
    );
  }

  switch (screen as PhoneSetupQuestion) {
    case 'have':
      return question(
        W.have.title,
        W.have.hint,
        <>
          <Choices label={W.have.title}>
            {(['new', 'keep', 'twilio'] as const).map((k) => (
              <ChoiceTile
                key={k}
                selected={answers.have === k}
                onSelect={() => set({ have: k })}
                title={W.have[k].title}
                hint={W.have[k].hint}
                testID={`have-${k}`}
              >
                {k !== 'new' ? (
                  <Text
                    className="text-[13px] leading-[18px] text-text-2"
                    testID="have-on-computer"
                  >
                    {PW.moveOnComputer}
                  </Text>
                ) : null}
              </ChoiceTile>
            ))}
          </Choices>
          <FieldError>{problems['have']}</FieldError>
          <GuidedNote>
            <Text className="text-[13.5px] leading-[19px] text-text-2">{W.have.note}</Text>
          </GuidedNote>
        </>,
        answers.have && answers.have !== 'new' ? LINK_WORDS.action : undefined,
      );
    case 'texting':
      return question(
        W.texting.title,
        W.texting.hint,
        <>
          <Choices label={W.texting.title}>
            <ChoiceTile
              selected={answers.texting === true}
              onSelect={() => set({ texting: true })}
              title={W.texting.yes.title}
              hint={mode === 'new' ? W.texting.yes.hint : W.texting.yes.hintAgain}
              best={W.best}
              testID="texting-yes"
            />
            <ChoiceTile
              selected={answers.texting === false}
              onSelect={() => set({ texting: false })}
              title={W.texting.no.title}
              hint={W.texting.no.hint}
              testID="texting-no"
            />
          </Choices>
          <FieldError>{problems['texting']}</FieldError>
          <GuidedNote>
            <Text className="text-[13.5px] font-medium">{W.texting.takesTitle}</Text>
            {W.texting.takes.map((line) => (
              <View key={line} className="flex-row items-start gap-2">
                <Text className="text-[13px] leading-[18px] text-text-2">•</Text>
                <Text className="min-w-0 flex-1 text-[13px] leading-[18px] text-text-2">
                  {line}
                </Text>
              </View>
            ))}
          </GuidedNote>
        </>,
      );
    case 'ein':
      return question(
        W.ein.title,
        W.ein.hint,
        <>
          <Choices label={W.ein.title}>
            <ChoiceTile
              selected={answers.ein === true}
              onSelect={() => set({ ein: true })}
              title={W.ein.yes.title}
              hint={W.ein.yes.hint}
              testID="ein-yes"
            />
            <ChoiceTile
              selected={answers.ein === false}
              onSelect={() => set({ ein: false })}
              title={W.ein.no.title}
              hint={W.ein.no.hint}
              testID="ein-no"
            />
          </Choices>
          <FieldError>{problems['ein']}</FieldError>
          <GuidedNote>
            <Text className="text-[13.5px] leading-[19px] text-text-2">
              {W.ein.note} {W.ein.unsure}
            </Text>
          </GuidedNote>
        </>,
      );
    case 'number': {
      const kind = phoneSetupNumberType(answers);
      const place = [answers.search.city, answers.search.state].filter(Boolean).join(', ');
      return question(
        lost ? W.number.titleAgain : W.number.title,
        `${
          kind === 'toll_free'
            ? W.number.hintTollFree
            : answers.search.city && answers.search.state
              ? W.number.hintNear(place)
              : W.number.hintLocal
        }${lost ? ` ${W.number.goneHint}` : ''}`,
        <>
          <NumberPicker
            workspaceId={workspaceId}
            answers={answers}
            set={set}
            // Only with an EIN can a local number be approved to text, so without one it stays toll-free.
            canSwitchKind={!(answers.texting === true && answers.ein === false)}
            calls={calls}
          />
          <FieldError>{problems['number']}</FieldError>
          <GuidedNote>
            <Text className="text-[13.5px] leading-[19px] text-text-2">{W.number.notYet}</Text>
          </GuidedNote>
        </>,
      );
    }
    case 'ring':
      return question(W.ring.title, W.ring.hint, <RingEditor {...editor} />);
    case 'missed':
      return question(W.missed.title, W.missed.hint, <MissedEditor {...editor} />);
    case 'quiet':
      return question(
        W.quiet.title,
        W.quiet.hint,
        <QuietEditor {...editor} timezone={status.timezone} />,
      );
  }
}

/**
 * The number is theirs: what to try now, and texting approval next for those who want to text. That is a long
 * form, so on the phone it emails them a link to it.
 */
function PhoneGuidedDone({
  workspaceId,
  status,
  number,
  onClose,
}: {
  workspaceId: string;
  status: PhoneSetupStatus;
  number: PhoneNumberInfo;
  onClose: () => void;
}) {
  const local = number.numberType === 'local';
  const texts = status.settings.texting !== 'not_now';
  const approve = texts && !status.messagingReady;
  const ring = phoneRingSummary(
    number.routing.forwarding.map((f) => ({
      label: f.label,
      number: formatPhone(f.e164),
      enabled: f.enabled,
    })),
    number.routing.forwardedCallerId,
  );
  const missedNow = phoneMissedNow({
    routing: number.routing,
    settings: status.settings,
    teammate: status.teammate,
  });
  const missed = phoneMissedSummary(
    { then: missedNow.then, mode: missedNow.mode, ringSeconds: number.routing.ringSeconds },
    status.teammate,
  );
  return (
    <GuidedPage
      screen="done"
      testID="phone-setup"
      kicker={W.done.kicker}
      progress={null}
      title={number.display}
      hint={W.done.mine}
      saved="idle"
      onLeave={onClose}
      leaveLabel={G.close}
      footer={
        approve ? null : (
          <Button onPress={onClose} testID="phone-setup-done-close">
            {G.close}
          </Button>
        )
      }
    >
      <View className="flex-row flex-wrap gap-1.5" testID="phone-setup-done">
        <Badge variant="ok">
          <Icon as={Phone} className="size-3.5 text-success-text" />
          <Text className="text-xs font-medium text-success-text">{W.done.calls}</Text>
        </Badge>
        {status.messagingReady ? null : texts ? (
          <Badge variant="pending">
            <Icon as={MessageCircle} className="size-3.5 text-warning-text" />
            <Text className="text-xs font-medium text-warning-text">{W.done.textingNeeds}</Text>
          </Badge>
        ) : (
          <Badge variant="gray">{W.done.textingOff}</Badge>
        )}
      </View>
      <GuidedNote>
        <View className="flex-row items-center gap-2">
          <Icon as={PhoneCall} className="size-4 text-text" />
          <Text className="text-[14px] font-medium">{W.done.tryTitle}</Text>
        </View>
        <Text className="text-[13.5px] leading-[19px] text-text-2">
          {W.done.tryCall(number.display, ring.value)}
        </Text>
        <Text className="text-[13.5px] leading-[19px] text-text-2">
          Let it ring out: {missed.value.charAt(0).toLowerCase() + missed.value.slice(1)}.
        </Text>
      </GuidedNote>
      {approve ? (
        <View
          className="gap-3 rounded-menu border border-border bg-card p-4"
          testID="phone-setup-approval"
        >
          <Text className="text-[11.5px] font-semibold uppercase tracking-[0.4px] text-text-3">
            {W.done.nextTitle}
          </Text>
          <Text className="text-[17px] font-semibold">{W.done.approveTitle}</Text>
          <Text className="text-[14px] leading-[20px] text-text-2">{W.done.approve}</Text>
          {[
            W.done.approveTime(local),
            ...(local ? [W.done.approveFee, W.done.approveHandy] : []),
          ].map((line) => (
            <View key={line} className="flex-row items-start gap-2">
              <Text className="text-[13px] leading-[18px] text-text-2">•</Text>
              <Text className="min-w-0 flex-1 text-[13px] leading-[18px] text-text-2">{line}</Text>
            </View>
          ))}
          <Note>{PW.approveOnComputer}</Note>
          <View className="flex-row flex-wrap items-center gap-2">
            <EmailMeALink
              workspaceId={workspaceId}
              step="number"
              testID="phone-setup-approval-link"
            />
            <Button variant="ghost" size="sm" onPress={onClose} testID="phone-setup-later">
              {W.done.later}
            </Button>
          </View>
        </View>
      ) : null}
    </GuidedPage>
  );
}
