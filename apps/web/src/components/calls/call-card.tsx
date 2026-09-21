'use client';
import { callCardWords, THREAD_WORDS } from '@hfos/core';
import { ChevronDown, Phone, PhoneMissed, PhoneOutgoing, Voicemail } from 'lucide-react';
import { useState } from 'react';
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
 * What a call left behind: its recording, its words, or the reason there are neither.
 *
 * A whole call's transcript can run to thousands of words, so it opens rather than filling the thread — somebody
 * scrolling a conversation for a text should not have to scroll past one. A voicemail is a sentence or two and is
 * the point of its card, so it just shows. Before this, a recorded call's words were not on the web at all.
 */
function CallRecord({
  item,
  note,
  size,
  open: openByDefault,
}: {
  item: ThreadItem;
  note: string | null;
  size: 30 | 36;
  open: boolean;
}) {
  const [open, setOpen] = useState(openByDefault);
  if (!item.recordingPath && !item.transcript)
    return note ? <p className="text-xs text-text-3">{note}</p> : null;

  const body = (
    <>
      {item.recordingPath ? (
        <VoicemailPlayer
          path={item.recordingPath}
          seconds={item.recordingSeconds}
          seed={item.id}
          size={size}
        />
      ) : null}
      {item.transcript ? (
        <>
          <p className="whitespace-pre-line text-[13px] leading-[1.5]">{item.transcript}</p>
          <p className="text-xs text-text-3">{THREAD_WORDS.transcribed}</p>
        </>
      ) : null}
      {note ? <p className="text-xs text-text-3">{note}</p> : null}
    </>
  );

  if (openByDefault) return body;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        data-testid="call-record-toggle"
        className="flex items-center gap-1 self-start text-xs font-medium text-accent-text"
      >
        <ChevronDown
          className={cn('h-3.5 w-3.5 transition-transform', open ? '' : '-rotate-90')}
          strokeWidth={2}
        />
        {open ? THREAD_WORDS.hideRecord : THREAD_WORDS.showRecord}
      </button>
      {open ? body : null}
    </>
  );
}

/**
 * A call in the conversation: a voicemail with its player and words, or a call with its length and, where one was
 * recorded, what was said on it. `compact` is the record page's message sheet (full width, a larger play button).
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
  const voicemail = words.kind === 'voicemail';
  return (
    <div
      data-testid={`call-${item.id}`}
      data-kind={voicemail ? 'voicemail' : 'call'}
      className={cn(
        'mt-2 flex flex-col gap-2.5 self-start rounded-[14px] border border-border bg-card px-3.5 py-3',
        compact
          ? 'w-full'
          : voicemail
            ? 'w-[420px] max-w-[80%] max-md:w-full max-md:max-w-full'
            : 'w-[360px] max-w-[80%]',
      )}
    >
      <div className="flex items-center gap-2.5">
        <ChannelIcon icon={CALL_ICON[words.icon]} tone={words.tone} />
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium">{words.title}</div>
          <div className="truncate text-xs text-text-3">
            {[time, words.detail].filter(Boolean).join(' · ')}
          </div>
        </div>
        {words.length ? (
          <span className="font-mono text-xs text-text-3">{words.length}</span>
        ) : null}
      </div>
      <CallRecord item={item} note={words.note} size={compact ? 36 : 30} open={voicemail} />
    </div>
  );
}
