'use client';
/**
 * Asking the listing feed while the agent types (round five, board 64). Only the worker holds the feed's keys, so this
 * asks the worker's `realestate.feed.search`; what it finds is shown to choose from, never kept.
 */
import { fmtMonthDay, money } from '@hfos/core';
import { useEffect, useState } from 'react';
import { errorMessage } from '@/lib/api/client';
import { workerPost } from '@/lib/api/worker';

/** One home the feed found while the agent typed. */
export interface FeedHit {
  readonly listingKey: string;
  readonly mlsNumber: string;
  readonly address: string;
  readonly status: string;
  readonly statusWords: string;
  readonly priceCents: number | null;
  readonly soldOn: string | null;
  readonly beds: number | null;
  readonly baths: number | null;
  readonly sqft: number | null;
  readonly photo: string | null;
  readonly mls: string;
  readonly notice: string | null;
  readonly courtesy: string | null;
}

export interface FeedAnswer {
  readonly connected: boolean;
  readonly supplier?: string;
  readonly homes: readonly FeedHit[];
}

/** "Active · $409,000", "Sold Aug 12 · $552,000" */
export function hitLine(h: FeedHit): string {
  const status =
    h.status === 'sold' && h.soldOn ? `Sold ${fmtMonthDay(h.soldOn.slice(0, 10))}` : h.statusWords;
  return [status, h.priceCents !== null ? money(h.priceCents) : null].filter(Boolean).join(' · ');
}

/** Asks the feed for what's typed, a moment after typing stops. Three characters or more. */
export function useFeedSearch(workspaceId: string, text: string) {
  const [answer, setAnswer] = useState<FeedAnswer | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const q = text.trim();
  useEffect(() => {
    if (q.length < 3) {
      setSearching(false);
      setError(null);
      return;
    }
    let stale = false;
    setSearching(true);
    const t = setTimeout(() => {
      workerPost<FeedAnswer>('/v1/addons/realestate/actions/realestate.feed.search', {
        workspaceId,
        input: { text: q },
      })
        .then((a) => {
          if (stale) return;
          setAnswer(a);
          setError(null);
        })
        .catch((e: unknown) => {
          if (!stale) setError(errorMessage(e));
        })
        .finally(() => {
          if (!stale) setSearching(false);
        });
    }, 350);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [workspaceId, q]);
  return { answer: q.length < 3 ? null : answer, searching, error };
}
