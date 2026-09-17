import * as React from 'react';
import { View } from 'react-native';

import { Check } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { usePhotoProgress } from '@/changes/hooks';
import { megabytes, type ChangeItem, type SentGroup } from '@/changes/list';
import { clockTime } from '@/lib/sync-status';

import {
  CHANGE_ICONS,
  ChangeTile,
  ProgressBar,
  StatePill,
  WhyBox,
  type PillTone,
} from './change-parts';

/**
 * One change on Changes on this phone: its icon, what it is, where it stands, why (held or refused), when it was made,
 * and what the person can do about it.
 */

function madeWords(item: ChangeItem): string {
  const at = clockTime(Date.parse(item.row.made_at));
  if (item.row.track === 'photo') return `Taken ${at}`;
  return item.words.icon === 'text' || item.words.icon === 'email' ? `Written ${at}` : `Made ${at}`;
}

function pillOf(item: ChangeItem): { tone: PillTone; words: string } {
  const { row } = item;
  if (row.state === 'refused') return { tone: 'refused', words: 'Refused' };
  if (item.ask === 'still-send') return { tone: 'ask', words: 'Still send?' };
  if (item.ask === 'quiet-hours') return { tone: 'quiet', words: 'Quiet hours' };
  if (item.ask === 'other') return { tone: 'ask', words: 'Needs you' };
  if (row.state === 'held') return { tone: 'held', words: 'Held' };
  if (row.state === 'sending')
    return { tone: 'sending', words: row.track === 'photo' ? 'Uploading' : 'Sending' };
  return { tone: 'wait', words: 'Waiting' };
}

/** "Not saved.", "Not sent.", "Not uploaded." */
function notDone(item: ChangeItem): string {
  if (item.row.track === 'photo') return 'Not uploaded.';
  return item.words.icon === 'text' || item.words.icon === 'email' ? 'Not sent.' : 'Not saved.';
}

export function ChangeRow({
  item,
  online,
  onDecide,
  onFix,
  onTryPhotoAgain,
  onDismiss,
  canFix,
}: {
  item: ChangeItem;
  online: boolean;
  onDecide: (item: ChangeItem) => void;
  onFix: (item: ChangeItem) => void;
  onTryPhotoAgain: (item: ChangeItem) => void;
  onDismiss: (item: ChangeItem) => void;
  canFix: boolean;
}) {
  const { row, words } = item;
  const pill = pillOf(item);
  const progress = usePhotoProgress(row.id);
  const photo = item.photo;
  const sent = progress?.sent ?? photo?.bytes_sent ?? 0;
  const total = progress?.total ?? photo?.size_bytes ?? 0;

  let when = madeWords(item);
  if (row.track === 'photo' && (row.state === 'waiting' || row.state === 'sending'))
    when = `${when} · ${online ? 'uploading on its own' : 'uploads when there’s signal'} · ${megabytes(sent, total)}`;
  else if (row.state === 'waiting' && item.ask === null && !online)
    when = `${when} · goes when there’s signal`;

  const action =
    row.state === 'refused' ? (
      row.track === 'photo' ? (
        <Button
          variant="secondary"
          size="sm"
          onPress={() => onTryPhotoAgain(item)}
          testID="change-try-again"
        >
          Try again
        </Button>
      ) : canFix ? (
        <Button variant="secondary" size="sm" onPress={() => onFix(item)} testID="change-fix">
          Fix and try again
        </Button>
      ) : (
        <Button
          variant="secondary"
          size="sm"
          onPress={() => onDismiss(item)}
          testID="change-dismiss"
        >
          Dismiss
        </Button>
      )
    ) : item.ask !== null ? (
      <Button size="sm" onPress={() => onDecide(item)} testID="change-decide">
        Decide
      </Button>
    ) : null;

  return (
    <View
      className="flex-row items-start gap-3 px-3.5 py-[13px]"
      testID={`change-${row.state}`}
      accessibilityLabel={`${words.title}. ${pill.words}.`}
    >
      <ChangeTile icon={CHANGE_ICONS[words.icon]} />
      <View className="min-w-0 flex-1 gap-0.5">
        <View className="flex-row items-start gap-2">
          <Text
            className="min-w-0 flex-1 text-[15px] font-semibold leading-[19.5px]"
            testID="change-title"
          >
            {words.title}
          </Text>
          <StatePill tone={pill.tone} testID="change-state">
            {pill.words}
          </StatePill>
        </View>
        {words.quote && item.ask !== null ? (
          <Text className="text-[13px] leading-[18px] text-text-2" numberOfLines={1}>
            “{words.quote}”
          </Text>
        ) : null}
        {row.state === 'refused' ? (
          <WhyBox tone="bad" testID="change-reason">
            {`${notDone(item)} ${row.reason ?? 'HandsFreeOS couldn’t do this.'}`}
          </WhyBox>
        ) : item.held ? (
          <WhyBox tone="hold" testID="change-reason">
            {item.held}
          </WhyBox>
        ) : item.ask === 'other' && row.reason ? (
          <WhyBox tone="plain" testID="change-reason">
            {row.reason}
          </WhyBox>
        ) : row.state === 'retry' && row.reason ? (
          <WhyBox tone="plain" testID="change-reason">
            {`${row.reason.replace(/\.?$/, '.')} It tries again on its own.`}
          </WhyBox>
        ) : null}
        {row.track === 'photo' && (row.state === 'waiting' || row.state === 'sending') ? (
          <ProgressBar fraction={total > 0 ? sent / total : 0} />
        ) : null}
        {action ? (
          <View className="mt-0.5 flex-row items-center justify-between gap-2">
            <Text className="text-xs text-text-3">{when}</Text>
            {action}
          </View>
        ) : (
          <Text className="mt-0.5 text-xs text-text-3" testID="change-when">
            {when}
          </Text>
        )}
      </View>
    </View>
  );
}

/** "3 changes for Maria Lopez · Number and email · a note · moved to Won", or one change and when it went. */
export function SentRow({ group }: { group: SentGroup }) {
  return (
    <View className="flex-row items-center gap-3 px-3.5 py-[13px]" testID="change-sent">
      <ChangeTile icon={Check} tone="sent" />
      <View className="min-w-0 flex-1 gap-0.5">
        <View className="flex-row items-center gap-2">
          <Text
            className="min-w-0 flex-1 text-[15px] font-semibold leading-[19.5px]"
            testID="sent-title"
          >
            {group.title}
          </Text>
          <StatePill tone="sent">Sent</StatePill>
        </View>
        <Text className="text-xs text-text-3" testID="sent-line">
          {group.count === 1 ? `Went through at ${clockTime(group.lastSentAt)}` : group.line}
        </Text>
      </View>
    </View>
  );
}
