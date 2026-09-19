'use client';
import { callClock, formatPhone, THREAD_WORDS } from '@hfos/core';
import { ChevronDown, Phone, PhoneMissed, PhoneOutgoing, Voicemail } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { ChannelIcon } from '@/components/inbox/bits';
import { Card } from '@/components/ui/card';
import { Segmented } from '@/components/ui/segmented';
import type { CallLogItem } from '@/lib/api/types';
import { cn } from '@/lib/utils';
import { VoicemailPlayer } from './voicemail-player';

type Filter = 'all' | 'missed' | 'voicemail';

const COLUMNS =
  'sm:grid sm:grid-cols-[minmax(0,2fr)_minmax(0,1.6fr)_110px] sm:items-center sm:gap-4';

/** Who rang, and how it went. */
function rowWords(call: CallLogItem): {
  title: string;
  detail: string | null;
  icon: 'voicemail' | 'missed' | 'incoming' | 'outgoing';
  tone: 'warning' | 'success' | 'accent';
} {
  if (call.isVoicemail)
    return {
      title: 'Voicemail',
      detail: 'they left a message',
      icon: 'voicemail',
      tone: 'warning',
    };
  const inbound = call.direction === 'inbound';
  const answered = !!call.answeredVia;
  if (inbound && !answered)
    return { title: 'Missed call', detail: null, icon: 'missed', tone: 'warning' };
  const detail = call.answeredBy
    ? `${call.answeredBy.fullName} answered`
    : call.answeredVia === 'forwarding'
      ? 'answered on a forwarding phone'
      : null;
  return inbound
    ? { title: 'Incoming call', detail, icon: 'incoming', tone: 'success' }
    : { title: 'Outgoing call', detail, icon: 'outgoing', tone: 'accent' };
}

const ICON = {
  voicemail: Voicemail,
  missed: PhoneMissed,
  incoming: Phone,
  outgoing: PhoneOutgoing,
} as const;

/** One call, with its recording and words folded away until somebody wants them. */
function CallRow({ call, workspaceId }: { call: CallLogItem; workspaceId: string }) {
  const [open, setOpen] = useState(false);
  const words = rowWords(call);
  const when = new Date(call.occurredAt);
  const has = !!call.recordingPath || !!call.transcript;
  const length =
    call.durationSeconds !== null && call.durationSeconds > 0
      ? callClock(call.durationSeconds)
      : null;

  return (
    <div className="px-4 py-3" data-testid="call-row">
      <div className={cn('flex items-center gap-3', COLUMNS)}>
        <div className="flex min-w-0 items-center gap-2.5">
          <ChannelIcon icon={ICON[words.icon]} tone={words.tone} />
          <div className="min-w-0">
            {call.conversationId ? (
              <Link
                href={`/app/w/${workspaceId}/inbox/${call.conversationId}`}
                className="truncate font-medium text-text hover:underline"
              >
                {call.who}
              </Link>
            ) : (
              <span className="truncate font-medium text-text">{call.who}</span>
            )}
            <p className="truncate text-[12.5px] text-text-3">
              {call.counterpart.startsWith('+') ? formatPhone(call.counterpart) : call.counterpart}
            </p>
          </div>
        </div>
        <div className="mt-1 min-w-0 text-[13px] text-text-2 sm:mt-0">
          <span className="block truncate">{words.title}</span>
          {words.detail ? (
            <span className="block truncate text-[12.5px] text-text-3">{words.detail}</span>
          ) : null}
        </div>
        <div className="mt-1 text-[12.5px] text-text-3 sm:mt-0 sm:text-right">
          <span className="block">
            {when.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
          </span>
          <span className="block">
            {when.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
            {length ? ` · ${length}` : ''}
          </span>
        </div>
      </div>

      {has ? (
        <div className="mt-2 flex flex-col gap-2 sm:pl-[42px]">
          <button
            type="button"
            onClick={() => setOpen(!open)}
            aria-expanded={open}
            data-testid="call-log-toggle"
            className="flex items-center gap-1 self-start text-xs font-medium text-accent-text"
          >
            <ChevronDown
              className={cn('h-3.5 w-3.5 transition-transform', open ? '' : '-rotate-90')}
              strokeWidth={2}
            />
            {open ? THREAD_WORDS.hideRecord : THREAD_WORDS.showRecord}
          </button>
          {open ? (
            <>
              {call.recordingPath ? (
                <VoicemailPlayer
                  path={call.recordingPath}
                  seconds={call.recordingSeconds}
                  seed={call.id}
                />
              ) : null}
              {call.transcript ? (
                <p className="whitespace-pre-line text-[13px] leading-[1.5]">{call.transcript}</p>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The call log: every call the business made or took, newest first. A conversation shows a call where it
 * happened, which is right when reading one thread and no use when the question is "who rang this morning".
 */
export function CallLog({
  workspaceId,
  items,
  filter,
}: {
  workspaceId: string;
  items: CallLogItem[];
  filter: Filter;
}) {
  const router = useRouter();
  const params = useSearchParams();

  const pick = (next: Filter) => {
    const p = new URLSearchParams(params.toString());
    if (next === 'all') p.delete('filter');
    else p.set('filter', next);
    const q = p.toString();
    router.push(`/app/w/${workspaceId}/calls${q ? `?${q}` : ''}`);
  };

  return (
    <div className="space-y-4">
      <Segmented
        value={filter}
        onChange={pick}
        ariaLabel="Which calls to show"
        options={[
          { value: 'all', label: 'All', testId: 'calls-all' },
          { value: 'missed', label: 'Missed', testId: 'calls-missed' },
          { value: 'voicemail', label: 'Voicemail', testId: 'calls-voicemail' },
        ]}
      />
      <Card className="divide-y divide-border">
        <div
          className={cn(
            'hidden px-4 py-2 text-[12px] font-medium uppercase tracking-wide text-text-3 sm:block',
            COLUMNS,
          )}
        >
          <span>Who</span>
          <span>What happened</span>
          <span className="text-right">When</span>
        </div>
        {items.length ? (
          items.map((call) => <CallRow key={call.id} call={call} workspaceId={workspaceId} />)
        ) : (
          <p className="px-4 py-10 text-center text-[13px] text-text-3">
            {filter === 'missed'
              ? 'No missed calls. Every call has been answered.'
              : filter === 'voicemail'
                ? 'No voicemails.'
                : 'No calls yet. They show up here as they come in.'}
          </p>
        )}
      </Card>
    </div>
  );
}
