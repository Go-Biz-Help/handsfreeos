'use client';
/**
 * What a customer sees at `/p/<token>`: the plan they have been put on, and the one thing only they can do
 * about it — put a card on it.
 *
 * **A plan that can only start on a card the provider already happens to hold is a trap.** A business signs up
 * their first maintenance customer and presses Start; without this page that either fails at the provider or
 * quietly bills a card left over from an old job. So the plan waits here until the customer says yes with a
 * card of their own, and the same page and the same link change it later — which is the honest answer to a
 * card that expired, instead of a phone call.
 *
 * The card goes in **the provider's own fields**, in the two phases the invoice page already uses (see
 * `apps/worker/src/http/money.ts`): the worker hands back a session, the provider turns the card into a token,
 * and the worker saves that token against the provider's own customer. No card number ever touches us, and
 * nothing here ever sees one.
 *
 * **A decline is an answer, not a failure state.** A refused card comes back as plain words with the plan still
 * waiting, exactly where it was, and they can try another.
 */
import { money } from '@hfos/core';
import { CalendarClock, CircleAlert, CircleCheck, CreditCard, Lock, Repeat } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ApiError } from '@/lib/api/client';
import { getPlan, savePlanCard, type PublicPlanView, type SavedCard } from '@/lib/api/public-money';
import {
  Honeypot,
  MoneyBody,
  MoneyFrame,
  OkBox,
  PageActions,
  PublicState,
  SectionLabel,
} from './public-shell';

/** The link didn't work, or a newer one replaced it: the same two answers every money page gives. */
interface Failure {
  readonly title: string;
  readonly detail: string;
}

function failureOf(e: unknown): Failure {
  if (e instanceof ApiError && e.status === 410)
    return {
      title: 'This link is out of date',
      detail: 'Use the newest link we sent you, or give us a call and we’ll send another.',
    };
  if (e instanceof ApiError && (e.status === 404 || e.status === 400))
    return {
      title: 'This link doesn’t work',
      detail: 'Check that it matches the one we sent you, or give us a call.',
    };
  return {
    title: 'Something went wrong',
    detail: 'Try again in a moment, or give us a call.',
  };
}

