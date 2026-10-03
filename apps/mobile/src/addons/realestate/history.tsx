import { localDateOf } from '@hfos/core';
import { dealHistoryWords } from '@hfos/core/addons/realestate/history-words';
import { RE_PHONE_WORDS } from '@hfos/core/addons/realestate/phone-words';
import { RE_HISTORY_WORDS } from '@hfos/core/addons/realestate/phone-words-deals';
import { holdsWhole } from '@hfos/core/addons/realestate/views/deal-facts';
import { historyOfCopy, type HistoryLine } from '@hfos/core/addons/realestate/views/history';
import * as React from 'react';
import { Pressable, View } from 'react-native';

import { Bot, CalendarClock, Check, UserRound } from '@/components/icons';
import { Screen } from '@/components/shell/screen';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { api, unwrap } from '@/lib/api';
import { cn } from '@/lib/utils';

import { useRealestateCopy } from './copy';
import { dayOf, KeptStrip } from './deal-bits';
import { NeedsSignalCard, SummaryChip, useLiveAnswer, useReContext } from './kit';

/**
 * What happened on a deal (board 81): who did what and when, people, HandsFreeOS, the AI and the client, newest first,
 * from the phone's copy. Every line is kept. A deal kept as its summary has its history with signal.
 */

const PAGE = 50;

export function HistoryScreen({ dealId }: { dealId: string }) {
  const ctx = useReContext();
  const copy = useRealestateCopy(ctx.workspaceId, { kind: 'deal', dealId });
  const [limit, setLimit] = React.useState(PAGE);
  const whole = holdsWhole(copy, dealId, ctx.userId);
  const lines = React.useMemo(() => historyOfCopy(copy, dealId, { limit }), [copy, dealId, limit]);
  const live = useLiveAnswer<readonly HistoryLine[]>(
    whole || !copy.deals.has(dealId)
      ? null
      : () =>
          api
            .POST('/v1/queries/realestate.deal.history', {
              body: { workspaceId: ctx.workspaceId, dealId, limit },
            })
            .then((r) => unwrap(r).lines as readonly HistoryLine[]),
    `history:${dealId}:${limit}`,
    RE_HISTORY_WORDS.summary,
  );
  return (
    <HistoryView
      dealName={copy.deals.get(dealId)?.name ?? ''}
      held={copy.deals.has(dealId)}
      whole={whole}
      lines={whole ? lines : (live.data ?? [])}
      summaryState={whole ? null : { loading: live.loading, error: live.error, retry: live.reload }}
      more={(whole ? lines : (live.data ?? [])).length >= limit}
      onMore={() => setLimit(limit + PAGE)}
      timeZone={ctx.timeZone}
      now={ctx.now}
    />
  );
}

export function HistoryView({
  dealName,
  held,
  whole,
  lines,
  summaryState,
  more,
  onMore,
  timeZone,
  now,
}: {
  dealName: string;
  held: boolean;
  whole: boolean;
  lines: readonly HistoryLine[];
  summaryState: { loading: boolean; error: string | null; retry: () => void } | null;
  more: boolean;
  onMore: () => void;
  timeZone: string;
  now: number;
}) {
  return (
    <Screen
      title={RE_HISTORY_WORDS.title}
      subtitle={dealName || undefined}
      leading="back"
      testID="re-history"
      header={<KeptStrip inset />}
    >
      {!held ? (
        <NeedsSignalCard words={RE_PHONE_WORDS.notOnPhone} />
      ) : !whole && summaryState && lines.length === 0 ? (
        summaryState.loading ? null : (
          <NeedsSignalCard
            words={summaryState.error ?? RE_HISTORY_WORDS.summary}
            onRetry={summaryState.retry}
            testID="re-history-summary"
          />
        )
      ) : lines.length === 0 ? (
        <Card className="px-5 py-8">
          <Text className="text-center text-[14px] text-text-2">{RE_HISTORY_WORDS.empty}</Text>
        </Card>
      ) : (
        <>
          {!whole ? <SummaryChip /> : null}
          <View className="gap-3.5 px-1 pt-1" testID="re-history-lines">
            {lines.map((l, i) => {
              const words = dealHistoryWords(l.what, l.before, l.after);
              const who =
                l.actorType === 'person'
                  ? (l.actor?.name ?? null)
                  : l.actorType === 'ai'
                    ? RE_HISTORY_WORDS.ai
                    : l.actorType === 'client'
                      ? RE_HISTORY_WORDS.client
                      : RE_HISTORY_WORDS.handsfree;
              const icon =
                l.actorType === 'ai'
                  ? Bot
                  : l.actorType === 'client'
                    ? UserRound
                    : l.actorType === 'system'
                      ? CalendarClock
                      : Check;
              return (
                <View key={`${l.at}-${i}`} className="flex-row gap-3" testID="re-history-line">
                  <View
                    className={cn(
                      'mt-0.5 size-6 items-center justify-center rounded-full',
                      l.actorType === 'ai'
                        ? 'bg-accent-soft'
                        : l.actorType === 'system'
                          ? 'bg-warning-soft'
                          : 'bg-success-soft',
                    )}
                  >
                    <Icon
                      as={icon}
                      className={cn(
                        'size-3.5',
                        l.actorType === 'ai'
                          ? 'text-accent-text'
                          : l.actorType === 'system'
                            ? 'text-warning-text'
                            : 'text-success-text',
                      )}
                    />
                  </View>
                  <View className="flex-1 gap-0.5">
                    <Text className="text-[14.5px] leading-[20px]">
                      {words}
                      {who ? (
                        <Text className="text-[14.5px] text-text-2">{` ${RE_HISTORY_WORDS.by(who)}`}</Text>
                      ) : null}
                    </Text>
                    <Text className="text-[12.5px] text-text-3">
                      {[dayOf(localDateOf(Date.parse(l.at), timeZone), timeZone, now), l.note]
                        .filter(Boolean)
                        .join(' · ')}
                    </Text>
                  </View>
                </View>
              );
            })}
          </View>
          {more ? (
            <Pressable
              role="button"
              onPress={onMore}
              className="px-1 py-2"
              testID="re-history-more"
            >
              <Text className="text-[14px] text-accent-text">{RE_HISTORY_WORDS.more}</Text>
            </Pressable>
          ) : null}
        </>
      )}
    </Screen>
  );
}
