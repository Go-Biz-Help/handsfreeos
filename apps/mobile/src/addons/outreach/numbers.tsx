import {
  bookStanding,
  percent,
  TRACKING_WORDS as T,
  yesStanding,
  type RateStanding,
  type TrackingNumbers,
  type TrackingOutput,
} from '@hfos/core/addons/outreach/tracking';
import * as React from 'react';
import { View } from 'react-native';

import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';

import { Note, Part } from './kit';

/**
 * The three numbers on the phone's Results (docs/outreach.md, decision 70; the boards in design/tracking), as the
 * web's tab leads with them (apps/web/src/addons/outreach/tracking-view.tsx): first messages sent, said yes and calls
 * booked against the person's targets, the two rates against the usual ones, their latest week's review, and the
 * numbers by playbook and by the offer's version. Every word and rule is core's.
 */

const KEYS = [
  'messages',
  'positive',
  'booked',
] as const satisfies readonly (keyof TrackingNumbers)[];
const STANDING_BADGE: Record<RateStanding, 'gray' | 'pending' | 'ok'> = {
  few: 'gray',
  below: 'pending',
  like: 'ok',
  above: 'ok',
};
/** "40 sent · 3 yes · 1 booked". */
const lineOf = (n: TrackingNumbers) =>
  `${n.messages.toLocaleString('en-US')} sent · ${n.positive.toLocaleString('en-US')} yes · ${n.booked.toLocaleString('en-US')} booked`;

export function NumbersPart({ tracking }: { tracking: TrackingOutput }) {
  const n = tracking.numbers;
  const target = tracking.target;
  const rates = [
    {
      key: 'yes',
      label: T.rates.yes,
      rate: tracking.rates.yes,
      of: [n.positive, n.messages, 'message'] as const,
      benchmark: T.benchmark.yes,
      standing: yesStanding(n),
    },
    {
      key: 'books',
      label: T.rates.books,
      rate: tracking.rates.books,
      of: [n.booked, n.positive, 'yes'] as const,
      benchmark: T.benchmark.books,
      standing: bookStanding(n),
    },
  ];
  return (
    <View className="gap-3" testID="results-numbers">
      <View className="gap-2">
        <View className="flex-row items-baseline justify-between gap-2 px-1">
          <Text className="text-[16px] font-semibold">
            {tracking.everyone ? T.titleTeam : T.title}
          </Text>
          {target ? <Note>{T.goal(target.goal)}</Note> : null}
        </View>
        <View className="flex-row gap-2">
          {KEYS.map((key) => {
            const goal = target ? target[key] : null;
            const pct = goal ? Math.min(100, Math.round((n[key] / goal) * 100)) : 0;
            const win = key === 'booked';
            return (
              <Card
                key={key}
                className={cn(
                  'flex-1 gap-1 px-3 py-3',
                  win && 'border-success-soft bg-success-soft',
                )}
                testID={`results-number-${key}`}
              >
                <Text className={cn('text-[12px]', win ? 'text-success-text' : 'text-text-2')}>
                  {T.numbers[key]}
                </Text>
                <Text className={cn('text-[24px] font-semibold', win && 'text-success-text')}>
                  {n[key].toLocaleString('en-US')}
                </Text>
                {goal !== null ? (
                  <>
                    <View className={cn('h-1 rounded-full', win ? 'bg-card' : 'bg-card-2')}>
                      <View
                        className={cn('h-1 rounded-full', win ? 'bg-success' : 'bg-accent')}
                        style={{ width: `${n[key] > 0 ? Math.max(4, pct) : 0}%` }}
                      />
                    </View>
                    <Text
                      className={cn('text-[12px]', win ? 'text-success-text' : 'text-text-3')}
                      testID={`results-target-${key}`}
                    >
                      {T.target(goal)}
                    </Text>
                  </>
                ) : null}
              </Card>
            );
          })}
        </View>
        {!tracking.everyone && !target ? <Note>{T.noGoal}</Note> : null}
      </View>
      <Card className="px-4 py-1" testID="results-rates">
        {rates.map((r, i) => (
          <View
            key={r.key}
            className={cn(
              'flex-row items-center justify-between gap-3 py-3',
              i > 0 && 'border-t border-border',
            )}
            testID={`results-rate-${r.key}`}
          >
            <View className="flex-1 gap-0.5">
              <Text className="text-[14px] font-semibold">
                {r.rate === null ? r.label : `${r.label}: ${percent(r.rate)}`}
              </Text>
              <Note>
                {r.rate === null
                  ? T.noRate
                  : `${T.countOf(r.of[0], r.of[1], r.of[2])} · ${r.benchmark}`}
              </Note>
            </View>
            <Badge variant={STANDING_BADGE[r.standing]}>{T.standing[r.standing]}</Badge>
          </View>
        ))}
      </Card>
      {tracking.everyone ? null : <ReviewPart review={tracking.review} />}
      <Breakdown
        title={T.byPlaybook}
        rows={tracking.byPlaybook.map((p) => ({
          key: p.playbookId ?? 'none',
          name: p.name ?? T.noPlaybook,
          n: p,
        }))}
        testID="results-playbooks"
      />
      <Breakdown
        title={T.byVersion}
        rows={tracking.byVersion.map((v) => ({
          key: String(v.version),
          name: T.version(v.version, v.live),
          n: v,
        }))}
        testID="results-versions"
      />
    </View>
  );
}

function ReviewPart({ review }: { review: TrackingOutput['review'] }) {
  const R = T.review;
  if (!review)
    return (
      <Card className="gap-1 px-4 py-3.5" testID="results-review-none">
        <Text className="text-[15px] font-semibold">{R.title}</Text>
        <Note>{R.none}</Note>
      </Card>
    );
  return (
    <Card className="gap-2 px-4 py-3.5" testID="results-review">
      <Text className="text-[11.5px] font-semibold uppercase tracking-[0.5px] text-text-3">
        {`${R.title} · ${R.week(review.week)}`}
      </Text>
      <Text className="text-[16px] font-semibold" testID="results-review-headline">
        {review.headline}
      </Text>
      <Text className="text-[14px] leading-[20px]">{review.why}</Text>
      <View className="gap-1.5">
        {review.steps.map((s, i) => (
          <View key={i} className="flex-row gap-2">
            <Text className="w-4 text-[14px] text-text-2">{`${i + 1}.`}</Text>
            <Text className="flex-1 text-[14px] leading-[20px]">{s}</Text>
          </View>
        ))}
      </View>
      <Note>{R.by[review.by]}</Note>
    </Card>
  );
}

function Breakdown({
  title,
  rows,
  testID,
}: {
  title: string;
  rows: readonly { key: string; name: string; n: TrackingNumbers }[];
  testID: string;
}) {
  if (!rows.length) return null;
  return (
    <Part title={title} testID={testID}>
      <Card className="px-4 py-1">
        {rows.map((r, i) => (
          <View
            key={r.key}
            className={cn(
              'flex-row items-center justify-between gap-3 py-3',
              i > 0 && 'border-t border-border',
            )}
          >
            <Text className="flex-1 text-[14px]" numberOfLines={1}>
              {r.name}
            </Text>
            <Note>{lineOf(r.n)}</Note>
          </View>
        ))}
      </Card>
    </Part>
  );
}
