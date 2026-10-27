'use client';
/**
 * Asking to be let into a HandsFreeOS video call (docs/video-calls.md): the page makes a random key and keeps it to
 * itself, and the worker keeps only its hash, so only this page can ask how the request stands, or come in on it. It's
 * kept for the tab (sessionStorage), so a reload carries on waiting instead of asking again, and the team isn't told
 * twice.
 */
import { VIDEO_CALL_WAIT_POLL_MS } from '@hfos/core';
import { useEffect, useRef } from 'react';
import { knockStatus, type KnockAnswer } from '@/lib/api/public-booking';

/** 32 random bytes, base64url: what the worker's key check asks for. */
export function newKnockKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export interface Knock {
  readonly callId: string;
  readonly personId: string;
  readonly key: string;
}

const slot = (callId: string) => `hfos.call.knock.${callId}`;

export function keptKnock(callId: string): Knock | null {
  try {
    const k = JSON.parse(sessionStorage.getItem(slot(callId)) ?? 'null') as Knock | null;
    return k && k.callId === callId && typeof k.personId === 'string' && typeof k.key === 'string'
      ? k
      : null;
  } catch {
    return null;
  }
}

export function keepKnock(k: Knock | null, callId: string): void {
  try {
    if (k) sessionStorage.setItem(slot(callId), JSON.stringify(k));
    else sessionStorage.removeItem(slot(callId));
  } catch {
    // Not kept: a reload asks again.
  }
}

/** Asks how a request stands at once and then every few seconds while `knock` is set, and hands each answer on. */
export function useKnockWatch(knock: Knock | null, onAnswer: (a: KnockAnswer) => void): void {
  const answered = useRef(onAnswer);
  answered.current = onAnswer;
  useEffect(() => {
    if (!knock) return;
    let gone = false;
    const ask = () =>
      void knockStatus(knock.callId, knock.personId, knock.key)
        .then((a) => {
          if (!gone) answered.current(a);
        })
        // A missed answer is caught up by the next one.
        .catch(() => undefined);
    ask();
    const t = setInterval(ask, VIDEO_CALL_WAIT_POLL_MS);
    return () => {
      gone = true;
      clearInterval(t);
    };
  }, [knock]);
}
