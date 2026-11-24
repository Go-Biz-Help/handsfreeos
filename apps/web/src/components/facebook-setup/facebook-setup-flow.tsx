'use client';
/**
 * The guided Facebook & Instagram setup on the web (the owner, 24 Nov 2026: F1 a, F2 a, F3 a, F4 a): Settings →
 * Facebook & Instagram opens it (Start while nothing is connected, Change, Go through the questions again). Four
 * questions on a page of their own (what lands in the inbox, getting Instagram ready, someone new, ads), then Check it
 * over, where Connect with Facebook saves them (facebook_setup.save) and opens Facebook's own sign-in. Facebook comes
 * back to Send yourself a test message (FacebookSetupTest, through setup-return.ts), where a message sent to the Page
 * and to Instagram turns green the moment it lands (F2). With a Page already connected, Save my answers changes the
 * answers and keeps the sign-in. Every answer is saved as it's given (guided_setup.save_draft), so leaving and coming
 * back opens on the same question with the same answers.
 *
 * Where the answers start, what is wrong with one, the lines beside the questions and the test's words are core's
 * (guided-setup/facebook.ts), shared with the phone.
 */
import {
  FACEBOOK_SETUP_WORDS as W,
  FACEBOOK_TEST_HINT_AFTER_MS,
  facebookSetupAnswersOf,
  facebookSetupFirstProblem,
  facebookSetupLines,
  facebookSetupOpenStages,
  facebookSetupPipeline,
  facebookSetupProblems,
  facebookSetupQuestionOf,
  facebookSetupQuestions,
  facebookSetupScreen,
  facebookSetupStart,
  facebookSignInSteps,
  GUIDED_SETUP_WORDS as G,
  guidedSetupSavedWhen,
  metaAccountLabel,
  type FacebookSetupAccount,
  type FacebookSetupAnswers,
  type FacebookSetupContext,
  type FacebookSetupQuestion,
  type FacebookSetupScreen,
  type MetaAccountTestMessages,
} from '@hfos/core';
import { CircleAlert, CircleCheck, Clock, FileText, Inbox, Megaphone, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
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
import { InstagramIcon, MessengerIcon } from '@/components/inbox/social-bits';
import { Callout } from '@/components/crm/chips';
import { Badge } from '@/components/ui/badge';
import { Button, ButtonLink } from '@/components/ui/button';
import { FieldError } from '@/components/ui/field';
import { Select } from '@/components/ui/input';
import { apiBrowser, ApiError, errorMessage, unwrap } from '@/lib/api/client';
import { connectFacebook, metaResultWords, type MetaResult } from '@/lib/meta-connect';
import { keepSetupReturn } from '@/lib/setup-return';
import { cn } from '@/lib/utils';

const settingsOf = (workspaceId: string) => `/app/w/${workspaceId}/settings/facebook-instagram`;

type Problems = Partial<Record<keyof FacebookSetupAnswers, string>>;

const problemsOf = (
  q: FacebookSetupScreen,
  a: FacebookSetupAnswers,
  ctx: FacebookSetupContext,
): Problems => Object.fromEntries(facebookSetupProblems(q, a, ctx).map((p) => [p.path, p.message]));

/** Saves the answers' way back, then Facebook's sign-in: it comes back to the test. */
async function signIn(workspaceId: string, instagram: boolean) {
  keepSetupReturn(
    workspaceId,
    'facebook',
    `/onboarding/${workspaceId}/facebook?step=test${instagram ? '&ig=1' : ''}`,
  );
  await connectFacebook(workspaceId);
}

export function FacebookSetupFlow({
  workspaceId,
  businessName,
  email,
  firstName,
  ctx,
  draft,
  at,
}: {
  workspaceId: string;
  businessName: string;
  /** Who's signed in, under the card. */
  email: string;
  firstName: string | null;
  ctx: FacebookSetupContext;
  /** The answers as they were left (guided_setup.get_draft). */
  draft: { readonly answers: Record<string, unknown> | null; readonly savedAt: string | null };
  /** `?at=`: Settings' Change opens that question, and Next goes to Check it over. */
  at: FacebookSetupScreen | null;
}) {
  const router = useRouter();
  const home = settingsOf(workspaceId);
  const [first] = useState(() => {
    const start = facebookSetupStart(ctx);
    // A Change from Settings starts from what's set now; a draft from before a Page was connected (or after one was
    // taken away) is for the other way through.
    const usable = !at && draft.answers && draft.answers['mode'] === ctx.mode;
    const kept = usable ? facebookSetupAnswersOf(draft.answers, start) : null;
    return { answers: kept ?? start, kept: !!kept };
  });
  const [answers, setAnswers] = useState<FacebookSetupAnswers>(first.answers);
  const questions = facebookSetupQuestions(answers);
  const [screen, setScreen] = useState<FacebookSetupScreen>(() => {
    const saved = facebookSetupScreen.safeParse(first.kept ? draft.answers?.['at'] : at);
    return saved.success &&
      (saved.data === 'review' || facebookSetupQuestions(first.answers).includes(saved.data))
      ? saved.data
      : 'inbox';
  });
  const [problems, setProblems] = useState<Problems>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'connect' | 'save' | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [done, setDone] = useState(false);
  /** Check it over's Change (and Settings'): Next goes straight back there, not through every question again. */
  const [returnTo, setReturnTo] = useState<FacebookSetupScreen | null>(at ? 'review' : null);
  const [welcome, setWelcome] = useState(
    () => first.kept && !!draft.savedAt && Date.now() - Date.parse(draft.savedAt) > 10 * 60_000,
  );
  const [startingOver, setStartingOver] = useState(false);
  const top = useRef<HTMLDivElement>(null);

  const saving = useGuidedDraft(
    workspaceId,
    'facebook',
    done ? null : { ...answers, at: screen, mode: ctx.mode },
    { hadDraft: first.kept },
  );

  const set = (patch: Partial<FacebookSetupAnswers>) => {
    setAnswers((now) => ({ ...now, ...patch }));
    setProblems({});
    setError(null);
  };

  const go = (to: FacebookSetupScreen) => {
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
    const after = questions[i + 1];
    // Picking Instagram from Check it over still asks Instagram's steps on the way back.
    if (returnTo && !(screen === 'inbox' && answers.instagram && after === 'instagram')) {
      setReturnTo(null);
      go('review');
      return;
    }
    go(after ?? 'review');
  }

  const back = () => {
    setReturnTo(null);
    const before = screen === 'review' ? questions[questions.length - 1] : questions[i - 1];
    if (before) go(before);
  };

  async function finish(how: 'connect' | 'save') {
    const wrong = facebookSetupFirstProblem(answers, ctx);
    if (wrong) {
      go(wrong);
      setProblems(problemsOf(wrong, answers, ctx));
      return;
    }
    setBusy(how);
    setError(null);
    try {
      await saving.flush();
      unwrap(
        await apiBrowser().POST('/v1/commands/facebook_setup.save', {
          body: { workspaceId, answers },
        }),
      );
    } catch (e) {
      setBusy(null);
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
    if (how === 'save') {
      toast.success(W.review.saved);
      router.push(home);
      router.refresh();
      return;
    }
    try {
      await signIn(workspaceId, answers.instagram);
    } catch (e) {
      // The answers are saved; only the sign-in didn't start.
      setBusy(null);
      setError(errorMessage(e));
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
    setAnswers(facebookSetupStart(ctx));
    setStartingOver(false);
    setReturnTo(null);
    go('inbox');
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

  const lines = facebookSetupLines(answers, ctx);
  const steps: GuidedStep[] = lines.map((l, n) => ({
    key: l.key,
    label: l.label,
    value: l.value,
    state: n < i ? 'done' : n === i ? 'now' : 'todo',
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

  const card = (q: FacebookSetupQuestion, title: string, hint: string, children: ReactNode) =>
    page(
      <GuidedCard
        screen={q}
        testId="facebook-setup"
        kicker={G.question(i + 1, questions.length)}
        title={title}
        hint={hint}
        banner={banner}
        steps={steps}
        stepsTitle={W.soFar}
        stepsNote={
          ctx.mode === 'new' && !first.kept ? (
            <p
              className="px-2.5 text-[12.5px] text-text-3"
              data-testid="facebook-setup-started-from"
            >
              {W.startedFrom}
            </p>
          ) : null
        }
        footer={
          <GuidedFooter
            onBack={i > 0 ? back : undefined}
            onNext={next}
            error={error}
            testId="facebook-setup"
            nextLabel={
              (returnTo === 'review' &&
                !(screen === 'inbox' && answers.instagram && questions[i + 1] === 'instagram')) ||
              (!returnTo && i === questions.length - 1)
                ? G.checkItOver
                : G.next
            }
          />
        }
      >
        {children}
      </GuidedCard>,
    );

  if (screen === 'review') {
    const signInSteps = facebookSignInSteps(answers);
    return page(
      <GuidedCard
        screen="review"
        testId="facebook-setup"
        kicker={W.review.kicker}
        title={W.review.title}
        hint={`${ctx.mode === 'new' ? W.review.hintNew : W.review.hintAgain} ${G.answersKept}`}
        banner={banner}
        aside={
          <>
            <div className="text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3">
              {W.review.onFacebook}
            </div>
            <ol className="flex flex-col gap-3">
              {signInSteps.map((line, n) => (
                <li key={line} className="flex items-start gap-2.5">
                  <span
                    aria-hidden
                    className="mt-px inline-flex h-5 w-5 flex-none items-center justify-center rounded-full border border-border-strong text-[11px] font-semibold text-text-2"
                  >
                    {n + 1}
                  </span>
                  <span className="text-[13px] text-text-2">{line}</span>
                </li>
              ))}
            </ol>
            {ctx.mode === 'new' ? (
              <p className="text-[12.5px] text-text-3">{W.review.asideNew}</p>
            ) : null}
          </>
        }
        footer={
          <GuidedFooter
            onBack={back}
            onNext={() => void finish(ctx.mode === 'new' ? 'connect' : 'save')}
            busy={busy !== null && (ctx.mode === 'new' ? busy === 'connect' : busy === 'save')}
            error={error}
            nextIcon={false}
            nextLabel={ctx.mode === 'new' ? W.review.connect : W.review.save}
            testId="facebook-setup"
          />
        }
      >
        <div className="overflow-hidden rounded-menu border border-border">
          {lines.map((l) => (
            <div
              key={l.key}
              className="flex items-start justify-between gap-4 border-b border-border px-4 py-3 last:border-b-0"
              data-testid={`facebook-review-${l.key}`}
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
                data-testid={`facebook-review-change-${l.key}`}
              >
                {G.change}
              </Button>
            </div>
          ))}
        </div>
        {ctx.mode === 'again' ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-menu bg-card-2 px-3.5 py-3">
            <span className="text-[13.5px] text-text-2">{W.review.saveConnectHint}</span>
            <Button
              variant="secondary"
              size="sm"
              loading={busy === 'connect'}
              disabled={busy !== null}
              onClick={() => void finish('connect')}
              data-testid="facebook-setup-save-connect"
            >
              {W.review.saveConnect}
            </Button>
          </div>
        ) : null}
      </GuidedCard>,
    );
  }

  switch (screen) {
    case 'inbox':
      return card(
        'inbox',
        W.inbox.title,
        W.inbox.hint,
        <>
          <fieldset className="flex min-w-0 flex-col gap-2">
            <legend className="sr-only">{W.inbox.title}</legend>
            <CheckTile
              icon={<MessengerIcon className="h-5 w-5" />}
              title={W.inbox.messenger}
              hint={W.inbox.messengerHint}
              checked
              disabled
              testId="facebook-setup-messenger"
            />
            <CheckTile
              icon={<InstagramIcon className="h-5 w-5" />}
              title={W.inbox.instagram}
              hint={W.inbox.instagramHint}
              checked={answers.instagram}
              onChange={(instagram) => set({ instagram })}
              testId="facebook-setup-instagram"
            />
          </fieldset>
          {!answers.instagram ? (
            <p className="text-[13px] text-text-2" data-testid="facebook-setup-instagram-off">
              {W.inbox.instagramOff}
            </p>
          ) : null}
          <div className="flex flex-col gap-2 rounded-menu bg-card-2 px-4 py-3.5">
            <span className="text-[14px] font-semibold">{W.inbox.need}</span>
            {[W.inbox.needLogin, ...(answers.instagram ? [W.inbox.needInstagram] : [])].map((t) => (
              <span key={t} className="flex items-start gap-2.5 text-[13.5px] leading-snug">
                <CircleCheck className="mt-0.5 h-4 w-4 flex-none text-text-2" strokeWidth={1.75} />
                <span>{t}</span>
              </span>
            ))}
          </div>
          <GuidedNote>{W.inbox.note}</GuidedNote>
        </>,
      );

    case 'instagram':
      return card(
        'instagram',
        W.instagram.title,
        W.instagram.hint,
        <>
          <div className="rounded-menu border border-border px-4">
            {W.instagram.steps.map((s, n) => (
              <label
                key={s.key}
                className={cn(
                  'flex cursor-pointer items-start gap-3 py-3.5',
                  n > 0 && 'border-t border-border',
                )}
              >
                <input
                  type="checkbox"
                  className="mt-0.5 h-[18px] w-[18px] flex-none cursor-pointer rounded-[5px] border border-border-strong accent-accent"
                  checked={answers[s.key]}
                  onChange={(e) => set({ [s.key]: e.target.checked })}
                  data-testid={`facebook-setup-${s.key}`}
                />
                <span className="flex min-w-0 flex-col gap-1">
                  <span className="text-[14.5px] font-semibold">
                    {n + 1}. {s.title}
                  </span>
                  <span className="text-[13.5px] leading-normal text-text-2">{s.how}</span>
                </span>
              </label>
            ))}
          </div>
          <GuidedNote>{W.instagram.note}</GuidedNote>
        </>,
      );

    case 'leads': {
      const pipeline = facebookSetupPipeline(answers, ctx);
      const stages = facebookSetupOpenStages(pipeline);
      return card(
        'leads',
        W.leads.title,
        W.leads.hint,
        <>
          <Choices label={W.leads.title}>
            <ChoiceTile
              selected={answers.createLead}
              onSelect={() => set({ createLead: true })}
              title={W.leads.lead}
              best={W.leads.best}
              hint={W.leads.leadHint}
              testId="facebook-setup-lead"
            >
              <div className="flex flex-wrap gap-3">
                <label className="flex min-w-[180px] flex-1 flex-col gap-1">
                  <span className="text-[12.5px] font-medium text-text-2">{W.leads.pipeline}</span>
                  <Select
                    selectSize="sm"
                    value={answers.pipelineId ?? ''}
                    onChange={(e) => set({ pipelineId: e.target.value || null, stageId: null })}
                    data-testid="facebook-setup-pipeline"
                  >
                    <option value="">{W.leads.firstPipeline}</option>
                    {ctx.pipelines.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </Select>
                </label>
                <label className="flex min-w-[180px] flex-1 flex-col gap-1">
                  <span className="text-[12.5px] font-medium text-text-2">{W.leads.stage}</span>
                  <Select
                    selectSize="sm"
                    value={answers.stageId ?? ''}
                    onChange={(e) => set({ stageId: e.target.value || null })}
                    data-testid="facebook-setup-stage"
                  >
                    <option value="">{W.leads.firstStage}</option>
                    {stages.map((st) => (
                      <option key={st.id} value={st.id}>
                        {st.name}
                      </option>
                    ))}
                  </Select>
                </label>
              </div>
              {problems.pipelineId ? <FieldError>{problems.pipelineId}</FieldError> : null}
              {problems.stageId ? <FieldError>{problems.stageId}</FieldError> : null}
            </ChoiceTile>
            <ChoiceTile
              selected={!answers.createLead}
              onSelect={() => set({ createLead: false })}
              title={W.leads.customer}
              hint={W.leads.customerHint}
              testId="facebook-setup-customer"
            />
          </Choices>
          <GuidedNote>{W.leads.note}</GuidedNote>
        </>,
      );
    }

    case 'ads':
      return card(
        'ads',
        W.ads.title,
        W.ads.hint,
        <>
          <fieldset className="flex min-w-0 flex-col gap-2">
            <legend className="sr-only">{W.ads.title}</legend>
            <CheckTile
              icon={<Megaphone className="h-[18px] w-[18px] text-text-2" strokeWidth={1.75} />}
              title={W.ads.chat}
              hint={W.ads.chatHint}
              checked={answers.adsChat}
              onChange={(adsChat) => set({ adsChat })}
              testId="facebook-setup-ads-chat"
            />
            <CheckTile
              icon={<FileText className="h-[18px] w-[18px] text-text-2" strokeWidth={1.75} />}
              title={W.ads.leadAds}
              hint={W.ads.leadAdsHint}
              badge={ctx.readsLeads ? undefined : W.ads.leadAdsWait}
              checked={answers.leadAds}
              disabled={!ctx.readsLeads}
              onChange={(leadAds) => set({ leadAds })}
              testId="facebook-setup-lead-ads"
            />
            <CheckTile
              icon={<X className="h-[18px] w-[18px] text-text-2" strokeWidth={1.75} />}
              title={W.ads.none}
              hint={W.ads.noneHint}
              checked={!answers.adsChat && !answers.leadAds}
              onChange={(none) =>
                set(none ? { adsChat: false, leadAds: false } : { adsChat: true })
              }
              testId="facebook-setup-ads-none"
            />
          </fieldset>
          {problems.leadAds ? <FieldError>{problems.leadAds}</FieldError> : null}
          <GuidedNote>{W.ads.note}</GuidedNote>
        </>,
      );
  }
}

/** A refusal from Connect with Facebook about one answer: its question, its field and its words. */
function refusalOf(
  e: ApiError,
): { question: FacebookSetupQuestion; field: keyof FacebookSetupAnswers; message: string } | null {
  if (e.code !== 'validation' || !Array.isArray(e.details)) return null;
  for (const d of e.details as { path?: unknown; message?: unknown }[]) {
    const path = Array.isArray(d.path) ? d.path.join('.') : String(d.path ?? '');
    const hit = facebookSetupQuestionOf(path);
    if (hit && typeof d.message === 'string') return { ...hit, message: d.message };
  }
  return null;
}

/** A tick box as a tile: its icon, what it is, and why, with a note when it can't be ticked yet. */
function CheckTile({
  icon,
  title,
  hint,
  badge,
  checked,
  disabled,
  onChange,
  testId,
}: {
  icon: ReactNode;
  title: string;
  hint: string;
  badge?: string | undefined;
  checked: boolean;
  disabled?: boolean;
  onChange?: (checked: boolean) => void;
  testId: string;
}) {
  return (
    <label
      className={cn(
        'flex items-center gap-3 rounded-menu border p-3.5 transition-colors',
        checked ? 'border-accent bg-accent-soft' : 'border-border bg-card',
        disabled ? 'cursor-not-allowed' : 'cursor-pointer hover:bg-card-2',
        disabled && !checked && 'opacity-70',
      )}
    >
      <input
        type="checkbox"
        className="h-[18px] w-[18px] flex-none cursor-pointer rounded-[5px] border border-border-strong accent-accent disabled:cursor-not-allowed"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange?.(e.target.checked)}
        data-testid={testId}
      />
      <span className="inline-flex h-9 w-9 flex-none items-center justify-center rounded-[10px] border border-border bg-card">
        {icon}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex flex-wrap items-center gap-2 font-semibold">
          {title}
          {badge ? <Badge variant="pending">{badge}</Badge> : null}
        </span>
        <span className="text-[13.5px] leading-snug text-text-2">{hint}</span>
      </span>
    </label>
  );
}

// ---------- the live test ----------

/**
 * Send yourself a test message (F2 a): where Facebook's sign-in comes back to, and Settings' Send a test message. Each
 * Page and Instagram account connected now, with the newest message someone sent it since this opened; asked again
 * every few seconds until each has one. After 2 minutes, a row still waiting says what to check.
 */
export function FacebookSetupTest({
  workspaceId,
  businessName,
  email,
  accounts,
  result,
  instagramAsked = false,
}: {
  workspaceId: string;
  businessName: string;
  email: string;
  accounts: readonly FacebookSetupAccount[];
  /** `?meta=`: what Facebook's sign-in came back with, when it just did. */
  result: MetaResult | null;
  /** `?ig=1`: Instagram was picked, so an Instagram account is expected. */
  instagramAsked?: boolean;
}) {
  const router = useRouter();
  const home = settingsOf(workspaceId);
  const [since] = useState(() => new Date(Date.now() - 2 * 60_000).toISOString());
  const [opened] = useState(() => Date.now());
  const [got, setGot] = useState<MetaAccountTestMessages['accounts']>([]);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const failed = result && result.meta !== 'connected' ? metaResultWords(result) : null;
  const allIn =
    accounts.length > 0 && accounts.every((a) => got.find((g) => g.accountId === a.id)?.gotAt);

  useEffect(() => {
    if (failed || accounts.length === 0 || allIn) return;
    let stop = false;
    const ask = async () => {
      try {
        const out = unwrap(
          await apiBrowser().POST('/v1/queries/meta_account.test_messages', {
            body: { workspaceId, since },
          }),
        );
        if (!stop) setGot(out.accounts);
      } catch {
        // Asked again in a moment.
      }
      if (!stop) setNow(Date.now());
    };
    void ask();
    const timer = setInterval(() => {
      // Fifteen minutes is long enough to send a message; after that, Settings' Send a test message starts again.
      if (Date.now() - opened > 15 * 60_000) return clearInterval(timer);
      void ask();
    }, 4000);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, [workspaceId, since, opened, failed, accounts.length, allIn]);

  async function again() {
    setBusy(true);
    try {
      await signIn(workspaceId, instagramAsked);
    } catch (e) {
      setBusy(false);
      toast.error(errorMessage(e));
    }
  }

  const waited = now - opened > FACEBOOK_TEST_HINT_AFTER_MS;
  const waiting = (platform: 'facebook' | 'instagram') =>
    accounts.some((a) => a.platform === platform && !got.find((g) => g.accountId === a.id)?.gotAt);
  const noInstagram = instagramAsked && !accounts.some((a) => a.platform === 'instagram');
  const names = accounts.map((a) => metaAccountLabel(a)).join(' and ');

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
        screen="test"
        testId="facebook-test"
        kicker=""
        title={W.test.title}
        hint={accounts.length && !failed ? W.test.hint : undefined}
        banner={
          failed ? (
            <Callout tone={failed.tone === 'info' ? 'info' : 'danger'} icon={CircleAlert}>
              {failed.text}
            </Callout>
          ) : accounts.length ? (
            <div
              role="status"
              className="flex items-center gap-2.5 rounded-menu bg-success-soft px-3.5 py-2.5 text-[14px] font-semibold text-success-text"
              data-testid="facebook-test-connected"
            >
              <CircleCheck className="h-[18px] w-[18px] flex-none" strokeWidth={2} />
              {W.test.connected(names)}
            </div>
          ) : null
        }
        aside={<p className="text-[13px] text-text-2">{W.test.aside}</p>}
        footer={
          <div className="mt-auto flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
            <ButtonLink href={home} variant="ghost" data-testid="facebook-test-later">
              {W.test.later}
            </ButtonLink>
            <span className="flex flex-wrap gap-2">
              <ButtonLink href={`/app/w/${workspaceId}/inbox`} variant="secondary" size="lg">
                <Inbox className="h-4 w-4" strokeWidth={1.75} />
                {W.test.openInbox}
              </ButtonLink>
              <ButtonLink href={home} size="lg" data-testid="facebook-test-done">
                {W.test.done}
              </ButtonLink>
            </span>
          </div>
        }
      >
        {failed || accounts.length === 0 ? (
          <div className="flex flex-col items-start gap-3">
            {accounts.length === 0 ? (
              <p className="text-[14px] text-text-2" data-testid="facebook-test-nothing">
                <span className="font-semibold text-text">{W.test.nothing}</span>{' '}
                {W.test.nothingHint}
              </p>
            ) : null}
            <Button onClick={() => void again()} loading={busy} data-testid="facebook-test-again">
              {W.test.tryAgain}
            </Button>
          </div>
        ) : (
          <>
            <ul className="overflow-hidden rounded-menu border border-border">
              {accounts.map((a, n) => {
                const g = got.find((x) => x.accountId === a.id);
                const ig = a.platform === 'instagram';
                return (
                  <li
                    key={a.id}
                    className={cn(
                      'flex flex-wrap items-center gap-3 px-4 py-3.5',
                      n > 0 && 'border-t border-border',
                    )}
                    data-testid={`facebook-test-${a.id}`}
                    data-got={g?.gotAt ? 'yes' : 'no'}
                  >
                    <span className="inline-flex h-9 w-9 flex-none items-center justify-center rounded-[10px] border border-border bg-card">
                      {ig ? (
                        <InstagramIcon className="h-5 w-5" />
                      ) : (
                        <MessengerIcon className="h-5 w-5" />
                      )}
                    </span>
                    <span className="flex min-w-[180px] flex-1 flex-col">
                      <span className="text-[14.5px] font-semibold">{metaAccountLabel(a)}</span>
                      <span className="text-[12.5px] text-text-3">
                        {ig ? W.test.kindInstagram : W.test.kindPage}
                      </span>
                    </span>
                    {g?.gotAt ? (
                      <span className="inline-flex items-center gap-2 rounded-[8px] bg-success-soft px-2.5 py-1.5 text-[13px] font-semibold text-success-text">
                        <CircleCheck className="h-[15px] w-[15px]" strokeWidth={2} />
                        {W.test.got(g.preview)}
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-2 rounded-[8px] bg-card-2 px-2.5 py-1.5 text-[13px] font-semibold text-text-2">
                        <Clock className="h-[15px] w-[15px]" strokeWidth={2} />
                        {W.test.waiting}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
            {waited && waiting('instagram') ? (
              <Callout
                tone="warning"
                icon={CircleAlert}
                data-testid="facebook-test-stuck-instagram"
              >
                {W.test.stuckInstagram}
              </Callout>
            ) : null}
            {waited && waiting('facebook') ? (
              <Callout tone="warning" icon={CircleAlert} data-testid="facebook-test-stuck-page">
                {W.test.stuckPage}
              </Callout>
            ) : null}
            {noInstagram ? (
              <Callout
                tone="warning"
                icon={CircleAlert}
                action={
                  <Button size="sm" variant="secondary" onClick={() => void again()} loading={busy}>
                    {W.test.tryAgain}
                  </Button>
                }
                data-testid="facebook-test-no-instagram"
              >
                {W.test.noInstagram}
              </Callout>
            ) : null}
          </>
        )}
      </GuidedCard>
    </GuidedPage>
  );
}
