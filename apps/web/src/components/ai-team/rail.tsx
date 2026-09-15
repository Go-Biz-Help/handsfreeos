'use client';
import { isPatchFix, type TeammateIssue, type TeammatePatchFix } from '@hfos/core';
import {
  AlertCircle,
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronRight,
  CornerUpLeft,
  FlaskConical,
  PowerOff,
  Undo2,
  Zap,
} from 'lucide-react';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Button, buttonClassName } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import {
  plural,
  progressAfter,
  STATUS_NAMES,
  statusLine,
  type ProgressView,
} from '@/lib/ai-team/describe';
import type { TeammateStatus } from '@/lib/ai-team/types';
import { cn } from '@/lib/utils';
import { TeammateLabelChips, TeammateStatusBadge } from './chips';
import { AI_FILL, TeammateMark } from './mark';
import { Choice, Note } from './parts';

const STATUSES: readonly TeammateStatus[] = ['off', 'training', 'automatic'];

/** "17 of 20 approved · 3 edited", "3 to go" and the bar. */
export function ProgressBlock({
  progress,
  name,
  showRejected,
  className,
}: {
  progress: ProgressView;
  name: string;
  /** Autonomy shows the rejections instead of what's left. */
  showRejected?: boolean;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)} data-testid="teammate-progress">
      <div className="flex items-center justify-between gap-2 text-[13px]">
        <span className="font-semibold">{progress.text}</span>
        <span className="whitespace-nowrap text-xs text-text-3">
          {showRejected ? `${progress.rejected} rejected` : progress.toGo}
        </span>
      </div>
      <div
        className="h-1.5 overflow-hidden rounded-full bg-card-3"
        role="progressbar"
        aria-label="Approvals"
        aria-valuemin={0}
        aria-valuemax={progress.needed}
        aria-valuenow={Math.min(progress.approved, progress.needed)}
      >
        <span
          className={cn('block h-full rounded-full', AI_FILL)}
          style={{ width: `${progress.percent}%` }}
        />
      </div>
      {showRejected ? null : (
        <span className="text-xs text-text-3">{progressAfter(progress, name)}</span>
      )}
    </div>
  );
}

/** Off, Training wheels or Automatic, with the progress and the ways between them. */
export function StatusCard({
  name,
  status,
  progress,
  blocking,
  readOnly,
  busy,
  automaticNote,
  onStatus,
  bare,
}: {
  name: string;
  status: TeammateStatus;
  progress: ProgressView;
  /** Red items: they stop it being turned on. */
  blocking: boolean;
  readOnly: boolean;
  busy: boolean;
  automaticNote: string | null;
  onStatus: (next: TeammateStatus) => void;
  /** Without the card (inside the phone's sheet). */
  bare?: boolean;
}) {
  const body = (
    <>
      <h3 className="text-[15px] font-semibold">Status</h3>
      <div role="radiogroup" aria-label={`${name}’s status`} className="flex flex-col gap-1.5">
        {STATUSES.map((s) => (
          <Choice
            key={s}
            compact
            on={status === s}
            disabled={readOnly || busy || (s !== 'off' && status === 'off' && blocking)}
            onSelect={() => {
              if (s !== status) onStatus(s);
            }}
            title={STATUS_NAMES[s]}
            testId={`status-${s}`}
          />
        ))}
      </div>
      <p className="text-xs text-text-2">{statusLine(status, name)}</p>
      {status === 'training' ? (
        <>
          <ProgressBlock progress={progress} name={name} />
          {readOnly ? null : (
            <Button
              variant="secondary"
              size="sm"
              className="self-start"
              disabled={busy}
              onClick={() => onStatus('automatic')}
              data-testid="switch-automatic"
            >
              <Zap className="h-3.5 w-3.5" strokeWidth={1.75} />
              Switch to automatic now
            </Button>
          )}
        </>
      ) : null}
      {status === 'automatic' ? (
        <>
          {automaticNote ? <Note icon={Zap}>{automaticNote}</Note> : null}
          {readOnly ? null : (
            <div className="flex flex-col items-start gap-1">
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => onStatus('training')}
                data-testid="back-to-training"
              >
                <CornerUpLeft className="h-3.5 w-3.5" strokeWidth={1.75} />
                Back to training
              </Button>
              <span className="text-xs text-text-3">
                Starts the count again at 0 of {progress.needed}.
              </span>
            </div>
          )}
        </>
      ) : null}
      {status === 'off' ? (
        <>
          <Note icon={PowerOff}>
            {name} is off. New texts and chats go to the team, and the website chat shows your away
            message.
          </Note>
          {blocking && !readOnly ? (
            <p className="text-xs font-medium text-danger-text">
              Fix the red items under Things to check to turn it on.
            </p>
          ) : null}
        </>
      ) : null}
    </>
  );
  return bare ? (
    <div className="flex flex-col gap-3" data-testid="teammate-status-card">
      {body}
    </div>
  ) : (
    <Card className="flex flex-col gap-3 px-[18px] py-4" data-testid="teammate-status-card">
      {body}
    </Card>
  );
}

