'use client';
/**
 * Cloudflare Turnstile's "are you a person" check, loaded only on pages that need it. It hands its one-time
 * token up, and null when the token expires or the check fails. Change `resetKey` for a fresh token (each
 * token works once, so after every submit).
 */
import { useEffect, useRef } from 'react';

interface TurnstileApi {
  render(el: HTMLElement, options: Record<string, unknown>): string;
  remove(id: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
let loading: Promise<void> | null = null;

function loadTurnstile(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  loading ??= new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SCRIPT;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      loading = null;
      reject(new Error('Turnstile did not load'));
    };
    document.head.appendChild(script);
  });
  return loading;
}

export function Turnstile({
  siteKey,
  onToken,
  resetKey = 0,
  invisible = false,
}: {
  siteKey: string;
  onToken: (token: string | null) => void;
  resetKey?: number;
  /** Shows nothing unless Cloudflare needs the person to do something (the website chat). */
  invisible?: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  const handler = useRef(onToken);
  useEffect(() => {
    handler.current = onToken;
  });
  useEffect(() => {
    let id: string | null = null;
    let gone = false;
    loadTurnstile()
      .then(() => {
        if (gone || !box.current || !window.turnstile) return;
        id = window.turnstile.render(box.current, {
          sitekey: siteKey,
          theme: 'auto',
          size: 'flexible',
          ...(invisible ? { appearance: 'interaction-only' } : {}),
          callback: (token: string) => handler.current(token),
          'expired-callback': () => handler.current(null),
          'error-callback': () => handler.current(null),
        });
      })
      .catch(() => handler.current(null));
    return () => {
      gone = true;
      if (id && window.turnstile) window.turnstile.remove(id);
    };
  }, [siteKey, resetKey, invisible]);
  return (
    <div ref={box} className={invisible ? undefined : 'min-h-[65px]'} data-testid="turnstile" />
  );
}
