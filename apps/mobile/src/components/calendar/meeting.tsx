import { VIDEO_CALL_NAME, VIDEO_CALL_WORDS } from '@hfos/core';
import * as React from 'react';
import { Linking, View } from 'react-native';
import { Video } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { api, errorMessage, unwrap } from '@/lib/api';

/** The video meeting on an appointment's place, from `appointments.location` as the commands store it. */
export interface Meeting {
  /** `handsfree` is a HandsFreeOS video call, which the AI hears while its notes are on (docs/video-calls.md). */
  readonly video: 'zoom' | 'google_meet' | 'handsfree' | null;
  readonly url: string | null;
  readonly error: string | null;
  readonly record: boolean;
}

export function meetingOf(location: string | null): Meeting | null {
  if (!location) return null;
  try {
    const p = JSON.parse(location) as {
      kind?: string;
      video?: string | null;
      meetingUrl?: string | null;
      meetingError?: string | null;
      record?: boolean;
    };
    if (p.kind !== 'virtual') return null;
    const video =
      p.video === 'zoom' || p.video === 'google_meet' || p.video === 'handsfree' ? p.video : null;
    return {
      video,
      url: p.meetingUrl ?? null,
      error: p.meetingError ?? null,
      record: (video === 'zoom' || video === 'google_meet') && p.record === true,
    };
  } catch {
    return null;
  }
}

const PROVIDER = { zoom: 'Zoom', google_meet: 'Google Meet', handsfree: VIDEO_CALL_NAME } as const;

/** The link to join, or why there's none yet (the web's Make link fixes that). */
export function MeetingLink({ meeting }: { meeting: Meeting }) {
  const name = meeting.video ? PROVIDER[meeting.video] : 'Video call';
  if (meeting.url)
    return (
      <View testID="appointment-meeting">
        <Text className="text-[15px]">{name}</Text>
        <Button
          variant="secondary"
          size="sm"
          icon={Video}
          className="mt-2 self-start"
          onPress={() => void Linking.openURL(meeting.url!)}
          testID="appointment-join"
        >
          Join
        </Button>
        {meeting.record ? (
          <Text className="mt-1.5 text-[13px] text-text-2">
            Recorded and transcribed. The customer was told when they booked.
          </Text>
        ) : null}
      </View>
    );
  return (
    <View testID="appointment-meeting">
      <Text className="text-[15px]">{name}</Text>
      <Text className="mt-1 text-[13px] text-text-2" testID="appointment-meeting-error">
        {meeting.error ?? 'The link is on its way. Pull to refresh in a minute.'}
      </Text>
    </View>
  );
}

type Suggestion = {
  id: string;
  kind: 'task' | 'follow_up' | 'record_change';
  status: 'pending' | 'approved' | 'dismissed';
  preview: Record<string, unknown>;
};
type Review = { summary: string | null; items: Suggestion[] };
type Transcript = { id: string; provider: string; createdAt: string; body: string };

const text = (v: unknown) => (typeof v === 'string' ? v : '');
const LABEL = {
  task: 'Suggested task',
  follow_up: 'Suggested follow-up email',
  record_change: 'Suggested update to their record',
};
const APPROVE = { task: 'Add task', follow_up: 'Send email', record_change: 'Update record' };
const FIELDS = [
  ['firstName', 'First name'],
  ['lastName', 'Last name'],
  ['email', 'Email'],
  ['phone', 'Phone'],
] as const;
const SHORT = 600;

/**
 * A recorded call, once it's over: the AI's summary, the tasks, follow-up and record update it suggests (each
 * waits for an OK here or on the web), and what was said. Asked for online; nothing of it is kept on the phone.
 */
