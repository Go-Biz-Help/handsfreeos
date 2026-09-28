'use client';
import { ADDON_PAGE_WORDS as W } from '@hfos/core';
import { PartyPopper, Rocket } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button, ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { AddonNews } from '@/lib/api/types';

/**
 * Home's note to the owners and admins of a business that voted for an add-on (0109): it's coming soon, or it's
 * ready to add (`addon.news` picks the one to show; the emails say the same). See it opens it on Settings → Add-ons,
 * and Got it sets the note aside for this person.
 */
export function AddonNewsCard({ workspaceId, news }: { workspaceId: string; news: AddonNews }) {
  const [gone, setGone] = useState(false);
  const [busy, setBusy] = useState(false);
  if (gone) return null;
  const shipped = news.kind === 'shipped';
  const Icon = shipped ? PartyPopper : Rocket;
  const titleId = `addon-news-${news.addonId}`;

  async function setAside() {
    setBusy(true);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/addon.mark_news_seen', {
          body: { workspaceId, addonId: news.addonId, kind: news.kind },
        }),
      );
      setGone(true);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      className="p-4"
      role="group"
      aria-labelledby={titleId}
      data-testid="addon-news"
      data-addon={news.addonId}
      data-kind={news.kind}
    >
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className="flex h-8 w-8 flex-none items-center justify-center rounded-menu bg-accent-soft text-accent-text"
        >
          <Icon className="h-4 w-4" strokeWidth={1.5} />
        </span>
        <div className="min-w-0 flex-1">
          <h3 id={titleId} className="text-[15px] font-semibold tracking-tight">
            {shipped ? W.newsShipped(news.name) : W.newsPicked(news.name)}
          </h3>
          <p className="mt-0.5 text-[13px] text-text-2">
            {shipped ? W.newsShippedDetail : W.newsPickedDetail}
          </p>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5">
        <ButtonLink
          href={`/app/w/${workspaceId}/settings/add-ons?addon=${news.addonId}`}
          variant="primary"
          size="sm"
          data-testid="addon-news-see"
        >
          {W.seeIt}
        </ButtonLink>
        <Button
          variant="ghost"
          size="sm"
          loading={busy}
          disabled={busy}
          onClick={() => void setAside()}
          data-testid="addon-news-got-it"
        >
          {W.gotIt}
        </Button>
      </div>
    </Card>
  );
}
