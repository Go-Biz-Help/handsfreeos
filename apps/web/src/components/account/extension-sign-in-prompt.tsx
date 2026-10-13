'use client';
import {
  EXTENSION_SIGN_IN_WATCH_MS,
  EXTENSION_SIGN_IN_WORDS,
  type ExtensionSignInPending,
} from '@hfos/core';
import { KeyRound } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';

/**
 * Someone is signing in to the browser extension with this person's email (20261027002910): "Signing in to the
 * extension on Chrome? Pick the number you see." with three numbers, one of them the extension's. The right one lets
 * it in; a wrong one, or That wasn't me, stops it. Mounted once in the workspace layout; while the tab is in front it
 * asks every few seconds whether a request is waiting (`extension_sign_in.pending`), and a hidden tab asks nothing.
 */
export function ExtensionSignInPrompt() {
  const [request, setRequest] = useState<ExtensionSignInPending | null>(null);
  const [busy, setBusy] = useState(false);
  const answered = useRef(new Set<string>());

  const look = useCallback(async () => {
    if (document.visibilityState !== 'visible') return;
    try {
      const found = unwrap(
        await apiBrowser().POST('/v1/queries/extension_sign_in.pending', { body: {} }),
      );
      const next = found.requests.find((r) => !answered.current.has(r.id)) ?? null;
      setRequest((now) => (now?.id === next?.id ? now : next));
    } catch {
      // Signed out or offline for a moment: the next look tries again.
    }
  }, []);

  useEffect(() => {
    void look();
    const timer = setInterval(() => void look(), EXTENSION_SIGN_IN_WATCH_MS);
    const shown = () => void look();
    document.addEventListener('visibilitychange', shown);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', shown);
    };
  }, [look]);

  // A request runs out on its own: the prompt goes with it.
  useEffect(() => {
    if (!request) return;
    const left = Date.parse(request.expiresAt) - Date.now();
    const timer = setTimeout(() => setRequest(null), Math.max(0, left));
    return () => clearTimeout(timer);
  }, [request]);

  if (!request) return null;

  const answer = async (pick: number | null) => {
    setBusy(true);
    answered.current.add(request.id);
    try {
      const out = unwrap(
        await apiBrowser().POST('/v1/commands/extension_sign_in.answer', {
          body: { requestId: request.id, pick },
        }),
      );
      if (out.outcome === 'approved') toast.success(EXTENSION_SIGN_IN_WORDS.approved);
      else toast(pick === null ? EXTENSION_SIGN_IN_WORDS.denied : EXTENSION_SIGN_IN_WORDS.refused);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
      setRequest(null);
    }
  };

  return createPortal(
    <div
      role="alertdialog"
      aria-labelledby="extension-sign-in-question"
      aria-describedby="extension-sign-in-pick"
      data-testid="extension-sign-in-prompt"
      style={{ pointerEvents: 'auto' }}
      className="fixed inset-x-4 top-4 z-[70] flex flex-col gap-3.5 rounded-dialog border border-border bg-card p-4 shadow-3 md:inset-x-auto md:right-[18px] md:top-[18px] md:w-[360px]"
    >
      <div className="flex items-center gap-3">
        <span className="flex h-11 w-11 flex-none items-center justify-center rounded-full bg-accent-soft text-accent-text">
          <KeyRound className="h-[18px] w-[18px]" strokeWidth={1.5} />
        </span>
        <div className="min-w-0 flex-1">
          <h3 id="extension-sign-in-question" className="text-[15px] font-semibold">
            {EXTENSION_SIGN_IN_WORDS.question(request.browser)}
          </h3>
          <p id="extension-sign-in-pick" className="text-[13px] text-text-2">
            {EXTENSION_SIGN_IN_WORDS.pick}
          </p>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-2">
        {request.choices.map((n) => (
          <Button
            key={n}
            variant="secondary"
            size="lg"
            className="text-xl font-semibold tabular-nums"
            disabled={busy}
            onClick={() => void answer(n)}
            data-testid={`extension-sign-in-pick-${n}`}
          >
            {n}
          </Button>
        ))}
      </div>
      <Button variant="ghost" disabled={busy} onClick={() => void answer(null)}>
        {EXTENSION_SIGN_IN_WORDS.notMe}
      </Button>
    </div>,
    document.body,
  );
}
