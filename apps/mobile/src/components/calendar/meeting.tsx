import {
  CALL_REVIEW_WORDS,
  VIDEO_CALL_NAME,
  VIDEO_CALL_WORDS,
  callIdOfLink,
  callReviewLabel,
  videoCallAppPath,
} from '@hfos/core';
import { router, type Href } from 'expo-router';
import * as React from 'react';
import { Linking, View } from 'react-native';
import { Video } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { api, errorMessage, unwrap } from '@/lib/api';
import { ChatText } from '@/video-call/chat-text';

type ChatMessage = { id: string; name: string; body: string; sentAt: string };

const clock = (at: string) =>
  new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/**
 * A HandsFreeOS call's chat, kept with the call whatever its AI notes (docs/video-calls.md, "The chat, kept"):
 * folded away under its count, oldest first, each message's links pressable.
 */
function CallChat({ messages, more }: { messages: readonly ChatMessage[]; more: number }) {
  const [open, setOpen] = React.useState(false);
  if (!messages.length) return null;
  return (
    <View className="gap-2" testID="call-chat-log">
      <Button
        variant="ghost"
        size="sm"
        className="self-start"
        onPress={() => setOpen(!open)}
        testID="call-chat-log-toggle"
      >
        {`${VIDEO_CALL_WORDS.chatLog} · ${messages.length + more}`}
      </Button>
      {open ? (
        <View className="gap-2.5">
          {messages.map((m) => (
            <View key={m.id} className="gap-0.5" testID="call-chat-log-message">
              <Text className="text-[12px] text-text-3">
                <Text className="text-[12px] font-medium text-text-2">{m.name}</Text> ·{' '}
                {clock(m.sentAt)}
              </Text>
              <ChatText text={m.body} className="text-[13.5px]" />
            </View>
          ))}
          {more ? (
            <Text className="text-[12px] text-text-3">{VIDEO_CALL_WORDS.chatLogMore(more)}</Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

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

/**
 * The link to join, or why there's none yet (the web's Make link fixes that). A HandsFreeOS video call opens in the
 * app (docs/video-calls.md, "On the phone"); Zoom and Google Meet open their own apps or the browser.
 */
export function MeetingLink({ meeting, workspaceId }: { meeting: Meeting; workspaceId: string }) {
  const name = meeting.video ? PROVIDER[meeting.video] : 'Video call';
  const callId = meeting.video === 'handsfree' ? callIdOfLink(meeting.url) : null;
  const join = () => {
    if (callId) router.push(videoCallAppPath(workspaceId, callId) as Href);
    else if (meeting.url) void Linking.openURL(meeting.url);
  };
  if (meeting.url)
    return (
      <View testID="appointment-meeting">
        <Text className="text-[15px]">{name}</Text>
        <Button
          variant="secondary"
          size="sm"
          icon={Video}
          className="mt-2 self-start"
          onPress={join}
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
  taskId?: string | null;
};
type Review = { summary: string | null; transcript?: string | null; items: Suggestion[] };
type Transcript = { id: string; provider: string; createdAt: string; body: string };

const text = (v: unknown) => (typeof v === 'string' ? v : '');
const APPROVE = CALL_REVIEW_WORDS.approve;
const FIELDS = [
  ['firstName', 'First name'],
  ['lastName', 'Last name'],
  ['email', 'Email'],
  ['phone', 'Phone'],
] as const;
const SHORT = 600;

/**
 * A recorded call, once it's over: the AI's summary, the tasks it added, the follow-up and record update it suggests
 * (each waits for an OK here or on the web), and what was said. Asked for online; nothing of it is kept on the phone.
 * An appointment's call, a HandsFreeOS video call that wasn't for one (docs/video-calls.md, part 5), or a phone call
 * on the business number (20261027023200), from the line it has on the customer's timeline. A phone call keeps its
 * words on itself, so they come with the review.
 */
export function CallRecord({
  workspaceId,
  online,
  ours = false,
  ...call
}: {
  workspaceId: string;
  online: boolean;
  /** A HandsFreeOS video call: its transcript comes from the AI's notes, once the call ends. */
  ours?: boolean;
} & ({ appointmentId: string } | { videoCallId: string } | { callId: string })) {
  const appointmentId = 'appointmentId' in call ? call.appointmentId : undefined;
  const videoCallId = 'videoCallId' in call ? call.videoCallId : undefined;
  const callId = 'callId' in call ? call.callId : undefined;
  const [review, setReview] = React.useState<Review | null>(null);
  const [transcripts, setTranscripts] = React.useState<Transcript[]>([]);
  const [titles, setTitles] = React.useState<Record<string, string>>({});
  const [busy, setBusy] = React.useState<string | null>(null);
  const [full, setFull] = React.useState(false);
  const [chat, setChat] = React.useState<{ messages: ChatMessage[]; more: number }>({
    messages: [],
    more: 0,
  });

  const load = React.useCallback(async () => {
    const body = {
      body: { workspaceId, ...(appointmentId ? { appointmentId } : { videoCallId }) },
    };
    const [r, t, c] = await Promise.allSettled([
      api
        .POST('/v1/queries/call_suggestion.list', {
          body: callId ? { workspaceId, callId } : body.body,
        })
        .then(unwrap),
      // A phone call's words come with its review.
      callId
        ? Promise.resolve({ items: [] as Transcript[] })
        : api.POST('/v1/queries/appointment.transcripts', body).then(unwrap),
      // A HandsFreeOS call keeps its chat, whatever its AI notes.
      ours
        ? api
            .POST('/v1/queries/video_call.chat', {
              body: {
                workspaceId,
                ...(appointmentId ? { appointmentId } : { callId: videoCallId }),
              },
            })
            .then(unwrap)
        : Promise.resolve(null),
    ]);
    if (r.status === 'fulfilled') setReview(r.value as Review);
    if (t.status === 'fulfilled') setTranscripts((t.value as { items: Transcript[] }).items);
    if (c.status === 'fulfilled' && c.value)
      setChat({ messages: c.value.messages, more: c.value.more });
  }, [workspaceId, appointmentId, videoCallId, callId, ours]);

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
  const latest: Transcript | undefined =
    transcripts[0] ??
    (review?.transcript
      ? { id: 'call', provider: 'phone', createdAt: '', body: review.transcript }
      : undefined);
  if (!latest && !review?.summary && !review?.items.length)
    return (
      <View className="gap-3">
        <Text className="text-[13px] text-text-2" testID="call-record-waiting">
          {callId
            ? CALL_REVIEW_WORDS.saidSoon
            : ours
              ? VIDEO_CALL_WORDS.transcriptSoon
              : 'The transcript shows here after the call.'}
        </Text>
        <CallChat messages={chat.messages} more={chat.more} />
      </View>
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
        const label = callReviewLabel(s.kind, s.status);
        const was = (s.preview.was ?? {}) as Record<string, unknown>;
        return (
          <View
            key={s.id}
            className="gap-2 rounded-menu border border-border p-3"
            testID="call-suggestion"
          >
            <Text className="text-[12px] font-semibold uppercase text-text-3">{label}</Text>
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
                    {appointmentId
                      ? 'To change the wording, open this appointment on the web.'
                      : 'To change the wording, open this customer on the web.'}
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
            {CALL_REVIEW_WORDS.said}
            {latest.provider === 'phone'
              ? ''
              : ` · ${
                  latest.provider === 'handsfree'
                    ? VIDEO_CALL_NAME
                    : latest.provider === 'google_meet'
                      ? 'Google Meet'
                      : 'Zoom'
                }`}
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
      <CallChat messages={chat.messages} more={chat.more} />
    </View>
  );
}
