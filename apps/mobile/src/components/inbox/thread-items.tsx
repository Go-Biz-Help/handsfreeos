import {
  arrived,
  callCardWords,
  clockTime,
  deliveryStateOf,
  deliveryWords,
  emailSender,
  emailStatusLine,
  FAILED_STATUSES,
  heldLine,
  keywordLine,
  mediaOnlyLine,
  readLine,
  senderOf,
  textFailureHelp,
  THREAD_WORDS,
  type MediaShape,
  type ThreadItemShape,
  VIDEO_LINK_WORDS,
  FILE_LINK_WORDS,
} from '@hfos/core';
import type { LucideIcon } from 'lucide-react-native';
import * as React from 'react';
import { Image, Linking, Pressable, View } from 'react-native';

import { useAiColors } from '@/components/drafts';
import {
  CheckCheck,
  ChevronDown,
  CircleAlert,
  FileText,
  Image as ImageIcon,
  Moon,
  Phone,
  PhoneIncoming,
  PhoneMissed,
  PhoneOutgoing,
  Play,
  Sparkles,
  Voicemail,
} from '@/components/icons';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { signedUrl, useSignedUrl } from '@/inbox/storage';
import { cn } from '@/lib/utils';

import { MediaViewer } from './media-viewer';
import { ButtonReplyNote, PlainFace, RichContent, TransportTag } from './rich-message';
import { VoicemailPlayer } from './voicemail-player';

/** "Today", "Yesterday", "Monday": between days in the thread. */
export function DayDivider({ label }: { label: string }) {
  return (
    <View className="mb-1 mt-[18px] items-center" role="none">
      <Text className="text-xs font-medium text-text-3">{label}</Text>
    </View>
  );
}

/** A line in the thread about something that happened: "Mike opted out of texts". */
export function SystemLine({ icon, children }: { icon: LucideIcon; children: string }) {
  return (
    <View className="mb-0.5 mt-3 flex-row items-center justify-center gap-1.5 px-6">
      <Icon as={icon} className="size-3.5 text-text-3" />
      <Text className="text-center text-xs text-text-3">{children}</Text>
    </View>
  );
}

/**
 * A photo or a video in a message: the picture once its link is ready (with signal), a dark tile with a play mark for
 * a video, a quiet tile until then. A tap opens it full screen over the thread; a file that's neither opens in
 * whatever the phone opens that kind of file with.
 */
export function MediaThumb({ media }: { media: MediaShape }) {
  const image = media.contentType.startsWith('image/');
  const video = media.contentType.startsWith('video/');
  const url = useSignedUrl(image ? media.bucket : null, image ? media.objectPath : null);
  // Each opening gets a new key, so it starts unzoomed; closing keeps it mounted long enough to fade out.
  const [viewer, setViewer] = React.useState<{ url: string; key: number; open: boolean } | null>(
    null,
  );
  async function open() {
    const link = url ?? (await signedUrl(media.bucket, media.objectPath).catch(() => null));
    if (!link) {
      if (image) toast.error(THREAD_WORDS.photoWontLoad);
      else if (video) toast.error(THREAD_WORDS.videoWontLoad);
      return;
    }
    if (!image && !video) return void Linking.openURL(link);
    setViewer((was) => ({ url: link, key: (was?.key ?? 0) + 1, open: true }));
  }
  return (
    <>
      <Pressable
        role="button"
        accessibilityLabel={`${video ? 'Play' : 'Open'} ${media.name}`}
        testID="media-thumb"
        onPress={() => void open()}
        className={cn(
          'h-[136px] w-[180px] items-center justify-center overflow-hidden rounded-[14px] border border-border',
          video ? 'bg-black' : 'bg-card-2',
        )}
      >
        {url && image ? (
          <Image
            source={{ uri: url }}
            accessibilityIgnoresInvertColors
            className="size-full"
            resizeMode="cover"
          />
        ) : video ? (
          <View className="size-11 items-center justify-center rounded-full bg-white/20">
            <Icon as={Play} className="ml-0.5 size-5 text-white" fill="white" />
          </View>
        ) : (
          <Icon as={image ? ImageIcon : FileText} className="size-[18px] text-text-3" />
        )}
      </Pressable>
      {viewer ? (
        <MediaViewer
          key={viewer.key}
          media={media}
          url={viewer.url}
          open={viewer.open}
          onClose={() => setViewer((was) => was && { ...was, open: false })}
        />
      ) : null}
    </>
  );
}

