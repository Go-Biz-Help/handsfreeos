'use client';
import { BookOpen, Check, Clock, FileText, Info, Lock, LockOpen, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { FieldError, Label } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import { useLiveRefresh } from '@/lib/realtime/live-provider';
import { cn, relativeTime } from '@/lib/utils';
import { KindTile } from '../chips';
import type { Approval } from './types';
import { approvalsChanged } from './use-waiting-approvals';
import {
  approvalTitle,
  customerOf,
  decidedLine,
  expiresIn,
  nameList,
  previewOf,
  segmentLabel,
  waitedFor,
  type ApprovalPreview,
} from './words';

type View = 'waiting' | 'decided';

const SECTION = 'text-xs font-semibold uppercase tracking-[0.06em] text-text-3';
const CHIP =
  'inline-flex max-w-full items-center gap-1 rounded-[7px] bg-card-2 px-2 py-[3px] text-xs font-medium text-text-2';

/** The clock the page counts down with: the server's at first (so hydration matches), then the browser's. */
function useNow(initial: number, everyMs = 30_000): number {
  const [now, setNow] = useState(initial);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}

/**
 * The Approvals page: approval steps waiting for the viewer, each showing what will happen (the AI-written
 * text, editable; the customer and what they said; the knowledge used; the workflow; the run; the time left),
 * with Approve, or Reject with a reason. The Decided view lists what was approved, rejected or expired lately.
 * It follows approvals opened, decided and expired, live.
 */
export function ApprovalsBoard({
  workspaceId,
  waiting,
  decided,
  allowPrices,
  serverNow,
}: {
  workspaceId: string;
  /** Pending approvals the viewer can decide, newest first. */
  waiting: Approval[];
  /** Approvals decided or expired lately that were the viewer's to decide. */
  decided: Approval[];
  /** The business's "AI may quote prices" switch (null when unknown). */
  allowPrices: boolean | null;
  /** When the server rendered the page. */
  serverNow: number;
}) {
  useLiveRefresh(['workflow_approval']);
  const now = useNow(serverNow);
  const [view, setView] = useState<View>('waiting');
  const [done, setDone] = useState<ReadonlySet<string>>(() => new Set());
  const open = waiting.filter((a) => !done.has(a.id));
  const tabs: readonly { id: View; label: string }[] = [
    { id: 'waiting', label: `Waiting · ${open.length}` },
    { id: 'decided', label: `Decided · ${decided.length}` },
  ];
  return (
    <div data-testid="approvals-board">
      <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
        <h2 className={SECTION}>{view === 'waiting' ? 'Waiting for you' : 'Decided lately'}</h2>
        <div role="tablist" aria-label="Approvals" className="flex gap-1.5">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={view === t.id}
              data-testid={`approvals-tab-${t.id}`}
              onClick={() => setView(t.id)}
              className={cn(
                'h-7 rounded-full border px-3 text-[13px] font-medium transition-colors',
                view === t.id
                  ? 'border-accent bg-accent-soft text-accent-text'
                  : 'border-border bg-card text-text-2 hover:text-text',
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>
      {view === 'decided' ? (
        <DecidedList workspaceId={workspaceId} items={decided} now={now} />
      ) : open.length ? (
        <div className="flex flex-col gap-2.5">
          {open.map((a, i) => (
            <ApprovalCard
              key={a.id}
              a={a}
              workspaceId={workspaceId}
              now={now}
              allowPrices={allowPrices}
              startOpen={i === 0}
              onDone={() => setDone((s) => new Set(s).add(a.id))}
            />
          ))}
        </div>
      ) : (
        <Card data-testid="approvals-empty">
          <EmptyState title="Nothing waiting for you">
            When a workflow’s approval step needs you, it shows up here, on Home and by email.
          </EmptyState>
        </Card>
      )}
    </div>
  );
}

function fieldLabel(p: ApprovalPreview, key: string): string {
  if (p.channel === 'sms') return 'The text that will go';
  if (p.channel === 'email') return 'The email that will go';
  return `The AI’s words (${key})`;
}

function ApprovalCard({
  a,
  workspaceId,
  now,
  allowPrices,
  startOpen,
  onDone,
}: {
  a: Approval;
  workspaceId: string;
  now: number;
  allowPrices: boolean | null;
  startOpen: boolean;
  onDone: () => void;
}) {
  const router = useRouter();
  const p = useMemo(() => previewOf(a), [a]);
  const [open, setOpen] = useState(startOpen);
  const [drafts, setDrafts] = useState<Record<string, string>>(() => Object.fromEntries(p.fields));
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const who = customerOf(a, p);
  const first = who.split(/\s+/)[0] || who;
  const expires = expiresIn(a.expiresAt, now);
  const expired = expires === 'Expired';
  const textOf = (key: string, original: string) => drafts[key] ?? original;
  const blank = p.fields.some(([k, v]) => !textOf(k, v).trim());
  const sends = p.fields.length > 0 && p.channel !== null;
  const asked = a.approvers.length ? `asked ${nameList(a.approvers)}` : 'for owners and admins';
  const byline = `${a.workflow.name} · ${asked} · waiting ${waitedFor(a.createdAt, now)}`;
  const hasContext = !!(p.note || p.asked || p.items.length || (sends && allowPrices !== null));

  async function decide(decision: 'approve' | 'reject') {
    setBusy(decision);
    const edits = Object.fromEntries(
      p.fields.filter(([k, v]) => textOf(k, v) !== v).map(([k, v]) => [k, textOf(k, v).trim()]),
    );
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/workflow.decide_approval', {
          body: {
            workspaceId,
            approvalId: a.id,
            decision,
            ...(decision === 'approve' && Object.keys(edits).length ? { edits } : {}),
            ...(decision === 'reject' && reason.trim() ? { reason: reason.trim() } : {}),
          },
        }),
      );
      toast.success(
        decision === 'reject'
          ? 'Rejected. The workflow takes its rejected path.'
          : sends
            ? 'Approved. It goes out now.'
            : 'Approved. The workflow carries on.',
      );
      setRejecting(false);
      onDone();
      approvalsChanged();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
      router.refresh();
    }
  }

  if (!open)
    return (
      <Card
        className="flex items-center gap-3 px-4 py-3"
        data-testid="approval-card"
        data-approval-id={a.id}
      >
        <KindTile tone="appr" icon={ShieldCheck} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[13.5px] font-semibold">{approvalTitle(a, p)}</span>
          <span className="truncate text-xs text-text-3">{byline}</span>
        </span>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => setOpen(true)}
          data-testid="approval-review"
        >
          Review
        </Button>
      </Card>
    );

  return (
    <Card
      className="border-[color-mix(in_oklab,var(--accent)_45%,var(--border))] px-4 py-4 shadow-[0_0_0_3px_var(--accent-soft)] md:px-[18px]"
      data-testid="approval-card"
      data-approval-id={a.id}
    >
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <KindTile tone="appr" icon={ShieldCheck} />
        <span className="flex min-w-0 flex-1 basis-56 flex-col gap-0.5">
          <h3 className="text-[15px] font-semibold leading-snug" data-testid="approval-title">
            {approvalTitle(a, p)}
          </h3>
          <span className="text-xs text-text-3">{byline}</span>
        </span>
        {expires ? (
          <span
            data-testid="approval-expires"
            className={cn(
              'inline-flex flex-none items-center gap-1 rounded-full px-2 py-1 text-xs font-medium',
              expired ? 'bg-danger-soft text-danger-text' : 'bg-warning-soft text-warning-text',
            )}
          >
            <Clock className="h-3.5 w-3.5" strokeWidth={1.75} />
            {expires}
          </span>
        ) : null}
      </div>

      <div
        className={cn(
          'mt-3.5 grid grid-cols-1 gap-4',
          hasContext && 'md:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)]',
        )}
      >
        {hasContext ? (
          <div className="flex min-w-0 flex-col gap-2">
            {p.note ? (
              <p className="text-[13px] text-text-2" data-testid="approval-note">
                {p.note}
              </p>
            ) : null}
            {p.asked ? (
              <>
                <span className={SECTION}>{first}’s latest message</span>
                <div
                  className="max-w-full whitespace-pre-wrap break-words rounded-[14px] rounded-bl-[4px] bg-card-2 px-3 py-2 text-[13.5px] leading-[1.45]"
                  data-testid="approval-asked"
                >
                  {p.asked}
                </div>
              </>
            ) : null}
            {p.items.length || (sends && allowPrices !== null) ? (
              <div className="flex flex-wrap items-center gap-1.5" data-testid="approval-knowledge">
                <span className="text-xs text-text-3">
                  {p.items.length ? 'Knowledge used:' : 'No knowledge items used.'}
                </span>
                {p.items.map((i) => (
                  <span key={i.id} className={CHIP} title={i.title}>
                    {i.kind === 'document' ? (
                      <FileText className="h-3.5 w-3.5 flex-none" strokeWidth={1.5} />
                    ) : (
                      <BookOpen className="h-3.5 w-3.5 flex-none" strokeWidth={1.5} />
                    )}
                    <span className="truncate">{i.title}</span>
                  </span>
                ))}
                {sends && allowPrices !== null ? (
                  <span className={CHIP} data-testid="approval-prices">
                    {allowPrices ? (
                      <LockOpen className="h-3.5 w-3.5" strokeWidth={1.5} />
                    ) : (
                      <Lock className="h-3.5 w-3.5" strokeWidth={1.5} />
                    )}
                    {allowPrices ? 'Prices allowed' : 'Prices are off'}
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="flex min-w-0 flex-col gap-2">
          {p.fields.length ? (
            p.fields.map(([key, original]) => {
              const value = textOf(key, original);
              const id = `approval-${a.id}-${key}`;
              return (
                <div key={key} className="flex flex-col gap-1.5">
                  <Label htmlFor={id} className={SECTION}>
                    {fieldLabel(p, key)} · you can edit it
                  </Label>
                  <Textarea
                    id={id}
                    data-testid={`approval-field-${key}`}
                    className="min-h-[104px] text-[14px]"
                    value={value}
                    maxLength={5000}
                    readOnly={busy !== null || expired}
                    invalid={!value.trim()}
                    onChange={(e) => setDrafts((d) => ({ ...d, [key]: e.target.value }))}
                  />
                  <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs text-text-3">
                    <span data-testid="approval-edited">
                      {value !== original
                        ? 'Edited: your version is what goes out.'
                        : 'Written by the AI.'}
                    </span>
                    {p.channel === 'sms' ? (
                      <span className="tabular-nums" data-testid="approval-segments">
                        {segmentLabel(value)}
                      </span>
                    ) : null}
                  </div>
                  {!value.trim() ? <FieldError>Write the text, or reject it.</FieldError> : null}
                </div>
              );
            })
          ) : (
            <p className="text-[13.5px] text-text-2">
              Approving lets {a.workflow.name} carry on for {who}.
            </p>
          )}
          <p className="flex items-start gap-2 rounded-[9px] bg-card-2 px-[11px] py-[9px] text-[12.5px] leading-[1.45] text-text-2">
            <Info className="mt-px h-3.5 w-3.5 flex-none" strokeWidth={1.75} />
            {expired
              ? 'This expired. The workflow goes on as its approval step says.'
              : 'If nobody decides in time, the workflow goes on as its approval step says.'}
          </p>
        </div>
      </div>

      <div className="mt-3.5 flex flex-wrap items-center gap-2 border-t border-border pt-3.5">
        <Button
          variant="primary"
          onClick={() => void decide('approve')}
          disabled={busy !== null || expired || blank}
          data-testid="approval-approve"
        >
          <Check className="h-4 w-4" strokeWidth={1.75} />
          {busy === 'approve' ? 'Approving…' : sends ? 'Approve and send' : 'Approve'}
        </Button>
        <Button
          variant="secondary"
          onClick={() => setRejecting(true)}
          disabled={busy !== null || expired}
          data-testid="approval-reject"
        >
          Reject…
        </Button>
        <span className="flex-1" />
        <Link
          href={`/app/w/${workspaceId}/workflows/runs/${a.runId}`}
          className="text-[13px] font-medium text-accent-text hover:underline"
          data-testid="approval-run"
        >
          Open the run
        </Link>
      </div>

      <Dialog
        open={rejecting}
        onOpenChange={(o) => {
          if (busy === null) setRejecting(o);
        }}
      >
        <DialogContent
          title="Reject it?"
          description={`${a.workflow.name} takes its “If it’s rejected” steps for ${who}, then the run ends.`}
        >
          <div className="mt-4 flex flex-col gap-1.5">
            <Label htmlFor={`reject-${a.id}`}>Why (optional)</Label>
            <Textarea
              id={`reject-${a.id}`}
              data-testid="reject-reason"
              className="min-h-[72px] text-[14px]"
              value={reason}
              maxLength={1000}
              placeholder="I’ll call them myself."
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
          <div className="mt-5 flex justify-end gap-2">
            <Button
              variant="secondary"
              onClick={() => setRejecting(false)}
              disabled={busy !== null}
            >
              Keep it
            </Button>
            <Button
              variant="danger"
              onClick={() => void decide('reject')}
              disabled={busy !== null}
              data-testid="reject-confirm"
            >
              {busy === 'reject' ? 'Rejecting…' : 'Reject'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function DecidedList({
  workspaceId,
  items,
  now,
}: {
  workspaceId: string;
  items: Approval[];
  now: number;
}) {
  if (!items.length)
    return (
      <Card data-testid="approvals-decided-empty">
        <EmptyState title="Nothing decided lately">
          Approved, rejected and expired approvals show here.
        </EmptyState>
      </Card>
    );
  return (
    <Card className="overflow-hidden" data-testid="approvals-decided">
      <ul>
        {items.map((a, i) => {
          const who = customerOf(a);
          return (
            <li
              key={a.id}
              data-testid="decided-row"
              data-status={a.status}
              className={cn(
                'flex items-center gap-2.5 px-4 py-2.5',
                i > 0 && 'border-t border-border',
              )}
            >
              <Avatar name={who} seed={a.person?.id ?? a.id} size="sm" />
              <span className="flex min-w-0 flex-1 flex-col md:flex-row md:items-center md:gap-3">
                <span className="flex min-w-0 flex-col md:w-44 md:flex-none">
                  <span className="truncate text-[13px] font-semibold">{who}</span>
                  <span className="truncate text-xs text-text-3">{a.workflow.name}</span>
                </span>
                <span className="min-w-0 break-words text-[13px] text-text-2">
                  {decidedLine(a)}
                </span>
              </span>
              <span className="flex flex-none flex-col items-end gap-0.5">
                <span className="text-xs text-text-3">
                  {relativeTime(a.decidedAt ?? a.createdAt, now)}
                </span>
                <Link
                  href={`/app/w/${workspaceId}/workflows/runs/${a.runId}`}
                  className="text-xs font-medium text-accent-text hover:underline"
                >
                  Run
                </Link>
              </span>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
