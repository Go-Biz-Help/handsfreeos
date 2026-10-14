'use client';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';

type Review = {
  summary: string | null;
  items: {
    id: string;
    kind: 'task' | 'follow_up';
    status: 'pending' | 'approved' | 'dismissed';
    preview: Record<string, unknown>;
  }[];
};

const text = (v: unknown) => (typeof v === 'string' ? v : '');

/**
 * What the AI made of a recorded call: its summary (already on the customer's timeline), and the tasks and
 * follow-up it suggests, each waiting for someone to approve (as they are, or edited) or dismiss.
 */
export function CallReview({
  workspaceId,
  appointmentId,
  version,
}: {
  workspaceId: string;
  appointmentId: string;
  version: number;
}) {
  const [review, setReview] = useState<Review | null>(null);
  const [edits, setEdits] = useState<Record<string, Record<string, string>>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setReview(
        unwrap(
          await apiBrowser().POST('/v1/queries/call_suggestion.list', {
            body: { workspaceId, appointmentId },
          }),
        ) as Review,
      );
    } catch {
      // The transcript section still shows; the review appears on the next refresh.
    }
  }, [workspaceId, appointmentId]);
  useEffect(() => {
    void load();
  }, [load, version]);

  async function decide(id: string, decision: 'approve' | 'dismiss') {
    setBusy(`${id}:${decision}`);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/call_suggestion.decide', {
          body: {
            workspaceId,
            suggestionId: id,
            decision,
            ...(edits[id] ? { edits: edits[id] } : {}),
          },
        }),
      );
      toast.success(decision === 'approve' ? 'Done.' : 'Dismissed.');
      await load();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }
  const edit = (id: string, key: string, value: string) =>
    setEdits((all) => ({ ...all, [id]: { ...all[id], [key]: value } }));

  if (!review || (!review.summary && review.items.length === 0)) return null;
  return (
    <div className="flex flex-col gap-2.5 pt-1.5" data-testid="call-review">
      {review.summary ? (
        <p className="whitespace-pre-wrap text-[13px] text-text-2">{review.summary}</p>
      ) : null}
      {review.items.map((s) => {
        const p = { ...s.preview, ...edits[s.id] };
        const pending = s.status === 'pending';
        return (
          <div
            key={s.id}
            className="flex flex-col gap-1.5 rounded-menu border border-border px-3 py-2"
            data-testid="call-suggestion"
            data-status={s.status}
          >
            <span className="text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3">
              {s.kind === 'task' ? 'Suggested task' : 'Suggested follow-up email'}
              {pending ? '' : s.status === 'approved' ? ' · Done' : ' · Dismissed'}
            </span>
            {s.kind === 'task' ? (
              <input
                className="rounded-control border border-border bg-card px-2 py-1 text-[13px]"
                aria-label="Task"
                value={text(p.title)}
                disabled={!pending}
                onChange={(e) => edit(s.id, 'title', e.target.value)}
              />
            ) : (
              <>
                <input
                  className="rounded-control border border-border bg-card px-2 py-1 text-[13px]"
                  aria-label="Subject"
                  value={text(p.subject)}
                  disabled={!pending}
                  onChange={(e) => edit(s.id, 'subject', e.target.value)}
                />
                <textarea
                  className="min-h-[90px] rounded-control border border-border bg-card px-2 py-1 text-[13px]"
                  aria-label="Message"
                  value={text(p.body)}
                  disabled={!pending}
                  onChange={(e) => edit(s.id, 'body', e.target.value)}
                />
              </>
            )}
            {pending ? (
              <span className="flex gap-1.5">
                <Button
                  size="sm"
                  loading={busy === `${s.id}:approve`}
                  onClick={() => void decide(s.id, 'approve')}
                >
                  {s.kind === 'task' ? 'Add task' : 'Send email'}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  loading={busy === `${s.id}:dismiss`}
                  onClick={() => void decide(s.id, 'dismiss')}
                >
                  Dismiss
                </Button>
              </span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
