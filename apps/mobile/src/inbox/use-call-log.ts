import { callLogWords, formatPhone, type CallLogRowWords } from '@hfos/core';
import { useQuery } from '@powersync/react-native';
import * as React from 'react';

import { useBusiness } from '@/components/shell/business-context';
import { CALL_LOG_SQL } from '@/inbox/queries';

/** Which calls the screen is showing. The same three the web's call log offers. */
export type CallFilter = 'all' | 'missed' | 'voicemail';

/** One row of the phone's call log: the facts, and the words core works out from them. */
export interface CallLogEntry {
  readonly id: string;
  readonly conversationId: string | null;
  readonly personId: string | null;
  /** The customer's name where we know it, otherwise their number. */
  readonly who: string;
  readonly number: string;
  readonly occurredAt: string;
  readonly isVoicemail: boolean;
  /** Whether the carrier recorded anything — see ThreadItemShape.hasRecording for what the phone can know. */
  readonly hasRecording: boolean;
  readonly recordingSeconds: number | null;
  readonly transcript: string | null;
  readonly words: CallLogRowWords;
}

interface CallLogRow {
  readonly id: string;
  readonly conversation_id: string | null;
  readonly person_id: string | null;
  readonly first_name: string | null;
  readonly last_name: string | null;
  readonly counterpart: string | null;
  readonly direction: string | null;
  readonly answered_via: string | null;
  readonly answered_name: string | null;
  readonly started_at: string | null;
  readonly duration_seconds: number | null;
  readonly is_voicemail: number | null;
  readonly recording_seconds: number | null;
  readonly transcript: string | null;
  readonly transcript_status: string | null;
}

const via = (v: string | null): 'browser' | 'forwarding' | 'bridge' | null =>
  v === 'browser' || v === 'forwarding' || v === 'bridge' ? v : null;

const status = (v: string | null): 'pending' | 'completed' | 'failed' | null =>
  v === 'pending' || v === 'completed' || v === 'failed' ? v : null;

/**
 * The call log from the phone's own copy, so it reads with no signal. Only the audio needs the network, and only
 * when somebody presses play.
 */
export function useCallLog(filter: CallFilter): {
  readonly items: readonly CallLogEntry[];
  readonly loading: boolean;
} {
  const { business } = useBusiness();
  const { data, isLoading } = useQuery<CallLogRow>(CALL_LOG_SQL, [business.id]);
  return React.useMemo(() => {
    const items = data.map((r) => {
      const number = r.counterpart ?? '';
      const voicemail = !!r.is_voicemail;
      const direction = r.direction === 'outbound' ? ('outbound' as const) : ('inbound' as const);
      return {
        id: r.id,
        conversationId: r.conversation_id,
        personId: r.person_id,
        who:
          `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim() ||
          (number.startsWith('+') ? formatPhone(number) : number),
        number: number.startsWith('+') ? formatPhone(number) : number,
        occurredAt: r.started_at ?? new Date(0).toISOString(),
        isVoicemail: voicemail,
        hasRecording: (r.recording_seconds ?? 0) > 0,
        recordingSeconds: r.recording_seconds,
        transcript: r.transcript,
        words: callLogWords({
          direction,
          isVoicemail: voicemail,
          answeredVia: via(r.answered_via),
          answeredByName: r.answered_name,
          hasRecording: (r.recording_seconds ?? 0) > 0,
          transcript: r.transcript,
          transcriptStatus: status(r.transcript_status),
          durationSeconds: r.duration_seconds,
        }),
        // Kept off the entry itself: the two filters below are the only readers.
        _voicemail: voicemail,
        _missed: direction === 'inbound' && !via(r.answered_via),
      };
    });
    const shown =
      filter === 'missed'
        ? items.filter((i) => i._missed)
        : filter === 'voicemail'
          ? items.filter((i) => i._voicemail)
          : items;
    return { items: shown.map(({ _voicemail, _missed, ...rest }) => rest), loading: isLoading };
  }, [data, filter, isLoading]);
}
