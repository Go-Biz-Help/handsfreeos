/**
 * What this phone downloads in a call, reported to the worker so the call is priced by what it really used
 * (docs/video-calls.md, "What a call used"). Core's `watchCallData` reads the counters and decides when to send, as
 * on the web; this is the phone's way of sending.
 */
import { watchCallData, type CallDataReport, type MeasuredRoom } from '@hfos/core';
import * as React from 'react';
import { AppState } from 'react-native';
import { config } from '@/lib/config';
import { appFetch } from '@/lib/network';

/** Sends one report, with the ticket the phone joined on (the worker reads who it's from off it). Nothing is read back. */
export function sendCallData(ticket: string, r: CallDataReport): void {
  if (!config.workerUrl) return;
  void appFetch(`${config.workerUrl}/public/calls/data`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ticket, sid: r.sid, bytes: r.bytes }),
  }).catch(() => undefined);
}

/** Measures and reports while the call is up, and once more as it goes (leaving, or the app going to the background). */
export function useCallData(room: MeasuredRoom, ticket: string): void {
  React.useEffect(() => {
    const watch = watchCallData(room, (r) => sendCallData(ticket, r));
    const away = AppState.addEventListener('change', (state) => {
      if (state !== 'active') watch.flush();
    });
    return () => {
      away.remove();
      watch.stop();
    };
  }, [room, ticket]);
}