export function CallRecord({
  workspaceId,
  appointmentId,
  online,
  ours = false,
}: {
  workspaceId: string;
  appointmentId: string;
  online: boolean;
  /** A HandsFreeOS video call: its transcript comes from the AI's notes, once the call ends. */
  ours?: boolean;
}) {
  const [review, setReview] = React.useState<Review | null>(null);
  const [transcripts, setTranscripts] = React.useState<Transcript[]>([]);
  const [titles, setTitles] = React.useState<Record<string, string>>({});
  const [busy, setBusy] = React.useState<string | null>(null);
  const [full, setFull] = React.useState(false);

  const load = React.useCallback(async () => {
    const body = { body: { workspaceId, appointmentId } };
    const [r, t] = await Promise.allSettled([
      api.POST('/v1/queries/call_suggestion.list', body).then(unwrap),
      api.POST('/v1/queries/appointment.transcripts', body).then(unwrap),
    ]);
    if (r.status === 'fulfilled') setReview(r.value as Review);
    if (t.status === 'fulfilled') setTranscripts((t.value as { items: Transcript[] }).items);
  }, [workspaceId, appointmentId]);

  React.useEffect(() => {
    if (online) void load();
  }, [online, load]);

  const decide = async (s: Suggestion, decision: 'approve' | 'dismiss') => {
    setBusy(`${s.id}:${decision}`);
    try {
      const title = titles[s.id];
      unwrap(
        await api.POST('/v1/commands/call_suggestion.decide', {
          body: {
            workspaceId,
            suggestionId: s.id,
            decision,
            ...(title !== undefined && s.kind === 'task' ? { edits: { title } } : {}),
          },
        }),
      );
      toast.show(decision === 'approve' ? 'Done.' : 'Dismissed.');
      await load();
    } catch (error) {
      toast.error(errorMessage(error));
    }
    setBusy(null);
  };

  if (!online && !review)
    return (
      <Text className="text-[13px] text-text-2">
        The call’s transcript and suggestions show when the phone is online.
      </Text>
    );
  const latest = transcripts[0];
  if (!latest && !review?.summary && !review?.items.length)
    return (
      <Text className="text-[13px] text-text-2" testID="call-record-waiting">
        {ours ? VIDEO_CALL_WORDS.transcriptSoon : 'The transcript shows here after the call.'}
      </Text>
    );
  return (
    <View className="gap-3" testID="call-record">
      {review?.summary ? (
        <Text className="text-[15px]" testID="call-summary">
          {review.summary}
        </Text>
      ) : null}
      {review?.items.map((s) => {
        const pending = s.status === 'pending';
        const label = LABEL[s.kind];
        const was = (s.preview.was ?? {}) as Record<string, unknown>;
        return (
          <View
            key={s.id}
            className="gap-2 rounded-menu border border-border p-3"
            testID="call-suggestion"
          >
            <Text className="text-[12px] font-semibold uppercase text-text-3">
              {label}
              {pending ? '' : s.status === 'approved' ? ' · Done' : ' · Dismissed'}
            </Text>
            {s.kind === 'record_change' ? (
              FIELDS.filter(([k]) => text(s.preview[k])).map(([k, name]) => (
                <Text key={k} className="text-[15px]" testID={`call-change-${k}`}>
                  {name}: {text(s.preview[k])}
                  <Text className="text-[13px] text-text-2">
                    {text(was[k]) ? ` (now ${text(was[k])})` : ' (none on file)'}
                  </Text>
                </Text>
              ))
            ) : s.kind === 'task' ? (
              pending ? (
                <Input
                  aria-label="Task"
                  value={titles[s.id] ?? text(s.preview.title)}
                  onChangeText={(v) => setTitles((all) => ({ ...all, [s.id]: v }))}
                  testID="call-suggestion-title"
                />
              ) : (
                <Text className="text-[15px]">{text(s.preview.title)}</Text>
              )
            ) : (
              <>
                <Text className="text-[15px] font-medium">{text(s.preview.subject)}</Text>
                <Text className="text-[13px] text-text-2">{text(s.preview.body)}</Text>
                {pending ? (
                  <Text className="text-[12px] text-text-3">
                    To change the wording, open this appointment on the web.
                  </Text>
                ) : null}
              </>
            )}
            {pending ? (
              <View className="flex-row gap-2">
                <Button
                  size="sm"
                  disabled={!online || busy !== null}
                  loading={busy === `${s.id}:approve`}
                  onPress={() => void decide(s, 'approve')}
                  testID="call-suggestion-approve"
                >
                  {APPROVE[s.kind]}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!online || busy !== null}
                  loading={busy === `${s.id}:dismiss`}
                  onPress={() => void decide(s, 'dismiss')}
                  testID="call-suggestion-dismiss"
                >
                  Dismiss
                </Button>
              </View>
            ) : null}
          </View>
        );
      })}
      {latest ? (
        <View testID="call-transcript">
          <Text className="mb-1 text-[12px] font-semibold uppercase text-text-3">
            What was said · {latest.provider === 'google_meet' ? 'Google Meet' : 'Zoom'}
          </Text>
          <Text className="text-[13px] text-text-2">
            {full || latest.body.length <= SHORT ? latest.body : `${latest.body.slice(0, SHORT)}…`}
          </Text>
          {latest.body.length > SHORT ? (
            <Button
              variant="ghost"
              size="sm"
              className="mt-1 self-start"
              onPress={() => setFull(!full)}
              testID="call-transcript-toggle"
            >
              {full ? 'Show less' : 'Show all'}
            </Button>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
