'use client';
/**
 * The Results tab's **Posts liked and commented on** (docs/outreach.md, "Posts liked and commented on"): each post
 * liked or commented on in the stretch, the latest first, with whose it was, a link to it, what it said, and for what
 * the extension did on its own, the comment it posted and why the AI picked that post to like. What the person wrote
 * themselves is never kept, so their own comments show without the words.
 */
import {
  TOUCHED_POST_KINDS,
  TOUCHED_POSTS_WORDS as T,
  type ActivityPeriod,
  type TouchedPostsOutput,
} from '@hfos/core/addons/outreach/activity';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Segmented } from '@/components/ui/segmented';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { relativeTime } from '@/lib/utils';

type Kind = (typeof TOUCHED_POST_KINDS)[number];
type Posted = TouchedPostsOutput['posts'][number];

export function TouchedPostsCard({
  workspaceId,
  period,
  everyone,
}: {
  workspaceId: string;
  period: ActivityPeriod;
  everyone: boolean;
}) {
  const [kind, setKind] = useState<Kind>('all');
  const [posts, setPosts] = useState<readonly Posted[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(false);
  const load = useCallback(
    async (before: string | null) => {
      setLoading(true);
      try {
        const got = unwrap(
          await apiBrowser().POST('/v1/queries/outreach.activity.posts', {
            body: { workspaceId, period, everyone, kind, before },
          }),
        );
        setPosts((was) => (before && was ? [...was, ...got.posts] : got.posts));
        setNext(got.next);
        setFailed(false);
      } catch {
        setFailed(true);
      } finally {
        setLoading(false);
      }
    },
    [workspaceId, period, everyone, kind],
  );
  useEffect(() => {
    void load(null);
  }, [load]);

  return (
    <Card className="p-0" data-testid="activity-posts">
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 pt-4">
        <div>
          <h3 className="text-[15px] font-semibold">{T.title}</h3>
          <p className="text-[12.5px] text-text-3">{T.latestFirst(period)}</p>
        </div>
        <Segmented
          ariaLabel="Which posts"
          value={kind}
          onChange={setKind}
          options={TOUCHED_POST_KINDS.map((k) => ({
            value: k,
            label: T.kinds[k],
            testId: `activity-posts-${k}`,
          }))}
        />
      </div>
      {failed && !posts ? (
        <p className="px-5 pb-4 pt-2 text-[13px] text-text-2">{T.failed}</p>
      ) : !posts ? (
        <p className="px-5 pb-4 pt-2 text-[13px] text-text-3">Loading…</p>
      ) : posts.length === 0 ? (
        <p className="px-5 pb-4 pt-2 text-[13px] text-text-2">{T.none(kind, period)}</p>
      ) : (
        <ul className="mt-2">
          {posts.map((p) => (
            <PostRow key={p.touchId} workspaceId={workspaceId} post={p} />
          ))}
        </ul>
      )}
      {next ? (
        <div className="border-t border-border px-5 py-3">
          <Button variant="secondary" size="sm" disabled={loading} onClick={() => void load(next)}>
            {T.more}
          </Button>
        </div>
      ) : null}
    </Card>
  );
}

function PostRow({ workspaceId, post: p }: { workspaceId: string; post: Posted }) {
  return (
    <li className="border-t border-border px-5 py-3" data-testid="activity-post">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 text-[13.5px]">
          <Badge variant={p.kind === 'comment' ? 'accent' : 'gray'}>{T.kind(p)}</Badge>{' '}
          {p.personId ? (
            <Link
              href={`/app/w/${workspaceId}/customers/people/${p.personId}`}
              className="font-medium text-accent-text hover:underline"
            >
              {p.name}
            </Link>
          ) : (
            <span className="font-medium">{p.name}</span>
          )}
          {p.postUrl ? (
            <a
              href={p.postUrl}
              target="_blank"
              rel="noreferrer"
              className="ml-2 text-[12.5px] text-accent-text hover:underline"
            >
              {T.openPost}
            </a>
          ) : (
            <a
              href={p.profileUrl}
              target="_blank"
              rel="noreferrer"
              className="ml-2 text-[12.5px] text-text-3 hover:underline"
            >
              {T.openProfile}
            </a>
          )}
          <div className="text-[12.5px] text-text-3">{T.byLine(p)}</div>
        </div>
        <span className="text-[12.5px] text-text-3" title={new Date(p.at).toLocaleString()}>
          {relativeTime(p.at)}
        </span>
      </div>
      {p.postText ? (
        <p className="mt-1.5 line-clamp-3 whitespace-pre-line text-[13px] text-text-2">
          “{p.postText}”
        </p>
      ) : null}
      {p.why ? <p className="mt-1 text-[12.5px] text-text-3">{T.why(p.why)}</p> : null}
      {p.commentText ? (
        <div className="mt-2 rounded-control bg-card-2 px-3 py-2 text-[13px]">
          <span className="text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3">
            {T.commentHeading}
          </span>
          <p className="mt-0.5 whitespace-pre-line">{p.commentText}</p>
        </div>
      ) : p.kind === 'comment' && !p.auto ? (
        <p className="mt-1 text-[12.5px] text-text-3">{T.ownComment}</p>
      ) : null}
    </li>
  );
}
