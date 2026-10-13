import {
  TOUCHED_POST_KINDS,
  TOUCHED_POSTS_WORDS as T,
  type ActivityPeriod,
  type TouchedPostsOutput,
} from '@hfos/core/addons/outreach/activity';
import { OUTREACH_WORDS as W } from '@hfos/core/addons/outreach/words';
import { ExternalLink } from '@/components/icons';
import * as React from 'react';
import { View } from 'react-native';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Segmented } from '@/components/ui/segmented';
import { Text } from '@/components/ui/text';
import { api, unwrap } from '@/lib/api';
import { cn } from '@/lib/utils';

import { NeedsSignal, Note, openOutside, Part, useOutreachAnswer } from './kit';

/**
 * Results' **Posts liked and commented on** on the phone, as the web's (docs/outreach.md): each post the person liked
 * or commented on in the stretch, the latest first, with whose it was, what it said, the comment the extension posted
 * on its own and why it picked a post to like; a tap opens the post on Facebook. The person's own; the team's is on
 * the web. It needs signal.
 */

type Kind = (typeof TOUCHED_POST_KINDS)[number];
type Posted = TouchedPostsOutput['posts'][number];

export function TouchedPostsPart({
  workspaceId,
  period,
}: {
  workspaceId: string;
  period: ActivityPeriod;
}) {
  const [kind, setKind] = React.useState<Kind>('all');
  const ask = React.useCallback(
    async (before: string | null) =>
      unwrap(
        await api.POST('/v1/queries/outreach.activity.posts', {
          body: { workspaceId, period, kind, before },
        }),
      ),
    [workspaceId, period, kind],
  );
  const first = useOutreachAnswer(
    () => ask(null),
    `posted:${workspaceId}:${period}:${kind}`,
    T.title,
  );
  // Show more adds the next pages under the first; a new stretch or kind starts again.
  const [more, setMore] = React.useState<{ posts: readonly Posted[]; next: string | null } | null>(
    null,
  );
  const [loading, setLoading] = React.useState(false);
  React.useEffect(() => setMore(null), [first.data]);
  const showMore = async () => {
    const next = more?.next ?? first.data?.next;
    if (!next) return;
    setLoading(true);
    try {
      const got = await ask(next);
      setMore((was) => ({ posts: [...(was?.posts ?? []), ...got.posts], next: got.next }));
    } catch {
      setMore((was) => was ?? { posts: [], next });
    } finally {
      setLoading(false);
    }
  };
  return (
    <TouchedPostsList
      period={period}
      kind={kind}
      onKind={setKind}
      posts={first.data ? [...first.data.posts, ...(more?.posts ?? [])] : null}
      next={more ? more.next : (first.data?.next ?? null)}
      error={first.error}
      loading={loading}
      onMore={() => void showMore()}
      onRetry={first.reload}
    />
  );
}

export function TouchedPostsList({
  period,
  kind,
  onKind,
  posts,
  next,
  error,
  loading,
  onMore,
  onRetry,
}: {
  period: ActivityPeriod;
  kind: Kind;
  onKind: (kind: Kind) => void;
  posts: readonly Posted[] | null;
  next: string | null;
  error: string | null;
  loading: boolean;
  onMore: () => void;
  onRetry: () => void;
}) {
  return (
    <Part title={T.title} about={T.latestFirst(period)} testID="results-posts">
      <Segmented
        label={T.title}
        value={kind}
        onChange={onKind}
        options={TOUCHED_POST_KINDS.map((k) => ({
          value: k,
          label: T.kinds[k],
          testID: `results-posts-${k}`,
        }))}
      />
      {!posts ? (
        error ? (
          <NeedsSignal words={error} onRetry={onRetry} testID="results-posts-needs-signal" />
        ) : null
      ) : posts.length === 0 ? (
        <Card className="px-4 py-3.5">
          <Note testID="results-posts-none">{T.none(kind, period)}</Note>
        </Card>
      ) : (
        <Card className="px-4 py-1">
          {posts.map((p, i) => (
            <PostedRow key={p.touchId} post={p} first={i === 0} />
          ))}
        </Card>
      )}
      {posts && next ? (
        <Button
          variant="secondary"
          size="md"
          loading={loading}
          onPress={onMore}
          testID="results-posts-more"
        >
          {T.more}
        </Button>
      ) : null}
    </Part>
  );
}

function PostedRow({ post: p, first }: { post: Posted; first: boolean }) {
  return (
    <View className={cn('gap-1.5 py-3', !first && 'border-t border-border')} testID="results-post">
      <View className="flex-row items-center gap-2">
        <Badge variant={p.kind === 'comment' ? 'accent' : 'gray'}>{T.kind(p)}</Badge>
        <Text className="flex-1 text-[15px] font-medium" numberOfLines={1}>
          {p.name}
        </Text>
        <Text className="text-[12.5px] text-text-3">{T.when(p.at)}</Text>
      </View>
      <Text className="text-[12.5px] text-text-3">{T.byLine(p)}</Text>
      {p.postText ? (
        <Text className="text-[14px] leading-[20px] text-text-2" numberOfLines={4}>
          “{p.postText}”
        </Text>
      ) : null}
      {p.why ? <Note>{T.why(p.why)}</Note> : null}
      {p.commentText ? (
        <View className="gap-0.5 rounded-control bg-card-2 px-3 py-2" testID="results-post-comment">
          <Text className="text-[11.5px] font-semibold uppercase text-text-3">
            {T.commentHeading}
          </Text>
          <Text className="text-[14px] leading-[20px]">{p.commentText}</Text>
        </View>
      ) : p.kind === 'comment' && !p.auto ? (
        <Note>{T.ownComment}</Note>
      ) : null}
      <Button
        size="md"
        variant="ghost"
        icon={ExternalLink}
        className="self-start"
        onPress={() => openOutside(p.postUrl ?? p.profileUrl)}
      >
        {p.postUrl ? T.openPost : W.openOnFacebook}
      </Button>
    </View>
  );
}
