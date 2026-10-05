'use client';
/**
 * A customer's portal (`/c/<token>`, boards 26–31 in design/realestate): the business on top, one phone-width
 * column, and a menu at the bottom. Chris decided (2026-09-30): the link in the email opens it, and a device that
 * hasn't been used here types the 6-digit code we email to the address on file; there's no password. A device
 * stays signed in for 30 days after it was last used, 90 at most.
 *
 * The menu is Home, each add-on's own places (its manifest's portal pages without an id, like Real Estate's Homes
 * and To do), and Messages. An add-on's pages open at `a/<id>/<path>` through the registry.
 */
import { Home, LayoutGrid, MessageSquare } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ADDON_UI, type AddonIcon } from '@/addons/registry';
import { BizMark } from '@/components/money/public-shell';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ApiError, errorMessage } from '@/lib/api/errors';
import {
  portalFileUrl,
  portalLink,
  portalOp,
  saveBearer,
  savedBearer,
  sendPortalCode,
  signOutPortal,
  uploadPortalFile,
  verifyPortalCode,
  type PortalLink,
} from '@/lib/api/public-portal';
import { cn } from '@/lib/utils';
import { PortalProvider, type Portal, type PortalHome } from './context';

type State =
  | { readonly kind: 'loading' }
  | { readonly kind: 'broken'; readonly words: string }
  | { readonly kind: 'signed_out'; readonly link: PortalLink }
  | {
      readonly kind: 'in';
      readonly link: PortalLink;
      readonly bearer: string;
      readonly home: PortalHome;
    };

/** A name for this device on the business's side ("iPhone · Safari"), so they can tell their devices apart. */
function deviceName(): string {
  const ua = navigator.userAgent;
  const os = /iPhone/.test(ua)
    ? 'iPhone'
    : /iPad/.test(ua)
      ? 'iPad'
      : /Android/.test(ua)
        ? 'Android'
        : /Mac OS X/.test(ua)
          ? 'Mac'
          : /Windows/.test(ua)
            ? 'Windows'
            : 'Computer';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Chrome\//.test(ua)
      ? 'Chrome'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Safari\//.test(ua)
          ? 'Safari'
          : 'a browser';
  return `${os} · ${browser}`;
}

