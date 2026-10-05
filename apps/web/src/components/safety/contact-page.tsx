'use client';
/**
 * An outside safety contact's page (`/s/<token>`, round six, core; board 91's second panel): someone who picked them
 * as a contact missed their check-out (or asked for help), and their text or email carried this link. It shows just
 * that check-in while it's being told about (the place, the planned end, when they checked in, where their phone was
 * and their phone), with Call, I reached them, they're OK (the alerts stop for everyone) and I couldn't reach them
 * (the teammates who were told hear it). Once someone says they're OK, or they check out, it says so and nothing more.
 *
 * Loaded from the contact's own browser (lib/api/public-safety.ts), so opening the link changes nothing.
 */
import { CircleCheck, Link2Off, MapPin, Phone, ShieldAlert } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { PublicFrame, PublicState } from '@/components/booking/public-shell';
import { Button, buttonClassName } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ApiError } from '@/lib/api/errors';
import {
  answerSafetyLink,
  getSafetyLink,
  type SafetyLinkOpen,
  type SafetyLinkView,
} from '@/lib/api/public-safety';
import { mapLink } from './safety-alert';

const BYLINE = 'Check-ins by HandsFreeOS';

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; view: SafetyLinkView }
  | { kind: 'missing'; message: string };

const message = (e: unknown) =>
  e instanceof ApiError ? e.message : 'Something went wrong. Try again, or call them yourself.';

export function SafetyContactPage({ token }: { token: string }) {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [busy, setBusy] = useState<'ok' | 'unreached' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unreached, setUnreached] = useState(false);

  useEffect(() => {
    let live = true;
    getSafetyLink(token).then(
      (view) => live && setState({ kind: 'ready', view }),
      (e: unknown) => live && setState({ kind: 'missing', message: message(e) }),
    );
    return () => {
      live = false;
    };
  }, [token]);

  const answer = async (how: 'ok' | 'unreached') => {
    setBusy(how);
    setError(null);
    try {
      const view = await answerSafetyLink(token, how);
      setState({ kind: 'ready', view });
      if (how === 'unreached') setUnreached(true);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(null);
    }
  };

  if (state.kind === 'loading')
    return (
      <PublicFrame business={null} byline={BYLINE}>
        <div className="flex-1" aria-busy />
      </PublicFrame>
    );
  if (state.kind === 'missing')
    return (
      <PublicFrame business={null} byline={BYLINE}>
        <PublicState
          icon={<Link2Off size={20} />}
          title="This link doesn’t work"
          testId="safety-link-missing"
        >
          {state.message}
        </PublicState>
      </PublicFrame>
    );
  const { view } = state;
  if (!view.open)
    return (
      <PublicFrame business={null} byline={BYLINE}>
        <PublicState
          tone="success"
          icon={<CircleCheck size={20} />}
          title={
            view.settled === 'checked_out' ? `${view.person} checked out` : `${view.person} is OK`
          }
          testId="safety-link-over"
        >
          {view.settled === 'checked_out'
            ? `${view.person} checked out, so the alerts have stopped. Nothing more to do.`
            : `Someone reached ${view.person}, so the alerts have stopped for everyone. Nothing more to do. Thanks for looking out.`}
        </PublicState>
      </PublicFrame>
    );
  return (
    <PublicFrame business={null} byline={BYLINE}>
      <OpenCheckIn
        view={view}
        busy={busy}
        error={error}
        unreached={unreached}
        onAnswer={(how) => void answer(how)}
      />
    </PublicFrame>
  );
}

function OpenCheckIn({
  view,
  busy,
  error,
  unreached,
  onAnswer,
}: {
  view: SafetyLinkOpen;
  busy: 'ok' | 'unreached' | null;
  error: string | null;
  unreached: boolean;
  onAnswer: (how: 'ok' | 'unreached') => void;
}) {
  return (
    <div className="mx-auto w-full max-w-[480px] px-4 py-6" data-testid="safety-link">
      <Card className="p-4">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 inline-flex h-8 w-8 flex-none items-center justify-center rounded-full bg-danger-soft text-danger-text">
            <ShieldAlert size={17} strokeWidth={1.75} />
          </span>
          <div className="min-w-0">
            <h1 className="text-[17px] font-semibold" data-testid="safety-link-title">
              {view.help ? `${view.person} asked for help` : `${view.person} hasn’t checked out`}
            </h1>
            <p className="text-[13px] text-text-2">
              At <span className="font-semibold text-text">{view.place}</span>
            </p>
          </div>
        </div>
        <dl className="mt-4 divide-y divide-border rounded-control border border-border">
          <Row label="Planned end">{view.plannedEnd}</Row>
          <Row label="Checked in">{view.checkedIn}</Row>
          {view.located ? (
            <Row label="Where their phone was">
              <a
                href={mapLink(view.located.latitude, view.located.longitude)}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-accent-text hover:underline"
              >
                <MapPin size={14} strokeWidth={1.75} />
                On the map{view.located.at ? `, ${view.located.at}` : ''}
              </a>
            </Row>
          ) : null}
          <Row label="Their phone">{view.phoneWords ?? 'Not on file'}</Row>
        </dl>
        <p className="mt-3 text-[12.5px] text-text-3">
          You’re a safety contact for {view.first} at {view.business}.
        </p>
      </Card>
      <div className="mt-4 flex flex-col gap-2">
        {view.phone ? (
          <a
            href={`tel:${view.phone}`}
            className={buttonClassName({ variant: 'primary', className: 'h-11 w-full' })}
            data-testid="safety-link-call"
          >
            <Phone size={16} aria-hidden />
            Call {view.first}
          </a>
        ) : null}
        <Button
          variant={view.phone ? 'secondary' : 'primary'}
          className="h-11 w-full"
          loading={busy === 'ok'}
          disabled={busy !== null}
          onClick={() => onAnswer('ok')}
          data-testid="safety-link-ok"
        >
          <CircleCheck size={16} aria-hidden />I reached {view.first}, they’re OK
        </Button>
        {unreached ? (
          <p
            className="rounded-menu bg-warning-soft px-3.5 py-3 text-[13px] text-warning-text"
            role="status"
            data-testid="safety-link-unreached"
          >
            Thanks for trying. The teammates who were told hear that you couldn’t reach {view.first}
            . Keep trying, and press I reached {view.first} once you do.
          </p>
        ) : (
          <Button
            variant="ghost"
            className="w-full"
            loading={busy === 'unreached'}
            disabled={busy !== null}
            onClick={() => onAnswer('unreached')}
            data-testid="safety-link-unreached-button"
          >
            I couldn’t reach them
          </Button>
        )}
        {error ? (
          <p className="text-center text-[13px] text-danger-text" role="alert">
            {error}
          </p>
        ) : null}
      </div>
      <p className="mt-4 text-[12.5px] text-text-3">
        If you think {view.first} is in danger, call 911. This page stops working once someone says{' '}
        {view.first} is OK.
      </p>
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 px-3.5 py-2.5 text-[13.5px]">
      <dt className="text-text-2">{label}</dt>
      <dd className="text-right">{children}</dd>
    </div>
  );
}
