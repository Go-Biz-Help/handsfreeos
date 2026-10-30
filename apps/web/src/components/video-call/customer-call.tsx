'use client';
/**
 * A customer's own Join link to a HandsFreeOS video call (`/j/<code>`, docs/video-calls.md): the page is the call. The
 * camera check with the name on their booking filled in, then Join. Once someone from the team is there they go
 * straight in (the owner's 6a); until then "Dana will be right with you", asking again every few seconds while the
 * team gets a push. Taken out by the team, they can ask to be let back in, like anyone on the call's link.
 *
 * A webinar asks for no camera or microphone: they join watching, by their first name (HANDSFREEOS_WEBINARS_
 * IMPLEMENTATION_PLAN.md).
 */
import { VIDEO_CALL_WAIT_POLL_MS, VIDEO_CALL_WORDS, WEBINAR_WORDS } from '@hfos/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '@/lib/api/errors';
import { enterCall, type JoinAnswer, type VideoTicket } from '@/lib/api/public-booking';
import { AfterCall, CallFrame, CallProblem, Waiting } from './call-frame';
import { CallRoom } from './call-room';
import { newKnockKey, useKnockWatch, type Knock } from './knock';
import { PreJoin, WebinarJoin } from './pre-join';
import type { CallEnd, DeviceChoices } from './types';

type CallAnswer = Extract<JoinAnswer, { state: 'call' }>;

type Step =
  | { readonly kind: 'pre' }
  | { readonly kind: 'waiting'; readonly host: string | null }
  | { readonly kind: 'knocking'; readonly knock: Knock }
  | { readonly kind: 'in'; readonly ticket: VideoTicket; readonly knock: Knock | null }
  | {
      readonly kind: 'after';
      readonly end: CallEnd | 'turned_away' | 'full';
      readonly knock: Knock | null;
    }
  | { readonly kind: 'problem'; readonly message: string };

const said = (e: unknown) =>
  e instanceof ApiError && e.status !== 0
    ? e.message
    : 'We couldn’t reach the call. Check your connection and try again.';

/** The worker's refusals that mean the call won't open now, whatever they press. */
const final = (e: unknown) =>
  e instanceof ApiError &&
  ['video_call_over', 'booking_cancelled', 'not_a_video_call', 'video_calls_off'].includes(
    e.rule ?? '',
  );

export function CustomerCall({ token, answer }: { token: string; answer: CallAnswer }) {
  const [step, setStep] = useState<Step>({ kind: 'pre' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const me = useRef<{ name: string; choices: DeviceChoices }>({
    name: answer.name,
    choices: { mic: true, camera: true, blur: false },
  });

  /** Join, or ask again while waiting. `ask`: taken out, they ask to be let back in. */
  const enter = useCallback(
    async (ask = false) => {
      const key = ask ? newKnockKey() : undefined;
      const a = await enterCall(token, { name: me.current.name, ...(ask ? { ask, key } : {}) });
      switch (a.status) {
        case 'in':
          if (a.ticket) setStep({ kind: 'in', ticket: a.ticket, knock: null });
          return;
        case 'waiting':
          setStep({ kind: 'waiting', host: a.host });
          return;
        case 'removed':
          setStep({ kind: 'after', end: 'removed', knock: null });
          return;
        case 'knocking':
          setStep({
            kind: 'knocking',
            knock: { callId: a.callId, personId: a.personId!, key: key! },
          });
          return;
        case 'full':
          setStep({ kind: 'after', end: 'full', knock: null });
          return;
      }
    },
    [token],
  );

  const press = async (run: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await run();
    } catch (e) {
      if (final(e)) setStep({ kind: 'problem', message: said(e) });
      else setError(said(e));
    } finally {
      setBusy(false);
    }
  };

  // Waiting for the team: ask again every few seconds, and go in as soon as someone's there.
  useEffect(() => {
    if (step.kind !== 'waiting') return;
    const t = setInterval(
      () =>
        void enter().catch((e: unknown) => {
          if (final(e)) setStep({ kind: 'problem', message: said(e) });
        }),
      VIDEO_CALL_WAIT_POLL_MS,
    );
    return () => clearInterval(t);
  }, [step.kind, enter]);

  // Asked to be let back in: how it stands, every few seconds.
  useKnockWatch(step.kind === 'knocking' ? step.knock : null, (a) => {
    if (step.kind !== 'knocking') return;
    if (a.status === 'in' && a.ticket) setStep({ kind: 'in', ticket: a.ticket, knock: step.knock });
    else if (a.status === 'turned_away' || a.status === 'removed')
      setStep({ kind: 'after', end: a.status, knock: null });
    else if (a.status === 'left') setStep({ kind: 'after', end: 'left', knock: null });
  });

  const business = { name: answer.business, look: answer.look };

  if (step.kind === 'in')
    return (
      <CallRoom
        ticket={step.ticket}
        choices={me.current.choices}
        heading={{ title: answer.business, detail: answer.title }}
        color={answer.look.color}
        onEnd={(end) => setStep({ kind: 'after', end, knock: step.knock })}
      />
    );

  return (
    <CallFrame business={business}>
      {step.kind === 'pre' && answer.webinar ? (
        <WebinarJoin
          heading={
            <div className="text-center">
              <h1 className="text-[17px] font-semibold" data-testid="call-heading">
                {answer.title}
              </h1>
              <p className="text-[13px] text-text-2">{answer.when}</p>
            </div>
          }
          name={answer.name}
          notice={answer.aiNotes ? VIDEO_CALL_WORDS.aiNotice(answer.business) : null}
          busy={busy}
          error={error}
          onJoin={(name, choices) => {
            me.current = { name, choices };
            void press(() => enter());
          }}
        />
      ) : step.kind === 'pre' ? (
        <PreJoin
          heading={
            <div className="text-center">
              <h1 className="text-[17px] font-semibold" data-testid="call-heading">
                {answer.title}
              </h1>
              <p className="text-[13px] text-text-2">{answer.when}</p>
            </div>
          }
          name={answer.name}
          joinLabel={VIDEO_CALL_WORDS.join}
          notice={answer.aiNotes ? VIDEO_CALL_WORDS.aiNotice(answer.business) : null}
          busy={busy}
          error={error}
          onJoin={(name, choices) => {
            me.current = { name, choices };
            void press(() => enter());
          }}
        />
      ) : step.kind === 'waiting' ? (
        <Waiting
          title={answer.webinar ? WEBINAR_WORDS.name : VIDEO_CALL_WORDS.waitingFor(step.host)}
        >
          {answer.webinar ? WEBINAR_WORDS.waitingFor : VIDEO_CALL_WORDS.waitingHint}
        </Waiting>
      ) : step.kind === 'knocking' ? (
        <Waiting title="Asking to come back in">{VIDEO_CALL_WORDS.knocking}</Waiting>
      ) : step.kind === 'problem' ? (
        <CallProblem message={step.message} />
      ) : (
        <>
          <AfterCall
            end={step.end}
            webinar={answer.webinar === true}
            busy={busy}
            onAgain={
              step.end === 'ended' || step.end === 'turned_away'
                ? undefined
                : () =>
                    void press(async () => {
                      // Back in on the request they were let in on; otherwise through their own link.
                      if (step.knock && step.end !== 'removed')
                        return setStep({ kind: 'knocking', knock: step.knock });
                      await enter(step.end === 'removed');
                    })
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
