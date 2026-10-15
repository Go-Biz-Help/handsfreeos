'use client';
/**
 * The Review tab (HANDSFREEOS_AI_FEEDBACK_IMPLEMENTATION_PLAN.md): what the AI teammate sent on its own, newest first,
 * with what the customer said, to rate one by one. A thumbs down that says why comes back as a rule to save.
 */
import { fmtAt, REVIEW_WHY_WORDS } from '@hfos/core';
import { usePathname, useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button, ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Segmented } from '@/components/ui/segmented';
import { CHANNEL_NAMES } from '@/lib/ai-team/describe';
import {
  feedbackActions,
  feedbackOn,
  myFeedback,
  useReplyFeedback,
  type ReviewItem,
  type ReviewPage,
} from '@/lib/ai-team/feedback';
import type { TeammateChannelKey, TeammateGet } from '@/lib/ai-team/types';
import { errorMessage } from '@/lib/api/client';
import { ReplyFeedback } from './reply-feedback';
import { TeammateTabShell } from './tab-shell';

export type ReviewShow = 'unrated' | 'all';

const channelName = (c: string | null) =>
  c && c in CHANNEL_NAMES ? CHANNEL_NAMES[c as TeammateChannelKey] : null;

export function TeammateReviewTab({
  workspaceId,
  data,
  show,
  initial,
}: {
  workspaceId: string;
  data: TeammateGet;
  /** From the page's address (`?show=all`). */
  show: ReviewShow;
  initial: ReviewPage | null;
}) {
  return (
    <TeammateTabShell
      workspaceId={workspaceId}
      data={data}
      emptyBody="What it sends on its own shows here, to rate, once it’s working."
      testId="teammate-review-tab"
    >
      {data.teammate && initial ? (
        <ReviewList
          workspaceId={workspaceId}
          name={data.teammate.name}
          timeZone={data.catalogs.timeZone}
          show={show}
          initial={initial}
        />
      ) : data.teammate ? (
        <Card>
          <EmptyState title="Review is for people who work the inbox">
            What {data.teammate.name} sends is inbox business. Ask an owner or admin for access to
            the inbox.
          </EmptyState>
        </Card>
      ) : null}
    </TeammateTabShell>
  );
}

function ReviewList({
  workspaceId,
  name,
  timeZone,
  show,
  initial,
}: {
  workspaceId: string;
  name: string;
  timeZone: string;
  show: ReviewShow;
  initial: ReviewPage;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const actions = useMemo(() => feedbackActions(workspaceId), [workspaceId]);
  const [items, setItems] = useState<readonly ReviewItem[]>(initial.items);
  const [cursor, setCursor] = useState(initial.nextCursor);
  const [loading, setLoading] = useState(false);
  const feedback = useReplyFeedback(
    workspaceId,
    { runIds: items.map((i) => i.runId) },
    { list: items.flatMap((i) => i.feedback), canSaveRules: initial.canSaveRules },
  );

  async function more() {
    if (!cursor) return;
    setLoading(true);
    try {
      const page = await actions.review({ show, cursor });
      setItems((now) => [...now, ...page.items]);
      setCursor(page.nextCursor);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col gap-3" data-testid="review-list">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[13px] text-text-2">
          What {name} sent on its own. Rate each reply, and say what it should have said: it
          suggests a rule to save for next time.
        </p>
        <Segmented
          ariaLabel="Which replies"
          value={show}
          onChange={(v) => router.push(v === 'all' ? `${pathname}?show=all` : pathname)}
          options={[
            {
              value: 'unrated',
              label: `Not rated yet${initial.unrated ? ` · ${initial.unrated}` : ''}`,
              testId: 'review-unrated',
            },
            { value: 'all', label: 'All', testId: 'review-all' },
          ]}
        />
      </div>
      {items.length === 0 ? (
        <Card>
          <EmptyState title={show === 'unrated' ? 'All caught up' : 'Nothing sent on its own yet'}>
            {show === 'unrated'
              ? `You’ve rated everything ${name} sent on its own in the last 30 days.`
              : `Replies ${name} sends without waiting for an OK show here.`}
          </EmptyState>
        </Card>
      ) : (
        items.map((item) => (
          <Card key={item.runId} className="p-4" data-testid={`review-${item.runId}`}>
            <div className="mb-2.5 flex flex-wrap items-center gap-2 text-[12.5px] text-text-3">
              <span className="font-semibold text-text">
                {item.person?.fullName ?? 'Unknown customer'}
              </span>
              <Badge>{REVIEW_WHY_WORDS[item.why]}</Badge>
              <span>
                {[channelName(item.channel), fmtAt(item.sentAt, timeZone)]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            </div>
            {item.asked ? (
              <div className="mb-2">
                <p className="mb-1 text-[12px] font-medium text-text-3">They said</p>
                <p className="whitespace-pre-wrap rounded-control bg-card-2 px-2.5 py-[7px] text-[13px] leading-[1.45] [overflow-wrap:anywhere]">
                  {item.asked}
                </p>
              </div>
            ) : null}
            <p className="mb-1 text-[12px] font-medium text-text-3">{name} replied</p>
            <p className="whitespace-pre-wrap rounded-control border border-border bg-card px-2.5 py-[7px] text-[13px] leading-[1.45] [overflow-wrap:anywhere]">
              {item.reply}
            </p>
            <div className="mt-2 flex flex-wrap items-start justify-between gap-2">
              <ReplyFeedback
                workspaceId={workspaceId}
                actions={actions}
                reply={item.reply}
                runId={item.runId}
                messageId={item.messageId}
                mine={myFeedback(feedback, { runId: item.runId })}
                all={feedbackOn(feedback, { runId: item.runId })}
                canSaveRules={feedback.canSaveRules}
                slow={feedback.slow}
                onChange={feedback.put}
                className="min-w-0 flex-1"
              />
              {item.conversationId ? (
                <ButtonLink
                  size="sm"
                  variant="ghost"
                  href={`/app/w/${workspaceId}/inbox/${item.conversationId}`}
                >
                  Open the conversation
                </ButtonLink>
              ) : null}
            </div>
          </Card>
        ))
      )}
      {cursor ? (
        <div className="flex justify-center">
          <Button variant="secondary" size="sm" loading={loading} onClick={() => void more()}>
            Show more
          </Button>
        </div>
      ) : null}
    </div>
  );
}