export function PortalShell({ token, children }: { token: string; children: ReactNode }) {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const enter = useCallback(
    async (bearer: string | null) => {
      try {
        const link = await portalLink(token, bearer);
        if (!link.signedIn || !bearer) {
          if (bearer) saveBearer(token, null);
          return setState({ kind: 'signed_out', link });
        }
        const home = await portalOp<PortalHome>(bearer, 'portal.home');
        setState({ kind: 'in', link, bearer, home });
      } catch (e) {
        setState({ kind: 'broken', words: errorMessage(e) });
      }
    },
    [token],
  );
  useEffect(() => {
    void enter(savedBearer(token));
  }, [enter, token]);

  const portal = useMemo<Portal | null>(() => {
    if (state.kind !== 'in') return null;
    const bearer = state.bearer;
    const base = `/c/${encodeURIComponent(token)}`;
    return {
      token,
      home: state.home,
      href: (path = '') => (path ? `${base}/${path}` : base),
      op: async <T,>(name: string, input: Record<string, unknown> = {}) => {
        try {
          return await portalOp<T>(bearer, name, input);
        } catch (e) {
          // Signed out elsewhere, or the business turned the portal off: back to the sign-in.
          if (e instanceof ApiError && e.rule === 'portal_signed_out') {
            saveBearer(token, null);
            void enter(null);
          }
          throw e;
        }
      },
      upload: (file, recordId) => uploadPortalFile(bearer, file, recordId),
      openFile: async (fileId) => {
        const f = await portalFileUrl(bearer, fileId);
        window.open(f.url, '_blank', 'noopener');
      },
    };
  }, [state, token, enter]);

  const business =
    state.kind === 'signed_out' || state.kind === 'in' ? state.link.business.name : '';
  const who =
    state.kind === 'in'
      ? `${state.home.person.firstName} ${state.home.person.lastName}`.trim()
      : state.kind === 'signed_out'
        ? state.link.person.firstName
        : '';
  return (
    <div className="min-h-dvh bg-bg" data-testid="portal">
      <header className="sticky top-0 z-20 border-b border-border bg-card">
        <div className="mx-auto flex h-16 max-w-[560px] items-center gap-3 px-4">
          {business ? <BizMark name={business} /> : null}
          <div className="min-w-0 flex-1">
            <div className="truncate text-[15px] font-semibold">{business}</div>
            {who ? <div className="truncate text-[12.5px] text-text-2">{who}’s portal</div> : null}
          </div>
          {state.kind === 'in' ? (
            <button
              type="button"
              className="text-[13.5px] text-text-2 hover:text-text"
              onClick={() =>
                void signOutPortal(token, state.bearer)
                  .catch(() => null)
                  .then(() => {
                    saveBearer(token, null);
                    void enter(null);
                  })
              }
              data-testid="portal-sign-out"
            >
              Sign out
            </button>
          ) : null}
        </div>
      </header>
      {state.kind === 'loading' ? (
        <div className="mx-auto max-w-[560px] px-4 py-10 text-center text-[14px] text-text-2">
          Opening your portal…
        </div>
      ) : state.kind === 'broken' ? (
        <div className="mx-auto max-w-[560px] px-4 py-10">
          <Card className="p-5 text-[14px]" role="alert" data-testid="portal-broken">
            {state.words}
          </Card>
        </div>
      ) : state.kind === 'signed_out' ? (
        <SignIn
          token={token}
          link={state.link}
          onIn={(bearer) => {
            saveBearer(token, bearer);
            void enter(bearer);
          }}
        />
      ) : (
        <PortalProvider value={portal}>
          <main className="mx-auto max-w-[560px] px-4 pb-28 pt-5">{children}</main>
          <PortalMenu home={state.home} base={portal!.href()} />
        </PortalProvider>
      )}
    </div>
  );
}

