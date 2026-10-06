'use client';
/**
 * Where a customer came from (20261025000200): every Facebook or Instagram ad or link that brought them, newest
 * first, each kept as it came, with the ad's campaign, ad set and creative once Meta has said. On a Messenger or
 * Instagram conversation (that conversation's) and on the customer's page (all of theirs).
 *
 * The words are core's (`crm/attribution-words.ts`), so the phone can read the same.
 */
import {
  adLookupNote,
  attributionSummary,
  touchFacts,
  touchKindWords,
  touchTitle,
} from '@hfos/core';
import { Megaphone } from 'lucide-react';
import { useEffect, useState } from 'react';
import { InstagramIcon, MessengerIcon } from '@/components/inbox/social-bits';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { apiBrowser, unwrap } from '@/lib/api/client';
import type { AttributionList, AttributionTouch } from '@/lib/api/types';
import { formatDate } from '@/lib/format';
import { useLiveVersion } from '@/lib/realtime/live-provider';
import { cn } from '@/lib/utils';

/** How many touches show before "and more": a customer an ad brings back often still reads at a glance. */
const SHOWN = 5;

/** One customer's or one conversation's touches; null while loading, and on trouble (the card then hides). */
function useAttribution(
  workspaceId: string,
  of: { readonly personId: string } | { readonly conversationId: string },
): AttributionList | null {
  const live = useLiveVersion(['attribution_touch', 'ad'], 300);
  const [got, setGot] = useState<AttributionList | null>(null);
  const key = 'personId' in of ? `p:${of.personId}` : `c:${of.conversationId}`;
  useEffect(() => {
    let cancelled = false;
    const [kind, id] = [key.slice(0, 1), key.slice(2)];
    apiBrowser()
      .POST('/v1/queries/attribution.list', {
        body: {
          workspaceId,
          ...(kind === 'p' ? { personId: id } : { conversationId: id }),
          limit: 25,
        },
      })
      .then((r) => {
        if (!cancelled) setGot(unwrap(r));
      })
      .catch(() => {
        // Where somebody came from is a side note: a card that can't load stays out of the way.
        if (!cancelled) setGot(null);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, key, live]);
  return got;
}

function Touch({ touch: t, first }: { touch: AttributionTouch; first: boolean }) {
  const picture = t.ad?.creativeThumbnailUrl ?? t.adPhotoUrl;
  const facts = touchFacts(t);
  const note = adLookupNote(t);
  const Mark = t.platform === 'instagram' ? InstagramIcon : MessengerIcon;
  return (
    <li className="flex gap-2.5" data-testid={`attribution-touch-${t.id}`} data-kind={t.kind}>
      {picture ? (
        // Meta's own copy of the ad's picture, as the customer saw it.
        <img
          src={picture}
          alt=""
          className="h-10 w-10 flex-none rounded-[8px] border border-border object-cover"
          referrerPolicy="no-referrer"
        />
      ) : (
        <span
          aria-hidden
          className="inline-flex h-10 w-10 flex-none items-center justify-center rounded-[8px] bg-accent-soft text-accent-text"
        >
          {t.adId ? (
            <Megaphone className="h-4 w-4" strokeWidth={1.5} />
          ) : (
            <Mark className="h-4 w-4" />
          )}
        </span>
      )}
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium leading-snug">{touchTitle(t)}</div>
        <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-text-3">
          <span>
            {touchKindWords(t)} · {formatDate(t.touchedAt, { time: true })}
          </span>
          {first ? (
            <Badge variant="accent" className="h-[18px] px-1.5 text-[11px]">
              First
            </Badge>
          ) : null}
        </div>
        {facts.length ? (
          <dl className="mt-1.5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-2.5 gap-y-0.5 text-xs">
            {facts.map((f) => (
              <div key={f.label} className="contents">
                <dt className="text-text-3">{f.label}</dt>
                <dd className="truncate text-text-2" title={f.value}>
                  {f.value}
                </dd>
              </div>
            ))}
          </dl>
        ) : null}
        {note ? <p className="mt-1 text-xs text-text-3">{note}</p> : null}
      </div>
    </li>
  );
}

function TouchList({ data }: { data: AttributionList }) {
  const [all, setAll] = useState(false);
  const shown = all ? data.touches : data.touches.slice(0, SHOWN);
  const more = data.touches.length - shown.length;
  return (
    <>
      <p className="text-[13px] text-text-2" data-testid="attribution-summary">
        {attributionSummary(data.touches, data.first, data.total)}
      </p>
      <ul className="mt-3 flex flex-col gap-3">
        {shown.map((t) => (
          <Touch key={t.id} touch={t} first={t.id === data.first && data.total > 1} />
        ))}
      </ul>
      {more > 0 ? (
        <button
          type="button"
          onClick={() => setAll(true)}
          className="mt-2 text-[12.5px] font-medium text-accent-text hover:underline"
        >
          Show {more === 1 ? 'one more' : `${more} more`}
        </button>
      ) : null}
    </>
  );
}

/** The customer's page: a card of its own, only when something brought them. */
export function AttributionCard({
  workspaceId,
  personId,
}: {
  workspaceId: string;
  personId: string;
}) {
  const data = useAttribution(workspaceId, { personId });
  if (!data || data.total === 0) return null;
  return (
    <Card className="px-5 py-[18px]" data-testid="attribution-card">
      <h3 className="mb-2 text-[15px] font-semibold">Where they came from</h3>
      <TouchList data={data} />
    </Card>
  );
}

/** Beside a Messenger or Instagram conversation: the same, for this conversation, under the panel's own label. */
export function AttributionSection({
  workspaceId,
  conversationId,
  className,
}: {
  workspaceId: string;
  conversationId: string;
  className?: string;
}) {
  const data = useAttribution(workspaceId, { conversationId });
  if (!data || data.total === 0) return null;
  return (
    <section className={cn('flex flex-col', className)} data-testid="attribution-section">
      <div className="mb-1.5 text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3">
        Came from
      </div>
      <TouchList data={data} />
    </section>
  );
}