function Bubble({
  out,
  tone = 'plain',
  children,
}: {
  out: boolean;
  tone?: 'plain' | 'failed' | 'held';
  children: string;
}) {
  return (
    <View
      className={cn(
        'rounded-2xl px-[13px] py-[9px]',
        out
          ? tone === 'failed'
            ? 'rounded-br-[5px] bg-danger-soft'
            : tone === 'held'
              ? 'rounded-br-[5px] border border-dashed border-accent bg-accent-soft'
              : 'rounded-br-[5px] bg-accent'
          : 'rounded-bl-[5px] border border-border bg-card',
      )}
    >
      <Text
        selectable
        className={cn(
          'text-[15px] leading-[22px]',
          out && tone === 'plain' && 'text-white',
          out && tone === 'failed' && 'text-danger-text',
        )}
      >
        {children}
      </Text>
    </View>
  );
}

/**
 * Where a reply the business sent is: Sending…, Sent, Delivered (or Seen in a chat), Read, Not delivered. An RCS
 * message the customer opened says when, since a phone has nowhere to hover for it: "Read Tue 2:14 PM".
 */
function Delivery({
  status,
  chat,
  readAt,
}: {
  status: string;
  chat: boolean;
  readAt?: string | null;
}) {
  const state = deliveryStateOf(status);
  const words = state === 'read' ? readLine(readAt) : deliveryWords(state, chat);
  if (!words) return null;
  if (arrived(state))
    return (
      <View className="flex-row items-center gap-[3px]" testID="delivery">
        <Text className="text-xs text-text-3">·</Text>
        <Icon as={CheckCheck} className="size-3.5 text-success-text" strokeWidth={1.75} />
        <Text className="text-xs text-success-text">{words}</Text>
      </View>
    );
  if (state === 'failed')
    return (
      <View className="flex-row items-center gap-[3px]">
        <Text className="text-xs text-text-3">·</Text>
        <Icon as={CircleAlert} className="size-3.5 text-danger-text" strokeWidth={1.75} />
        <Text className="text-xs font-medium text-danger-text">{words}</Text>
      </View>
    );
  return <Text className="text-xs text-text-3">{`· ${words}`}</Text>;
}

