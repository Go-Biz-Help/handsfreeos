import {
  draftActionLine,
  draftSegmentsLabel,
  DRAFT_WORDS,
  expiresLine,
  rejectReasonLabel,
  type DraftActionFacts,
} from '@hfos/core';
import type { LucideIcon } from 'lucide-react-native';
import * as React from 'react';
import { TextInput, View } from 'react-native';

import {
  CalendarCheck,
  CalendarClock,
  CalendarX,
  Check,
  Clock,
  ListPlus,
  Minus,
  Pencil,
  Percent,
  Repeat,
  Send,
  Sparkles,
} from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';
import { useColors } from '@/theme';

import { useAiColors } from './ai-colors';
import type { DraftDecision } from './use-draft-decision';

const ACTION_ICON: Record<DraftActionFacts['kind'], LucideIcon> = {
  book: CalendarCheck,
  reschedule: CalendarClock,
  cancel: CalendarX,
  book_series: Repeat,
  waitlist: ListPlus,
};

/** "Will book …", "Will move …", "Will cancel …", with the first two words in bold. */
function ActionRow({ icon, line }: { icon: LucideIcon; line: string }) {
  const [w1, w2, ...rest] = line.split(' ');
  return (
    <View
      className="flex-row items-center gap-2.5 rounded-menu bg-card-2 px-2.5 py-2"
      testID="draft-action"
    >
      <View className="size-[26px] items-center justify-center rounded-[7px] bg-accent-soft">
        <Icon as={icon} className="size-[13px] text-accent-text" />
      </View>
      <Text className="min-w-0 flex-1 text-[13px] leading-[18px]">
        <Text className="text-[13px] font-semibold">
          {w1} {w2}
        </Text>{' '}
        {rest.join(' ')}
      </Text>
    </View>
  );
}

function Chip({
  icon,
  tone,
  children,
  testID,
}: {
  icon?: LucideIcon;
  tone: 'success' | 'gray';
  children: string;
  testID?: string;
}) {
  return (
    <View
      testID={testID}
      className={cn(
        'h-[22px] flex-row items-center gap-1 rounded-[6px] px-[7px]',
        tone === 'success' ? 'bg-success-soft' : 'bg-card-2',
      )}
    >
      {icon ? (
        <Icon
          as={icon}
          className={cn('size-3', tone === 'success' ? 'text-success-text' : 'text-text-2')}
        />
      ) : null}
      <Text
        className={cn(
          'text-xs font-medium',
          tone === 'success' ? 'text-success-text' : 'text-text-2',
        )}
      >
        {children}
      </Text>
    </View>
  );
}

/** Approve and send, Edit and Reject…; Send my version and Cancel while editing; Reject and Keep it while rejecting. */
export function DraftButtons({ d }: { d: DraftDecision }) {
  const draft = d.draft;
  if (!draft) return null;
  if (d.mode === 'editing')
    return (
      <View className="gap-2">
        <Button
          icon={Send}
          loading={d.busy === 'approve'}
          disabled={d.busy !== null || d.blank}
          onPress={d.sendEdit}
          testID="draft-send-edit"
        >
          {DRAFT_WORDS.sendMyVersion}
        </Button>
        <Button variant="ghost" disabled={d.busy !== null} onPress={d.cancelEdit}>
          {DRAFT_WORDS.cancel}
        </Button>
      </View>
    );
  if (d.mode === 'rejecting')
    return (
      <View className="gap-2">
        <Button
          variant="danger"
          loading={d.busy === 'reject'}
          disabled={d.busy !== null}
          onPress={d.reject}
          testID="draft-reject-confirm"
        >
          {DRAFT_WORDS.rejectConfirm}
        </Button>
        <Button variant="ghost" disabled={d.busy !== null} onPress={() => d.setMode('view')}>
          {DRAFT_WORDS.keepIt}
        </Button>
        <Text className="text-center text-xs text-text-3">{DRAFT_WORDS.nothingSent}</Text>
      </View>
    );
  const sends = !!draft.preview.message;
  return (
    <View className="gap-2">
      <Button
        icon={Check}
        loading={d.busy === 'approve'}
        disabled={d.busy !== null}
        onPress={d.approve}
        testID="draft-approve"
      >
        {sends ? DRAFT_WORDS.approveAndSend : DRAFT_WORDS.approve}
      </Button>
      <View className="flex-row gap-2">
        {sends ? (
          <Button
            variant="secondary"
            icon={Pencil}
            className="flex-1"
            disabled={d.busy !== null}
            onPress={() => d.setMode('editing')}
            testID="draft-edit"
          >
            {DRAFT_WORDS.edit}
          </Button>
        ) : null}
        <Button
          variant="secondary"
          className="flex-1"
          disabled={d.busy !== null}
          onPress={() => d.setMode('rejecting')}
          testID="draft-reject"
        >
          {DRAFT_WORDS.reject}
        </Button>
      </View>
    </View>
  );
}

