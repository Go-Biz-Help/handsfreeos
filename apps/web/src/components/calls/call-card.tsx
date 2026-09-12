'use client';
import { Phone, PhoneMissed, PhoneOutgoing, Voicemail } from 'lucide-react';
import { ChannelIcon } from '@/components/inbox/bits';
import type { ThreadItem } from '@/lib/api/types';
import { clock } from '@/lib/calls/format';
import { cn } from '@/lib/utils';
import { VoicemailPlayer } from './voicemail-player';

const LIVE = new Set(['initiated', 'ringing', 'in_progress']);

function answeredLine(item: ThreadItem): string | null {
  if (item.answeredVia === 'forwarding') return 'answered on a forwarding phone';
  if (item.answeredBy) return `${item.answeredBy.fullName} answered`;
  return null;
}

/**
 * A call in the conversation: a voicemail with its player and words, or a plain call with its length.
 * `compact` is the record page's message sheet (full width, a larger play button).
 */
export function CallCard({
  item,
  time,
  compact,
}: {
  item: ThreadItem;
  time: string;
  compact?: boolean;
}) {
  const inbound = item.direction === 'inbound';
  if (item.isVoicemail)
    return (
      <div
        data-testid={`call-${item.id}`}
        data-kind="voicemail"
        className={cn(
          'mt-2 flex flex-col gap-2.5 self-start rounded-[14px] border border-border bg-card px-3.5 py-3',
          compact ? 'w-full' : 'w-[420px] max-w-[80%] max-md:w-full max-md:max-w-full',
        )}
      >
        <div className="flex items-center gap-2.5">
          <ChannelIcon icon={Voicemail} tone="warning" />
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium">Missed call · left a voicemail</div>
            <div className="text-xs text-text-3">{time}</div>
          </div>
        </div>
        {item.recordingPath ? (
          <VoicemailPlayer
            path={item.recordingPath}
            seconds={item.recordingSeconds}
            seed={item.id}
            size={compact ? 36 : 30}
          />
        ) : null}
        {item.transcript ? (
          <>
            <p className="text-[13px] leading-[1.5]">“{item.transcript}”</p>
            {compact ? null : (
              <p className="text-xs text-text-3 max-md:hidden">
                Transcribed automatically, so it may contain mistakes.
              </p>
            )}
          </>
        ) : null}
      </div>
    );

  const live = LIVE.has(item.status);
  const answered = inbound ? !!item.answeredVia : item.status === 'completed';
  const missed = !live && !answered;
  const title = live
    ? inbound
      ? 'Incoming call'
      : 'Calling…'
    : answered
      ? inbound
        ? 'Incoming call'
        : 'Outgoing call'
      : inbound
        ? 'Missed call'
        : 'Call not answered';
  const detail = live
    ? item.status === 'in_progress'
      ? 'in progress'
      : 'ringing'
    : inbound
      ? answered
        ? answeredLine(item)
        : null
      : item.sentBy
        ? `${item.sentBy.fullName} called`
        : null;
  return (
    <div
      data-testid={`call-${item.id}`}
      data-kind="call"
      className={cn(
        'mt-2 flex items-center gap-2.5 self-start rounded-[14px] border border-border bg-card px-3.5 py-3',
        compact ? 'w-full' : 'w-[360px] max-w-[80%]',
      )}
    >
      <ChannelIcon
        icon={missed ? PhoneMissed : inbound ? Phone : PhoneOutgoing}
        tone={missed ? 'warning' : inbound ? 'success' : 'accent'}
      />
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium">{title}</div>
        <div className="truncate text-xs text-text-3">
          {[time, detail].filter(Boolean).join(' · ')}
        </div>
      </div>
      {answered && !live ? (
        <span className="font-mono text-xs text-text-3">{clock(item.durationSeconds)}</span>
      ) : null}
    </div>
  );
}
