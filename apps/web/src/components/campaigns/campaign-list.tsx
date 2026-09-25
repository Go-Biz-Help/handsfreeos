import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import type { CampaignSummary } from '@/lib/api/types';
import { CAMPAIGN_STATUS_BADGE, CHANNEL_WORDS, statusWords } from './words';

/** Every campaign, newest first, with how far each has got. */
export function CampaignList({
  workspaceId,
  items,
}: {
  workspaceId: string;
  items: CampaignSummary[];
}) {
  if (!items.length)
    return (
      <EmptyState title="No campaigns yet" dashed>
        Pick customers by tag or pipeline stage, say in a line what it’s for, and the AI writes each
        of them a text, one email to them all, or how your AI teammate’s calls open, for you to read
        before anything goes.
      </EmptyState>
    );
  return (
    <Card className="divide-y divide-border" data-testid="campaign-list">
      {items.map((c) => {
        const going = c.counts.approved + c.counts.sent + c.counts.failed;
        return (
          <Link
            key={c.id}
            href={`/app/w/${workspaceId}/campaigns/${c.id}`}
            className="flex items-center justify-between gap-4 px-[18px] py-3.5 hover:bg-card-2"
            data-testid={`campaign-${c.id}`}
          >
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="flex items-center gap-2 truncate text-[13.5px] font-medium">
                {c.name}
                <Badge variant="gray">{CHANNEL_WORDS[c.channel] ?? 'Texts'}</Badge>
              </span>
              <span className="truncate text-[12.5px] text-text-2">{c.goal}</span>
            </div>
            <div className="flex flex-none items-center gap-3">
              {c.status === 'sending' || c.status === 'paused' || c.status === 'done' ? (
                <span className="text-[12.5px] text-text-2">
                  {c.counts.sent} of {going} sent
                </span>
              ) : null}
              <Badge variant={CAMPAIGN_STATUS_BADGE[c.status] ?? 'gray'}>
                {statusWords(c.status, c.channel)}
              </Badge>
            </div>
          </Link>
        );
      })}
    </Card>
  );
}