/**
 * The AI teammate's draft waiting for an OK, dashed in its violet as the web draws it: the message (editable), the
 * booking changes it holds as plain sentences, when it expires, and Approve and send, Edit and Reject. In a thread it
 * sits after the newest message; Home and Approvals give it a `header` (the customer) and a `footer`.
 */
export function DraftCard({
  d,
  timeZone,
  header,
  footer,
  now = Date.now(),
  testID = 'draft-card',
}: {
  d: DraftDecision;
  timeZone: string;
  header?: React.ReactNode;
  footer?: React.ReactNode;
  now?: number;
  testID?: string;
}) {
  const colors = useColors();
  const ai = useAiColors();
  const draft = d.draft;
  if (!draft) return null;
  const name = draft.teammate.name;
  const expires = expiresLine(draft.expiresAt, timeZone, now);
  const message = draft.preview.message;
  const email = draft.channel === 'email';
  const sms = draft.channel === 'sms' || draft.channel === null;
  const readOnly = !draft.canDecide;
  return (
    <View
      role="group"
      accessibilityLabel={`${name}’s draft`}
      testID={testID}
      className="gap-2.5 rounded-2xl border-[1.5px] border-dashed bg-card px-3.5 py-3"
      style={{ borderColor: ai.dash }}
    >
      {header}
      <View className="flex-row items-center gap-[7px]">
        <Sparkles size={13} color={ai.text} strokeWidth={1.75} />
        <Text
          numberOfLines={1}
          className="min-w-0 flex-1 text-[13px] font-semibold"
          style={{ color: ai.text }}
        >
          {`${name}’s draft`}
        </Text>
        {expires ? (
          <View className="flex-row items-center gap-1" testID="draft-expires">
            <Icon as={Clock} className="size-3.5 text-text-3" />
            <Text className="text-xs font-medium text-text-3">{expires}</Text>
          </View>
        ) : null}
      </View>
      {message ? (
        d.mode === 'editing' ? (
          <View className="gap-1.5">
            {email ? (
              <Input
                accessibilityLabel="Subject"
                value={d.subject}
                maxLength={200}
                onChangeText={d.setSubject}
                testID="draft-subject-input"
              />
            ) : null}
            <TextInput
              accessibilityLabel={`Edit ${name}’s draft`}
              multiline
              autoFocus
              value={d.body}
              maxLength={email ? 10000 : 1600}
              onChangeText={d.setBody}
              testID="draft-input"
              placeholderTextColor={colors.placeholder}
              selectionColor={colors.accent}
              className={cn(
                'min-h-[132px] rounded-menu border bg-card px-3.5 py-2.5 font-sans text-base leading-[22px] text-text',
                d.blank ? 'border-danger' : 'border-border-strong',
              )}
              style={{ textAlignVertical: 'top' }}
            />
            <View className="flex-row flex-wrap justify-between gap-x-3">
              <Text className="text-xs text-text-3">{DRAFT_WORDS.editNote}</Text>
              {sms ? (
                <Text className="text-xs text-text-3">{draftSegmentsLabel(d.body)}</Text>
              ) : null}
            </View>
          </View>
        ) : (
          <View className="gap-1">
            {email && message.subject ? (
              <Text className="text-[13.5px] font-semibold" testID="draft-subject">
                {message.subject}
              </Text>
            ) : null}
            <Text className="text-[15px] leading-[22px]" testID="draft-text">
              {message.body}
            </Text>
          </View>
        )
      ) : null}
      {draft.preview.actions.map((a, i) => (
        <ActionRow key={i} icon={ACTION_ICON[a.kind]} line={draftActionLine(a)} />
      ))}
      {draft.preview.discount ? (
        <ActionRow
          icon={Percent}
          line={`Offers ${draft.preview.discount.percent}% off${draft.preview.discount.reason ? `: ${draft.preview.discount.reason}` : ''}`}
        />
      ) : null}
      <View className="flex-row flex-wrap items-center gap-1.5">
        <Chip icon={Check} tone="success">
          {DRAFT_WORDS.safetyPassed}
        </Chip>
        {readOnly ? (
          <Chip icon={Minus} tone="gray" testID="draft-read-only">
            {DRAFT_WORDS.ownersDecide}
          </Chip>
        ) : null}
        {message && sms && d.mode !== 'editing' ? (
          <Text className="ml-auto text-xs text-text-3">
            {draftSegmentsLabel(message.body).split(' · ')[1]}
          </Text>
        ) : null}
      </View>
      {d.mode === 'rejecting' ? (
        <View className="gap-1.5">
          <Text className="text-[13.5px] font-medium">{rejectReasonLabel(name)}</Text>
          <Input
            value={d.reason}
            maxLength={1000}
            placeholder={DRAFT_WORDS.rejectPlaceholder}
            onChangeText={d.setReason}
            testID="draft-reject-reason"
          />
        </View>
      ) : null}
      {readOnly ? null : (
        <View className="border-t border-border pt-2.5">
          <DraftButtons d={d} />
        </View>
      )}
      {footer}
    </View>
  );
}
