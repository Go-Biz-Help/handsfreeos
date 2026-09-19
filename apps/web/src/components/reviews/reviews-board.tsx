'use client';
import { RefreshCw, Star, ThumbsDown, ThumbsUp, Unplug } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { ReviewConnectionRow, ReviewRow } from '@/lib/api/types';

const PROVIDER_LABEL = { google: 'Google', facebook: 'Facebook' } as const;

function Stars({ rating }: { rating: number }) {
  return (
    <span className="flex items-center gap-0.5" aria-label={`${rating} out of 5`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <Star
          key={n}
          className={n <= rating ? 'size-4 fill-current text-amber-500' : 'size-4 text-border'}
          aria-hidden
        />
      ))}
    </span>
  );
}

/**
 * The reviews, newest first, with the place they came from and somewhere to answer.
 *
 * Facebook has no stars and cannot be answered by an app, so those two differences are shown rather than
 * papered over: a thumb where the stars would be, and a link out where the reply box would be.
 */
export function ReviewsBoard({
  workspaceId,
  reviews,
  connections,
  summary,
  canManage,
}: {
  workspaceId: string;
  reviews: ReviewRow[];
  connections: ReviewConnectionRow[];
  summary: {
    total: number;
    averageRating: number | null;
    recommended: number;
    notRecommended: number;
    unanswered: number;
  };
  canManage: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [answering, setAnswering] = useState<string | null>(null);
  const [onlyUnanswered, setOnlyUnanswered] = useState(false);

  async function call(key: string, fn: () => Promise<unknown>, ok: string) {
    setBusy(key);
    try {
      await fn();
      toast.success(ok);
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  /** The sign-in happens on the worker; the browser is only ever handed a one-time state. */
  async function connect(provider: 'google' | 'facebook') {
    setBusy(`connect-${provider}`);
    try {
      const out = unwrap(
        await apiBrowser().POST('/v1/commands/review_connection.connect', {
          body: { workspaceId, provider },
        }),
      );
      window.location.href = `/oauth/${provider}/start?state=${encodeURIComponent(out.state)}`;
    } catch (e) {
      toast.error(errorMessage(e));
      setBusy(null);
    }
  }

  async function reply(event: FormEvent<HTMLFormElement>, review: ReviewRow) {
    event.preventDefault();
    const body = String(new FormData(event.currentTarget).get('body') ?? '').trim();
    if (!body) return;
    await call(
      `reply-${review.id}`,
      async () =>
        unwrap(
          await apiBrowser().POST('/v1/commands/review.reply', {
            body: { workspaceId, reviewId: review.id, body },
          }),
        ),
      'Answered. It goes out to where people read it.',
    );
    setAnswering(null);
  }

  const live = connections.filter((c) => c.status !== 'disconnected');
  const shown = onlyUnanswered ? reviews.filter((r) => !r.replyBody) : reviews;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-3">
        {(['google', 'facebook'] as const).map((provider) => {
          const c = live.find((x) => x.provider === provider);
          return (
            <Card
              key={provider}
              className="flex min-w-60 flex-1 items-start justify-between gap-3 p-3"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{PROVIDER_LABEL[provider]}</span>
                  {c?.status === 'connected' && <Badge variant="ok">Connected</Badge>}
                  {c?.status === 'needs_attention' && <Badge variant="danger">Sign in again</Badge>}
                </div>
                <p className="truncate text-[13px] text-text-2">
                  {c?.displayName ??
                    (provider === 'google'
                      ? 'Your Business Profile, and the stars people leave on it.'
                      : 'Your Page, and whether people recommend you.')}
                </p>
                {c?.lastError && <p className="text-[12px] text-danger">{c.lastError}</p>}
              </div>
              {canManage && (
                <div className="flex shrink-0 gap-1">
                  {c && c.status !== 'pending' && (
                    <>
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label={`Read ${PROVIDER_LABEL[provider]} again`}
                        disabled={busy === `sync-${c.id}`}
                        onClick={() =>
                          void call(
                            `sync-${c.id}`,
                            async () =>
                              unwrap(
                                await apiBrowser().POST('/v1/commands/review_connection.sync_now', {
                                  body: { workspaceId, connectionId: c.id },
                                }),
                              ),
                            'Reading them again now.',
                          )
                        }
                      >
                        <RefreshCw className="size-4" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label={`Disconnect ${PROVIDER_LABEL[provider]}`}
                        disabled={busy === `off-${c.id}`}
                        onClick={() => {
                          if (
                            !confirm(
                              `Stop reading ${PROVIDER_LABEL[provider]} reviews? The ones already here stay, and every one of them stays on ${PROVIDER_LABEL[provider]}.`,
                            )
                          )
                            return;
                          void call(
                            `off-${c.id}`,
                            async () =>
                              unwrap(
                                await apiBrowser().POST(
                                  '/v1/commands/review_connection.disconnect',
                                  { body: { workspaceId, connectionId: c.id } },
                                ),
                              ),
                            'Disconnected.',
                          );
                        }}
                      >
                        <Unplug className="size-4" />
                      </Button>
                    </>
                  )}
                  {(!c || c.status === 'pending') && (
                    <Button
                      size="sm"
                      disabled={busy === `connect-${provider}`}
                      onClick={() => void connect(provider)}
                    >
                      Connect
                    </Button>
                  )}
                </div>
              )}
            </Card>
          );
        })}
      </div>

      {summary.total > 0 && (
        <Card className="flex flex-wrap items-center gap-x-6 gap-y-2 p-3 text-[13px]">
          {summary.averageRating !== null && (
            <span className="flex items-center gap-2">
              <Stars rating={Math.round(summary.averageRating)} />
              <strong>{summary.averageRating.toFixed(1)}</strong> on Google
            </span>
          )}
          {summary.recommended + summary.notRecommended > 0 && (
            <span>
              {summary.recommended} recommend you
              {summary.notRecommended > 0 ? `, ${summary.notRecommended} do not` : ''}
            </span>
          )}
          <span className="text-text-2">{summary.total} in total</span>
          {summary.unanswered > 0 && (
            <Button
              size="sm"
              variant={onlyUnanswered ? 'secondary' : 'ghost'}
              onClick={() => setOnlyUnanswered((v) => !v)}
            >
              {summary.unanswered} unanswered
            </Button>
          )}
        </Card>
      )}

      {shown.length === 0 && (
        <Card className="p-6 text-center text-[13px] text-text-2">
          {live.length === 0
            ? 'Connect Google or Facebook and what customers said shows up here. Nothing is copied — they stay where people read them.'
            : onlyUnanswered
              ? 'Every one of them has an answer.'
              : 'Nothing yet. New reviews arrive within the hour.'}
        </Card>
      )}

      {shown.map((review) => (
        <Card key={review.id} className="space-y-2 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{review.authorName ?? 'Someone'}</span>
            {review.rating !== null && <Stars rating={review.rating} />}
            {review.sentiment === 'positive' && (
              <span className="flex items-center gap-1 text-[13px] text-text-2">
                <ThumbsUp className="size-4" aria-hidden /> Recommends
              </span>
            )}
            {review.sentiment === 'negative' && (
              <span className="flex items-center gap-1 text-[13px] text-text-2">
                <ThumbsDown className="size-4" aria-hidden /> Does not recommend
              </span>
            )}
            <Badge variant="gray">{PROVIDER_LABEL[review.provider]}</Badge>
            <span className="text-[12px] text-text-2">
              {new Date(review.postedAt).toLocaleDateString()}
            </span>
          </div>
          {review.body && <p className="text-[14px] leading-relaxed">{review.body}</p>}

          {review.replyBody ? (
            <div className="rounded-lg border border-border bg-card-2 p-2">
              <p className="text-[12px] font-medium text-text-2">Your answer</p>
              <p className="text-[13px]">{review.replyBody}</p>
            </div>
          ) : canManage && review.canReply ? (
            answering === review.id ? (
              <form onSubmit={(e) => void reply(e, review)} className="space-y-2">
                <Textarea name="body" rows={3} required placeholder="Write an answer…" />
                <div className="flex gap-2">
                  <Button type="submit" size="sm" disabled={busy === `reply-${review.id}`}>
                    Answer
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setAnswering(null)}
                  >
                    Cancel
                  </Button>
                </div>
              </form>
            ) : (
              <Button size="sm" variant="secondary" onClick={() => setAnswering(review.id)}>
                Answer
              </Button>
            )
          ) : (
            !review.canReply &&
            review.url && (
              // Facebook answers a recommendation as a comment on the story behind it, which its API will
              // not let an app post. A link out beats a box that quietly fails.
              <a
                href={review.url}
                target="_blank"
                rel="noreferrer noopener"
                className="text-[13px] font-medium text-accent-text"
              >
                Answer on Facebook
              </a>
            )
          )}
        </Card>
      ))}
    </div>
  );
}
