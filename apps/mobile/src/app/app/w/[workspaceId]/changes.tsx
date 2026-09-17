import * as React from 'react';
import { View } from 'react-native';

import {
  AskSheet,
  DiscardSheet,
  QuietHoursSheet,
  StillSendSheet,
  type Decided,
} from '@/components/changes/decide-sheets';
import { ChangeRow, SentRow } from '@/components/changes/change-row';
import { CloudCheck, CloudOff, TriangleAlert } from '@/components/icons';
import { List, ListLabel } from '@/components/shell/list';
import { Screen } from '@/components/shell/screen';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { changes } from '@/changes';
import { describe, loadNames } from '@/changes/describe';
import { fixerFor } from '@/changes/fixers';
import { useChangeList, useChanges } from '@/changes/hooks';
import type { ChangeItem } from '@/changes/list';
import type { OutboxRow } from '@/changes/outbox';
import { TOO_OLD_WORDS } from '@/changes/version-gate';
import { changesWord, clockTime, useSyncStatus } from '@/lib/sync-status';

/**
 * Changes on this phone, opened from the strip under the top bar and from More: what needs the person (a question to
 * answer, a refusal to fix), what waits (held behind another change, a photo uploading on its own, set aside to try
 * again), and what went just now. Nothing jams: a refused change holds only what depends on it.
 */
