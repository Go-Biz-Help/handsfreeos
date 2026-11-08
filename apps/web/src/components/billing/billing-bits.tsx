'use client';
import { BILLING_WORDS as W, moreTimeBounds, planCardName } from '@hfos/core';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { Ok } from '@/lib/api/types';
import { planCard } from '@/lib/api/worker';

type Owed = NonNullable<Ok<'/v1/queries/billing.status'>['owed']>;

/**
 * The parts Settings → Billing and the failed-payment page share (20261027023600): what's owed with its buttons, asking
 * for more time, adding a card on Stripe's page, and coming back from it.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * After Try my cards now (or a card added to pay with), wait for the worker's answer: paid when nothing is owed, still
 * declined once a card was declined after we asked. Gives up after about half a minute, still trying.
 */
export async function waitForPayment(
  workspaceId: string,
  since: number,
): Promise<'paid' | 'declined' | 'waiting'> {
  for (let i = 0; i < 15; i++) {
    await sleep(2000);
    const status = unwrap(
      await apiBrowser().POST('/v1/queries/billing.status', { body: { workspaceId } }),
    );
    if (!status.owed) return 'paid';
    if (status.owed.lastTriedAt && new Date(status.owed.lastTriedAt).getTime() >= since - 1000)
      return 'declined';
  }
  return 'waiting';
}

/** Sends them to Stripe's page for a card: the worker builds the address they come back to. */
export async function goAddCard(input: {
  workspaceId: string;
  from: 'billing' | 'payment';
  makeDefault?: boolean;
  payNow?: boolean;
}): Promise<void> {
  const started = await planCard(input);
  if (started.stage === 'started') window.location.assign(started.hostedUrl);
}

/**
 * Back from Stripe's card page, with `?card=` on the address (and what they asked for: `makeDefault`, `payNow`). The
 * session is only a name for what happened, as on Usage & balance: the worker reads the card off Stripe itself. It is
 * taken off the address either way, so a refresh never saves anything twice.
 */
export function usePlanCardReturn({
  workspaceId,
  from,
  onPaid,
}: {
  workspaceId: string;
  from: 'billing' | 'payment';
  /** A payment that was owed went through on the new card. */
  onPaid?: () => void;
}): boolean {
  const router = useRouter();
  const [busy, start] = useTransition();
  const done = useRef(false);
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const mark = q.get('card');
    if (!mark || done.current) return;
    done.current = true;
    window.history.replaceState(null, '', window.location.pathname);
    if (mark === 'cancelled') {
      toast.info(W.cardCancelled);
      return;
    }
    const makeDefault = q.get('makeDefault') === '1';
    const payNow = q.get('payNow') === '1';
    start(async () => {
      try {
        const since = Date.now();
        const answer = await planCard({ workspaceId, sessionRef: mark, makeDefault, payNow, from });
        if (answer.stage !== 'saved') {
          toast.info(W.cardCancelled);
          return;
        }
        const name = planCardName(answer.card);
        toast.success(answer.card.isDefault ? W.cardAddedDefault(name) : W.cardAdded(name));
        if (answer.paying) {
          toast.info(W.payingNow);
          const result = await waitForPayment(workspaceId, since);
          if (result === 'paid') {
            toast.success(W.paidNow);
            onPaid?.();
          } else if (result === 'declined') {
            const status = unwrap(
              await apiBrowser().POST('/v1/queries/billing.status', { body: { workspaceId } }),
            );
            toast.error(W.stillDeclined(status.owed?.problem ?? 'The card was declined.'));
          }
        }
        router.refresh();
      } catch (e) {
        toast.error(errorMessage(e));
      }
    });
  }, [from, onPaid, router, workspaceId]);
  return busy;
}

