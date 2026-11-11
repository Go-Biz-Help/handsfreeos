import { CONTENT_NETWORK_INFO, networkName } from '@hfos/core/addons/socialcontent/networks';
import type { Creator, Post } from '@hfos/core/addons/socialcontent/shapes';
import { SOCIALCONTENT_WORDS as W } from '@hfos/core/addons/socialcontent/words';
import * as React from 'react';
import { Pressable, ScrollView, View } from 'react-native';

import { Check, ChevronDown } from '@/components/icons';
import { List, ListRow } from '@/components/shell/list';
import { Screen } from '@/components/shell/screen';
import { Button } from '@/components/ui/button';
import { FilterChip } from '@/components/ui/filter-chip';
import { Icon } from '@/components/ui/icon';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { api, errorMessage, unwrap } from '@/lib/api';

import { NeedsSignal, Note, useSocialcontentAnswer, useSocialcontentContext } from './kit';
import { PostCard } from './post-card';

/**
 * Standouts on the phone, as on the web (docs/socialcontent.md, decisions 6 and 7): the studied creators' posts that
 * did at least 2 times the posts around them, on views or on likes plus comments, newest first, with the AI's notes on
 * why each worked. Kept to one network or one creator (`?network=`, `?creator=`, which a link may carry); **Show
 * more** reads the next page on from the last post shown. It needs signal.
 */

export const STANDOUTS_PAGE_SIZE = 30;

type Network = Creator['network'];

export interface StandoutsData {
  readonly posts: readonly Post[];
  readonly more: boolean;
  /** The creators studied, to keep the list to one. */
  readonly creators: readonly Creator[];
}

export function StandoutsScreen({
  network: firstNetwork,
  creator: firstCreator,
}: {
  network?: string;
  creator?: string;
}) {
  const ctx = useSocialcontentContext();
  const ws = ctx.workspaceId;
  const [network, setNetwork] = React.useState<Network | null>(
    firstNetwork && firstNetwork in CONTENT_NETWORK_INFO ? (firstNetwork as Network) : null,
  );
  const [creatorId, setCreatorId] = React.useState<string | null>(firstCreator || null);
  const filters = {
    ...(network ? { network } : {}),
    ...(creatorId ? { creatorId } : {}),
  };
  const answer = useSocialcontentAnswer<StandoutsData>(
    async () => {
      const [found, studied] = await Promise.all([
        api
          .POST('/v1/queries/socialcontent.post.list', {
            body: { workspaceId: ws, standoutsOnly: true, limit: STANDOUTS_PAGE_SIZE, ...filters },
          })
          .then(unwrap),
        api
          .POST('/v1/queries/socialcontent.creator.list', {
            body: { workspaceId: ws, state: 'studying' },
          })
          .then(unwrap),
      ]);
      return { posts: found.posts, more: found.more, creators: studied.creators };
    },
    `socialcontent-standouts:${ws}:${network ?? ''}:${creatorId ?? ''}`,
    W.standouts.title,
  );
  // Pages shown after the first, kept until the filters change or the list is asked for again.
  const [extra, setExtra] = React.useState<{ key: string; posts: readonly Post[]; more: boolean }>({
    key: '',
    posts: [],
    more: false,
  });
  const key = `${network ?? ''}:${creatorId ?? ''}:${answer.at ?? 0}`;
  const paged = extra.key === key ? extra : null;
  const posts = answer.data ? [...answer.data.posts, ...(paged?.posts ?? [])] : [];
  const more = paged ? paged.more : (answer.data?.more ?? false);
  const [loading, setLoading] = React.useState(false);
  const showMore = async () => {
    const last = posts[posts.length - 1];
    if (!last) return;
    setLoading(true);
    try {
      const got = unwrap(
        await api.POST('/v1/queries/socialcontent.post.list', {
          body: {
            workspaceId: ws,
            standoutsOnly: true,
            before: last.postedAt,
            limit: STANDOUTS_PAGE_SIZE,
            ...filters,
          },
        }),
      );
      const seen = new Set(posts.map((p) => p.id));
      setExtra({
        key,
        posts: [...(paged?.posts ?? []), ...got.posts.filter((p) => !seen.has(p.id))],
        more: got.more,
      });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setLoading(false);
    }
  };
  return (
    <StandoutsBody
      data={answer.data ? { posts, more, creators: answer.data.creators } : null}
      error={answer.error}
      online={ctx.online}
      network={network}
      creatorId={creatorId}
      loadingMore={loading}
      onRetry={answer.reload}
      onNetwork={(n) => {
        setNetwork(n);
        setCreatorId(null);
      }}
      onCreator={setCreatorId}
      onMore={() => void showMore()}
    />
  );
}

