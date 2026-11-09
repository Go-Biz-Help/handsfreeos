import { networkName } from '@hfos/core/addons/socialcontent/networks';
import type { Post, StandoutRef } from '@hfos/core/addons/socialcontent/shapes';
import { STANDOUT } from '@hfos/core/addons/socialcontent/standouts';
import {
  SOCIALCONTENT_WORDS as W,
  daysAgo,
  timesWords,
} from '@hfos/core/addons/socialcontent/words';
import * as React from 'react';
import { Pressable, View } from 'react-native';

import { ExternalLink, Eye, Sparkles } from '@/components/icons';
import { Badge } from '@/components/ui/badge';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';

import { openOutside } from './kit';

/**
 * One creator's post, as the web's (apps/web/src/addons/socialcontent/post-card.tsx): who posted it, where and when,
 * what kind it is, its caption, its numbers and how many times the posts around it it did. A standout says which it
 * beat them on, with the AI's notes on why and, for a video it watched, what it saw and heard. Standouts and a
 * creator's posts both draw it. Open post opens it on its network.
 */

const engagementOf = (p: Post) =>
  p.likes === null && p.comments === null ? null : (p.likes ?? 0) + (p.comments ?? 0);

export function PostCard({ post, showCreator = true }: { post: Post; showCreator?: boolean }) {
  const engagement = engagementOf(post);
  const line = (n: number | null, words: string, times: number | null, testID: string) =>
    n === null ? null : (
      <Text
        className={cn(
          'text-[13px] text-text-2',
          times !== null && times >= STANDOUT.times && 'font-semibold text-text',
        )}
        testID={testID}
      >
        {words}
        {times !== null ? ` · ${timesWords(times)}` : ''}
      </Text>
    );
  const facts = [
    showCreator ? (post.creatorName ?? post.creatorShown) : null,
    showCreator && post.creatorName ? post.creatorShown : null,
    networkName(post.network),
    W.kinds[post.kind],
    daysAgo(post.postedAt),
  ].filter(Boolean);
  return (
    <View
      className={cn(
        'gap-2 rounded-card border p-3.5',
        post.standout ? 'border-accent-soft bg-accent-soft/30' : 'border-border bg-card',
      )}
      testID={`socialcontent-post-${post.postKey}`}
    >
      <View className="flex-row flex-wrap items-center gap-x-2 gap-y-1">
        <Text className="text-[12.5px] text-text-3">{facts.join(' · ')}</Text>
        {post.standout && post.standoutOn ? (
          <Badge variant="accent">
            {W.creators.posts.standout} · {W.standouts.on[post.standoutOn]}
          </Badge>
        ) : post.waiting === 'too_new' ? (
          <Badge>{W.creators.posts.tooNew}</Badge>
        ) : post.waiting === 'too_few' ? (
          <Badge>{W.creators.posts.tooFew}</Badge>
        ) : null}
      </View>
      {post.caption ? (
        <Text className="text-[13.5px] leading-[19px]" numberOfLines={3}>
          {post.caption}
        </Text>
      ) : null}
      <View className="gap-0.5">
        {line(post.views, W.standouts.views(post.views ?? 0), post.viewsTimes, 'post-views')}
        {line(
          engagement,
          W.standouts.engagement(engagement ?? 0),
          post.engagementTimes,
          'post-engagement',
        )}
      </View>
      <OutsideLink
        words={W.standouts.open}
        onPress={() => openOutside(post.link)}
        testID="post-open"
      />
      {post.standout ? <Notes post={post} /> : null}
    </View>
  );
}

/** A small link that opens a page on its network. */
export function OutsideLink({
  words,
  onPress,
  testID,
}: {
  words: string;
  onPress: () => void;
  testID?: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={{ top: 10, bottom: 10, left: 4, right: 4 }}
      accessibilityRole="link"
      className="flex-row items-center gap-1 self-start"
      testID={testID}
    >
      <Text className="text-[13px] font-medium text-accent-text">{words}</Text>
      <Icon as={ExternalLink} className="size-3.5 text-accent-text" />
    </Pressable>
  );
}