/** A text (or a website chat message) in the thread: the customer on the left, the business on the right. */
export function MessageBubble({
  item,
  customerFirstName,
  timeZone,
  onCancelHeld,
}: {
  item: ThreadItemShape;
  customerFirstName: string | null;
  /** The business's time zone: a held text says when it goes on the business's clock, as quiet hours end. */
  timeZone: string;
  onCancelHeld: (messageId: string) => void;
}) {
  const ai = useAiColors();
  const out = item.direction === 'outbound';
  const time = clockTime(item.occurredAt);
  if (out && item.scheduledFor)
    return (
      <View className="mt-2 max-w-[84%] items-end gap-[3px] self-end" testID={`message-${item.id}`}>
        {item.media.map((m) => (
          <MediaThumb key={m.objectPath} media={m} />
        ))}
        {item.body ? (
          <Bubble out tone="held">
            {item.body}
          </Bubble>
        ) : null}
        <View className="flex-row items-center justify-end gap-x-[5px] px-1">
          <Icon as={Moon} className="size-3 text-warning-text" strokeWidth={1.75} />
          <Text className="shrink text-right text-xs text-text-3" testID="held-line">
            {heldLine(item, item.scheduledFor, timeZone)}
          </Text>
        </View>
        <View className="flex-row justify-end px-1">
          <Pressable
            role="button"
            onPress={() => onCancelHeld(item.id)}
            hitSlop={{ top: 12, bottom: 12, left: 8, right: 8 }}
            className="h-7 justify-center px-1.5"
            testID="cancel-held"
          >
            <Text className="text-[13px] font-semibold text-accent-text">
              {THREAD_WORDS.cancel}
            </Text>
          </Pressable>
        </View>
      </View>
    );
  const failed = out && FAILED_STATUSES.has(item.status);
  const sender = senderOf(item);
  const keyword = keywordLine(item, customerFirstName);
  return (
    <>
      <View
        className={cn('mt-2 max-w-[84%] gap-[3px]', out ? 'items-end self-end' : 'self-start')}
        testID={`message-${item.id}`}
      >
        {/* A rich text's buttons, card or carousel go with its words (RCS, 0103). */}
        <RichContent
          item={item}
          bubble={
            <>
              {item.media.map((m) => (
                <MediaThumb key={m.objectPath} media={m} />
              ))}
              {item.media.some((m) => m.via === 'video_link') ? (
                <Text className="px-1 text-xs text-text-3" testID="came-by-video-link">
                  {VIDEO_LINK_WORDS.cameByLink}
                </Text>
              ) : item.media.some((m) => m.via === 'file_link') ? (
                <Text className="px-1 text-xs text-text-3" testID="came-by-file-link">
                  {FILE_LINK_WORDS.cameByLink}
                </Text>
              ) : null}
              {item.body ? (
                <Bubble out={out} tone={failed ? 'failed' : 'plain'}>
                  {item.body}
                </Bubble>
              ) : null}
            </>
          }
        />
        {out && item.rich && (item.transport === 'sms' || item.transport === 'mms') ? (
          <PlainFace smsText={item.rich.smsText} />
        ) : null}
        {!out && item.buttonReply ? (
          <ButtonReplyNote reply={item.buttonReply} body={item.body} />
        ) : null}
        <View className="flex-row flex-wrap items-center gap-[5px] px-1">
          {out ? (
            <>
              {sender.ai ? (
                <View className="flex-row items-center gap-[3px]" testID="ai-label">
                  <Sparkles size={12} color={ai.text} strokeWidth={1.75} />
                  <Text className="text-xs font-semibold" style={{ color: ai.text }}>
                    {sender.label}
                  </Text>
                </View>
              ) : (
                <Text className="text-xs text-text-3">{`${sender.label} · ${time}`}</Text>
              )}
              {sender.ai ? <Text className="text-xs text-text-3">{`· ${time}`}</Text> : null}
              <TransportTag transport={item.transport} />
              <Delivery
                status={item.status}
                chat={item.channel === 'chat' || item.channel === 'portal'}
                readAt={item.readAt}
              />
            </>
          ) : (
            <>
              <Text className="text-xs text-text-3">{mediaOnlyLine(item, time)}</Text>
              <TransportTag transport={item.transport} />
            </>
          )}
        </View>
        {failed ? (
          <Text className="px-1 text-right text-[13px] text-text-2">{textFailureHelp(item)}</Text>
        ) : null}
      </View>
      {keyword ? (
        <SystemLine icon={keyword.kind === 'stop' ? CircleAlert : CheckCheck}>
          {keyword.text}
        </SystemLine>
      ) : null}
    </>
  );
}

