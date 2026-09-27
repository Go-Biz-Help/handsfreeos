'use client';
import {
  answerProblem,
  formState,
  isButtonAddress,
  isWebAddress,
  money,
  consentPolicyPath,
  smsConsentWords,
  type AnswerSheet,
  type AnswerValue,
  type FormDefinition,
} from '@hfos/core';
import { CheckCircle2, Loader2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Turnstile } from '@/components/booking/turnstile';
import { ApiError } from '@/lib/api/errors';
import { TURNSTILE_SITE_KEY } from '@/lib/api/public-booking';
import { saveSheet, sendSheet, startSheet, type SentForm } from '@/lib/api/public-forms';
import { QuestionField } from './question-field';

/**
 * The form a customer fills in. It runs core's own engine — the same `formState` and `answerProblem` the
 * editor's preview and the server run — so what is asked here is what the server will accept, and a
 * question that hides itself here is one the server will drop the answer to.
 *
 * The sheet is started when they answer the first thing, not when the page loads, so a page that is opened
 * and closed leaves nothing behind. After that the answers are saved as they go.
 */
export function PublicForm({
  site,
  slug,
  business,
  definition,
  closed,
  closedMessage,
  botCheck,
  resumed,
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
  resumed: { responseId: string; token: string; answers: AnswerSheet } | null;
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
  // The box links to the business's privacy policy: that the terms are findable is one of the six
  // things a compliant opt-in has to say, and a link is the only way of saying it that works.
  const consentWords = smsConsentWords(business, 'form', consentPolicyPath(site));
  /** The honeypot: hidden from people, irresistible to robots. */
  const [website, setWebsite] = useState('');
  const botSiteKey = botCheck ? (botCheck.siteKey ?? TURNSTILE_SITE_KEY) : null;
  const [botToken, setBotToken] = useState<string | null>(null);
  const [botReset, setBotReset] = useState(0);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const starting = useRef<Promise<{ responseId: string; token: string }> | null>(null);

  const state = formState(definition, answers);

  useEffect(() => {
    // Only ever on to a web page: a `javascript:` address here would run on this origin.
    if (isWebAddress(sent?.redirectUrl)) window.location.assign(sent.redirectUrl);
  }, [sent]);

  /** One sheet per person filling it in, however fast they type. */
  async function sheetNow(): Promise<{ responseId: string; token: string }> {
    if (sheet) return sheet;
    starting.current ??= startSheet(site, slug, { website, source: 'link' }).then((s) => {
      const opened = { responseId: s.responseId, token: s.token };
      setSheet(opened);
      return opened;
    });
    return starting.current;
  }

  function answer(questionId: string, value: AnswerValue) {
    setAnswers((a) => ({ ...a, [questionId]: value }));
    if (closed) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      void (async () => {
        try {
          const open = await sheetNow();
          await saveSheet(site, slug, open.responseId, {
            token: open.token,
            answers: { ...answers, [questionId]: value } as Record<string, unknown>,
          });
        } catch {
          // Saving as they go is a convenience; sending is what matters, and that reports for itself.
        }
      })();
    }, 1200);
  }

  async function send() {
    setTried(true);
    const problems = state.questions.filter(
      (q) => answerProblem(q, state.answers[q.id] ?? null) !== null,
    );
    if (problems.length) {
      document
        .getElementById(`q-${problems[0]!.id}`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
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
        website,
        turnstileToken: botToken ?? undefined,
      });
      setSent(out);
    } catch (e) {
      // Each token works once.
      if (botSiteKey) {
        setBotToken(null);
        setBotReset((n) => n + 1);
      }
      setFailed(
        e instanceof ApiError ? e.message : 'Something went wrong. Please try again in a moment.',
      );
    } finally {
      setSending(false);
    }
  }

  if (sent) {
    return (
      <Card className="p-6 text-center sm:p-8" data-testid="form-sent">
        <CheckCircle2 className="mx-auto h-8 w-8 text-success-text" strokeWidth={1.5} />
        <h1 className="mt-3 text-[19px] font-medium text-text">{sent.headline}</h1>
        {sent.body ? (
          <p className="mx-auto mt-2 max-w-prose whitespace-pre-wrap text-[14px] text-text-2">
            {sent.body}
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
          {definition.settings.showProgress && state.questions.length > 2 ? (
            <div className="mt-5 h-1 w-full overflow-hidden rounded-full bg-card-2">
              <div
                className="h-full bg-accent transition-all"
                style={{ width: `${Math.round(state.progress * 100)}%` }}
              />
            </div>
          ) : null}

          <div className="mt-6 space-y-6">
            {state.pages.map((page) => (
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

          {definition.calculations.length ? (
            <div className="mt-6 space-y-1 rounded-card bg-card-2 p-4" data-testid="form-totals">
              {definition.calculations.map((calculation) => (
                <p key={calculation.id} className="flex justify-between text-[14px] text-text-2">
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

          {/*
            The words come from core (messaging/consent.ts), not from here, because the booking page asks
            the same thing and a carrier reads both. What was here before — "It's OK to text me about this"
            — named nobody, mentioned no cost and offered no way out, which is an opt-in record that would
            not survive being asked about.
          */}
          {definition.settings.identity !== 'anonymous' ? (
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
                  <a
                    className="underline"
                    href={consentWords.policyUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Privacy policy
                  </a>
                ) : null}
              </p>
            </div>
          ) : null}

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

          {botSiteKey ? (
            <div className="mt-4">
              <Turnstile siteKey={botSiteKey} onToken={setBotToken} resetKey={botReset} />
            </div>
          ) : botCheck ? (
            <p className="mt-4 text-[13px] text-danger-text">
              This form isn’t fully set up, so it can’t be sent just now.
            </p>
          ) : null}

          {failed ? (
            <p role="alert" className="mt-4 text-[13px] text-danger-text">
              {failed}
            </p>
          ) : null}

          <Button
            className="mt-6 w-full"
            onClick={send}
            disabled={sending || (botCheck !== null && !botToken)}
            data-testid="form-send"
          >
            {sending ? <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.75} /> : null}
            {definition.settings.submitLabel}
          </Button>
          {definition.settings.identity === 'anonymous' ? (
            <p className="mt-3 text-center text-[12.5px] text-text-3">
              This one is anonymous. Nothing here says who you are.
            </p>
          ) : null}
        </>
      )}
    </Card>
  );
}
