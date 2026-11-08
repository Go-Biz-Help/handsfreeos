'use client';
/**
 * Standouts (docs/socialcontent.md, decisions 6 and 7): the studied creators' posts that did at least 2 times the
 * median of the 10 posts on each side of them, on views or on likes plus comments, newest first. Kept to one network
 * or one creator with `?network=` and `?creator=`; **Show more** reads the next page on from the last post shown.
 */
import { CONTENT_NETWORK_INFO, networkName } from '@hfos/core/addons/socialcontent/networks';
import { SOCIALCONTENT_WORDS as W } from '@hfos/core/addons/socialcontent/words';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/shell/page-header';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Select } from '@/components/ui/input';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import { useLiveRefresh } from '@/lib/realtime/live-provider';
import { PostCard } from './post-card';
import type { Creator, Post } from './types';

export const STANDOUTS_PAGE_SIZE = 30;

export function StandoutsPage({
  workspaceId,
  posts: first,
  more: firstMore,
  creators,
  network,
  creatorId,
}: {
  workspaceId: string;
  posts: readonly Post[];
  more: boolean;
  /** The creators studied, to keep the list to one. */
  creators: readonly Creator[];
  network: Creator['network'] | null;
  creatorId: string | null;
}) {
  useLiveRefresh(['socialcontent_creator']);
  const router = useRouter();
  const pathname = usePathname();
  const [loading, setLoading] = useState(false);
  const [posts, setPosts] = useState<readonly Post[]>(first);
  const [more, setMore] = useState(firstMore);
  const paged = useRef(false);
  // New posts read while the page is open show at the top, unless someone has shown more: then their place is kept.
  // A filter changing draws the page afresh (the route keys it by the filters).
  useEffect(() => {
    if (paged.current) return;
    setPosts(first);
    setMore(firstMore);
  }, [first, firstMore]);

  const go = (next: { network?: string | null; creator?: string | null }) => {
    const sp = new URLSearchParams();
    const n = next.network === undefined ? network : next.network;
    const c = next.creator === undefined ? creatorId : next.creator;
    if (n) sp.set('network', n);
    if (c) sp.set('creator', c);
    const q = sp.toString();
    router.push(q ? `${pathname}?${q}` : pathname);
  };
  const showMore = async () => {
    const last = posts[posts.length - 1];
    if (!last) return;
    // Not through useAct: drawing the page again would put the list back to its first page.
    setLoading(true);
    try {
      const got = await apiBrowser()
        .POST('/v1/queries/socialcontent.post.list', {
          body: {
            workspaceId,
            standoutsOnly: true,
            before: last.postedAt,
            limit: STANDOUTS_PAGE_SIZE,
            ...(network ? { network } : {}),
            ...(creatorId ? { creatorId } : {}),
          },
        })
        .then(unwrap);
      const seen = new Set(posts.map((p) => p.id));
      paged.current = true;
      setPosts([...posts, ...got.posts.filter((p) => !seen.has(p.id))]);
      setMore(got.more);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  const networks = [...new Set(creators.map((c) => c.network))];
  const shownCreators = network ? creators.filter((c) => c.network === network) : creators;

  return (
    <div data-testid="socialcontent-standouts" className="space-y-5">
      <PageHeader title={W.standouts.title} description={W.standouts.intro} />
      {creators.length ? (
        <div className="flex flex-wrap gap-2">
          {networks.length > 1 || network ? (
            <Select
              selectSize="sm"
              className="w-auto min-w-[160px]"
              value={network ?? ''}
              aria-label={W.standouts.allNetworks}
              onChange={(e) => go({ network: e.target.value || null, creator: null })}
              data-testid="socialcontent-standouts-network"
            >
              <option value="">{W.standouts.allNetworks}</option>
              {networks
                .filter((n) => CONTENT_NETWORK_INFO[n])
                .map((n) => (
                  <option key={n} value={n}>
                    {networkName(n)}
                  </option>
                ))}
            </Select>
          ) : null}
          <Select
            selectSize="sm"
            className="w-auto min-w-[200px]"
            value={creatorId ?? ''}
            aria-label={W.standouts.allCreators}
            onChange={(e) => go({ creator: e.target.value || null })}
            data-testid="socialcontent-standouts-creator"
          >
            <option value="">{W.standouts.allCreators}</option>
            {shownCreators.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name ? `${c.name} (${c.shown})` : c.shown}
              </option>
            ))}
          </Select>
        </div>
      ) : null}
      {posts.length === 0 ? (
        <Card>
          <EmptyState title={W.standouts.title} className="py-10">
            {W.standouts.none}
          </EmptyState>
        </Card>
      ) : (
        <div className="space-y-3">
          {posts.map((p) => (
            <PostCard key={p.id} post={p} />
          ))}
          {more ? (
            <div className="flex justify-center pt-1">
              <Button
                variant="secondary"
                loading={loading}
                onClick={() => void showMore()}
                data-testid="socialcontent-standouts-more"
              >
                {W.standouts.more}
              </Button>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