/** Asking HandsFreeOS for more time: the day they think they can pay by, and a note. Opens a support ticket. */
export function MoreTimeDialog({
  workspaceId,
  open,
  onClose,
}: {
  workspaceId: string;
  open: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const bounds = moreTimeBounds(new Date());
  const [payBy, setPayBy] = useState(bounds.earliest);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sending, start] = useTransition();
  const send = () =>
    start(async () => {
      setError(null);
      try {
        unwrap(
          await apiBrowser().POST('/v1/commands/billing.ask_more_time', {
            body: { workspaceId, payBy, note },
          }),
        );
        toast.success(W.moreTimeSent(`${payBy}T12:00:00Z`));
        onClose();
        router.refresh();
      } catch (e) {
        setError(errorMessage(e));
      }
    });
  return (
    <Dialog open={open} onOpenChange={(o) => (o ? null : onClose())}>
      <DialogContent title={W.moreTimeTitle} description={W.moreTimeBlurb}>
        <div className="mt-4 flex flex-col gap-3">
          <Field
            label={W.moreTimeDate}
            htmlFor="more-time-date"
            hint={W.moreTimeLimits(`${bounds.earliest}T12:00:00Z`, `${bounds.latest}T12:00:00Z`)}
          >
            <Input
              id="more-time-date"
              type="date"
              min={bounds.earliest}
              max={bounds.latest}
              value={payBy}
              onChange={(e) => setPayBy(e.target.value)}
              data-testid="more-time-date"
            />
          </Field>
          <Field label={W.moreTimeNote} htmlFor="more-time-note">
            <Textarea
              id="more-time-note"
              rows={3}
              maxLength={2000}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              data-testid="more-time-note"
            />
          </Field>
        </div>
        {error ? <p className="mt-3 text-[13px] text-danger-text">{error}</p> : null}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={send} disabled={sending || !payBy} data-testid="more-time-send">
            {sending ? W.moreTimeSending : W.moreTimeSend}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * A payment that didn't go through: what and when, why, the next automatic try, and the three ways out (try the cards
 * now, add a card and pay with it, ask for more time). For whoever manages money; everyone else is told who to ask.
 */
export function OwedPanel({
  workspaceId,
  owed,
  from,
  hasCards,
  onPaid,
}: {
  workspaceId: string;
  owed: Owed;
  from: 'billing' | 'payment';
  /** Try my cards now needs a card to try. */
  hasCards: boolean;
  onPaid?: () => void;
}) {
  const router = useRouter();
  const [asking, setAsking] = useState(false);
  const [busy, start] = useTransition();
  const request = owed.timeRequest;
  const waiting = request?.status === 'pending';

  const payNow = () =>
    start(async () => {
      try {
        const since = Date.now();
        const out = unwrap(
          await apiBrowser().POST('/v1/commands/billing.pay_now', { body: { workspaceId } }),
        );
        if (out.outcome === 'nothing_owed') {
          toast.success(W.paidNow);
          onPaid?.();
          router.refresh();
          return;
        }
        const result = await waitForPayment(workspaceId, since);
        if (result === 'paid') {
          toast.success(W.paidNow);
          onPaid?.();
        } else if (result === 'declined') {
          const status = unwrap(
            await apiBrowser().POST('/v1/queries/billing.status', { body: { workspaceId } }),
          );
          toast.error(W.stillDeclined(status.owed?.problem ?? 'The card was declined.'));
        } else toast.info(W.payingNow);
        router.refresh();
      } catch (e) {
        toast.error(errorMessage(e));
      }
    });

  const addAndPay = () =>
    start(async () => {
      try {
        await goAddCard({ workspaceId, from, makeDefault: true, payNow: true });
      } catch (e) {
        toast.error(errorMessage(e));
      }
    });

  return (
    <div data-testid="billing-owed">
      <p className="text-[13px]">{W.owedLine(owed.amountCents, owed.failedAt)}</p>
      {owed.problem ? (
        <p className="mt-1 text-[13px] text-text-2">{W.owedWhy(owed.problem)}</p>
      ) : null}
      <p className="mt-1 text-[13px] text-text-2">
        {owed.moreTimeUntil
          ? W.moreTimeGranted(owed.moreTimeUntil)
          : owed.nextRetryAt
            ? W.owedRetry(owed.nextRetryAt)
            : W.owedNoMoreRetries}
      </p>
      {waiting ? (
        <p className="mt-2 text-[13px] text-text-2" data-testid="billing-more-time-waiting">
          {W.moreTimeWaiting(`${request.payBy}T12:00:00Z`)}
        </p>
      ) : request?.status === 'declined' ? (
        <p className="mt-2 text-[13px] text-danger-text">{W.moreTimeDeclined}</p>
      ) : null}
      <div className="mt-4 flex flex-wrap gap-2">
        {hasCards ? (
          <Button onClick={payNow} disabled={busy} data-testid="billing-pay-now">
            {busy ? W.payingNow : W.payNow}
          </Button>
        ) : null}
        <Button
          variant={hasCards ? 'secondary' : 'primary'}
          onClick={addAndPay}
          disabled={busy}
          data-testid="billing-add-and-pay"
        >
          {W.addCardAndPay}
        </Button>
        {!waiting && !owed.moreTimeUntil ? (
          <Button
            variant="ghost"
            onClick={() => setAsking(true)}
            disabled={busy}
            data-testid="billing-more-time"
          >
            {W.moreTime}
          </Button>
        ) : null}
      </div>
      <MoreTimeDialog workspaceId={workspaceId} open={asking} onClose={() => setAsking(false)} />
    </div>
  );
}
