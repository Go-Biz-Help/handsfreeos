'use client';
/**
 * The guided phone number setup on the web (the owner, 22 Nov 2026, "all your picks except 8b"): seven questions on a
 * page of their own, then Check it over, where Get my number buys the number and sets everything the way they said
 * (phone_setup.save). Every answer is saved as it is given (guided_setup.save_draft), so leaving and coming back opens
 * on the same question with the same answers. A number picked earlier that somebody else has since taken is said so,
 * and they pick another. With the number already there, the same questions open without the ones about getting it
 * ("Run the guided setup again" on Settings → Texting & calls).
 *
 * Which questions a path asks, what is wrong with an answer and the lines beside the questions are core's
 * (guided-setup/phone.ts), shared with the phone.
 */
import {
  GUIDED_SETUP_WORDS as G,
  guidedSetupSavedWhen,
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
  formatPhone,
  type PhoneSetupAnswers,
  type PhoneSetupContext,
  type PhoneSetupQuestion,
  type PhoneSetupScreen,
} from '@hfos/core';
import { Check, CircleAlert, MessageCircle, Phone, PhoneCall } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
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
import { Badge } from '@/components/ui/badge';
import { Button, ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { PhoneSetupStatus } from '@/lib/api/types';
import { numberStillFree } from '@/lib/api/worker';
import { useLiveRefresh } from '@/lib/realtime/live-provider';
import { MissedEditor, QuietEditor, RingEditor } from './editors';
import { NumberPicker } from './number-picker';

/** Why the number question is being asked again: the pick was taken, or buying it failed. */
type Lost = {
  readonly kind: 'gone' | 'failed';
  readonly display: string;
  readonly why: string | null;
};

export function PhoneSetupFlow({
  workspaceId,
  businessName,
  email,
  firstName,
  near,
  status,
  draft,
  done,
}: {
  workspaceId: string;
  businessName: string;
  /** Who's signed in, under the card. */
  email: string;
  firstName: string | null;
  /** The business's city and state, where local numbers are looked for first. */
  near: { readonly city: string; readonly state: string } | null;
  status: PhoneSetupStatus;
  /** The answers as they were left (guided_setup.get_draft). */
  draft: { readonly answers: Record<string, unknown> | null; readonly savedAt: string | null };
  /** `?done=1`: back on the page after the number was bought. */
  done: boolean;
}) {
  useLiveRefresh(['phone_number', 'registration', 'workspace', 'ai_teammate']);
  const router = useRouter();
  const settings = `/app/w/${workspaceId}/settings/texting`;
  const number = status.number;
  const usable =
    number && (number.status === 'active' || number.status === 'porting') ? number : null;
  const mode: PhoneSetupContext['mode'] = usable ? 'again' : 'new';
  const ctx: PhoneSetupContext = useMemo(
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
        !!usable &&
        (usable.status === 'active' ? status.nextStep : status.localRegistrationStep) !==
          'submit_registration',
      businessE164: usable?.e164 ?? null,
    }),
    [mode, businessName, status.teammate, status.nextStep, status.localRegistrationStep, usable],
  );

  // What these answers start from, and the saved ones over them when they are for the same path.
  const [first] = useState(() => {
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
  const [answers, setAnswers] = useState<PhoneSetupAnswers>(first.answers);
  const questions = phoneSetupQuestions(answers, ctx);
  const [screen, setScreen] = useState<PhoneSetupScreen>(() => {
    if (first.failed) return 'number';
    const at = first.kept ? first.answers.at : null;
    const asked = phoneSetupQuestions(first.answers, ctx);
    return at === 'review' || (at && asked.includes(at)) ? at : asked[0]!;
  });
  const [view, setView] = useState<'questions' | 'getting' | 'done'>(
    number?.status === 'provisioning'
      ? 'getting'
      : (done && usable) || first.bought
        ? 'done'
        : 'questions',
  );
  const [lost, setLost] = useState<Lost | null>(first.failed);
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [leaving, setLeaving] = useState(false);
  /**
   * Where Next goes back to after a detour: Check it over after its Change, or the question they were on when the
   * number they picked turned out to be taken. Not through every question again.
   */
  const [returnTo, setReturnTo] = useState<PhoneSetupScreen | null>(null);
  const [welcome, setWelcome] = useState(
    () =>
      first.kept &&
      !!draft.savedAt &&
      Date.now() - Date.parse(draft.savedAt) > 10 * 60_000 &&
      view === 'questions',
  );
  const [startingOver, setStartingOver] = useState(false);
  const top = useRef<HTMLDivElement>(null);

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
    top.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  // Coming back to a number picked earlier: still free? Asked once, on the way in.
  const checked = useRef(false);
  useEffect(() => {
    const picked = first.answers.number;
    if (checked.current || view !== 'questions' || mode !== 'new' || !first.kept || !picked) return;
    checked.current = true;
    // Where they had got to: past the number question, Next takes them back there once a new one is picked.
    const was = screen;
    const asked = phoneSetupQuestions(first.answers, ctx);
    const past = was === 'review' || asked.indexOf(was) > asked.indexOf('number');
    void numberStillFree({ workspaceId, e164: picked.e164, numberType: picked.numberType }).then(
      (free) => {
        if (free !== false) return;
        setLost({ kind: 'gone', display: picked.display, why: null });
        setAnswers((now) => (now.number?.e164 === picked.e164 ? { ...now, number: null } : now));
        setReturnTo(past ? was : null);
        setScreen('number');
        setWelcome(false);
      },
    );
  }, []);

  // While the number is being bought: check again every few seconds, in case the live channel is down.
  useEffect(() => {
    if (view !== 'getting') return;
    const timer = setInterval(() => router.refresh(), 3000);
    return () => clearInterval(timer);
  }, [view, router]);
  // Bought: the answers are spent. Not bought: back to the number question, with why, and the answers still here.
  useEffect(() => {
    if (view !== 'getting' || !number) return;
    if (number.status === 'active') {
      setView('done');
      void saving.clear();
      router.replace(`/onboarding/${workspaceId}/phone?done=1`);
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
  useEffect(() => {
    if (first.bought) void saving.clear();
  }, []);

  const i = screen === 'review' ? questions.length : Math.max(0, questions.indexOf(screen));

  function next() {
    if (screen === 'review') return;
    const found = phoneSetupProblems(screen, answers, ctx);
    if (found.length) {
      setProblems(Object.fromEntries(found.map((p) => [p.path, p.message])));
      return;
    }
    // A number that stays with them is moved, not bought: those screens are on Settings → Texting & calls.
    if (screen === 'have' && answers.have !== 'new') {
      setBusy(true);
      void saving.flush().finally(() => {
        router.push(`${settings}?bring=${answers.have === 'keep' ? 'carrier' : 'choose'}`);
      });
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

  async function finish() {
    const wrong = phoneSetupFirstProblem(answers, ctx);
    const body = wrong ? null : phoneSetupSaveBody(answers, ctx, usable?.id ?? null);
    if (wrong || !body) {
      if (wrong) {
        go(wrong);
        setProblems(
          Object.fromEntries(
            phoneSetupProblems(wrong, answers, ctx).map((p) => [p.path, p.message]),
          ),
        );
      }
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const picked = answers.number;
      if (mode === 'new' && picked) {
        const free = await numberStillFree({
          workspaceId,
          e164: picked.e164,
          numberType: picked.numberType,
        });
        if (free === false) {
          setLost({ kind: 'gone', display: picked.display, why: null });
          setAnswers((now) => ({ ...now, number: null }));
          setReturnTo('review');
          go('number');
          return;
        }
      }
      await saving.flush();
      unwrap(
        await apiBrowser().POST('/v1/commands/phone_setup.save', {
          body: { workspaceId, ...body },
        }),
      );
      if (mode === 'new') {
        setView('getting');
        router.refresh();
        return;
      }
      await saving.clear();
      toast.success('Saved. Your number is set up the way you said.');
      router.push(settings);
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function leave() {
    setLeaving(true);
    if (view === 'questions') await saving.flush();
    router.push(settings);
    router.refresh();
  }

  async function startOver() {
    await saving.clear();
    saving.resume();
    const fresh = phoneSetupStart(ctx, near);
    setAnswers(
      usable
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
    setStartingOver(false);
    setReturnTo(null);
    go(phoneSetupQuestions(fresh, ctx)[0]!);
  }

  const page = (children: ReactNode, leaveLabel?: string) => (
    <GuidedPage
      business={{ name: businessName, home: `/app/w/${workspaceId}` }}
      email={email}
      settingUp={W.settingUp(businessName)}
      saved={view === 'questions' ? saving.state : 'idle'}
      onLeave={() => void leave()}
      leaving={leaving}
      {...(leaveLabel ? { leaveLabel } : {})}
    >
      <div ref={top} className="w-full scroll-mt-20">
        {children}
      </div>
    </GuidedPage>
  );

  if (view === 'getting')
    return page(
      <Card
        className="mx-auto flex w-full max-w-[640px] flex-col items-center gap-3 rounded-dialog p-10 text-center"
        data-testid="phone-setup-getting"
        role="status"
      >
        <span className="h-6 w-6 animate-spin rounded-full border-2 border-accent border-t-transparent" />
        <h1 className="text-[22px] font-semibold tracking-[-0.015em]">
          {W.getting.title(number?.display ?? answers.number?.display ?? 'your number')}
        </h1>
        <p className="text-text-2">{W.getting.hint}</p>
      </Card>,
    );

  if (view === 'done' && usable)
    return page(
      <DoneScreen
        workspaceId={workspaceId}
        status={status}
        number={usable}
        settings={settings}
        bought
      />,
      G.close,
    );

  const lines = phoneSetupLines(answers, ctx);
  const steps: GuidedStep[] = lines.map((l, at) => ({
    key: l.question,
    label: l.label,
    value: l.value,
    state: at < i ? 'done' : at === i ? 'now' : 'todo',
  }));
  const when = draft.savedAt ? guidedSetupSavedWhen(draft.savedAt, new Date()) : null;
  const banner = (
    <>
      {welcome && when ? (
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
              <Button
                size="sm"
                onClick={() => void startOver()}
                data-testid="guided-start-over-yes"
              >
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
      ) : null}
      {lost && screen === 'number' ? (
        <Callout
          tone="warning"
          icon={CircleAlert}
          data-testid={lost.kind === 'gone' ? 'number-gone' : 'number-failed'}
        >
          <div className="font-semibold">
            {lost.kind === 'gone'
              ? W.number.goneTitle(lost.display)
              : W.number.failedTitle(lost.display)}
          </div>
          <div>{lost.kind === 'gone' ? W.number.gone : W.number.failed(lost.why)}</div>
        </Callout>
      ) : null}
    </>
  );
  const position = `${G.question(i + 1, questions.length)} · ${W.stop}`;
  const footer = (nextLabel?: string) => (
    <GuidedFooter
      onBack={i > 0 ? back : undefined}
      onNext={next}
      busy={busy}
      error={error}
      testId="phone-setup"
      nextLabel={
        nextLabel ??
        (returnTo === 'review' || (!returnTo && i === questions.length - 1)
          ? G.checkItOver
          : G.next)
      }
    />
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
      <GuidedCard
        screen="review"
        testId="phone-setup"
        kicker={`${G.checkKicker} · ${W.stop}`}
        title={W.review.title}
        hint={`${mode === 'new' ? W.review.hintNew : W.review.hintAgain} ${G.answersKept}`}
        banner={banner}
        aside={
          happens.length ? (
            <>
              <div className="text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3">
                {W.review.nextTitle}
              </div>
              <ol className="flex flex-col gap-3">
                {happens.map(([title, text], at) => (
                  <li key={title} className="flex items-start gap-2.5">
                    <span
                      aria-hidden
                      className="mt-px inline-flex h-5 w-5 flex-none items-center justify-center rounded-full border border-border-strong text-[11px] font-semibold text-text-2"
                    >
                      {at + 1}
                    </span>
                    <span className="flex flex-col">
                      <span className="text-[13px] font-medium">{title}</span>
                      <span className="text-[13px] text-text-2">{text}</span>
                    </span>
                  </li>
                ))}
              </ol>
            </>
          ) : undefined
        }
        footer={
          <GuidedFooter
            onBack={back}
            onNext={() => void finish()}
            busy={busy}
            error={error}
            nextIcon={false}
            nextLabel={mode === 'new' ? W.review.finishNew : W.review.finishAgain}
            testId="phone-setup"
          />
        }
      >
        <div className="overflow-hidden rounded-menu border border-border">
          {lines
            .filter((l) => l.question !== 'have' && l.question !== 'ein')
            .map((l) => (
              <div
                key={l.question}
                className="flex items-start justify-between gap-4 border-b border-border px-4 py-3 last:border-b-0"
                data-testid={`review-${l.question}`}
              >
                <div className="flex min-w-0 flex-col gap-0.5">
                  <div className="text-xs font-medium uppercase tracking-[0.04em] text-text-3">
                    {l.label}
                  </div>
                  <div
                    className={
                      l.question === 'number'
                        ? 'font-mono text-[17px] font-medium'
                        : 'font-semibold'
                    }
                  >
                    {l.value}
                  </div>
                  {l.sub ? <div className="text-[13px] text-text-2">{l.sub}</div> : null}
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setReturnTo('review');
                    go(l.question);
                  }}
                  data-testid={`review-change-${l.question}`}
                >
                  {G.change}
                </Button>
              </div>
            ))}
        </div>
        {mode === 'new' ? (
          <GuidedNote>
            <div className="mb-1.5 font-medium text-text">{W.review.setTitle}</div>
            <ul className="flex flex-col gap-1">
              {W.review.set
                .filter((_, at) => answers.texting || at === 0)
                .map((line) => (
                  <li key={line} className="flex items-start gap-2">
                    <Check
                      className="mt-0.5 h-3.5 w-3.5 flex-none text-success"
                      strokeWidth={2.5}
                    />
                    {line}
                  </li>
                ))}
            </ul>
          </GuidedNote>
        ) : null}
      </GuidedCard>,
    );
  }

  const card = (
    q: PhoneSetupQuestion,
    title: string,
    hint: string,
    children: ReactNode,
    opts: { nextLabel?: string; kicker?: string } = {},
  ) =>
    page(
      <GuidedCard
        screen={q}
        testId="phone-setup"
        kicker={opts.kicker ?? position}
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

  switch (screen) {
    case 'have':
      return card(
        'have',
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
                testId={`have-${k}`}
              />
            ))}
          </Choices>
          {problems['have'] ? <Problem>{problems['have']}</Problem> : null}
          <GuidedNote>{W.have.note}</GuidedNote>
        </>,
        answers.have && answers.have !== 'new' ? { nextLabel: W.have.moveNext } : {},
      );
    case 'texting':
      return card(
        'texting',
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
              testId="texting-yes"
            />
            <ChoiceTile
              selected={answers.texting === false}
              onSelect={() => set({ texting: false })}
              title={W.texting.no.title}
              hint={W.texting.no.hint}
              testId="texting-no"
            />
          </Choices>
          {problems['texting'] ? <Problem>{problems['texting']}</Problem> : null}
          <GuidedNote>
            <div className="mb-1.5 font-medium text-text">{W.texting.takesTitle}</div>
            <ul className="flex list-disc flex-col gap-1 pl-4">
              {W.texting.takes.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </GuidedNote>
        </>,
      );
    case 'ein':
      return card(
        'ein',
        W.ein.title,
        W.ein.hint,
        <>
          <Choices label={W.ein.title}>
            <ChoiceTile
              selected={answers.ein === true}
              onSelect={() => set({ ein: true })}
              title={W.ein.yes.title}
              hint={W.ein.yes.hint}
              testId="ein-yes"
            />
            <ChoiceTile
              selected={answers.ein === false}
              onSelect={() => set({ ein: false })}
              title={W.ein.no.title}
              hint={W.ein.no.hint}
              testId="ein-no"
            />
          </Choices>
          {problems['ein'] ? <Problem>{problems['ein']}</Problem> : null}
          <GuidedNote>
            {W.ein.note} {W.ein.unsure}
          </GuidedNote>
        </>,
      );
    case 'number': {
      const kind = phoneSetupNumberType(answers);
      const place = [answers.search.city, answers.search.state].filter(Boolean).join(', ');
      return card(
        'number',
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
          />
          {problems['number'] ? <Problem>{problems['number']}</Problem> : null}
          <GuidedNote>{W.number.notYet}</GuidedNote>
        </>,
        lost && first.kept
          ? { kicker: `Welcome back · ${G.question(i + 1, questions.length)}` }
          : {},
      );
    }
    case 'ring':
      return card('ring', W.ring.title, W.ring.hint, <RingEditor {...editor} />);
    case 'missed':
      return card('missed', W.missed.title, W.missed.hint, <MissedEditor {...editor} />);
    case 'quiet':
      return card(
        'quiet',
        W.quiet.title,
        W.quiet.hint,
        <QuietEditor {...editor} timezone={status.timezone} />,
      );
  }
}

const Problem = ({ children }: { children: ReactNode }) => (
  <p className="text-[13.5px] font-medium text-danger-text" role="alert">
    {children}
  </p>
);

/** The number is theirs: what to try now, and texting approval next for those who want to text. */
function DoneScreen({
  workspaceId,
  status,
  number,
  settings,
  bought,
}: {
  workspaceId: string;
  status: PhoneSetupStatus;
  number: NonNullable<PhoneSetupStatus['number']>;
  settings: string;
  bought: boolean;
}) {
  const local = number.numberType === 'local';
  const texts = status.settings.texting !== 'not_now';
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
    <Card
      className="mx-auto flex w-full max-w-[720px] flex-col gap-6 rounded-dialog p-6 sm:p-9"
      data-testid="phone-setup-done"
    >
      <div className="flex flex-col gap-2">
        <div className="text-xs font-medium uppercase tracking-[0.04em] text-text-3">
          {W.done.kicker}
        </div>
        <h1
          className="font-mono text-[30px] font-medium leading-tight tracking-[-0.01em]"
          data-testid="phone-setup-done-number"
        >
          {number.display}
        </h1>
        <p className="text-[15px] text-text-2">{bought ? W.done.mine : W.done.saved}</p>
        <div className="mt-1 flex flex-wrap gap-1.5">
          <Badge variant="ok">
            <Phone className="h-3.5 w-3.5" strokeWidth={1.75} />
            {W.done.calls}
          </Badge>
          {status.messagingReady ? null : texts ? (
            <Badge variant="pending">
              <MessageCircle className="h-3.5 w-3.5" strokeWidth={1.75} />
              {W.done.textingNeeds}
            </Badge>
          ) : (
            <Badge variant="gray">{W.done.textingOff}</Badge>
          )}
        </div>
      </div>
      <GuidedNote>
        <div className="mb-1 flex items-center gap-2 font-medium text-text">
          <PhoneCall className="h-4 w-4" strokeWidth={1.75} />
          {W.done.tryTitle}
        </div>
        <p>{W.done.tryCall(number.display, ring.value)}</p>
        <p>Let it ring out: {missed.value.charAt(0).toLowerCase() + missed.value.slice(1)}.</p>
      </GuidedNote>
      {texts && !status.messagingReady ? (
        <div className="flex flex-col gap-3 rounded-menu border border-border p-4 sm:p-5">
          <div className="text-xs font-medium uppercase tracking-[0.04em] text-text-3">
            {W.done.nextTitle}
          </div>
          <h2 className="text-lg font-semibold tracking-tight">{W.done.approveTitle}</h2>
          <p className="text-text-2">{W.done.approve}</p>
          <ul className="flex list-disc flex-col gap-1 pl-4 text-[13.5px] text-text-2">
            <li>{W.done.approveTime(local)}</li>
            {local ? <li>{W.done.approveFee}</li> : null}
            {local ? <li>{W.done.approveHandy}</li> : null}
          </ul>
          <div className="mt-1 flex flex-wrap gap-2">
            <ButtonLink
              href={`${settings}#approval`}
              variant="primary"
              size="lg"
              data-testid="phone-setup-approval"
            >
              {W.done.start}
            </ButtonLink>
            <ButtonLink
              href={`/app/w/${workspaceId}`}
              variant="ghost"
              size="lg"
              data-testid="phone-setup-later"
            >
              {W.done.later}
            </ButtonLink>
          </div>
        </div>
      ) : (
        <div>
          <ButtonLink
            href={settings}
            variant="primary"
            size="lg"
            data-testid="phone-setup-to-settings"
          >
            {W.done.toSettings}
          </ButtonLink>
        </div>
      )}
    </Card>
  );
}
