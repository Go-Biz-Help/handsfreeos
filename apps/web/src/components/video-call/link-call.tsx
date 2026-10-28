'use client';
/**
 * A HandsFreeOS video call's own link (`/call/<id>`, docs/video-calls.md): the team's way in from the appointment,
 * and the link anyone else may have been given.
 *
 * - **Someone from the team**, signed in, goes straight in. Signed in but not on this business (or not allowed to see
 *   the appointment), they ask to be let in like anyone else.
 * - **Anyone else** types their name and asks to join; the page waits until the team lets them in or turns them away.
 *   What they see is the business, never the appointment: the link may have been passed on.
 */
import { VIDEO_CALL_WORDS } from '@hfos/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '@/lib/api/errors';
import {
  getPublicCall,
  knockCall,
  type PublicCall,
  type VideoTicket,
} from '@/lib/api/public-booking';
import { joinVideoCall } from '@/lib/api/worker';
import { CallCoachPanel, type CallBusiness } from './call-coach';
import { AfterCall, CallFrame, CallProblem, Waiting } from './call-frame';
import { CallRoom } from './call-room';
import { keepKnock, keptKnock, newKnockKey, useKnockWatch, type Knock } from './knock';
import { PreJoin } from './pre-join';
import type { CallEnd, DeviceChoices, TeamSide } from './types';

type Step =
  | { readonly kind: 'loading' }
  | { readonly kind: 'pre' }
  | { readonly kind: 'knocking'; readonly knock: Knock }
  | { readonly kind: 'in'; readonly ticket: VideoTicket; readonly team: TeamSide | null }
  | { readonly kind: 'after'; readonly end: CallEnd | 'turned_away'; readonly team: boolean }
  | { readonly kind: 'problem'; readonly message: string };

const said = (e: unknown) =>
  e instanceof ApiError && e.status !== 0
    ? e.message
    : 'We couldn’t reach the call. Check your connection and try again.';

export function LinkCall({
  callId,
  teammate,
}: {
  callId: string;
  /** Signed in: their name, from their account, and their businesses, for the coach beside the video. */
  teammate: { readonly name: string; readonly businesses?: readonly CallBusiness[] } | null;
}) {
  const [call, setCall] = useState<PublicCall | null>(null);
  const [step, setStep] = useState<Step>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Signed in, and the team's join said this call isn't theirs: from then on they ask like anyone else.
  const [asGuest, setAsGuest] = useState(!teammate);
  const me = useRef<{ name: string; choices: DeviceChoices }>({
    name: teammate?.name ?? '',
    choices: { mic: true, camera: true, blur: false },
  });

  useEffect(() => {
    let gone = false;
    getPublicCall(callId)
      .then((c) => {
        if (gone) return;
        setCall(c);
        setStep(
          c.ready
            ? { kind: 'pre' }
            : {
                kind: 'problem',
                message: `Video calls aren’t on for ${c.business} right now. Ask them for another way to meet.`,
              },
        );
      })
      .catch((e: unknown) => {
        if (!gone) setStep({ kind: 'problem', message: said(e) });
      });
    return () => {
      gone = true;
    };
  }, [callId]);

  /** Asks to be let in, or carries on with the request this tab already made. */
  const knock = useCallback(async () => {
    const kept = keptKnock(callId);
    if (kept) {
      setStep({ kind: 'knocking', knock: kept });
      return;
    }
    const key = newKnockKey();
    const k = await knockCall(callId, { name: me.current.name, key });
    const made = { callId, personId: k.personId, key };
    keepKnock(made, callId);
    setStep({ kind: 'knocking', knock: made });
  }, [callId]);

  const join = useCallback(async () => {
    if (asGuest) return knock();
    try {
      const j = await joinVideoCall(callId);
      setStep({
        kind: 'in',
        ticket: j.ticket,
        team: { workspaceId: j.workspaceId, callId, personId: j.personId },
      });
    } catch (e) {
      // Not a call they can see as the team: they ask to be let in instead.
      if (e instanceof ApiError && (e.status === 404 || e.status === 403)) {
        setAsGuest(true);
        return knock();
      }
      throw e;
    }
  }, [asGuest, callId, knock]);

  const press = async (run: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await run();
    } catch (e) {
      setError(said(e));
    } finally {
      setBusy(false);
    }
  };

  useKnockWatch(step.kind === 'knocking' ? step.knock : null, (a) => {
    if (step.kind !== 'knocking') return;
    if (a.status === 'in' && a.ticket) setStep({ kind: 'in', ticket: a.ticket, team: null });
    else if (a.status === 'turned_away' || a.status === 'removed' || a.status === 'left') {
      // That request is spent: asking again makes a new one.
      keepKnock(null, callId);
      setStep({ kind: 'after', end: a.status, team: false });
    }
  });

  if (step.kind === 'in') {
    const business = step.team
      ? teammate?.businesses?.find((b) => b.id === step.team!.workspaceId)
      : undefined;
    return (
      <CallRoom
        ticket={step.ticket}
        choices={me.current.choices}
        heading={{ title: call?.business ?? VIDEO_CALL_WORDS.name }}
        color={step.team ? null : (call?.look.color ?? null)}
        team={step.team}
        coach={business ? <CallCoachPanel business={business} /> : null}
        onEnd={(end) => {
          if (!step.team && end === 'removed') keepKnock(null, callId);
          setStep({ kind: 'after', end, team: !!step.team });
        }}
      />
    );
  }

  const business = call ? { name: call.business, look: call.look } : null;
  return (
    <CallFrame business={business}>
      {step.kind === 'loading' ? (
        <div className="flex flex-1 items-center justify-center text-[13px] text-text-3">
          {VIDEO_CALL_WORDS.opening}
        </div>
      ) : step.kind === 'problem' ? (
        <CallProblem message={step.message} />
      ) : step.kind === 'pre' ? (
        <PreJoin
          heading={
            <div className="text-center">
              <h1 className="text-[17px] font-semibold" data-testid="call-heading">
                {asGuest ? `Join ${call?.business ?? 'the'} video call` : VIDEO_CALL_WORDS.joinCall}
              </h1>
              {asGuest ? (
                <p className="text-[13px] text-text-2">Someone in the call lets you in.</p>
              ) : null}
            </div>
          }
          name={me.current.name}
          nameFixed={!asGuest}
          joinLabel={asGuest ? 'Ask to join' : VIDEO_CALL_WORDS.join}
          notice={call?.aiNotes ? VIDEO_CALL_WORDS.aiNotice(call.business) : null}
          busy={busy}
          error={error}
          onJoin={(name, choices) => {
            me.current = { name, choices };
            void press(join);
          }}
        />
      ) : step.kind === 'knocking' ? (
        <Waiting title="Asking to join">{VIDEO_CALL_WORDS.knocking}</Waiting>
      ) : (
        <>
          <AfterCall
            end={step.end}
            team={step.team}
            busy={busy}
            onAgain={
              step.end === 'turned_away' || (step.end === 'ended' && !step.team)
                ? undefined
                : () => void press(step.team ? join : knock)
            }
          />
          {error ? (
            <p className="pb-6 text-center text-[13px] text-danger-text" role="alert">
              {error}
            </p>
          ) : null}
        </>
      )}
    </CallFrame>
  );
}
