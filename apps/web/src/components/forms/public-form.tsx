'use client';
import {
  answerProblem,
  fillFormWords,
  fillWords,
  firstNameFor,
  formState,
  isButtonAddress,
  isWebAddress,
  money,
  consentPolicyPath,
  consentTermsPath,
  smsConsentWords,
  type AnswerSheet,
  type AnswerValue,
  type FillContext,
  type FormDefinition,
} from '@hfos/core';
import { ArrowLeft, CheckCircle2, Loader2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Turnstile } from '@/components/booking/turnstile';
import { ApiError } from '@/lib/api/errors';
import { TURNSTILE_SITE_KEY } from '@/lib/api/public-booking';
import {
  saveContactSheet,
  saveSheet,
  sendSheet,
  startSheet,
  type SentForm,
} from '@/lib/api/public-forms';
import { QuestionField } from './question-field';
import { StepButtons, StepProgress, useFormSteps } from './steps';

/** A personal link (`?k=`): who to greet, and the contact details we already have, as answer targets. */
export interface PersonalLink {
  readonly key: string;
  readonly firstName: string;
  readonly known: readonly string[];
}

/**
 * The form a customer fills in. It runs core's own engine — the same `formState` and `answerProblem` the
 * editor's preview and the server run — so what is asked here is what the server will accept, and a
 * question that hides itself here is one the server will drop the answer to.
 *
 * The sheet is started when they answer the first thing, not when the page loads, so a page that is opened
 * and closed leaves nothing behind. After that the answers are saved as they go.
 *
 * Shown one page at a time, a page that saves their details (`savesContact`) does it as they leave it: the
 * consent box and the "are you a person" check sit on that page then, rather than at the end. A personal link
 * knows who they are: it skips the contact details we have, greets them by name, and never shows what's on
 * file.
 */
