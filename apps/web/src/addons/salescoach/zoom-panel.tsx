'use client';
/**
 * The coach inside a Zoom meeting (round three, `?view=zoom`): what HandsFreeOS's app in Zoom's Apps panel opens.
 *
 * In a meeting it reads the meeting and the person through Zoom's app SDK, claims the meeting for them
 * (`live_meeting.claim`, which finds the customer from the appointment the meeting was made for), and asks Zoom to
 * start the meeting's stream (`startRTMS`). The worker then hears it and the cards come as on a phone call
 * (./live-coach.tsx). Without a known customer it asks who the call is with first. **Stop coaching** asks Zoom to
 * stop the stream. Outside Zoom it says where to open it, and that the same cards show on the Live call tab.
 */
import { SALESCOACH_WORDS as W } from '@hfos/core/addons/salescoach/words';
import type zoomSdkType from '@zoom/appssdk';
import type { Apis } from '@zoom/appssdk';
import { Video } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { PersonPicker } from '@/components/money/person-picker';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import { LiveCoach } from './live-coach';

type Sdk = typeof zoomSdkType;

interface Meeting {
  readonly meetingUuid: string;
  readonly meetingNumber: string | null;
  readonly screenName: string | null;
}

type Person = { readonly id: string; readonly name: string } | null;

type Phase =
  | { k: 'loading' }
  | { k: 'outside' }
  | { k: 'elsewhere' }
  | { k: 'pick' }
  | { k: 'ready' }
  | { k: 'starting' }
  | { k: 'on' }
  | { k: 'stopping' }
  | { k: 'off' }
  | { k: 'failed'; message: string };

/** What the app asks Zoom for (also ticked on the Zoom app's Surface → Zoom App SDK list). */
const CAPABILITIES: Apis[] = [
  'getRunningContext',
  'getMeetingContext',
  'getMeetingUUID',
  'getUserContext',
  'startRTMS',
  'stopRTMS',
  'getRTMSStatus',
];

/** Zoom's own browser says so: anywhere else, nothing here can reach a meeting. */
const inZoom = () => typeof navigator !== 'undefined' && /zoom/i.test(navigator.userAgent);

