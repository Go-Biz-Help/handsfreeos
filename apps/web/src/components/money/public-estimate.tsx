'use client';
/**
 * What a customer sees at `/e/<token>`: the estimate they were sent, and the two things they can do with it.
 * `design/m9/Estimate.dc.html` is the drawing this follows.
 *
 * Three rules from the canvas are load-bearing:
 * - **Approve and Decline are the only two buttons**, and both are a POST, so a mail scanner opening the link
 *   can't answer for anybody.
 * - **The sentence above Approve is the worker's, word for word.** It is what is stored with the acceptance as
 *   evidence, so the page renders `answer.wording` rather than writing its own — reword it here and the record
 *   would stop matching what was on screen.
 * - **Any typed name is taken.** People type "Maria L."; what is kept is what they typed, the words they saw
 *   and the moment.
 */
import { CircleAlert, CircleCheck, CircleSlash, Link2Off } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';
import { expiryPhrase, money } from '@hfos/core';
import { ApiError } from '@/lib/api/errors';
import {
  acceptEstimate,
  declineEstimate,
  getEstimate,
  markEstimateViewed,
  type EstimateBlockedReason,
  type PublicBusiness,
  type PublicEstimateView,
} from '@/lib/api/public-money';
import { joinParts, momentLong, momentShort, viewerZone } from './public-format';
import {
  BottomSheet,
  callPhrase,
  DocumentCard,
  Hero,
  Honeypot,
  MoneyBody,
  MoneyFrame,
  NotesCard,
  OkBox,
  PageActions,
  PublicState,
  SectionLabel,
  TotalRow,
} from './public-shell';

type Failure =
  | { kind: 'stale'; business: PublicBusiness | null }
  | { kind: 'missing' }
  | { kind: 'error'; message: string };

/** Why it can't be answered, said to the person holding the link rather than to the business. */
const BLOCKED: Record<EstimateBlockedReason, string> = {
  expired: 'This estimate has run out.',
  withdrawn: 'This estimate was withdrawn.',
  answered: 'This estimate has already been answered.',
};

const failureOf = (e: unknown): Failure => {
  if (e instanceof ApiError && e.rule === 'money_link_stale')
    return {
      kind: 'stale',
      business: (e.details as { business?: PublicBusiness } | undefined)?.business ?? null,
    };
  if (e instanceof ApiError && e.status === 404) return { kind: 'missing' };
  return {
    kind: 'error',
    message: e instanceof ApiError ? e.message : 'Something went wrong. Please try again.',
  };
};