function PortalMenu({ home, base }: { home: PortalHome; base: string }) {
  const pathname = usePathname();
  const items: { href: string; label: string; icon: AddonIcon; exact?: boolean }[] = [
    { href: base, label: 'Home', icon: Home, exact: true },
    ...home.addons.flatMap((a) =>
      a.pages
        .filter((p) => p.path !== '')
        .map((p) => ({
          href: `${base}/a/${a.id}/${p.path}`,
          label: p.title,
          icon: ADDON_UI[a.id]?.portal?.icons?.[p.path] ?? LayoutGrid,
        })),
    ),
    { href: `${base}/messages`, label: 'Messages', icon: MessageSquare },
  ];
  return (
    <nav
      aria-label="Your portal"
      className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-card pb-[env(safe-area-inset-bottom)]"
    >
      <ul className="mx-auto flex max-w-[560px]">
        {items.map((i) => {
          const on = i.exact ? pathname === i.href : pathname.startsWith(i.href);
          const Icon = i.icon;
          return (
            <li key={i.href} className="flex-1">
              <Link
                href={i.href}
                aria-current={on ? 'page' : undefined}
                className={cn(
                  'flex h-16 flex-col items-center justify-center gap-1 text-[12px]',
                  on ? 'font-semibold text-accent-text' : 'text-text-2',
                )}
              >
                <Icon className="h-5 w-5" strokeWidth={1.75} />
                {i.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** Board 26: a code to the email on file, typed back here. */
function SignIn({
  token,
  link,
  onIn,
}: {
  token: string;
  link: PortalLink;
  onIn: (bearer: string) => void;
}) {
  const [sent, setSent] = useState<{ to: string; minutes: number } | null>(null);
  const [digits, setDigits] = useState<string[]>(['', '', '', '', '', '']);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const boxes = useRef<(HTMLInputElement | null)[]>([]);
  const send = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const out = await sendPortalCode(token);
      setSent({ to: out.sentTo, minutes: out.minutes });
      setDigits(['', '', '', '', '', '']);
      setTimeout(() => boxes.current[0]?.focus(), 0);
    } catch (e) {
      setProblem(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const verify = async (code: string) => {
    setBusy(true);
    setProblem(null);
    try {
      const out = await verifyPortalCode(token, code, deviceName());
      if (out.verified) return onIn(out.bearer);
      setProblem(
        out.triesLeft > 0
          ? `That code isn’t right. Check the email and try again (${out.triesLeft} ${out.triesLeft === 1 ? 'try' : 'tries'} left).`
          : 'That code has had too many tries. Send a new one.',
      );
      setDigits(['', '', '', '', '', '']);
      boxes.current[0]?.focus();
    } catch (e) {
      setProblem(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const type = (i: number, raw: string) => {
    const typed = raw.replace(/\D/g, '');
    if (!typed) {
      setDigits(digits.map((d, j) => (j === i ? '' : d)));
      return;
    }
    // A pasted code fills the boxes from here on.
    const next = [...digits];
    for (let k = 0; k < typed.length && i + k < 6; k += 1) next[i + k] = typed[k]!;
    setDigits(next);
    const at = Math.min(5, i + typed.length);
    boxes.current[at]?.focus();
    if (next.every(Boolean)) void verify(next.join(''));
  };
  return (
    <div className="mx-auto max-w-[420px] px-4 py-10 text-center" data-testid="portal-sign-in">
      {sent ? (
        <>
          <h1 className="text-[22px] font-semibold">Check your email</h1>
          <p className="mt-2 text-[14px] text-text-2">
            We sent a 6-digit code to {sent.to}. It works for {sent.minutes} minutes.
          </p>
          <form
            className="mt-6"
            onSubmit={(e) => {
              e.preventDefault();
              if (digits.every(Boolean)) void verify(digits.join(''));
            }}
          >
            <div className="flex justify-center gap-2">
              {digits.map((d, i) => (
                <input
                  key={i}
                  ref={(el) => {
                    boxes.current[i] = el;
                  }}
                  value={d}
                  inputMode="numeric"
                  autoComplete={i === 0 ? 'one-time-code' : 'off'}
                  aria-label={`Digit ${i + 1}`}
                  maxLength={6}
                  onChange={(e) => type(i, e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Backspace' && !d && i > 0) boxes.current[i - 1]?.focus();
                  }}
                  className="h-14 w-12 rounded-control border border-border-strong bg-card text-center text-[22px] font-semibold focus:border-accent focus:outline-none focus:ring-[3px] focus:ring-ring"
                  data-testid={`portal-digit-${i}`}
                />
              ))}
            </div>
            {problem ? (
              <p role="alert" className="mt-3 text-[13.5px] text-danger-text">
                {problem}
              </p>
            ) : null}
            <Button
              type="submit"
              size="lg"
              className="mt-5 w-full"
              loading={busy}
              disabled={!digits.every(Boolean)}
            >
              Continue
            </Button>
          </form>
          <p className="mt-4 text-[13.5px]">
            Didn’t get it?{' '}
            <button
              type="button"
              className="text-accent-text hover:underline"
              onClick={() => void send()}
              disabled={busy}
            >
              Send a new code
            </button>
          </p>
        </>
      ) : (
        <>
          <h1 className="text-[22px] font-semibold">Hi {link.person.firstName}</h1>
          <p className="mt-2 text-[14px] text-text-2">
            This is your portal with {link.business.name}. To open it on this device, we’ll email a
            6-digit code{link.sentTo ? ` to ${link.sentTo}` : ''}.
          </p>
          {problem ? (
            <p role="alert" className="mt-3 text-[13.5px] text-danger-text">
              {problem}
            </p>
          ) : null}
          <Button
            size="lg"
            className="mt-6 w-full"
            loading={busy}
            onClick={() => void send()}
            data-testid="portal-send-code"
          >
            Email me a code
          </Button>
        </>
      )}
      <p className="mt-8 text-[12.5px] text-text-3">
        This device stays signed in for 30 days after you last use it. On a shared computer, sign
        out when you’re done.
      </p>
    </div>
  );
}
