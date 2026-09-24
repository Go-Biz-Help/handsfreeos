'use client';
/**
 * A campaign email's unsubscribe page (/u/<token>): whose email it is, one button, and then "done". Loaded from
 * the customer's browser, so the worker's per-address limits count per customer. It stops that business's
 * campaign email only; their visit confirmations and replies still come.
 */
import { CircleCheck, Link2Off, MailX } from 'lucide-react';
import { useEffect, useState } from 'react';
import { PublicFrame, PublicState } from '@/components/booking/public-shell';
import { Button } from '@/components/ui/button';
import { ApiError } from '@/lib/api/errors';
import { getUnsubscribe, unsubscribe, type UnsubscribeView } from '@/lib/api/public-unsubscribe';

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; view: UnsubscribeView }
  | { kind: 'missing'; message: string };

export function UnsubscribePage({ token }: { token: string }) {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    getUnsubscribe(token).then(
      (view) => live && setState({ kind: 'ready', view }),
      (e: unknown) =>
        live &&
        setState({
          kind: 'missing',
          message: e instanceof ApiError ? e.message : 'Something went wrong. Please try again.',
        }),
    );
    return () => {
      live = false;
    };
  }, [token]);

  const press = async () => {
    setBusy(true);
    setError(null);
    try {
      setState({ kind: 'ready', view: await unsubscribe(token) });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  if (state.kind === 'loading')
    return (
      <PublicFrame business={null}>
        <div className="flex-1" aria-busy />
      </PublicFrame>
    );
  if (state.kind === 'missing')
    return (
      <PublicFrame business={null}>
        <PublicState
          icon={<Link2Off size={20} />}
          title="This link doesn’t work"
          testId="unsubscribe-missing"
        >
          {state.message}
        </PublicState>
      </PublicFrame>
    );
  const { view } = state;
  if (view.unsubscribed)
    return (
      <PublicFrame business={null}>
        <PublicState
          tone="success"
          icon={<CircleCheck size={20} />}
          title="You’re unsubscribed"
          testId="unsubscribe-done"
        >
          {view.business} won’t send {view.address} any more of these emails. Messages about your
          own visits still come.
        </PublicState>
      </PublicFrame>
    );
  return (
    <PublicFrame business={null}>
      <PublicState
        icon={<MailX size={20} />}
        title={`Stop emails from ${view.business}?`}
        testId="unsubscribe-ask"
        action={
          <div className="flex flex-col items-center gap-2">
            <Button onClick={() => void press()} disabled={busy} data-testid="unsubscribe-button">
              {busy ? 'Unsubscribing…' : 'Unsubscribe'}
            </Button>
            {error ? (
              <p className="text-[13px] text-danger-text" role="alert">
                {error}
              </p>
            ) : null}
          </div>
        }
      >
        {view.address} won’t get their offers and news any more. Messages about your own visits
        still come.
      </PublicState>
    </PublicFrame>
  );
}
