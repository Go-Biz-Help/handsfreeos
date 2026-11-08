'use client';
/**
 * One creator's post (docs/socialcontent.md): who posted it, where and when, what kind it is, its caption, its numbers,
 * and how many times the posts around it it did, on views and on likes plus comments. Standouts say which they beat
 * them on, and carry the AI's notes on why (part 3) and, for a video it watched, what it saw and heard (part 4). The
 * Standouts page and a creator's posts under Creators both draw it.
 */
import { networkName } from '@hfos/core/addons/socialcontent/networks';
import { STANDOUT } from '@hfos/core/addons/socialcontent/standouts';
import {
  SOCIALCONTENT_WORDS as W,
  daysAgo,
  timesWords,
} from '@hfos/core/addons/socialcontent/words';
import { ExternalLink, Eye, Sparkles } from 'lucide-react';
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
      {post.standout ? <Notes post={post} /> : null}
    </div>
  );
}

function Facts({ items }: { items: readonly (readonly [string, string | null])[] }) {
  const shown = items.filter((i): i is readonly [string, string] => !!i[1]);
  if (!shown.length) return null;
  return (
    <dl className="mt-2 grid gap-x-3 gap-y-1 text-[13px] sm:grid-cols-[max-content_1fr]">
      {shown.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-text-3">{label}</dt>
          <dd className="text-text">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Techniques({ list }: { list: readonly string[] }) {
  if (!list.length) return null;
  return (
    <div className="mt-2">
      <div className="text-[12.5px] text-text-3">{W.standouts.notes.techniques}</div>
      <ul className="mt-1 list-disc space-y-0.5 pl-5 text-[13px] text-text">
        {list.map((t) => (
          <li key={t}>{t}</li>
        ))}
      </ul>
    </div>
  );
}

/** The AI's notes on a standout, and what it saw and heard watching it. */
function Notes({ post }: { post: Post }) {
  const n = post.notes;
  const w = post.watched;
  return (
    <div
      className="mt-3 space-y-3 border-t border-accent-soft pt-3"
      data-testid={`socialcontent-notes-${post.postKey}`}
    >
      {n ? (
        <div>
          <div className="flex items-center gap-1.5 text-[12.5px] font-semibold text-accent-text">
            <Sparkles className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
            {W.standouts.notes.why}
          </div>
          <p className="mt-1 text-[13.5px] text-text">{n.why}</p>
          <Facts
            items={[
              [W.standouts.notes.hook, n.hook],
              [W.standouts.notes.format, n.format],
              [W.standouts.notes.topic, n.topic],
              [W.standouts.notes.useIt, n.useIt],
            ]}
          />
          <Techniques list={n.techniques} />
        </div>
      ) : (
        <p className="text-[12.5px] text-text-3">{W.standouts.notes.waiting}</p>
      )}
      {w ? (
        <div data-testid={`socialcontent-watched-${post.postKey}`}>
          <div className="flex items-center gap-1.5 text-[12.5px] font-semibold text-accent-text">
            <Eye className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
            {W.standouts.watched.title}
          </div>
          <p className="mt-1 text-[13.5px] text-text">{w.why}</p>
          <Facts
            items={[
              [W.standouts.watched.hook, w.hook],
              [W.standouts.watched.seen, w.seen],
              [W.standouts.watched.heard, w.heard],
              [W.standouts.watched.pacing, w.pacing],
            ]}
          />
          <Techniques list={w.techniques} />
        </div>
      ) : post.watching ? (
        <p className="text-[12.5px] text-text-3">{W.standouts.watched.watching}</p>
      ) : null}
    </div>
  );
}
