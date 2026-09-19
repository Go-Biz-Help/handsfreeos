'use client';
import { callCardWords, THREAD_WORDS } from '@hfos/core';
import { Phone, PhoneMissed, PhoneOutgoing, Voicemail } from 'lucide-react';
import { ChannelIcon } from '@/components/inbox/bits';
import type { ThreadItem } from '@/lib/api/types';
import { cn } from '@/lib/utils';
import { VoicemailPlayer } from './voicemail-player';

const CALL_ICON = {
  voicemail: Voicemail,
  missed: PhoneMissed,
  incoming: Phone,
  outgoing: PhoneOutgoing,
} as const;

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
  const words = callCardWords(item);
  if (words.kind === 'voicemail')
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
            <div className="text-[13px] font-medium">{words.title}</div>
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
              <p className="text-xs text-text-3 max-md:hidden">{THREAD_WORDS.transcribed}</p>
            )}
          </>
        ) : null}
        {/* Why there is nothing to play or read. Without it the card just showed less, which looked like a bug. */}
        {words.note ? (
          <p className="text-xs text-text-3" data-testid="voicemail-note">
            {words.note}
          </p>
        ) : null}
      </div>
    );

  return (
    <div
      data-testid={`call-${item.id}`}
      data-kind="call"
      className={cn(
        'mt-2 flex items-center gap-2.5 self-start rounded-[14px] border border-border bg-card px-3.5 py-3',
        compact ? 'w-full' : 'w-[360px] max-w-[80%]',
      )}
    >
      <ChannelIcon icon={CALL_ICON[words.icon]} tone={words.tone} />
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium">{words.title}</div>
        <div className="truncate text-xs text-text-3">
          {[time, words.detail].filter(Boolean).join(' · ')}
        </div>
      </div>
      {words.length ? <span className="font-mono text-xs text-text-3">{words.length}</span> : null}
    </div>
  );
}