export default function Changes() {
  const status = useSyncStatus();
  const snapshot = useChanges();
  const list = useChangeList();
  const [deciding, setDeciding] = React.useState<{
    kind: 'still-send' | 'quiet-hours' | 'other';
    decided: Decided;
  } | null>(null);
  const [discarding, setDiscarding] = React.useState<{
    decided: Decided;
    dependants: ReturnType<typeof describe>[];
  } | null>(null);

  const unsent = list.unsent;
  const sentSinceBack =
    snapshot.backOnlineAt === null
      ? 0
      : list.sent.reduce((n, g) => n + (g.lastSentAt >= snapshot.backOnlineAt! ? g.count : 0), 0);
  const one = unsent === 1;
  const [title, line] =
    unsent === 0
      ? ['Up to date', 'Every change made on this phone has reached HandsFreeOS.']
      : [
          `${changesWord(unsent)} waiting to send`,
          snapshot.tooOld
            ? `Nothing is lost: ${one ? 'it goes' : 'they go'} once HandsFreeOS is updated.`
            : status.connection === 'offline'
              ? `No signal: ${one ? 'it goes' : 'they go'} on ${one ? 'its' : 'their'} own when the phone is back online.`
              : status.connection === 'unreachable'
                ? `HandsFreeOS can’t be reached right now: ${one ? 'it goes' : 'they go'} on ${one ? 'its' : 'their'} own once it can.`
                : snapshot.backOnlineAt !== null && sentSinceBack > 0
                  ? `Signal came back at ${clockTime(snapshot.backOnlineAt)} and ${sentSinceBack} went through.`
                  : list.waiting.length === 0
                    ? one
                      ? 'It needs you before it can go.'
                      : 'They need you before they can go.'
                    : one
                      ? 'It’s on its way.'
                      : 'They’re on their way.',
        ];

  const fixerOf = (row: OutboxRow) => fixerFor(row.name);
  const decide = (item: ChangeItem) => {
    if (!item.ask) return;
    setDeciding({ kind: item.ask, decided: { row: item.row, words: item.words } });
  };

  /** Discards a change; one that others wait for asks about them first. */
  const discard = async (decided: Decided) => {
    const dependants = await changes.dependantsOf(decided.row.id);
    setDeciding(null);
    if (dependants.length === 0) {
      await changes.discard([decided.row.id]);
      toast.show('Discarded. Nothing was sent.');
      return;
    }
    const db = changes.open?.db;
    const names = db ? await loadNames(db, dependants) : null;
    // One sheet at a time: the question closes before this one opens.
    setTimeout(
      () =>
        setDiscarding({
          decided,
          dependants: names ? dependants.map((d) => describe(d, names)) : [],
        }),
      300,
    );
  };

  const sheetOf = (kind: 'still-send' | 'quiet-hours' | 'other') =>
    deciding?.kind === kind ? deciding.decided : null;
  const close = () => setDeciding(null);
  const edit = deciding ? fixerOf(deciding.decided.row) : null;

  return (
    <Screen title="Changes on this phone" leading="close" testID="changes">
      <View className="gap-[3px] px-1 pb-0.5 pt-1.5">
        <View className="flex-row items-center gap-2">
          {unsent === 0 ? <Icon as={CloudCheck} className="size-6 text-success-text" /> : null}
          <Text
            className="text-2xl font-semibold leading-[29px] tracking-[-0.36px]"
            testID="changes-title"
          >
            {title}
          </Text>
        </View>
        <Text className="text-[13.5px] leading-[19px] text-text-2" testID="changes-line">
          {line}
        </Text>
      </View>

      {snapshot.tooOld ? (
        <View
          className="flex-row items-start gap-2.5 rounded-menu bg-danger-soft px-3 py-[11px]"
          testID="changes-too-old"
        >
          <Icon as={TriangleAlert} className="mt-px size-[17px] text-danger-text" />
          <Text className="flex-1 text-[13.5px] leading-5 text-danger-text">{TOO_OLD_WORDS}</Text>
        </View>
      ) : null}

      {list.needsYou.length > 0 ? (
        <>
          <ListLabel>{`Needs you · ${list.needsYou.length}`}</ListLabel>
          <List testID="changes-needs-you">
            {list.needsYou.map((item) => (
              <ChangeRow
                key={item.row.id}
                item={item}
                online={status.online}
                canFix={fixerOf(item.row) !== null}
                onDecide={decide}
                onFix={(i) => fixerOf(i.row)?.(i.row)}
                onTryPhotoAgain={(i) =>
                  void changes.tryPhotoAgain(i.row.id).catch((e: unknown) => toast.error(String(e)))
                }
                onDismiss={(i) => void discard({ row: i.row, words: i.words })}
              />
            ))}
          </List>
        </>
      ) : null}

      {list.waiting.length > 0 ? (
        <>
          <ListLabel>{`Waiting · ${list.waiting.length}`}</ListLabel>
          <List testID="changes-waiting">
            {list.waiting.map((item) => (
              <ChangeRow
                key={item.row.id}
                item={item}
                online={status.online}
                canFix={false}
                onDecide={decide}
                onFix={() => undefined}
                onTryPhotoAgain={() => undefined}
                onDismiss={() => undefined}
              />
            ))}
          </List>
        </>
      ) : null}

      {list.sent.length > 0 ? (
        <>
          <ListLabel>{`Sent just now · ${list.sent.reduce((n, g) => n + g.count, 0)}`}</ListLabel>
          <List testID="changes-sent">
            {list.sent.map((group) => (
              <SentRow key={group.key} group={group} />
            ))}
          </List>
        </>
      ) : null}

      {unsent === 0 && list.sent.length === 0 && !list.loading ? (
        <View className="flex-row items-center gap-2 rounded-menu bg-card-2 px-3 py-[11px]">
          <Icon as={status.online ? CloudCheck : CloudOff} className="size-[17px] text-text-3" />
          <Text className="flex-1 text-[13.5px] leading-5 text-text-2">
            Anything you change waits on this phone until it reaches HandsFreeOS, and shows here.
          </Text>
        </View>
      ) : null}

      <StillSendSheet
        decided={sheetOf('still-send')}
        onClose={close}
        onEdit={edit}
        onDiscard={(d) => void discard(d)}
      />
      <QuietHoursSheet decided={sheetOf('quiet-hours')} onClose={close} onEdit={edit} />
      <AskSheet
        decided={sheetOf('other')}
        onClose={close}
        onEdit={edit}
        onDiscard={(d) => void discard(d)}
      />
      <DiscardSheet
        decided={discarding?.decided ?? null}
        dependants={discarding?.dependants ?? []}
        onClose={() => setDiscarding(null)}
        onDiscarded={() => toast.show('Discarded. Nothing was sent.')}
      />
    </Screen>
  );
}
