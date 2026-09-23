'use client';
import { IDEA_STATUS_WORDS } from '@hfos/core';
import { ChevronUp } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { IdeaArea, WhatsNewEntry } from '@/lib/api/types';
import { areaNames, dayWords, KindPill, PlainText } from './idea-bits';
import { whatsNewRead } from './whats-new-signal';

/**
 * What's new in HandsFreeOS, newest first: what shipped, what got better, what got fixed, and the ideas each
 * one answers — so the people who asked can see it was them. Opening the page is reading it: the dots go out.
 */
export function WhatsNewList({
  workspaceId,
  entries,
  nextCursor,
  areas,
}: {
  workspaceId: string;
  entries: readonly WhatsNewEntry[];
  nextCursor: string | null;
  areas: readonly IdeaArea[];
}) {
  const names = areaNames(areas);
  const [more, setMore] = useState<WhatsNewEntry[]>([]);
  const [cursor, setCursor] = useState(nextCursor);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    whatsNewRead();
    void apiBrowser()
      .POST('/v1/commands/whats_new.mark_seen', { body: {} })
      .catch(() => undefined);
  }, []);

  const showMore = async () => {
    if (!cursor) return;
    setLoading(true);
    try {
      const out = unwrap(
        await apiBrowser().POST('/v1/queries/whats_new.list', { body: { cursor } }),
      );
      setMore((m) => [...m, ...out.entries]);
      setCursor(out.nextCursor);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  const all = [...entries, ...more];
  if (!all.length)
    return (
      <Card>
        <EmptyState title="Nothing here yet">
          When something new reaches HandsFreeOS, it shows up here first.
        </EmptyState>
      </Card>
    );
  return (
    <div className="flex flex-col gap-4" data-testid="whats-new">
      {all.map((e) => (
        <Card key={e.id} id={e.id} className="scroll-mt-24 p-5" data-testid="whats-new-entry">
          <div className="flex flex-wrap items-center gap-2 text-[13px] text-text-3">
            <KindPill kind={e.kind} />
            {e.publishedAt ? <span>{dayWords(e.publishedAt)}</span> : null}
            {e.areaId ? <span>· {names.get(e.areaId) ?? ''}</span> : null}
            {e.unseen ? (
              <span className="rounded-full bg-accent px-2 py-0.5 text-[11px] font-semibold text-white">
                New for you
              </span>
            ) : null}
          </div>
          <h2 className="mt-2 text-lg font-semibold leading-snug tracking-[-0.01em]">{e.title}</h2>
          {e.body ? <PlainText text={e.body} className="mt-2 text-[14.5px] text-text" /> : null}
          {e.ideas.length ? (
            <div className="mt-4 border-t border-border pt-3">
              <p className="text-xs font-medium text-text-3">The ideas this answers</p>
              <ul className="mt-1.5 flex flex-col gap-1">
                {e.ideas.map((i) => (
                  <li key={i.id} className="flex items-center gap-2 text-[13px]">
                    <span className="inline-flex items-center gap-0.5 tabular-nums text-text-3">
                      <ChevronUp className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
                      {i.voteCount}
                    </span>
                    <Link
                      href={`/app/w/${workspaceId}/ideas/${i.id}`}
                      className="min-w-0 truncate hover:underline"
                    >
                      #{i.number} {i.title}
                    </Link>
                    <span className="flex-none text-xs text-text-3">
                      {IDEA_STATUS_WORDS[i.status]}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </Card>
      ))}
      {cursor ? (
        <div className="flex justify-center">
          <Button variant="secondary" onClick={showMore} loading={loading}>
            Show older
          </Button>
        </div>
      ) : null}
    </div>
  );
}