const newClientId = (): string =>
  globalThis.crypto?.randomUUID?.() ??
  `card-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

const pressKey = (token: string) => `hfos.plan-card.${token}`;

function rememberPress(token: string, clientId: string): void {
  try {
    sessionStorage.setItem(pressKey(token), clientId);
  } catch {
    // A browser with storage turned off still works; it just can't be told it already saved.
  }
}
const recallPress = (token: string): string | null => {
  try {
    return sessionStorage.getItem(pressKey(token));
  } catch {
    return null;
  }
};
const forgetPress = (token: string): void => {
  try {
    sessionStorage.removeItem(pressKey(token));
  } catch {
    // Nothing to forget.
  }
};

/** What the provider sent this browser back with: the token it minted, or a cancelled trip. */
type Returned = { kind: 'cancelled' } | { kind: 'tokenised'; sourceToken: string } | null;

function readReturn(search: string): Returned {
  const q = new URLSearchParams(search);
  if (q.get('payment') === 'cancelled') return { kind: 'cancelled' };
  const sourceToken = q.get('token');
  return sourceToken ? { kind: 'tokenised', sourceToken } : null;
}

/** "Visa •••• 4242 · expires 04 / 29". */
function cardWords(card: NonNullable<PublicPlanView['card']>): string {
  const face = [card.brand, card.last4 ? `•••• ${card.last4}` : null].filter(Boolean).join(' ');
  const expiry =
    card.expiryMonth && card.expiryYear
      ? ` · expires ${String(card.expiryMonth).padStart(2, '0')} / ${String(card.expiryYear).slice(-2)}`
      : '';
  return `${face || 'Your card'}${expiry}`;
}

/** A stored day the customer can read, in their own browser's language. */
const dayWords = (day: string): string =>
  new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(new Date(`${day}T12:00:00Z`));

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 border-t border-border py-2.5 text-[13.5px] first:border-t-0">
      <span className="flex-none text-text-3">{label}</span>
      <span className="min-w-0 text-right">{children}</span>
    </div>
  );
}

export function PublicPlan({ token }: { token: string }) {
  const [view, setView] = useState<PublicPlanView | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [outcome, setOutcome] = useState<SavedCard | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [website, setWebsite] = useState('');
  const returned = useRef(false);
  /**
   * What the provider sent this browser back with, read once from the address before anything else runs — the
   * page is opened fresh by that redirect, so whether there is a card to finish saving is settled at the first
   * render and the plain read below is skipped for one.
   */
  const [handoff] = useState<Returned>(() =>
    typeof window === 'undefined' ? null : readReturn(window.location.search),
  );
  const finishing = !!handoff && handoff.kind !== 'cancelled';

  const failedSave = useCallback(
    async (e: unknown) => {
      if (e instanceof ApiError && (e.status === 410 || e.status === 404)) {
        setFailure(failureOf(e));
        return;
      }
      setError(e instanceof ApiError ? e.message : 'Something went wrong. Please try again.');
      try {
        setView(await getPlan(token));
      } catch {
        // Keep what's on screen.
      }
    },
    [token],
  );

  useEffect(() => {
    if (finishing) return;
    let live = true;
    getPlan(token)
      .then((v) => live && setView(v))
      .catch((e: unknown) => live && setFailure(failureOf(e)));
    return () => {
      live = false;
    };
  }, [token, finishing]);

  /** Back from the provider with a token: phase two saves it, and the worker's answer is what the page shows. */
  useEffect(() => {
    if (returned.current) return;
    returned.current = true;
    const back = handoff;
    if (!back) return;
    window.history.replaceState(null, '', window.location.pathname);
    if (back.kind === 'cancelled') {
      forgetPress(token);
      setNotice('Nothing was saved. Your plan is still waiting on a card.');
      void getPlan(token)
        .then(setView)
        .catch((e: unknown) => setFailure(failureOf(e)));
      return;
    }
    const clientId = recallPress(token) ?? newClientId();
    setBusy(true);
    void savePlanCard(token, { clientId, sourceToken: back.sourceToken, website: '' })
      .then((answer) => {
        forgetPress(token);
        if (answer.stage === 'saved') setOutcome(answer);
        setView(answer.plan);
        window.scrollTo({ top: 0 });
      })
      .catch((e: unknown) => void failedSave(e))
      .finally(() => setBusy(false));
  }, [token, failedSave, handoff]);

  /** Phase one: ask for a session and go wherever the provider collects the card. */
  async function addCard() {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    setOutcome(null);
    const clientId = newClientId();
    rememberPress(token, clientId);
    try {
      const answer = await savePlanCard(token, { clientId, website });
      if (answer.stage === 'saved') {
        forgetPress(token);
        setOutcome(answer);
        setView(answer.plan);
        setBusy(false);
        return;
      }
      const hosted = answer.session.hostedUrl;
      if (hosted) {
        window.location.assign(hosted);
        return;
      }
      // No page to send them to: a provider whose fields run inside this one isn't built yet.
      setError('We can’t take a card here just now. Please give us a call.');
      setBusy(false);
    } catch (e) {
      forgetPress(token);
      await failedSave(e);
      setBusy(false);
    }
  }

  if (failure)
    return (
      <MoneyFrame business={null} testId="plan-page">
        <PublicState
          tone="warning"
          icon={<CircleAlert size={20} />}
          title={failure.title}
          testId="plan-link-problem"
        >
          {failure.detail}
        </PublicState>
      </MoneyFrame>
    );
  if (!view)
    return (
      <MoneyFrame business={null} testId="plan-page">
        <PublicState icon={<Repeat size={20} />} title="Getting your plan…" testId="plan-loading">
          One moment.
        </PublicState>
      </MoneyFrame>
    );

  const { plan, card, standing, save } = view;
  const first = plan.startsOn ?? plan.nextBillingOn;
  const declined = outcome?.status === 'declined';
  const saved = outcome?.status === 'saved';
  const waiting = standing === 'waiting';
  const label = card ? 'Use a different card' : 'Add a card';

  return (
    <MoneyFrame
      business={view.business}
      testId="plan-page"
      footer={
        save.canSave ? (
          <Button
            className="h-12 w-full text-[15px]"
            loading={busy}
            onClick={() => void addCard()}
            data-testid="plan-add-card"
          >
            <CreditCard className="h-[18px] w-[18px]" strokeWidth={1.5} />
            {label}
          </Button>
        ) : null
      }
    >
      <MoneyBody testId="plan-body">
        {saved ? (
          <OkBox icon={<CircleCheck className="h-4 w-4" strokeWidth={1.75} />} testId="plan-saved">
            Your card is on your {plan.name} plan.{' '}
            {first ? `It bills ${dayWords(first)}, ` : 'It bills '}
            {plan.priceLabel.replace(/^\$\S+\s/, 'then ')} until you tell us to stop.
          </OkBox>
        ) : null}
        {declined ? (
          <div
            className="flex items-start gap-2.5 rounded-card bg-danger-soft p-3.5 text-[13.5px] leading-[1.5] text-danger-text"
            data-testid="plan-declined"
          >
            <CircleAlert className="mt-px h-4 w-4 flex-none" strokeWidth={1.75} />
            <span className="min-w-0 flex-1">
              {outcome?.failureMessage ?? 'That card was declined.'} Nothing was saved and your plan
              is still waiting — try another card, or give us a call.
            </span>
          </div>
        ) : null}
        {notice ? (
          <p
            className="rounded-card bg-card-2 p-3.5 text-[13.5px] leading-[1.5] text-text-2"
            data-testid="plan-notice"
          >
            {notice}
          </p>
        ) : null}
        {error ? (
          <p
            className="rounded-card bg-danger-soft p-3.5 text-[13.5px] leading-[1.5] text-danger-text"
            data-testid="plan-error"
          >
            {error}
          </p>
        ) : null}

        <div className="flex flex-col gap-0.5" data-testid="plan-hero">
          <span className="text-xs font-semibold uppercase tracking-[0.04em] text-text-3">
            {standing === 'ended'
              ? 'This plan has ended'
              : standing === 'paused'
                ? 'This plan is paused'
                : waiting
                  ? 'Your plan is ready to start'
                  : 'Your plan'}
          </span>
          <h1 className="text-[30px] font-semibold leading-[1.1] tracking-[-0.02em] sm:text-[34px]">
            {plan.name}
          </h1>
          <p className="text-sm text-text-2" data-testid="plan-price">
            {money(plan.priceCents)} {plan.priceLabel.replace(/^\S+\s/, '')}
            {view.customer.name ? ` · for ${view.customer.name}` : ''}
          </p>
        </div>

        {plan.includes.length ? (
          <div className="rounded-card border border-border bg-card p-4" data-print="card">
            <SectionLabel>What it includes</SectionLabel>
            <ul className="mt-1.5 flex flex-col gap-1.5 text-[13.5px]">
              {plan.includes.map((what) => (
                <li key={what} className="flex items-start gap-2">
                  <CircleCheck
                    className="mt-0.5 h-3.5 w-3.5 flex-none text-success-text"
                    strokeWidth={1.75}
                  />
                  <span>{what}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="rounded-card border border-border bg-card p-4" data-print="card">
          <SectionLabel>How it bills</SectionLabel>
          <div className="mt-1.5">
            <Row label="Price">{plan.priceLabel}</Row>
            <Row label="First charge">
              <span className="inline-flex items-center gap-1.5" data-testid="plan-first-charge">
                <CalendarClock className="h-3.5 w-3.5 text-text-3" strokeWidth={1.5} />
                {standing === 'ended'
                  ? 'Nothing — it has ended'
                  : standing === 'paused'
                    ? 'Nothing while it is paused'
                    : card
                      ? first
                        ? dayWords(first)
                        : 'On the next cycle'
                      : first
                        ? dayWords(first)
                        : 'As soon as you add a card'}
              </span>
            </Row>
            <Row label="Then">
              <span className="inline-flex items-center gap-1.5">
                <Repeat className="h-3.5 w-3.5 text-text-3" strokeWidth={1.5} />
                {plan.priceLabel}, until you tell us to stop
              </span>
            </Row>
            <Row label="Card">
              {card ? (
                <span data-testid="plan-card-on-file">{cardWords(card)}</span>
              ) : (
                <span className="text-text-3" data-testid="plan-card-on-file">
                  None yet
                </span>
              )}
            </Row>
          </div>
        </div>

        <p
          className="flex items-start gap-2 text-xs leading-[1.5] text-text-3"
          data-testid="plan-card-note"
        >
          <Lock className="mt-0.5 h-3.5 w-3.5 flex-none" strokeWidth={1.75} />
          <span>
            Your card details go straight to our payment company and are never held by{' '}
            {view.business.name}. You can change the card, or ask us to stop the plan, whenever you
            like.
          </span>
        </p>

        {!save.canSave && standing !== 'ended' ? (
          <p className="text-[13.5px] text-text-2" data-testid="plan-cannot-save">
            We can’t take a card on this plan right now. Please give us a call and we’ll sort it
            out.
          </p>
        ) : null}

        <Honeypot value={website} onChange={setWebsite} id="plan-website" />
        <PageActions business={view.business} />
      </MoneyBody>
    </MoneyFrame>
  );
}
