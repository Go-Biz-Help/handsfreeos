'use client';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';

type Review = {
  summary: string | null;
  items: {
    id: string;
    kind: 'task' | 'follow_up' | 'record_change';
    status: 'pending' | 'approved' | 'dismissed';
    preview: Record<string, unknown>;
  }[];
};

const text = (v: unknown) => (typeof v === 'string' ? v : '');
const LABEL = {
  task: 'Suggested task',
  follow_up: 'Suggested follow-up email',
  record_change: 'Suggested update to their record',
};
const FIELDS = [
  ['firstName', 'First name'],
  ['lastName', 'Last name'],
  ['email', 'Email'],
  ['phone', 'Phone'],
] as const;
const APPROVE = { task: 'Add task', follow_up: 'Send email', record_change: 'Update record' };

/** An appointment's call, or a HandsFreeOS video call that isn't for one (docs/video-calls.md, part 5). */
export type ReviewedCall = { appointmentId: string } | { videoCallId: string };

/**
 * What the AI made of a recorded call: its summary (already on the customer's timeline), and the tasks, follow-up
 * and record update it suggests, each waiting for someone to approve (as they are, or edited) or dismiss.
 */
export function CallReview({
  workspaceId,
  version,
  ...call
}: {
  workspaceId: string;
  version: number;
} & ReviewedCall) {
  const appointmentId = 'appointmentId' in call ? call.appointmentId : undefined;
  const videoCallId = 'videoCallId' in call ? call.videoCallId : undefined;
  const [review, setReview] = useState<Review | null>(null);
  const [edits, setEdits] = useState<Record<string, Record<string, string>>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setReview(
        unwrap(
          await apiBrowser().POST('/v1/queries/call_suggestion.list', {
            body: { workspaceId, ...(appointmentId ? { appointmentId } : { videoCallId }) },
          }),
        ) as Review,
      );
    } catch {
      // The transcript section still shows; the review appears on the next refresh.
    }
  }, [workspaceId, appointmentId, videoCallId]);
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
              {LABEL[s.kind]}
              {pending ? '' : s.status === 'approved' ? ' · Done' : ' · Dismissed'}
            </span>
            {s.kind === 'record_change' ? (
              FIELDS.filter(([k]) => text(s.preview[k])).map(([k, label]) => {
                const was = text((s.preview.was as Record<string, unknown> | undefined)?.[k]);
                return (
                  <label key={k} className="flex flex-col gap-0.5 text-[12px] text-text-3">
                    <span>
                      {label}
                      {was ? ` (now ${was})` : ' (none on file)'}
                    </span>
                    <input
                      className="rounded-control border border-border bg-card px-2 py-1 text-[13px] text-text"
                      aria-label={label}
                      value={text(p[k])}
                      disabled={!pending}
                      onChange={(e) => edit(s.id, k, e.target.value)}
                    />
                  </label>
                );
              })
            ) : s.kind === 'task' ? (
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
                  {APPROVE[s.kind]}
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
