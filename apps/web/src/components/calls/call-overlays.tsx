'use client';
import { ActiveCallBar } from './active-call-bar';
import { DialerDialog } from './dialer-dialog';
import { IncomingCallCard } from './incoming-call-card';

/** The ringing card, the call bar and the dialer, mounted once in the workspace layout. */
export function CallOverlays() {
  return (
    <>
      <IncomingCallCard />
      <ActiveCallBar />
      <DialerDialog />
    </>
  );
}