function Facts({ items }: { items: readonly (readonly [string, string | null])[] }) {
  const shown = items.filter((i): i is readonly [string, string] => !!i[1]);
  if (!shown.length) return null;
  return (
    <View className="gap-1.5">
      {shown.map(([label, value]) => (
        <View key={label} className="gap-px">
          <Text className="text-[12.5px] text-text-3">{label}</Text>
          <Text className="text-[13px] leading-[18px]">{value}</Text>
        </View>
      ))}
    </View>
  );
}

function Techniques({ list }: { list: readonly string[] }) {
  if (!list.length) return null;
  return (
    <View className="gap-0.5">
      <Text className="text-[12.5px] text-text-3">{W.standouts.notes.techniques}</Text>
      {list.map((t) => (
        <Text key={t} className="text-[13px] leading-[18px]">
          • {t}
        </Text>
      ))}
    </View>
  );
}

/** The AI's notes on a standout, and what it saw and heard watching it. */
function Notes({ post }: { post: Post }) {
  const n = post.notes;
  const w = post.watched;
  return (
    <View
      className="gap-3 border-t border-accent-soft pt-3"
      testID={`socialcontent-notes-${post.postKey}`}
    >
      {n ? (
        <View className="gap-2">
          <View className="flex-row items-center gap-1.5">
            <Icon as={Sparkles} className="size-3.5 text-accent-text" />
            <Text className="text-[12.5px] font-semibold text-accent-text">
              {W.standouts.notes.why}
            </Text>
          </View>
          <Text className="text-[13.5px] leading-[19px]">{n.why}</Text>
          <Facts
            items={[
              [W.standouts.notes.hook, n.hook],
              [W.standouts.notes.format, n.format],
              [W.standouts.notes.topic, n.topic],
              [W.standouts.notes.useIt, n.useIt],
            ]}
          />
          <Techniques list={n.techniques} />
        </View>
      ) : (
        <Text className="text-[12.5px] text-text-3">{W.standouts.notes.waiting}</Text>
      )}
      {w ? (
        <View className="gap-2" testID={`socialcontent-watched-${post.postKey}`}>
          <View className="flex-row items-center gap-1.5">
            <Icon as={Eye} className="size-3.5 text-accent-text" />
            <Text className="text-[12.5px] font-semibold text-accent-text">
              {W.standouts.watched.title}
            </Text>
          </View>
          <Text className="text-[13.5px] leading-[19px]">{w.why}</Text>
          <Facts
            items={[
              [W.standouts.watched.hook, w.hook],
              [W.standouts.watched.seen, w.seen],
              [W.standouts.watched.heard, w.heard],
              [W.standouts.watched.pacing, w.pacing],
            ]}
          />
          <Techniques list={w.techniques} />
        </View>
      ) : post.watching ? (
        <Text className="text-[12.5px] text-text-3">{W.standouts.watched.watching}</Text>
      ) : null}
    </View>
  );
}

/** The standouts a Playbook item or an idea came from: each a small link to the post, by its creator and kind. */
export function StandoutLinks({
  label,
  ids,
  examples,
}: {
  label: string;
  ids: readonly string[];
  examples: ReadonlyMap<string, StandoutRef>;
}) {
  const shown = ids.flatMap((id) => {
    const e = examples.get(id);
    return e ? [e] : [];
  });
  if (!shown.length) return null;
  return (
    <View className="flex-row flex-wrap items-center gap-x-3 gap-y-1.5" testID="standout-links">
      <Text className="text-[12.5px] text-text-3">{label}</Text>
      {shown.map((e) => (
        <OutsideLink
          key={e.id}
          words={`${e.creatorShown} · ${W.kinds[e.kind]}`}
          onPress={() => openOutside(e.link)}
        />
      ))}
    </View>
  );
}