/** An email in the thread: its subject, who it's from, the words (the phone keeps the plain text), files, and where it is. */
export function EmailCard({
  item,
  customerName,
}: {
  item: ThreadItemShape;
  customerName: string | null;
}) {
  const out = item.direction === 'outbound';
  const status = out ? emailStatusLine(item) : null;
  const sender = emailSender(item, customerName);
  return (
    <View
      className={cn('mt-2 max-w-[94%] gap-[3px]', out ? 'items-end self-end' : 'self-start')}
      testID={`message-${item.id}`}
    >
      <View
        className={cn(
          'w-full gap-2 rounded-dialog border bg-card px-4 py-3.5',
          status?.bad ? 'border-danger-soft' : out ? 'border-accent-soft-2' : 'border-border',
        )}
      >
        <View>
          <Text className="text-[14px] font-medium">{item.subject || THREAD_WORDS.noSubject}</Text>
          <Text numberOfLines={1} className="text-xs text-text-3">
            {`${sender} · ${clockTime(item.occurredAt)}`}
          </Text>
        </View>
        <Text
          selectable
          className={cn('text-[14.5px] leading-[21px]', status?.bad && 'text-text-2')}
        >
          {item.body ?? ''}
        </Text>
        {item.media.length > 0 ? (
          <View className="flex-row flex-wrap gap-1.5">
            {item.media.map((m) => (
              <FileChip key={m.objectPath} media={m} />
            ))}
          </View>
        ) : null}
      </View>
      {status ? (
        <View className="flex-row items-center gap-[3px] px-1">
          {status.bad ? (
            <Icon as={CircleAlert} className="size-3.5 text-danger-text" strokeWidth={1.75} />
          ) : status.text === 'Delivered' ? (
            <Icon as={CheckCheck} className="size-3.5 text-success-text" strokeWidth={1.75} />
          ) : null}
          <Text
            className={cn(
              'text-xs',
              status.bad
                ? 'font-medium text-danger-text'
                : status.text === 'Delivered'
                  ? 'text-success-text'
                  : 'text-text-3',
            )}
          >
            {status.text}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

function FileChip({ media }: { media: MediaShape }) {
  return (
    <Pressable
      role="link"
      accessibilityLabel={`Open ${media.name}`}
      onPress={() =>
        void signedUrl(media.bucket, media.objectPath).then((link) => link && Linking.openURL(link))
      }
      className="h-[34px] max-w-full flex-row items-center gap-2 rounded-control border border-border bg-card-2 px-2.5"
    >
      <Icon as={FileText} className="size-3.5 text-text" />
      <Text numberOfLines={1} className="shrink text-[13px] font-medium">
        {media.name}
      </Text>
    </Pressable>
  );
}

const CALL_ICON: Record<ReturnType<typeof callCardWords>['icon'], LucideIcon> = {
  voicemail: Voicemail,
  missed: PhoneMissed,
  incoming: PhoneIncoming,
  outgoing: PhoneOutgoing,
};

/** A recorded call's words, folded away until somebody wants them. */
function Transcript({ text }: { text: string }) {
  const [open, setOpen] = React.useState(false);
  return (
    <View className="gap-1.5">
      <Pressable
        onPress={() => setOpen(!open)}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        testID="call-transcript-toggle"
        className="min-h-11 flex-row items-center gap-1"
      >
        <Icon
          as={ChevronDown}
          className={cn('size-4 text-accent-text', open ? '' : '-rotate-90')}
        />
        <Text className="text-[13px] font-medium text-accent-text">
          {open ? THREAD_WORDS.hideRecord : THREAD_WORDS.showRecord}
        </Text>
      </Pressable>
      {open ? (
        <Text selectable className="text-[14.5px] leading-[21px]">
          {text}
        </Text>
      ) : null}
    </View>
  );
}

/** A call in the conversation: a voicemail with its player and words, or a call with who answered and its length. */
export function CallCard({ item, workspaceId }: { item: ThreadItemShape; workspaceId: string }) {
  const words = callCardWords(item);
  const time = clockTime(item.occurredAt);
  const tone =
    words.tone === 'warning'
      ? 'bg-warning-soft text-warning-text'
      : words.tone === 'success'
        ? 'bg-success-soft text-success-text'
        : 'bg-accent-soft text-accent-text';
  const [box, text] = tone.split(' ');
  return (
    <View
      className="mt-2 w-full gap-2.5 self-start rounded-[14px] border border-border bg-card px-3.5 py-3"
      testID={`call-${item.id}`}
    >
      <View className="flex-row items-center gap-2.5">
        <View className={cn('size-8 items-center justify-center rounded-full', box)}>
          <Icon as={CALL_ICON[words.icon] ?? Phone} className={cn('size-3.5', text)} />
        </View>
        <View className="min-w-0 flex-1">
          <Text className="text-[14px] font-medium">
            {words.length ? `${words.title} · ${words.length}` : words.title}
          </Text>
          <Text numberOfLines={1} className="text-xs text-text-3">
            {[time, words.detail].filter(Boolean).join(' · ')}
          </Text>
        </View>
      </View>
      {item.hasRecording && (words.kind === 'voicemail' || item.answeredVia === 'bridge') ? (
        <VoicemailPlayer
          workspaceId={workspaceId}
          callId={item.id}
          voicemail={item.isVoicemail}
          seconds={item.recordingSeconds}
        />
      ) : null}
      {item.transcript ? (
        words.kind === 'voicemail' ? (
          <View className="gap-1">
            <Text variant="group">Transcript</Text>
            <Text selectable className="text-[14.5px] leading-[21px]">
              {item.transcript}
            </Text>
          </View>
        ) : (
          // A whole call's words can run to thousands: they open rather than filling the thread.
          <Transcript text={item.transcript} />
        )
      ) : null}
      {/* Why there is nothing to play or read. Without it the card just showed less, which looked like a bug. */}
      {words.note ? (
        <Text className="text-xs text-text-3" testID="voicemail-note">
          {words.note}
        </Text>
      ) : null}
    </View>
  );
}
