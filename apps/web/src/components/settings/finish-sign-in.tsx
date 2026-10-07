'use client';
/**
 * The last step of connecting an account: Stripe, Square, a mailbox, a calendar, a review place, the CRM a
 * business is leaving (SEC-M1, SEC-M7), or the Facebook Pages and Instagram accounts the inbox answers.
 *
 * The provider sends the browser back to the worker, which connects nothing — whoever that browser belongs to is
 * not known there — and hands what came back to this page after the `#`. From here it is posted to the worker
 * signed in, and the worker finishes it only for the person who pressed Connect. So a sign-in link forwarded to
 * somebody in another business ends here, with nothing connected.
 */
import { AlertCircle } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Brand } from '@/components/ui/brand';
import { Button, ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { ApiError } from '@/lib/api/errors';
import { workerPost } from '@/lib/api/worker';
import { FINISH_PATH, forgetHandoff, keepHandoff, keptHandoff } from '@/lib/auth/sign-in-handoff';
import { setupReturnFor } from '@/lib/setup-return';

interface FinishPage {
  readonly title: string;
  readonly body: string;
  readonly link?: { readonly href: string; readonly label: string };
}

/** One line of a checklist: a Facebook Page, or the Instagram account linked to it (`parent`). */
interface PickOption {
  readonly id: string;
  readonly name: string;
  readonly detail: string | null;
  /** The line it sits under, and is ticked along with. */
  readonly parent: string | null;
  readonly checked: boolean;
  /** Not this checklist's to change: connected here already, or not this sign-in's to connect. */
  readonly disabled: boolean;
  readonly note: string | null;
}

/** Which of several things to connect (20261025000200), answered at `answer` with the ids ticked. */
interface FinishPick {
  readonly title: string;
  readonly body: string;
  readonly options: readonly PickOption[];
  readonly submit: string;
  readonly answer: string;
}

/**
 * What the worker answers: where to go next, a page to show, which review place this is, or which Facebook Pages
 * answer here.
 */
type Outcome =
  | { readonly next: string }
  | { readonly page: FinishPage }
  | { readonly choose: { readonly places: readonly { id: string; name: string }[] } }
  | { readonly pick: FinishPick };

type View =
  | { readonly kind: 'working' }
  | { readonly kind: 'page'; readonly page: FinishPage }
  | { readonly kind: 'choose'; readonly places: readonly { id: string; name: string }[] }
  | { readonly kind: 'pick'; readonly pick: FinishPick };

const EXPIRED: FinishPage = {
  title: 'This sign-in link has expired',
  body: 'Sign-in links last ten minutes. Go back to Settings and choose Connect again.',
};

const signedOut = (e: unknown) => e instanceof ApiError && e.status === 401;

/** Which callback sent the browser here, as its `?door=` says. */
type Door = 'oauth' | 'migration' | 'addon';

/** Where each door is finished, in the worker. */
const FINISH_AT: Record<Door, string> = {
  oauth: '/v1/oauth/finish',
  migration: '/v1/migrations/finish',
  // An add-on's connection by sign-in (round five).
  addon: '/v1/addons/connections/finish',
};

function failed(e: unknown, door: Door): FinishPage {
  if (signedOut(e))
    return {
      title: 'Sign in to finish connecting',
      body: 'Only the person who pressed Connect can finish connecting an account. Sign in as them to finish.',
      // The handoff is kept in this tab, so signing in comes straight back here and finishes.
      link: {
        href: `/sign-in?next=${encodeURIComponent(`${FINISH_PATH}?door=${door}`)}`,
        label: 'Sign in',
      },
    };
  return {
    title: 'That didn’t connect',
    body:
      e instanceof ApiError
        ? e.message
        : 'Something went wrong. Go back to Settings and try again.',
  };
}

export function FinishSignIn() {
  const [view, setView] = useState<View>({ kind: 'working' });
  const [choosing, setChoosing] = useState<string | null>(null);
  const [ticked, setTicked] = useState<ReadonlySet<string>>(() => new Set());
  const handoff = useRef<string | null>(null);
  const started = useRef(false);

  const follow = (out: Outcome) => {
    // Back to the setup wizard when the sign-in started there.
    if ('next' in out) window.location.replace(setupReturnFor(out.next));
    else if ('page' in out) setView({ kind: 'page', page: out.page });
    else if ('pick' in out) {
      setTicked(new Set(out.pick.options.filter((o) => o.checked).map((o) => o.id)));
      setView({ kind: 'pick', pick: out.pick });
    } else setView({ kind: 'choose', places: out.choose.places });
  };

  useEffect(() => {
    // Once, even when React runs an effect twice: a second post would find the sign-in already finished.
    if (started.current) return;
    started.current = true;
    // After the `#`, or kept in this tab when the person had to sign in first.
    const sealed = decodeURIComponent(window.location.hash.slice(1)) || keptHandoff();
    const asked = new URLSearchParams(window.location.search).get('door');
    const door: Door = asked === 'migration' || asked === 'addon' ? asked : 'oauth';
    // Out of the address bar and the history before anything else happens.
    window.history.replaceState(null, '', window.location.pathname);
    if (!sealed) {
      setView({ kind: 'page', page: EXPIRED });
      return;
    }
    handoff.current = sealed;
    // Kept until the worker answers somebody signed in, so a sign-in in between can pick it up again.
    keepHandoff(sealed);
    workerPost<Outcome>(FINISH_AT[door], {
      handoff: sealed,
    }).then(
      (out) => {
        forgetHandoff();
        follow(out);
      },
      (e: unknown) => {
        if (!signedOut(e)) forgetHandoff();
        setView({ kind: 'page', page: failed(e, door) });
      },
    );
  }, []);

  const choose = (place: string) => {
    if (!handoff.current) return;
    setChoosing(place);
    workerPost<Outcome>('/v1/oauth/place', { handoff: handoff.current, place }).then(
      (out) => {
        setChoosing(null);
        follow(out);
      },
      (e: unknown) => {
        setChoosing(null);
        setView({ kind: 'page', page: failed(e, 'oauth') });
      },
    );
  };

  /** A Page ticks or unticks the Instagram account linked to it along with it; an account goes on its own. */
  const tick = (pick: FinishPick, option: PickOption, on: boolean) =>
    setTicked((was) => {
      const next = new Set(was);
      const lines = [option, ...pick.options.filter((o) => o.parent === option.id && !o.disabled)];
      for (const o of lines) {
        if (on) next.add(o.id);
        else next.delete(o.id);
      }
      return next;
    });

  /** The checklist's answer; none ticked is a "no thanks", which the worker records as cancelled. */
  const answer = (pick: FinishPick, ids: readonly string[]) => {
    if (!handoff.current) return;
    setChoosing(ids.length ? 'pick' : 'cancel');
    workerPost<Outcome>(pick.answer, { handoff: handoff.current, ids }).then(
      (out) => {
        setChoosing(null);
        follow(out);
      },
      (e: unknown) => {
        setChoosing(null);
        setView({ kind: 'page', page: failed(e, 'oauth') });
      },
    );
  };

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 px-6 py-12">
      <Brand size={32} className="text-base" />
      <Card className="w-[480px] max-w-full rounded-dialog p-9" data-testid="finish-sign-in">
        {view.kind === 'working' ? (
          <p className="flex items-center gap-3 text-text-2" aria-live="polite">
            <span
              className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent"
              aria-hidden
            />
            Finishing connecting…
          </p>
        ) : view.kind === 'pick' ? (
          <>
            <h1 className="text-2xl font-semibold tracking-tight">{view.pick.title}</h1>
            <p className="mt-2 leading-relaxed text-text-2">{view.pick.body}</p>
            <div className="mt-6 flex flex-col gap-3" data-testid="finish-pick">
              {view.pick.options.map((o) => (
                <div key={o.id} className={o.parent ? 'pl-7' : undefined}>
                  <Checkbox
                    checked={ticked.has(o.id)}
                    disabled={o.disabled || choosing !== null}
                    onChange={(e) => tick(view.pick, o, e.target.checked)}
                    data-testid={`finish-pick-${o.id}`}
                    className={o.disabled ? 'cursor-not-allowed opacity-70' : undefined}
                    label={
                      <span className="flex flex-col">
                        <span className="font-medium">{o.name}</span>
                        {o.detail ? (
                          <span className="text-[13px] text-text-3">{o.detail}</span>
                        ) : null}
                        {o.note ? <span className="text-[13px] text-text-2">{o.note}</span> : null}
                      </span>
                    }
                  />
                </div>
              ))}
            </div>
            <div className="mt-6 flex flex-col gap-2">
              <Button
                size="lg"
                className="w-full"
                loading={choosing === 'pick'}
                // One already here counts: connecting it again is how a Page that stopped working is mended.
                disabled={choosing !== null || ticked.size === 0}
                onClick={() => answer(view.pick, [...ticked])}
                data-testid="finish-pick-submit"
              >
                {view.pick.submit}
              </Button>
              <Button
                size="lg"
                variant="ghost"
                className="w-full"
                loading={choosing === 'cancel'}
                disabled={choosing !== null}
                onClick={() => answer(view.pick, [])}
              >
                Cancel
              </Button>
            </div>
          </>
        ) : view.kind === 'choose' ? (
          <>
            <h1 className="text-2xl font-semibold tracking-tight">Which one is this business?</h1>
            <p className="mt-2 leading-relaxed text-text-2">
              That sign-in can speak for more than one. Choose the one whose reviews belong here.
            </p>
            <div className="mt-6 flex flex-col gap-2">
              {view.places.map((p) => (
                <Button
                  key={p.id}
                  variant="secondary"
                  size="lg"
                  className="w-full justify-start"
                  loading={choosing === p.id}
                  disabled={choosing !== null}
                  onClick={() => choose(p.id)}
                >
                  {p.name}
                </Button>
              ))}
            </div>
          </>
        ) : (
          <>
            <div className="flex items-start gap-3">
              <AlertCircle className="mt-1 h-5 w-5 flex-none text-danger" strokeWidth={1.5} />
              <div>
                <h1 className="text-2xl font-semibold tracking-tight">{view.page.title}</h1>
                <p className="mt-2 leading-relaxed text-text-2">{view.page.body}</p>
              </div>
            </div>
            <ButtonLink
              href={view.page.link?.href ?? '/app'}
              variant="primary"
              size="lg"
              className="mt-6 w-full"
            >
              {view.page.link?.label ?? 'Back to HandsFreeOS'}
            </ButtonLink>
          </>
        )}
      </Card>
    </div>
  );
}