export function PublicEstimate({ token }: { token: string }) {
  const [view, setView] = useState<PublicEstimateView | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [asking, setAsking] = useState<'approve' | 'decline' | null>(null);
  const [name, setName] = useState('');
  const [reason, setReason] = useState('');
  const [website, setWebsite] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const opened = useRef(false);

  useEffect(() => {
    let live = true;
    getEstimate(token)
      .then((v) => live && setView(v))
      .catch((e: unknown) => live && setFailure(failureOf(e)));
    return () => {
      live = false;
    };
  }, [token]);

  // "They opened it" is a fact the business is told once. A POST, never the GET: scanners open links.
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    void markEstimateViewed(token).catch(() => {
      // Nothing to say to the customer: this is only news for the business.
    });
  }, [token]);

  /** After an answer: the page shows what the worker says the estimate is now. */
  const answered = (next: PublicEstimateView) => {
    setView(next);
    setAsking(null);
    setError(null);
    window.scrollTo({ top: 0 });
  };

  /** A refusal mid-answer: a dead link ends the page, anything else is said and the page re-reads itself. */
  const failedAnswer = async (e: unknown) => {
    if (e instanceof ApiError && (e.status === 410 || e.status === 404)) {
      setFailure(failureOf(e));
      return;
    }
    setError(e instanceof ApiError ? e.message : 'Something went wrong. Please try again.');
    setAsking(null);
    try {
      setView(await getEstimate(token));
    } catch {
      // Keep what's on screen: it is still the truth of a moment ago.
    }
  };

  async function approve() {
    if (busy) return;
    const typed = name.trim();
    if (!typed) {
      setNameError('Type your name to approve.');
      return;
    }
    setBusy(true);
    setNameError(null);
    try {
      answered(await acceptEstimate(token, { name: typed, website }));
    } catch (e) {
      await failedAnswer(e);
    } finally {
      setBusy(false);
    }
  }

  async function decline() {
    if (busy) return;
    setBusy(true);
    try {
      answered(
        await declineEstimate(token, {
          name: name.trim() || null,
          reason: reason.trim() || null,
          website,
        }),
      );
    } catch (e) {
      await failedAnswer(e);
    } finally {
      setBusy(false);
    }
  }

  if (failure?.kind === 'stale')
    return (
      <MoneyFrame business={failure.business} testId="estimate-page">
        <PublicState
          tone="warning"
          icon={<CircleAlert size={20} />}
          title="This link is out of date"
          testId="link-stale"
        >
          We sent a newer copy of this estimate. Open the newest text or email from us
          {failure.business ? `, or ${callPhrase(failure.business)}` : ''}.
        </PublicState>
      </MoneyFrame>
    );
  if (failure)
    return (
      <MoneyFrame business={null} testId="estimate-page">
        <PublicState
          icon={<Link2Off size={20} />}
          title={failure.kind === 'missing' ? 'This link doesn’t work' : 'We couldn’t open this'}
          testId="link-missing"
        >
          {failure.kind === 'missing'
            ? 'Check that it matches the one we sent you, or contact the business.'
            : failure.message}
        </PublicState>
      </MoneyFrame>
    );
  if (!view)
    return (
      <MoneyFrame business={null} testId="estimate-page">
        <p aria-live="polite" className="mx-auto mt-16 text-[13px] text-text-3">
          Opening your estimate…
        </p>
      </MoneyFrame>
    );

  const { business, estimate, answer } = view;
  const total = estimate.totals.totalCents;
  const deposit = estimate.depositCents;
  const open = answer.canAccept || answer.canDecline;
  const isAnswered = !!(answer.acceptedAt || answer.declinedAt);

  // Withdrawn: there is nothing left to read, and a price the business has pulled shouldn't stay on screen.
  if (view.state === 'void')
    return (
      <MoneyFrame business={business} testId="estimate-page">
        <PublicState
          icon={<CircleSlash size={20} />}
          title="This estimate was withdrawn"
          action={<PageActions business={business} />}
          testId="estimate-withdrawn"
        >
          {business.name} has taken this estimate back. Please {callPhrase(business)} and we’ll sort
          it out.
        </PublicState>
      </MoneyFrame>
    );

  const depositRows =
    deposit > 0 ? (
      <>
        <TotalRow label="Deposit to start" value={money(deposit)} testId="money-deposit" />
        <TotalRow label="Balance when the work is done" value={money(total - deposit)} />
      </>
    ) : null;

  const document = (
    <DocumentCard
      number={estimate.number}
      title={estimate.title}
      when={estimate.sentAt ? momentShort(estimate.sentAt) : null}
      lines={estimate.lines}
      totals={estimate.totals}
      extra={depositRows}
    />
  );

  // Core's own phrase: "good until Wed, Sep 30", "good until today", "expired".
  const goodUntil = estimate.expiresOn
    ? expiryPhrase(estimate.expiresOn, Date.now(), viewerZone())
    : null;

  return (
    <MoneyFrame
      business={business}
      testId="estimate-page"
      footer={
        open ? (
          <>
            <Button
              size="lg"
              className="w-full"
              disabled={!answer.canAccept}
              onClick={() => {
                setError(null);
                setAsking('approve');
              }}
              data-testid="approve-open"
            >
              <CircleCheck size={17} aria-hidden />
              Approve this estimate
            </Button>
            <Button
              variant="ghost"
              className="w-full max-md:h-11"
              disabled={!answer.canDecline}
              onClick={() => {
                setError(null);
                setAsking('decline');
              }}
              data-testid="decline-open"
            >
              {answer.declineLabel}
            </Button>
          </>
        ) : null
      }
    >
      <MoneyBody testId="estimate-body">
        {answer.acceptedAt ? (
          <OkBox icon={<CircleCheck size={19} />} testId="estimate-approved">
            <b className="font-semibold">Approved.</b> {momentLong(answer.acceptedAt)}, by{' '}
            {answer.acceptedName ?? view.customer.name}.
            {view.customer.email ? (
              <>
                <br />A copy is on its way to {view.customer.email}.
              </>
            ) : null}
          </OkBox>
        ) : answer.declinedAt ? (
          <div
            className="flex items-start gap-2.5 rounded-card bg-card-2 p-3.5 text-[13.5px] leading-[1.5] text-text-2"
            data-testid="estimate-declined"
            data-print="card"
          >
            <CircleSlash size={19} className="mt-px flex-none" aria-hidden />
            <span className="min-w-0 flex-1">
              <b className="font-semibold text-text">Declined.</b> {momentLong(answer.declinedAt)}.
              <br />
              Changed your mind? Please {callPhrase(business)}.
            </span>
          </div>
        ) : !open && answer.reason ? (
          <div
            className="flex items-start gap-2.5 rounded-card bg-warning-soft p-3.5 text-[13.5px] leading-[1.5] text-warning-text"
            data-testid="estimate-blocked"
            data-print="card"
          >
            <CircleAlert size={19} className="mt-px flex-none" aria-hidden />
            <span className="min-w-0 flex-1">
              <b className="font-semibold">{BLOCKED[answer.reason]}</b> You can still read it here.
              To go ahead, please {callPhrase(business)}.
            </span>
          </div>
        ) : null}

        {/* Once it's answered the answer leads, as the canvas has it: the total is in the document below. */}
        {isAnswered ? null : (
          <Hero
            step="Estimate"
            amount={total}
            sub={joinParts(estimate.title, open ? goodUntil : null)}
            testId="estimate-hero"
          />
        )}

        {answer.acceptedAt && deposit > 0 ? (
          <div
            className="rounded-card border border-border bg-card px-4 py-3.5 shadow-1"
            data-print="card"
          >
            <SectionLabel>What happens next</SectionLabel>
            <TotalRow label="Deposit to start" value={money(deposit)} />
            <TotalRow label="Balance when the work is done" value={money(total - deposit)} />
            <p className="mt-2 text-[13px] leading-[1.5] text-text-2">
              {business.name} will email an invoice for the deposit. You can pay it by bank transfer
              or card. Nobody will call you for a card number.
            </p>
          </div>
        ) : null}

        {error ? (
          <p role="alert" className="text-[13px] text-danger-text" data-testid="estimate-error">
            {error}
          </p>
        ) : null}

        {document}
        {estimate.notes?.trim() ? <NotesCard notes={estimate.notes} business={business} /> : null}
        <PageActions business={business} />
      </MoneyBody>

      <BottomSheet
        open={asking === 'approve'}
        onOpenChange={(next) => setAsking(next ? 'approve' : null)}
        title="Approve this estimate"
        testId="approve-sheet"
      >
        <TotalRow label="Total" value={money(total)} big />
        <div className="relative">
          <Label htmlFor="approve-name">{answer.nameLabel}</Label>
          <Input
            id="approve-name"
            autoComplete="name"
            inputSize="lg"
            value={name}
            maxLength={120}
            invalid={!!nameError}
            onChange={(e) => {
              setName(e.target.value);
              setNameError(null);
            }}
            onKeyDown={(e) => e.key === 'Enter' && void approve()}
            data-testid="approve-name"
          />
          {nameError ? (
            <p role="alert" className="mt-1.5 text-[12.5px] text-danger-text">
              {nameError}
            </p>
          ) : null}
          <Honeypot id="approve-website" value={website} onChange={setWebsite} />
        </div>
        {/* The worker's own sentence, word for word: it is what the acceptance is recorded with. */}
        <p className="text-[13px] leading-[1.5] text-text-2" data-testid="approve-wording">
          {answer.wording}
        </p>
        <Button
          size="lg"
          className="w-full"
          loading={busy}
          onClick={() => void approve()}
          data-testid="approve"
        >
          {answer.acceptLabel}
        </Button>
        <Button
          variant="ghost"
          className="w-full max-md:h-11"
          onClick={() => setAsking(null)}
          data-testid="approve-cancel"
        >
          Cancel
        </Button>
        <p className="text-center text-xs text-text-3">
          We keep your name, the words above and the time.
        </p>
      </BottomSheet>

      <BottomSheet
        open={asking === 'decline'}
        onOpenChange={(next) => setAsking(next ? 'decline' : null)}
        title="Decline this estimate"
        testId="decline-sheet"
      >
        <p className="text-[13px] leading-[1.5] text-text-2">
          {business.name} will be told. Nothing is charged, and you can still {callPhrase(business)}{' '}
          if you change your mind.
        </p>
        <div className="relative">
          <Label htmlFor="decline-reason">
            Anything you’d like to tell us?{' '}
            <span className="font-normal text-text-3">Optional</span>
          </Label>
          <Textarea
            id="decline-reason"
            className="min-h-16"
            value={reason}
            maxLength={1000}
            onChange={(e) => setReason(e.target.value)}
            data-testid="decline-reason"
          />
          <Honeypot id="decline-website" value={website} onChange={setWebsite} />
        </div>
        <Button
          variant="secondary"
          size="lg"
          className="w-full text-danger-text"
          loading={busy}
          onClick={() => void decline()}
          data-testid="decline"
        >
          {answer.declineLabel}
        </Button>
        <Button
          variant="ghost"
          className="w-full max-md:h-11"
          onClick={() => setAsking(null)}
          data-testid="decline-cancel"
        >
          Keep it open
        </Button>
      </BottomSheet>
    </MoneyFrame>
  );
}
