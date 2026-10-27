'use client';
/**
 * The pages around a HandsFreeOS video call (docs/video-calls.md): the business's name, logo and colour on top, a
 * small "Powered by HandsFreeOS" at the bottom (the owner's 3a), and what to say before and after the call itself.
 */
import { VIDEO_CALL_WORDS } from '@hfos/core';
import { CalendarOff, Hand, LinkIcon, LogOut, UserX, Video, WifiOff } from 'lucide-react';
import type { ReactNode } from 'react';
import { PublicFrame, PublicState } from '@/components/booking/public-shell';
import { Button } from '@/components/ui/button';
import type { PublicBusiness } from '@/lib/api/public-booking';
import type { CallEnd } from './types';

export function CallFrame({
  business,
  children,
}: {
  business: { readonly name: string; readonly look: PublicBusiness['look'] } | null;
  children: ReactNode;
}) {
  return (
    <PublicFrame
      business={
        business
          ? { name: business.name, phone: null, phoneDisplay: null, look: business.look }
          : null
      }
      byline={VIDEO_CALL_WORDS.poweredBy}
    >
      {children}
    </PublicFrame>
  );
}

/** Waiting for the team, or for someone to let them in. */
export function Waiting({ title, children }: { title: string; children: ReactNode }) {
  return (
    <PublicState tone="accent" icon={<Video size={20} />} title={title} testId="call-waiting">
      <span className="flex flex-col items-center gap-3">
        {children}
        <span aria-hidden className="flex gap-1">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent"
              style={{ animationDelay: `${i * 200}ms` }}
            />
          ))}
        </span>
      </span>
    </PublicState>
  );
}

/** Why they're not in the call, and the one thing they can do about it. */
export function AfterCall({
  end,
  team,
  onAgain,
  busy,
}: {
  end: CallEnd | 'turned_away' | 'full';
  /** The team's own words where theirs differ: they can start an ended call again. */
  team?: boolean;
  onAgain?: () => void;
  busy?: boolean;
}) {
  const again = (label: string) =>
    onAgain ? (
      <Button onClick={onAgain} loading={busy} data-testid="call-again">
        {label}
      </Button>
    ) : undefined;
  switch (end) {
    case 'left':
      return (
        <PublicState
          icon={<LogOut size={20} />}
          title={VIDEO_CALL_WORDS.left}
          testId="call-left"
          action={again('Rejoin')}
        />
      );
    case 'removed':
      return (
        <PublicState
          tone="warning"
          icon={<UserX size={20} />}
          title={VIDEO_CALL_WORDS.removed}
          testId="call-removed"
          action={again('Ask to come back in')}
        >
          Someone from the team took you out. You can ask to be let back in.
        </PublicState>
      );
    case 'ended':
      return (
        <PublicState
          icon={<CalendarOff size={20} />}
          title={VIDEO_CALL_WORDS.ended}
          testId="call-ended"
          action={team ? again('Start it again') : undefined}
        >
          {team
            ? 'Everyone has left. Starting it again lets customers back in on their own link.'
            : 'Thanks for joining.'}
        </PublicState>
      );
    case 'elsewhere':
      return (
        <PublicState
          icon={<Video size={20} />}
          title="You’re in this call somewhere else"
          testId="call-elsewhere"
          action={again('Join here instead')}
        >
          You joined from another tab or device, so this one stepped out.
        </PublicState>
      );
    case 'lost':
      return (
        <PublicState
          tone="warning"
          icon={<WifiOff size={20} />}
          title="Your connection to the call dropped"
          testId="call-lost"
          action={again('Join again')}
        >
          Check your internet connection, then join again.
        </PublicState>
      );
    case 'turned_away':
      return (
        <PublicState
          tone="warning"
          icon={<Hand size={20} />}
          title="You weren’t let in"
          testId="call-turned-away"
        >
          {VIDEO_CALL_WORDS.turnedAway}
        </PublicState>
      );
    case 'full':
      return (
        <PublicState
          tone="warning"
          icon={<Video size={20} />}
          title="This call is full"
          testId="call-full"
          action={again('Try again')}
        >
          {VIDEO_CALL_WORDS.full}
        </PublicState>
      );
  }
}

/** The link doesn't open a call, or calls aren't ready: what the worker said, as it said it. */
export function CallProblem({ message }: { message: string }) {
  return (
    <PublicState
      tone="warning"
      icon={<LinkIcon size={20} />}
      title="This call didn’t open"
      testId="call-problem"
    >
      {message}
    </PublicState>
  );
}
