'use client';
/**
 * An appointment's HandsFreeOS video call (docs/video-calls.md): Join for the team, opening the call in a tab of its
 * own, and who has been in it and for how long. It's read again whenever the call's people come and go.
 */
import { callLengthLabel, VIDEO_CALL_WORDS } from '@hfos/core';
import { Video } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Avatar } from '@/components/ui/avatar';
import { buttonClassName } from '@/components/ui/button';
import {
  readVideoCall,
  type VideoCallGot,
  type VideoCallPerson,
} from '@/components/video-call/team-call';
import type { AppointmentDetail } from '@/lib/api/types';
import { useLiveVersion } from '@/lib/realtime/live-provider';

const KIND: Record<VideoCallPerson['kind'], string> = {
  team: 'Team',
  customer: 'Customer',
  guest: 'Guest',
};

/** How long they were in, or how far they got. */
function stayOf(p: VideoCallPerson): string {
  if (p.connected) return 'In the call now';
  if (p.joinedAt) return callLengthLabel(p.seconds);
  switch (p.state) {
    case 'waiting':
      return p.kind === 'customer' ? 'Waiting for the team' : 'Asking to join';
    case 'admitted':
      return 'Let in, joining';
    case 'turned_away':
      return 'Turned away';
    default:
      return 'Left before joining';
  }
}

export function VideoCallBlock({
  workspaceId,
  appt,
  version,
}: {
  workspaceId: string;
  appt: AppointmentDetail;
  /** The appointment's own live version: a move or a new host changes the call too. */
  version: number;
}) {
  const calls = useLiveVersion(['video_call']);
  const [got, setGot] = useState<VideoCallGot | null>(null);
  useEffect(() => {
    let gone = false;
    readVideoCall(workspaceId, { appointmentId: appt.id })
      .then((g) => {
        if (!gone) setGot(g);
      })
      // Only who joined is missing then; Join still works from the appointment's link.
      .catch(() => undefined);
    return () => {
      gone = true;
    };
  }, [workspaceId, appt.id, version, calls]);

  // The call's own page: the link on the appointment is the same one, made by the worker.
  const href = got?.call ? `/call/${got.call.id}` : appt.location.meetingUrl;
  const been = (got?.people ?? []).filter((p) => p.kind !== 'team' || p.joinedAt);
  const upcoming = appt.status === 'scheduled';

  return (
    <div className="flex flex-col gap-2 pt-1.5" data-testid="sheet-video-call">
      {upcoming ? (
        href ? (
          <div className="flex flex-wrap items-center gap-2.5">
            <a
              href={href}
              target="_blank"
              rel="noopener"
              className={buttonClassName({ size: 'sm' })}
              data-testid="sheet-join-call"
            >
              <Video className="h-4 w-4" strokeWidth={1.75} />
              {VIDEO_CALL_WORDS.joinCall}
            </a>
            <span className="text-xs text-text-3">
              {got?.call?.state === 'live'
                ? 'The call has started.'
                : 'Customers join from their own link, and go in once you’re there.'}
            </span>
          </div>
        ) : (
          <p className="text-[13px] text-text-2" data-testid="meeting-pending">
            {appt.location.meetingError ?? 'Making the video call now.'}
          </p>
        )
      ) : null}
      {been.length ? (
        <div data-testid="sheet-call-people">
          {been.map((p) => (
            <div
              key={p.id}
              className="flex items-center gap-2.5 py-[5px]"
              data-testid="sheet-call-person"
            >
              <Avatar name={p.name} seed={p.personId ?? p.userId ?? p.id} size="sm" />
              <span className="min-w-0 flex-1 truncate text-[13px]">{p.name}</span>
              <span className="text-xs text-text-3">{KIND[p.kind]}</span>
              <span className="w-[110px] text-right text-xs text-text-2">{stayOf(p)}</span>
            </div>
          ))}
        </div>
      ) : !upcoming ? (
        <p className="text-[13px] text-text-3">Nobody joined the video call.</p>
      ) : null}
    </div>
  );
}