export function StandoutsBody({
  data,
  error,
  online,
  network,
  creatorId,
  loadingMore,
  onRetry,
  onNetwork,
  onCreator,
  onMore,
}: {
  data: StandoutsData | null;
  error: string | null;
  online: boolean;
  network: Network | null;
  creatorId: string | null;
  loadingMore: boolean;
  onRetry: () => void;
  onNetwork: (network: Network | null) => void;
  onCreator: (creatorId: string | null) => void;
  onMore: () => void;
}) {
  const [picking, setPicking] = React.useState(false);
  const creators = data?.creators ?? [];
  const networks = [...new Set(creators.map((c) => c.network))].filter(
    (n) => CONTENT_NETWORK_INFO[n],
  );
  const shownCreators = network ? creators.filter((c) => c.network === network) : creators;
  const picked = creators.find((c) => c.id === creatorId) ?? null;
  const nameOf = (c: Creator) => (c.name ? `${c.name} (${c.shown})` : c.shown);
  return (
    <Screen title={W.standouts.title} leading="back" testID="socialcontent-standouts">
      <Note>{W.standouts.intro}</Note>
      {data && creators.length ? (
        <View className="gap-2">
          {networks.length > 1 || network ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <View className="flex-row gap-2">
                <FilterChip
                  label={W.standouts.allNetworks}
                  on={network === null}
                  onPress={() => onNetwork(null)}
                  testID="socialcontent-standouts-network-all"
                />
                {networks.map((n) => (
                  <FilterChip
                    key={n}
                    label={networkName(n)}
                    on={network === n}
                    onPress={() => onNetwork(n)}
                    testID={`socialcontent-standouts-network-${n}`}
                  />
                ))}
              </View>
            </ScrollView>
          ) : null}
          <Pressable
            onPress={() => setPicking(true)}
            accessibilityRole="button"
            className="h-11 flex-row items-center gap-2 rounded-control border border-border-strong bg-card px-3"
            testID="socialcontent-standouts-creator"
          >
            <Text className="min-w-0 flex-1 text-[14px]" numberOfLines={1}>
              {picked ? nameOf(picked) : W.standouts.allCreators}
            </Text>
            <Icon as={ChevronDown} className="size-4 text-text-3" />
          </Pressable>
        </View>
      ) : null}
      {data ? (
        data.posts.length === 0 ? (
          <Note testID="socialcontent-standouts-none">{W.standouts.none}</Note>
        ) : (
          <>
            {data.posts.map((p) => (
              <PostCard key={p.id} post={p} />
            ))}
            {data.more ? (
              <Button
                variant="secondary"
                loading={loadingMore}
                disabled={!online}
                onPress={onMore}
                testID="socialcontent-standouts-more"
              >
                {W.standouts.more}
              </Button>
            ) : null}
          </>
        )
      ) : error ? (
        <NeedsSignal
          words={error}
          onRetry={onRetry}
          testID="socialcontent-standouts-needs-signal"
        />
      ) : null}
      <Sheet
        open={picking}
        onClose={() => setPicking(false)}
        title={W.phone.pickCreator}
        scroll
        testID="socialcontent-standouts-creators"
      >
        <View className="mt-3">
          <List>
            {[null, ...shownCreators].map((c) => (
              <ListRow
                key={c?.id ?? 'all'}
                label={c ? nameOf(c) : W.standouts.allCreators}
                detail={c ? networkName(c.network) : undefined}
                chevron={false}
                end={
                  (c?.id ?? null) === creatorId ? (
                    <Icon as={Check} className="size-5 text-accent" />
                  ) : undefined
                }
                onPress={() => {
                  onCreator(c?.id ?? null);
                  setPicking(false);
                }}
                testID={
                  c
                    ? `socialcontent-standouts-pick-${c.handle}`
                    : 'socialcontent-standouts-pick-all'
                }
              />
            ))}
          </List>
        </View>
      </Sheet>
    </Screen>
  );
}