/** "Switch to automatic now" and "Back to training" ask first. */
export function StatusConfirm({
  ask,
  name,
  needed,
  busy,
  onCancel,
  onConfirm,
}: {
  ask: 'automatic' | 'training' | null;
  name: string;
  needed: number;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const automatic = ask === 'automatic';
  return (
    <Dialog open={!!ask} onOpenChange={(o) => !o && !busy && onCancel()}>
      <DialogContent
        title={
          automatic ? `Switch ${name} to automatic now?` : `Put ${name} back in training wheels?`
        }
        description={
          automatic
            ? `${name} replies to customers without waiting for an OK, before it reaches ${needed} approvals. Discounts still wait for one, and you can go back to training at any time.`
            : `Every message to a customer waits for an OK again, and the progress starts again at 0 of ${needed}.`
        }
      >
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button loading={busy} onClick={onConfirm} data-testid="status-confirm">
            {automatic ? 'Switch to automatic' : 'Back to training'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** "How Ava works": the labels and a few plain sentences. */
export function HowCard({
  name,
  tags,
  lines,
  bare,
}: {
  name: string;
  tags: readonly string[];
  lines: readonly string[];
  bare?: boolean;
}) {
  const body = (
    <>
      <h3 className="mb-2.5 text-[15px] font-semibold">How {name} works</h3>
      <TeammateLabelChips tags={tags} testId="teammate-labels" className="mb-2.5" />
      <ul className="flex flex-col gap-1.5" data-testid="teammate-how">
        {lines.map((s) => (
          <li key={s} className="flex items-start gap-2.5 text-[13px]">
            <Check className="mt-0.5 h-4 w-4 flex-none text-accent-text" strokeWidth={1.75} />
            <span>{s}</span>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-[12.5px] text-text-3">
        The labels are worked out from its skills. They never limit what you can change.
      </p>
    </>
  );
  return bare ? <div>{body}</div> : <Card className="px-[18px] py-4">{body}</Card>;
}

/** Conflicts, each with Fix buttons: settings fixes change the draft (with Undo), links go to the page
 * that sorts it out. */
export function IssueList({
  workspaceId,
  issues,
  status,
  lastFix,
  readOnly,
  onFix,
  onUndoFix,
}: {
  workspaceId: string;
  issues: readonly TeammateIssue[];
  status: TeammateStatus;
  lastFix: string | null;
  readOnly: boolean;
  onFix: (fix: TeammatePatchFix) => void;
  onUndoFix: () => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      {lastFix ? (
        <div
          className="flex items-start gap-2.5 rounded-menu border border-[color-mix(in_oklab,var(--success)_30%,var(--border))] bg-[color-mix(in_oklab,var(--success-soft)_60%,var(--card))] px-3.5 py-3"
          data-testid="teammate-last-fix"
        >
          <CheckCircle2 className="mt-0.5 h-4 w-4 flex-none text-success-text" strokeWidth={1.75} />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="text-[13px] font-medium">Done: {lastFix}.</span>
            <span className="mt-0.5 text-xs text-text-2">
              Nothing else changed. Save when you’re ready.
            </span>
          </span>
          <Button variant="ghost" size="sm" onClick={onUndoFix} data-testid="teammate-undo-fix">
            Undo
          </Button>
        </div>
      ) : null}
      {issues.map((issue) => {
        const error = issue.severity === 'error';
        const fixes = issue.fixes.filter((f) => !readOnly || !isPatchFix(f));
        return (
          <div
            key={`${issue.code}-${issue.message}`}
            data-testid={`issue-${issue.code}`}
            className={cn(
              'flex items-start gap-2.5 rounded-menu border px-3.5 py-3',
              error
                ? 'border-[color-mix(in_oklab,var(--danger)_35%,var(--border))] bg-[color-mix(in_oklab,var(--danger-soft)_60%,var(--card))]'
                : 'border-[color-mix(in_oklab,var(--warning)_35%,var(--border))] bg-[color-mix(in_oklab,var(--warning-soft)_60%,var(--card))]',
            )}
          >
            {error ? (
              <AlertCircle
                className="mt-0.5 h-4 w-4 flex-none text-danger-text"
                strokeWidth={1.75}
              />
            ) : (
              <AlertTriangle
                className="mt-0.5 h-4 w-4 flex-none text-warning-text"
                strokeWidth={1.75}
              />
            )}
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="text-[13px] font-medium">{issue.message}</span>
              <span
                className={cn(
                  'mt-0.5 text-xs font-medium',
                  error ? 'text-danger-text' : 'text-warning-text',
                )}
              >
                {error
                  ? status === 'off'
                    ? 'Blocks turning it on'
                    : 'Needs fixing: it can’t work this way'
                  : 'Doesn’t block saving'}
              </span>
              {fixes.length ? (
                <span className="mt-2.5 flex flex-wrap items-center gap-1.5">
                  <span className="mr-0.5 text-xs font-semibold text-text-3">Fix:</span>
                  {fixes.map((fix) =>
                    isPatchFix(fix) ? (
                      <Button
                        key={fix.id}
                        variant="secondary"
                        size="sm"
                        className="h-7 text-[12.5px]"
                        data-testid={`fix-${issue.code}-${fix.id}`}
                        onClick={() => onFix(fix)}
                      >
                        {fix.label}
                      </Button>
                    ) : (
                      <Link
                        key={fix.id}
                        href={`/app/w/${workspaceId}/${fix.href}`}
                        data-testid={`fix-${issue.code}-${fix.id}`}
                        className={buttonClassName({
                          variant: 'secondary',
                          size: 'sm',
                          className: 'h-7 text-[12.5px]',
                        })}
                      >
                        {fix.label}
                      </Link>
                    ),
                  )}
                </span>
              ) : null}
            </span>
          </div>
        );
      })}
      {!issues.length && !lastFix ? (
        <div className="flex items-center gap-2.5 rounded-menu border border-[color-mix(in_oklab,var(--success)_30%,var(--border))] bg-[color-mix(in_oklab,var(--success-soft)_60%,var(--card))] px-3.5 py-3 text-[13px]">
          <CheckCircle2 className="h-4 w-4 flex-none text-success-text" strokeWidth={1.75} />
          Nothing to fix.
        </div>
      ) : null}
    </div>
  );
}

export function IssuesHeading({ issues }: { issues: readonly TeammateIssue[] }) {
  const errors = issues.some((i) => i.severity === 'error');
  return (
    <div className="mb-2.5 flex items-center justify-between gap-2">
      <h3 className="text-[15px] font-semibold">Things to check</h3>
      <Badge variant={issues.length ? (errors ? 'danger' : 'pending') : 'ok'}>
        {issues.length ? plural(issues.length, 'item', 'items') : 'All clear'}
      </Badge>
    </div>
  );
}

/** Save, with where things stand and a way to Undo and into History. */
export function SaveCard({
  dirty,
  revision,
  saving,
  readOnly,
  canUndo,
  undoLabel,
  onUndo,
  onSave,
  onHistory,
}: {
  dirty: boolean;
  revision: number;
  saving: boolean;
  readOnly: boolean;
  canUndo: boolean;
  undoLabel: string | null;
  onUndo: () => void;
  onSave: () => void;
  onHistory: () => void;
}) {
  return (
    <Card className="flex items-center gap-2 py-3 pl-[18px] pr-3" data-testid="teammate-save-card">
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-[13px] font-medium" data-testid="teammate-save-note">
          {readOnly
            ? `Revision ${revision}`
            : dirty
              ? 'Unsaved changes'
              : `All changes saved · revision ${revision}`}
        </span>
        <button
          type="button"
          onClick={onHistory}
          className="self-start text-xs text-accent-text hover:underline"
        >
          See history
        </button>
      </span>
      {!readOnly && canUndo ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={onUndo}
          title={undoLabel ? `Undo: ${undoLabel}` : 'Undo'}
          data-testid="teammate-undo"
        >
          <Undo2 className="h-3.5 w-3.5" strokeWidth={1.75} />
          Undo
        </Button>
      ) : null}
      {readOnly ? null : (
        <Button onClick={onSave} loading={saving} disabled={!dirty} data-testid="teammate-save">
          Save
        </Button>
      )}
    </Card>
  );
}

/** The rail folded into a card at the top of the phone's builder. */
export function PhoneSummary({
  name,
  status,
  saved,
  progress,
  issues,
  blocking,
  readOnly,
  busy,
  onStatus,
  onTest,
  onChecks,
}: {
  name: string;
  status: TeammateStatus;
  saved: string | null;
  progress: ProgressView;
  issues: readonly TeammateIssue[];
  blocking: boolean;
  readOnly: boolean;
  busy: boolean;
  onStatus: (next: TeammateStatus) => void;
  onTest?: () => void;
  /** Opens the status, labels and things to check. */
  onChecks: () => void;
}) {
  const errors = issues.some((i) => i.severity === 'error');
  const touch = 'h-11 flex-1 text-[14px]';
  return (
    <div
      className="-mx-4 -mt-4 flex flex-col gap-2.5 border-b border-border bg-card px-4 py-3.5 lg:hidden"
      data-testid="teammate-phone-summary"
    >
      <div className="flex items-center gap-2.5">
        <TeammateMark size="lg" label={`${name} (AI)`} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-lg font-semibold leading-tight">{name}</span>
          {saved ? <span className="truncate text-xs text-text-3">{saved}</span> : null}
        </span>
        <TeammateStatusBadge status={status} testId="teammate-status-phone" />
      </div>
      {status === 'training' ? (
        <div className="flex flex-col gap-[5px]">
          <div className="flex items-center justify-between gap-2 text-[13px]">
            <span className="font-semibold">{progress.text}</span>
            <span className="text-xs text-text-3">{progress.toGo}</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-card-3" aria-hidden>
            <span
              className={cn('block h-full rounded-full', AI_FILL)}
              style={{ width: `${progress.percent}%` }}
            />
          </div>
        </div>
      ) : null}
      <div className="flex gap-2">
        {readOnly ? null : status === 'training' ? (
          <Button
            variant="secondary"
            className={touch}
            disabled={busy}
            onClick={() => onStatus('automatic')}
          >
            <Zap className="h-4 w-4" strokeWidth={1.75} />
            Automatic now
          </Button>
        ) : status === 'automatic' ? (
          <Button
            variant="secondary"
            className={touch}
            disabled={busy}
            onClick={() => onStatus('training')}
          >
            <CornerUpLeft className="h-4 w-4" strokeWidth={1.75} />
            Back to training
          </Button>
        ) : (
          <Button
            className={touch}
            disabled={busy || blocking}
            onClick={() => onStatus('training')}
          >
            Turn on
          </Button>
        )}
        {onTest ? (
          <Button variant="secondary" className={touch} onClick={onTest}>
            <FlaskConical className="h-4 w-4" strokeWidth={1.5} />
            Test console
          </Button>
        ) : null}
      </div>
      <button
        type="button"
        onClick={onChecks}
        data-testid="teammate-phone-checks"
        className={cn(
          'flex h-11 items-center gap-2.5 rounded-menu px-3 text-left text-[13px] font-semibold focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring',
          issues.length
            ? errors
              ? 'bg-danger-soft text-danger-text'
              : 'bg-warning-soft text-warning-text'
            : 'bg-card-2 text-text-2',
        )}
      >
        {issues.length ? (
          <AlertTriangle className="h-4 w-4 flex-none" strokeWidth={1.75} />
        ) : (
          <CheckCircle2 className="h-4 w-4 flex-none" strokeWidth={1.75} />
        )}
        <span className="flex-1">
          {issues.length
            ? `${plural(issues.length, 'thing', 'things')} to check`
            : 'Status, labels and checks'}
        </span>
        <ChevronRight className="h-4 w-4 flex-none" strokeWidth={1.75} />
      </button>
    </div>
  );
}