export function ZoomPanel({ workspaceId }: { workspaceId: string }) {
  const sdk = useRef<Sdk | null>(null);
  const meeting = useRef<Meeting | null>(null);
  const [phase, setPhase] = useState<Phase>({ k: 'loading' });
  const [person, setPerson] = useState<Person>(null);

  const claim = useCallback(
    async (personId?: string | null) => {
      const m = meeting.current!;
      return unwrap(
        await apiBrowser().POST('/v1/commands/live_meeting.claim', {
          body: {
            workspaceId,
            provider: 'zoom',
            meetingUuid: m.meetingUuid,
            meetingNumber: m.meetingNumber,
            screenName: m.screenName,
            ...(personId !== undefined ? { personId } : {}),
          },
        }),
      );
    },
    [workspaceId],
  );

  const start = useCallback(async () => {
    setPhase({ k: 'starting' });
    try {
      await sdk.current!.startRTMS();
      setPhase({ k: 'on' });
    } catch {
      setPhase({ k: 'failed', message: W.zoom.startFailed });
    }
  }, []);

  useEffect(() => {
    let current = true;
    void (async () => {
      if (!inZoom()) return current && setPhase({ k: 'outside' });
      try {
        const zoomSdk = (await import('@zoom/appssdk')).default;
        await zoomSdk.config({ capabilities: CAPABILITIES, timeout: 8000 });
        sdk.current = zoomSdk;
        const { context } = await zoomSdk.getRunningContext();
        if (context !== 'inMeeting') return current && setPhase({ k: 'elsewhere' });
        const [uuid, ctx, user] = await Promise.all([
          zoomSdk.getMeetingUUID(),
          zoomSdk.getMeetingContext(),
          zoomSdk.getUserContext(),
        ]);
        const digits = String(ctx.meetingID ?? '').replace(/\D/g, '');
        meeting.current = {
          meetingUuid: uuid.meetingUUID,
          meetingNumber: digits.length >= 6 && digits.length <= 20 ? digits : null,
          screenName: user.screenName?.trim() || null,
        };
      } catch {
        return current && setPhase({ k: 'failed', message: W.zoom.zoomOld });
      }
      try {
        const got = await claim();
        if (!current) return;
        setPerson(got.person);
        if (got.state === 'live') setPhase({ k: 'on' });
        // The appointment says who it's with: coach at once, as on a phone call.
        else if (got.person) await start();
        else setPhase({ k: 'pick' });
      } catch (e) {
        if (current) setPhase({ k: 'failed', message: errorMessage(e) });
      }
    })();
    return () => {
      current = false;
    };
  }, [claim, start]);

  const pick = async (p: Person) => {
    try {
      const got = await claim(p?.id ?? null);
      setPerson(got.person);
      setPhase({ k: 'ready' });
    } catch (e) {
      setPhase({ k: 'failed', message: errorMessage(e) });
    }
  };

  const stop = async () => {
    setPhase({ k: 'stopping' });
    try {
      await sdk.current?.stopRTMS();
    } catch {
      // Already stopped in Zoom: nothing to undo.
    }
    setPhase({ k: 'off' });
  };

  if (phase.k === 'outside' || phase.k === 'elsewhere')
    return (
      <Card className="space-y-2 p-6 text-center" data-testid="zoom-outside">
        <Video className="mx-auto h-6 w-6 text-text-3" strokeWidth={1.5} aria-hidden />
        <p className="text-[14px]">
          {phase.k === 'outside' ? W.zoom.outside : W.zoom.notInMeeting}
        </p>
        {phase.k === 'outside' ? (
          <p className="text-[13px] text-text-3">{W.zoom.outsideHow}</p>
        ) : null}
      </Card>
    );

  return (
    <div className="space-y-3" data-testid="zoom-panel">
      <div className="flex items-center gap-2">
        <Video className="h-4 w-4 text-accent-text" strokeWidth={1.75} aria-hidden />
        <h1 className="text-[15px] font-semibold">{W.zoom.title}</h1>
      </div>
      {phase.k === 'loading' ? (
        <p className="text-[13px] text-text-2">{W.zoom.connecting}</p>
      ) : null}
      {phase.k === 'failed' ? (
        <Card className="space-y-2 p-4" role="alert">
          <p className="text-[13.5px]">{phase.message}</p>
          {meeting.current ? (
            <Button size="sm" onClick={() => void start()}>
              {W.zoom.start}
            </Button>
          ) : null}
        </Card>
      ) : null}
      {phase.k === 'pick' ? (
        <Card className="space-y-2.5 p-4">
          <p className="text-[14px] font-medium">{W.zoom.whoWith}</p>
          <p className="text-[12.5px] text-text-2">{W.zoom.whoWithHelp}</p>
          <PersonPicker
            workspaceId={workspaceId}
            id="zoom-customer"
            autoFocus
            onPick={(p) => void pick({ id: p.id, name: p.fullName })}
          />
          <Button variant="ghost" size="sm" onClick={() => void pick(null)}>
            {W.zoom.noCustomer}
          </Button>
        </Card>
      ) : null}
      {phase.k === 'ready' || phase.k === 'starting' || phase.k === 'off' ? (
        <Card className="space-y-2.5 p-4">
          {phase.k === 'off' ? <p className="text-[13.5px]">{W.zoom.off}</p> : null}
          <div className="flex items-center gap-2 text-[13px] text-text-2">
            <span className="truncate">
              {person ? W.zoom.withWhom(person.name) : W.zoom.noCustomer}
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto"
              onClick={() => setPhase({ k: 'pick' })}
            >
              {W.zoom.change}
            </Button>
          </div>
          <Button
            disabled={phase.k === 'starting'}
            onClick={() => void start()}
            data-testid="zoom-start"
          >
            {phase.k === 'starting' ? W.zoom.starting : W.zoom.start}
          </Button>
          <p className="text-[12px] text-text-3">{W.zoom.notice}</p>
        </Card>
      ) : null}
      {phase.k === 'on' || phase.k === 'stopping' ? (
        <>
          <LiveCoach workspaceId={workspaceId} idle={W.zoom.waiting} ownStop={false} />
          <Button
            variant="ghost"
            size="sm"
            disabled={phase.k === 'stopping'}
            onClick={() => void stop()}
            data-testid="zoom-stop"
          >
            {phase.k === 'stopping' ? W.zoom.stopping : W.zoom.stop}
          </Button>
          <p className="text-[12px] text-text-3">{W.zoom.notice}</p>
        </>
      ) : null}
    </div>
  );
}
