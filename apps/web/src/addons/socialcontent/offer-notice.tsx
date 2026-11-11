'use client';
import { SOCIALCONTENT_WORDS as W } from '@hfos/core/addons/socialcontent/words';
import { Megaphone } from 'lucide-react';
import { ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

/**
 * The main offer isn't live, so the AI writes no posts and no ideas (the owner's pick 7b, 11 Nov 2026): says so on the
 * Calendar and Ideas pages, with the way to Settings → Main offer.
 */
export function OfferNotLive({ workspaceId }: { workspaceId: string }) {
  return (
    <Card
      className="flex flex-wrap items-center gap-3 border-warning-border bg-warning-soft p-4"
      data-testid="socialcontent-offer-not-live"
    >
      <Megaphone className="h-4 w-4 flex-none text-warning-text" strokeWidth={1.75} aria-hidden />
      <p className="min-w-0 flex-1 text-[13.5px] text-warning-text">{W.offer.notLive}</p>
      <ButtonLink href={`/app/w/${workspaceId}/settings/main-offer`} size="sm">
        {W.offer.open}
      </ButtonLink>
    </Card>
  );
}