export function PublicForm({
  site,
  slug,
  business,
  definition: raw,
  closed,
  closedMessage,
  botCheck,
  offers = null,
  resumed,
  personal = null,
}: {
  site: string;
  slug: string;
  /** The business's own name, for the consent box. The sender is them, not us. */
  business: string;
  definition: FormDefinition;
  closed: boolean;
  closedMessage: string;
  /** The "are you a person" check before sending, as on the booking page; null when it's off. */
  botCheck: { siteKey: string | null } | null;
  /** The separate box for offers, for a business that sends them (core's offersConsentWords). */
  offers?: { title: string; detail: string } | null;
  resumed: { responseId: string; token: string; answers: AnswerSheet } | null;
  personal?: PersonalLink | null;
}) {
  const [answers, setAnswers] = useState<AnswerSheet>(resumed?.answers ?? {});
  const [sheet, setSheet] = useState<{ responseId: string; token: string } | null>(
    resumed ? { responseId: resumed.responseId, token: resumed.token } : null,
  );
  const [tried, setTried] = useState(false);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<SentForm | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [consent, setConsent] = useState(false);
  const [offersConsent, setOffersConsent] = useState(false);
  /** On a personal link: they want to give their details again, so nothing we know is skipped. */
  const [askAgain, setAskAgain] = useState(false);
  // The box links to the business's privacy policy and terms: that they are findable is one of the six
  // things a compliant opt-in has to say, and a link is the only way of saying it that works.
  const consentWords = smsConsentWords(
    business,
    'form',
    consentPolicyPath(site),
    consentTermsPath(site),
  );
  /** The honeypot: hidden from people, irresistible to robots. */
  const [website, setWebsite] = useState('');
  // A link we texted them ourselves needs no "are you a person" check.
  const botSiteKey = botCheck && !personal ? (botCheck.siteKey ?? TURNSTILE_SITE_KEY) : null;
  const botNeeded = botCheck !== null && !personal;
  const [botToken, setBotToken] = useState<string | null>(null);
  const [botReset, setBotReset] = useState(0);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const starting = useRef<Promise<{ responseId: string; token: string }> | null>(null);

  const knownList = personal?.known;
  const fill: FillContext = useMemo(
    () => (knownList && !askAgain ? { known: new Set(knownList) } : {}),
    [knownList, askAgain],
  );
  // Their name in the form's words, from what they typed or the link; the recorded wording stays the business's.
  const firstName = firstNameFor(raw, answers, personal?.firstName ?? null);
  const definition = useMemo(() => fillFormWords(raw, { firstName }), [raw, firstName]);
  const state = formState(definition, answers, fill);
  const steps = useFormSteps(definition, state, resumed?.answers ?? null, fill);
  const lastPageId = state.pages[state.pages.length - 1]?.page.id ?? null;
  // Where the consent box sits: on the page that saves their details, when there is one to show.
  const consentPageId = steps.stepped
    ? (state.pages.find((p) => p.page.savesContact)?.page.id ?? lastPageId)
    : null;
  const onContactPage = steps.stepped && steps.page?.page.savesContact === true;
  const showConsent =
    definition.settings.identity !== 'anonymous' &&
    (!steps.stepped || steps.page?.page.id === consentPageId);

  useEffect(() => {
    // Only ever on to a web page: a `javascript:` address here would run on this origin.
    if (isWebAddress(sent?.redirectUrl)) window.location.assign(sent.redirectUrl);
  }, [sent]);

  /** One sheet per person filling it in, however fast they type. */
  async function sheetNow(): Promise<{ responseId: string; token: string }> {
    if (sheet) return sheet;
    starting.current ??= startSheet(site, slug, {
      website,
      source: 'link',
      ...(personal ? { key: personal.key } : {}),
    }).then((s) => {
      const opened = { responseId: s.responseId, token: s.token };
      setSheet(opened);
      return opened;
    });
    return starting.current;
  }

  async function save(sheetAnswers: AnswerSheet) {
    try {
      const open = await sheetNow();
      await saveSheet(site, slug, open.responseId, {
        token: open.token,
        answers: sheetAnswers as Record<string, unknown>,
        askAgain,
      });
    } catch {
      // Saving as they go is a convenience; sending is what matters, and that reports for itself.
    }
  }

  function answer(questionId: string, value: AnswerValue) {
    setAnswers((a) => ({ ...a, [questionId]: value }));
    if (closed) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    const next = { ...answers, [questionId]: value };
    saveTimer.current = setTimeout(() => void save(next), 1200);
  }

  /** "Are you a person" tokens work once: a fresh one for the next thing sent. */
  function freshBotCheck() {
    if (!botSiteKey) return;
    setBotToken(null);
    setBotReset((n) => n + 1);
  }

  function showProblem(questionId: string) {
    document
      .getElementById(`q-${questionId}`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  /**
   * On to the next page once this one will do, saving what they have so far as they go. Leaving the page that
   * saves their details saves them there and then, and they stay put if that doesn't work.
   */
  async function next() {
    const problems = steps.problemsHere();
    if (problems.length) {
      setTried(true);
      showProblem(problems[0]!.questionId);
      return;
    }
    if (saveTimer.current) clearTimeout(saveTimer.current);
    if (onContactPage && definition.settings.identity !== 'anonymous') {
      setSending(true);
      setFailed(null);
      try {
        const open = await sheetNow();
        await saveContactSheet(site, slug, open.responseId, {
          token: open.token,
          answers: state.answers as Record<string, unknown>,
          smsConsent: consent,
          offersConsent: offers ? offersConsent : false,
          askAgain,
          website,
          turnstileToken: botToken ?? undefined,
        });
        freshBotCheck();
      } catch (e) {
        freshBotCheck();
        setFailed(
          e instanceof ApiError ? e.message : 'Something went wrong. Please try again in a moment.',
        );
        return;
      } finally {
        setSending(false);
      }
    } else if (Object.keys(state.answers).length) void save(state.answers);
    setTried(false);
    setFailed(null);
    steps.forward();
  }

  async function send() {
    setTried(true);
    const problems = state.questions.filter(
      (q) => answerProblem(q, state.answers[q.id] ?? null) !== null,
    );
    if (problems.length) {
      // A page they already passed can still have something to do: a sheet picked up from an older version.
      steps.showQuestion(problems[0]!.id);
      showProblem(problems[0]!.id);
      return;
    }
    setSending(true);
    setFailed(null);
    try {
      const open = await sheetNow();
      const out = await sendSheet(site, slug, open.responseId, {
        token: open.token,
        answers: state.answers as Record<string, unknown>,
        smsConsent: consent,
        offersConsent: offers ? offersConsent : false,
        askAgain,
        website,
        turnstileToken: botToken ?? undefined,
      });
      setSent(out);
    } catch (e) {
      freshBotCheck();
      setFailed(
        e instanceof ApiError ? e.message : 'Something went wrong. Please try again in a moment.',
      );
    } finally {
      setSending(false);
    }
  }

  if (sent) {
    const words = (text: string) => fillWords(text, { firstName });
    return (
      <Card className="p-6 text-center sm:p-8" data-testid="form-sent">
        <CheckCircle2 className="mx-auto h-8 w-8 text-success-text" strokeWidth={1.5} />
        <h1 className="mt-3 text-[19px] font-medium text-text">{words(sent.headline)}</h1>
        {sent.body ? (
          <p className="mx-auto mt-2 max-w-prose whitespace-pre-wrap text-[14px] text-text-2">
            {words(sent.body)}
          </p>
        ) : null}
        {sent.showScore && sent.scorePercent !== null && sent.scorePercent !== undefined ? (
          <p className="mt-3 text-[13px] text-text-3">
            You scored {sent.scorePercent}%
            {sent.passed === null || sent.passed === undefined
              ? ''
              : sent.passed
                ? ' — a pass.'
                : '.'}
          </p>
        ) : null}
        {sent.dueCents > 0 ? (
          <p className="mt-3 text-[13px] text-text-2">
            {money(sent.dueCents)} to pay. We’ll send that separately.
          </p>
        ) : null}
        {isButtonAddress(sent.buttonUrl) && sent.buttonLabel ? (
          <a
            href={sent.buttonUrl}
            className="mt-5 inline-flex h-9 items-center rounded-control bg-accent px-3.5 text-sm font-medium text-white"
          >
            {sent.buttonLabel}
          </a>
        ) : null}
      </Card>
    );
  }

  /*
    The words come from core (messaging/consent.ts), not from here, because the booking page asks the same thing
    and a carrier reads both. What was here before — "It's OK to text me about this" — named nobody, mentioned no
    cost and offered no way out, which is an opt-in record that would not survive being asked about.
  */
  const consentBox = (
    <div className="mt-6">
      <Checkbox
        className="text-[13px] font-medium"
        label={consentWords.title}
        checked={consent}
        onChange={(e) => setConsent(e.target.checked)}
        data-testid="form-sms-consent"
      />
      <p className="ml-[26px] mt-1 text-xs text-text-3">
        {consentWords.detail}{' '}
        {consentWords.policyUrl ? (
          <a className="underline" href={consentWords.policyUrl} target="_blank" rel="noreferrer">
            Privacy policy
          </a>
        ) : null}
        {consentWords.termsUrl ? (
          <>
            {' · '}
            <a className="underline" href={consentWords.termsUrl} target="_blank" rel="noreferrer">
              Terms
            </a>
          </>
        ) : null}
      </p>
      {/* Offers have their own box, never ticked for them: agreeing to hear about the job they asked for is not
          agreeing to hear about a special (core's offersConsentWords). */}
      {offers ? (
        <>
          <Checkbox
            className="mt-3 text-[13px] font-medium"
            label={offers.title}
            checked={offersConsent}
            onChange={(e) => setOffersConsent(e.target.checked)}
            data-testid="form-offers-consent"
          />
          <p className="ml-[26px] mt-1 text-xs text-text-3">{offers.detail}</p>
        </>
      ) : null}
    </div>
  );

  const botBox = botSiteKey ? (
    <div className="mt-4">
      <Turnstile siteKey={botSiteKey} onToken={setBotToken} resetKey={botReset} />
    </div>
  ) : botNeeded ? (
    <p className="mt-4 text-[13px] text-danger-text">
      This form isn’t fully set up, so it can’t be sent just now.
    </p>
  ) : null;

  const failedLine = failed ? (
    <p role="alert" className="mt-4 text-[13px] text-danger-text">
      {failed}
    </p>
  ) : null;

  return (
    <Card className="p-5 sm:p-7" data-testid="public-form">
      <h1 className="text-[19px] font-medium text-text">{definition.title}</h1>
      {definition.intro ? (
        <p className="mt-2 whitespace-pre-wrap text-[14px] text-text-2">{definition.intro}</p>
      ) : null}

      {closed ? (
        <p
          className="mt-5 rounded-card bg-card-2 px-4 py-6 text-center text-[14px] text-text-2"
          data-testid="form-closed"
        >
          {closedMessage}
        </p>
      ) : (
        <>
          {steps.stepped && definition.settings.showProgress ? (
            <StepProgress steps={steps} />
          ) : !steps.stepped && definition.settings.showProgress && state.questions.length > 2 ? (
            <div className="mt-5 h-1 w-full overflow-hidden rounded-full bg-card-2">
              <div
                className="h-full bg-accent transition-all"
                style={{ width: `${Math.round(state.progress * 100)}%` }}
              />
            </div>
          ) : null}

          {/* Their details are never shown back on a personal link; they can give them again, and those are added. */}
          {personal && personal.known.length && !askAgain && steps.index === 0 ? (
            <p className="mt-4 text-[13px] text-text-3">
              Details changed?{' '}
              <button
                type="button"
                className="underline"
                onClick={() => setAskAgain(true)}
                data-testid="form-ask-again"
              >
                Give us your current ones
              </button>
            </p>
          ) : null}

          <div className="mt-6 space-y-6">
            {steps.shown.map((page) => (
              <section key={page.page.id} className="space-y-6">
                {page.page.title ? (
                  <h2 className="text-[15px] font-medium text-text-2">{page.page.title}</h2>
                ) : null}
                {page.questions.map((question) => (
                  <QuestionField
                    key={question.id}
                    question={question}
                    value={state.answers[question.id] ?? null}
                    problem={
                      tried ? answerProblem(question, state.answers[question.id] ?? null) : null
                    }
                    onChange={(value) => answer(question.id, value)}
                  />
                ))}
              </section>
            ))}
          </div>

          {/* Hidden from people; robots fill it in and get a polite nothing. */}
          <label className="sr-only" aria-hidden="true">
            Website
            <input
              tabIndex={-1}
              autoComplete="off"
              value={website}
              onChange={(e) => setWebsite(e.target.value)}
            />
          </label>

          {!steps.isLast ? (
            <>
              {showConsent ? consentBox : null}
              {onContactPage ? botBox : null}
              {failedLine}
              <StepButtons
                steps={steps}
                onNext={() => void next()}
                disabled={sending || (onContactPage && botNeeded && !botToken)}
              />
            </>
          ) : (
            <>
              {definition.calculations.length ? (
                <div
                  className="mt-6 space-y-1 rounded-card bg-card-2 p-4"
                  data-testid="form-totals"
                >
                  {definition.calculations.map((calculation) => (
                    <p
                      key={calculation.id}
                      className="flex justify-between text-[14px] text-text-2"
                    >
                      <span>{calculation.name}</span>
                      <span className="font-medium text-text">
                        {calculation.format === 'money'
                          ? money(Math.round((state.calculations[calculation.id] ?? 0) * 100))
                          : calculation.format === 'percent'
                            ? `${state.calculations[calculation.id] ?? 0}%`
                            : (state.calculations[calculation.id] ?? 0)}
                      </span>
                    </p>
                  ))}
                </div>
              ) : null}

              {showConsent ? consentBox : null}
              {botBox}
              {failedLine}

              <div className="mt-6 flex items-center gap-2">
                {steps.stepped && steps.index > 0 ? (
                  <Button variant="secondary" onClick={steps.back} data-testid="form-back">
                    <ArrowLeft className="h-4 w-4" strokeWidth={1.75} />
                    Back
                  </Button>
                ) : null}
                <Button
                  className="flex-1"
                  onClick={send}
                  disabled={sending || (botNeeded && !botToken)}
                  data-testid="form-send"
                >
                  {sending ? <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.75} /> : null}
                  {definition.settings.submitLabel}
                </Button>
              </div>
              {definition.settings.identity === 'anonymous' ? (
                <p className="mt-3 text-center text-[12.5px] text-text-3">
                  This one is anonymous. Nothing here says who you are.
                </p>
              ) : null}
            </>
          )}
        </>
      )}
    </Card>
  );
}
