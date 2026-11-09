import type { Overview, Work } from '@hfos/core/addons/socialcontent/shapes';
import {
  READER_THERE_MS,
  SOCIALCONTENT_WORDS as W,
  momentAgo,
  progressFacts,
} from '@hfos/core/addons/socialcontent/words';
import * as React from 'react';
import { ActivityIndicator, View } from 'react-native';

import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';

import { Group, Note, Part, workWhat } from './kit';

/**
 * What it's doing, on top of Creators as on the web (docs/socialcontent.md, "What it's doing"): whether the reading
 * computer is there (when it last asked for work, and its extension's version), what it's doing now, how much more
 * waits, and what it did lately, each with what it found or why it didn't work. Creators asks again every half
 * minute while it's open.
 */

/** What a piece of work did, or is doing, as short facts. */
export function WorkFacts({ work }: { work: Work }) {
  const facts = progressFacts(work.progress);
  if (!facts.length) return null;
  return (
    <View className="flex-row flex-wrap gap-1.5" testID={`socialcontent-facts-${work.id}`}>
      {facts.map((f) => (
        <View key={f} className="rounded-full bg-card-2 px-2 py-0.5">
          <Text className="text-[12px] text-text-2">{f}</Text>
        </View>
      ))}
    </View>
  );
}

export function ActivityCard({ overview, now }: { overview: Overview; now: number }) {
  const { settings, work } = overview;
  if (!settings.readerUserId) return null;
  const name = settings.readerName ?? 'The reading';
  const seen = settings.readerSeenAt;
  const there = seen !== null && now - new Date(seen).getTime() < READER_THERE_MS;
  const taken = work.filter((w) => w.state === 'taken');
  const waiting = Math.max(0, overview.counts.waiting - taken.length);
  const lately = work
    .filter((w) => w.state === 'done' || w.state === 'failed')
    .sort((a, b) => (b.finishedAt ?? '').localeCompare(a.finishedAt ?? ''))
    .slice(0, 3);
  return (
    <Part title={W.activity.title} testID="socialcontent-activity">
      <Text
        className={cn('text-[13px] leading-[18px]', there ? 'text-text-2' : 'text-warning-text')}
        testID="socialcontent-reader"
      >
        {seen === null
          ? W.activity.readerNever(name)
          : there
            ? W.activity.reader(name, momentAgo(seen, now) ?? '', settings.readerVersion)
            : W.activity.readerQuiet(name, momentAgo(seen, now) ?? '')}
      </Text>
      {taken.length === 0 && waiting === 0 && lately.length === 0 ? (
        <Note>{W.activity.nothing}</Note>
      ) : null}
      {taken.length ? (
        <View className="gap-2">
          <Group>{W.activity.now}</Group>
          {taken.map((w) => (
            <View key={w.id} className="gap-1" testID={`socialcontent-now-${w.id}`}>
              <View className="flex-row items-center gap-2">
                <ActivityIndicator size="small" />
                <Text className="min-w-0 flex-1 text-[13.5px]">{workWhat(w)}</Text>
              </View>
              <Text className="text-[12.5px] text-text-2">
                {w.progress?.now ?? W.activity.starting}
              </Text>
              <WorkFacts work={w} />
            </View>
          ))}
        </View>
      ) : null}
      {waiting ? (
        <Text className="text-[12.5px] text-text-3">{W.activity.waiting(waiting)}</Text>
      ) : null}
      {lately.length ? (
        <View className="gap-2">
          <Group>{W.activity.lately}</Group>
          {lately.map((w) => (
            <View key={w.id} className="gap-1" testID={`socialcontent-lately-${w.id}`}>
              <Text className="text-[13.5px]">{workWhat(w)}</Text>
              <Text className="text-[12.5px] text-text-3">
                {[W.work.states[w.state], momentAgo(w.finishedAt, now)].filter(Boolean).join(' · ')}
              </Text>
              <WorkFacts work={w} />
              {w.state === 'failed' && w.failure ? (
                <Text className="text-[12.5px] text-danger-text">{w.failure}</Text>
              ) : null}
            </View>
          ))}
          <Text className="text-[12px] text-text-3">{W.activity.all}</Text>
        </View>
      ) : null}
    </Part>
  );
}
