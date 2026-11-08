'use client';
/**
 * One creator's post (docs/socialcontent.md): who posted it, where and when, what kind it is, its caption, its numbers,
 * and how many times the posts around it it did, on views and on likes plus comments. Standouts say which they beat
 * them on. The Standouts page and a creator's posts under Creators both draw it.
 */
import { networkName } from '@hfos/core/addons/socialcontent/networks';
import { STANDOUT } from '@hfos/core/addons/socialcontent/standouts';
import {
  SOCIALCONTENT_WORDS as W,
  daysAgo,
  timesWords,
} from '@hfos/core/addons/socialcontent/words';
import { ExternalLink } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { Post } from './types';

const engagementOf = (p: Post) =>
  p.likes === null && p.comments === null ? null : (p.likes ?? 0) + (p.comments ?? 0);

export function PostCard({ post, showCreator = true }: { post: Post; showCreator?: boolean }) {
  const engagement = engagementOf(post);
  const line = (n: number | null, words: string, times: number | null) =>
    n === null ? null : (
      <span className={cn(times !== null && times >= STANDOUT.times && 'font-semibold text-text')}>
        {words}
        {times !== null ? ` · ${timesWords(times)}` : ''}
      </span>
    );
  return (
    <div
      className={cn(
        'rounded-card border p-4',
        post.standout ? 'border-accent-soft bg-accent-soft/30' : 'border-border',
      )}
      data-testid={`socialcontent-post-${post.postKey}`}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-text-3">
        {showCreator ? (
          <span className="font-semibold text-text">{post.creatorName ?? post.creatorShown}</span>
        ) : null}
        {showCreator && post.creatorName ? <span>{post.creatorShown}</span> : null}
        <span>{networkName(post.network)}</span>
        <span>{W.kinds[post.kind]}</span>
        <span>{daysAgo(post.postedAt)}</span>
        {post.standout && post.standoutOn ? (
          <Badge variant="accent">
            {W.creators.posts.standout} · {W.standouts.on[post.standoutOn]}
          </Badge>
        ) : post.waiting === 'too_new' ? (
          <Badge>{W.creators.posts.tooNew}</Badge>
        ) : post.waiting === 'too_few' ? (
          <Badge>{W.creators.posts.tooFew}</Badge>
        ) : null}
      </div>
      {post.caption ? (
        <p className="mt-2 line-clamp-3 whitespace-pre-line text-[13.5px] text-text">
          {post.caption}
        </p>
      ) : null}
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-text-2">
        {line(post.views, W.standouts.views(post.views ?? 0), post.viewsTimes)}
        {line(engagement, W.standouts.engagement(engagement ?? 0), post.engagementTimes)}
        <a
          href={post.link}
          target="_blank"
          rel="noreferrer"
          className="ml-auto inline-flex items-center gap-1 text-accent-text hover:underline"
        >
          {W.standouts.open}
          <ExternalLink className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
        </a>
      </div>
    </div>
  );
}
