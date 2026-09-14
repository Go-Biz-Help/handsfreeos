'use client';
import {
  findStep,
  type WorkflowDefinition,
  type WorkflowIssue,
  type WorkflowNames,
} from '@hfos/core';
import { AlertCircle, AlertTriangle, CheckCircle2, Clock } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { stepLines } from '@/lib/workflows/steps';
import { cn } from '@/lib/utils';

export function issueCounts(issues: readonly WorkflowIssue[]): {
  errors: number;
  warnings: number;
} {
  const errors = issues.filter((i) => i.severity === 'error').length;
  return { errors, warnings: issues.length - errors };
}

/** The number on the Checks tab: red when something blocks publishing, amber for warnings only. */
export function ChecksCount({ issues }: { issues: readonly WorkflowIssue[] }) {
  const { errors } = issueCounts(issues);
  return (
    <span
      data-testid="checks-count"
      className={cn(
        'inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1.5 text-[11px] font-semibold leading-none',
        !issues.length
          ? 'bg-card-3 text-text-2'
          : errors
            ? 'bg-danger text-on-solid'
            : 'bg-warning text-on-solid',
      )}
    >
      {issues.length}
    </span>
  );
}

/** Things to check: each problem in plain words, the step it's about, and fixes that are ordinary edits. */
export function ChecksPanel({
  issues,
  def,
  names,
  readOnly,
  tested,
  liveVersion,
  lastFix,
  onFix,
  onUndoFix,
  onSelectStep,
}: {
  issues: readonly WorkflowIssue[];
  def: WorkflowDefinition;
  names: WorkflowNames;
  readOnly: boolean;
  /** The draft as it is passed a test. */
  tested: boolean;
  liveVersion: number | null;
  lastFix: string | null;
  onFix: (issue: WorkflowIssue, fix: WorkflowIssue['fixes'][number]) => void;
  onUndoFix: () => void;
  onSelectStep: (stepId: string | null) => void;
}) {
  const { errors } = issueCounts(issues);
  return (
    <div data-testid="workflow-checks">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-[15px] font-semibold">Things to check</h3>
        <Badge variant={issues.length ? (errors ? 'danger' : 'pending') : 'ok'}>
          {issues.length
            ? `${issues.length} ${issues.length === 1 ? 'item' : 'items'}`
            : 'All clear'}
        </Badge>
      </div>
      <div className="flex flex-col gap-2">
        {lastFix ? (
          <div className="flex items-start gap-2.5 rounded-[10px] border border-[color-mix(in_oklab,var(--success)_30%,var(--border))] bg-[color-mix(in_oklab,var(--success-soft)_60%,var(--card))] px-3.5 py-3">
            <CheckCircle2
              className="mt-0.5 h-4 w-4 flex-none text-success-text"
              strokeWidth={1.75}
            />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="text-[13px] font-medium" data-testid="fix-done">
                Done: {lastFix}.
              </span>
              <span className="mt-0.5 text-xs text-text-2">It’s saved with the draft.</span>
            </span>
            <Button variant="ghost" size="sm" onClick={onUndoFix}>
              Undo
            </Button>
          </div>
        ) : null}
        {issues.map((issue, n) => {
          const error = issue.severity === 'error';
          const step = issue.stepId ? findStep(def, issue.stepId)?.step : undefined;
          return (
            <div
              key={`${issue.code}-${issue.stepId}-${n}`}
              data-testid={`issue-${issue.code}`}
              className={cn(
                'flex items-start gap-2.5 rounded-[10px] border px-3.5 py-3',
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
                <span className="mt-0.5 text-xs text-text-2">
                  {step ? (
                    <button
                      type="button"
                      onClick={() => onSelectStep(issue.stepId)}
                      className="font-medium text-accent-text hover:underline"
                    >
                      {stepLines(step, names, def).title}
                    </button>
                  ) : issue.stepId === null && issue.fields.some((f) => f.startsWith('trigger')) ? (
                    <button
                      type="button"
                      onClick={() => onSelectStep(null)}
                      className="font-medium text-accent-text hover:underline"
                    >
                      The trigger
                    </button>
                  ) : null}
                  {step || issue.fields.some((f) => f.startsWith('trigger')) ? ' · ' : ''}
                  <span className={error ? 'text-danger-text' : 'text-warning-text'}>
                    {error ? 'Blocks publishing' : 'Doesn’t block publishing'}
                  </span>
                </span>
                {issue.fixes.length && !readOnly ? (
                  <span className="mt-2.5 flex flex-wrap items-center gap-1.5">
                    <span className="mr-0.5 text-xs font-semibold text-text-3">Fix:</span>
                    {issue.fixes.map((fix) => (
                      <Button
                        key={fix.id}
                        variant="secondary"
                        size="sm"
                        className="h-7 text-[12.5px]"
                        data-testid={`fix-${issue.code}-${fix.id}`}
                        onClick={() => onFix(issue, fix)}
                      >
                        {fix.label}
                      </Button>
                    ))}
                  </span>
                ) : null}
              </span>
            </div>
          );
        })}
        {!issues.length && !lastFix ? (
          <div className="flex items-center gap-2.5 rounded-[10px] border border-[color-mix(in_oklab,var(--success)_30%,var(--border))] bg-[color-mix(in_oklab,var(--success-soft)_60%,var(--card))] px-3.5 py-3 text-[13px]">
            <CheckCircle2 className="h-4 w-4 flex-none text-success-text" strokeWidth={1.75} />
            Nothing to fix.
          </div>
        ) : null}
      </div>

      <div className="mt-5 text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3">
        Before it can publish
      </div>
      <ul className="mt-2 flex flex-col gap-1.5 text-[12.5px] text-text-2">
        <li className="flex items-center gap-2">
          {errors ? (
            <AlertCircle className="h-4 w-4 text-danger-text" strokeWidth={1.75} />
          ) : (
            <CheckCircle2 className="h-4 w-4 text-success-text" strokeWidth={1.75} />
          )}
          {errors ? `${errors} red ${errors === 1 ? 'item' : 'items'} to fix` : 'No red items'}
        </li>
        <li className="flex items-center gap-2">
          {tested ? (
            <CheckCircle2 className="h-4 w-4 text-success-text" strokeWidth={1.75} />
          ) : (
            <Clock className="h-4 w-4 text-text-3" strokeWidth={1.75} />
          )}
          A passing test of this exact draft
        </li>
      </ul>
      <p className="mt-2 text-[12.5px] text-text-3">
        {liveVersion
          ? `Publishing makes version ${liveVersion + 1}. Runs already going finish on version ${liveVersion}.`
          : 'Publishing makes version 1. Any change after a test needs a new test.'}
      </p>
    </div>
  );
}
