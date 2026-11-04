'use client';
import { CALL_REVIEW_WORDS as W, callReviewLabel } from '@hfos/core';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';

type Review = {
  summary: string | null;
  /** A phone call's words; null for the others. */
  transcript: string | null;
  items: {
    id: string;
    kind: 'task' | 'follow_up' | 'record_change';
    status: 'pending' | 'approved' | 'dismissed';
    preview: Record<string, unknown>;
    taskId: string | null;
  }[];
};

const text = (v: unknown) => (typeof v === 'string' ? v : '');
const FIELDS = [
  ['firstName', 'First name'],
  ['lastName', 'Last name'],
  ['email', 'Email'],
  ['phone', 'Phone'],
] as const;

/**
 * An appointment's call, a HandsFreeOS video call that isn't for one (docs/video-calls.md, part 5), or a phone call on
 * the business number (20261027023200).
 */
export type ReviewedCall = { appointmentId: string } | { videoCallId: string } | { callId: string };

/**
 * What the AI made of a recorded call: its summary (already on the customer's timeline), the tasks it added (open
 * each on Tasks, or delete it there), and the follow-up and record update it suggests, each waiting for someone to
 * approve (as they are, or edited) or dismiss. A phone call's words show under it.
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
  const callId = 'callId' in call ? call.callId : undefined;
  const [review, setReview] = useState<Review | null>(null);
  const [edits, setEdits] = useState<Record<string, Record<string, string>>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setReview(
        unwrap(
          await apiBrowser().POST('/v1/queries/call_suggestion.list', {
            body: {
              workspaceId,
              ...(appointmentId ? { appointmentId } : callId ? { callId } : { videoCallId }),
            },
          }),
        ) as Review,
      );
    } catch {
      // The transcript section still shows; the review appears on the next refresh.
    }
  }, [workspaceId, appointmentId, videoCallId, callId]);
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

  if (callId && review && !review.summary && !review.transcript && review.items.length === 0)
    return <p className="pt-1.5 text-[13px] text-text-2">{W.saidSoon}</p>;
  if (!review || (!review.summary && !review.transcript && review.items.length === 0)) return null;
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
            <span className="flex items-center justify-between gap-2 text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3">
              {callReviewLabel(s.kind, s.status)}
              {s.kind === 'task' && s.taskId ? (
                <Link
                  href={`/app/w/${workspaceId}/tasks?scope=all&task=${s.taskId}`}
                  className="normal-case tracking-normal text-accent-text hover:underline"
                  data-testid="call-suggestion-task"
                >
                  {W.openTask}
                </Link>
              ) : null}
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
                  {W.approve[s.kind]}
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
      {review.transcript ? (
        <div className="flex flex-col gap-1" data-testid="call-review-said">
          <span className="text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3">
            {W.said}
          </span>
          <p className="max-h-[40vh] overflow-y-auto whitespace-pre-line text-[13px] leading-[1.5] text-text">
            {review.transcript}
          </p>
        </div>
      ) : null}
    </div>
  );
}
