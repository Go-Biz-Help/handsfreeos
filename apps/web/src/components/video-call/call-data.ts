'use client';

/**
 * What this call screen downloads, reported to the worker so the call is priced by what it really used
 * (docs/video-calls.md, "What a call used"). Core's `watchCallData` reads the counters and decides when to send; this
 * is the web's way of sending, which has to work as the page closes too.
 */
import { watchCallData, type CallDataReport, type MeasuredRoom } from '@hfos/core';
import { useEffect } from 'react';
import { publicEnv } from '@/lib/env';

/**
 * Sends one report, with the ticket the screen joined on (the worker reads who it's from off it). Plain text, so it
 * goes without a preflight from any address the page is on, and as a beacon so it still goes as the page closes.
 * Nothing is read back.
 */
export function sendCallData(ticket: string, r: CallDataReport): void {
  const url = `${publicEnv.workerUrl}/public/calls/data`;
  const body = JSON.stringify({ ticket, sid: r.sid, bytes: r.bytes });
  try {
    if (typeof navigator !== 'undefined' && navigator.sendBeacon?.(url, body)) return;
  } catch {
    // Some browsers refuse a beacon (too much queued already): a plain request instead.
  }
  void fetch(url, {
    method: 'POST',
    body,
    keepalive: true,
    mode: 'no-cors',
    headers: { 'content-type': 'text/plain' },
  }).catch(() => undefined);
}

/** Measures and reports while the call screen is up, and once more as it goes (leaving, or the tab closing). */
export function useCallData(room: MeasuredRoom, ticket: string): void {
  useEffect(() => {
    const watch = watchCallData(room, (r) => sendCallData(ticket, r));
    const closing = () => watch.flush();
    window.addEventListener('pagehide', closing);
    return () => {
      window.removeEventListener('pagehide', closing);
      watch.stop();
    };
  }, [room, ticket]);
}
