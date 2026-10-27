'use client';
/**
 * A person's Join link for an online session (funnels): `/j/<token>`, on the business's own domain when one is
 * serving. The page asks the worker from the browser, which records that they joined and answers with the
 * meeting's address, then sends them on. Link previews and mail scanners don't run this, so they never count.
 * Outside the session's hour-before-to-end, it says when the session is instead. For a HandsFreeOS video call the
 * page is the call itself (video-call/customer-call.tsx), and joining counts once they're really in it.
 */
import { CalendarClock, CalendarOff, LinkIcon, Video } from 'lucide-react';
import { useEffect, useState } from 'react';
import { CustomerCall } from '@/components/video-call/customer-call';
import { ApiError } from '@/lib/api/errors';
import { joinSession, type JoinAnswer } from '@/lib/api/public-booking';
import { PublicFrame, PublicState } from './public-shell';

type Shown =
  | { readonly kind: 'joining' }
  | { readonly kind: 'answer'; readonly a: JoinAnswer }
  | {
      readonly kind: 'error';
      readonly message: string;
    };

export function JoinSession({ token }: { token: string }) {
  const [shown, setShown] = useState<Shown>({ kind: 'joining' });

  useEffect(() => {
    let gone = false;
    joinSession(token)
      .then((a) => {
        if (gone) return;
        setShown({ kind: 'answer', a });
        if (a.state === 'open') window.location.replace(a.url);
      })
      .catch((e: unknown) => {
        if (gone) return;
        setShown({
          kind: 'error',
          message:
            e instanceof ApiError
              ? e.message
              : 'We couldn’t open your session. Check your connection and try again.',
        });
      });
    return () => {
      gone = true;
    };
  }, [token]);

  // A HandsFreeOS video call: this page is the call (docs/video-calls.md).
  if (shown.kind === 'answer' && shown.a.state === 'call')
    return <CustomerCall token={token} answer={shown.a} />;
  return (
    <PublicFrame business={null} byline="Sessions by HandsFreeOS">
      <JoinState shown={shown} />
    </PublicFrame>
  );
}

function JoinState({ shown }: { shown: Shown }) {
  if (shown.kind === 'joining')
    return (
      <PublicState icon={<Video size={20} />} title="Joining your session…" testId="join-joining">
        <noscript>
          Turn on JavaScript in your browser to join, or ask for the meeting link.
        </noscript>
      </PublicState>
    );
  if (shown.kind === 'error')
    return (
      <PublicState
        tone="warning"
        icon={<LinkIcon size={20} />}
        title="This link didn’t work"
        testId="join-error"
      >
        {shown.message}
      </PublicState>
    );
  const a = shown.a;
  switch (a.state) {
    case 'open':
      return (
        <PublicState
          tone="accent"
          icon={<Video size={20} />}
          title={`Joining ${a.title}…`}
          testId="join-open"
          action={
            <a href={a.url} className="text-[13px] font-medium text-accent-text underline">
              Not taken there? Open the meeting
            </a>
          }
        />
      );
    case 'early':
      return (
        <PublicState icon={<CalendarClock size={20} />} title={a.title} testId="join-early">
          {`It starts ${a.when}. This link opens it from an hour before.`}
        </PublicState>
      );
    case 'over':
      return (
        <PublicState icon={<CalendarOff size={20} />} title={a.title} testId="join-over">
          {`This session was ${a.when}, and it has ended. Get in touch with ${a.business} to book another.`}
        </PublicState>
      );
    case 'cancelled':
      return (
        <PublicState icon={<CalendarOff size={20} />} title={a.title} testId="join-cancelled">
          {`This booking was cancelled. Get in touch with ${a.business} to book another time.`}
        </PublicState>
      );
    case 'call':
      return null;
    default:
      return (
        <PublicState icon={<LinkIcon size={20} />} title={a.title} testId="join-no-link">
          {`This session doesn’t have an online meeting yet. Get in touch with ${a.business} for the link.`}
        </PublicState>
      );
  }
}
