'use client';
import {
  applyWorkflowOps,
  blankDefinition,
  describeStep,
  describeTrigger,
  validateWorkflow,
  type WorkflowCatalogs,
  type WorkflowDefinition,
  type WorkflowOp,
} from '@hfos/core';
import { CircleCheck, TriangleAlert, Zap } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { WorkflowProposal } from '@/lib/api/types';
import { askBuilder, builderErrorMessage, NEW_EXAMPLES } from '@/lib/workflows/builder';
import { cn } from '@/lib/utils';
import { Drafting, RequestBubble, UnsupportedNote, type ShownProposal } from './describe';

/** A proposal for a new workflow, from the builder or from the Assistant's card (proposal_get). */
export function shownFromRecord(p: WorkflowProposal): ShownProposal {
  return {
    id: p.id,
    baseRevision: p.baseRevision,
    ops: p.ops as unknown as WorkflowOp[],
    changes: p.changes,
    reply: p.summary,
    unsupported: p.unsupported,
    requests: p.prompt.split('\n').filter((l) => l.trim()),
    outdated: p.expired || !!p.appliedAt,
  };
}

function resultOf(ops: readonly WorkflowOp[]): WorkflowDefinition | null {
  try {
    return applyWorkflowOps(blankDefinition(), ops).definition;
  } catch {
    return null;
  }
}

/**
 * "Describe it" on "How do you want to start?": a sentence, then the AI builder's proposal for a new
 * workflow (its trigger and steps, what it can't do, its checks), a follow-up that refines it, then Create
 * workflow, which applies the proposal as a new draft. Nothing is made until then.
 */
export function DescribeNew({
  workspaceId,
  catalogs,
  initialProposal,
  initialName,
  onCancel,
}: {
  workspaceId: string;
  catalogs: WorkflowCatalogs;
  initialProposal: ShownProposal | null;
  initialName: string | null;
  onCancel: () => void;
}) {
  const router = useRouter();
  const [shown, setShown] = useState<ShownProposal | null>(initialProposal);
  const [text, setText] = useState('');
  const [asking, setAsking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(
    initialProposal?.outdated ? 'That draft expired or was already used. Ask again.' : null,
  );
  const [name, setName] = useState(initialName ?? 'New workflow');
  const [creating, setCreating] = useState(false);

  const result = useMemo(() => (shown ? resultOf(shown.ops) : null), [shown]);
  const errors = useMemo(
    () => (result ? validateWorkflow(result, catalogs).filter((i) => i.severity === 'error') : []),
    [result, catalogs],
  );
  const usable = !!shown && !shown.outdated && !!result;

  async function ask(prompt: string) {
    const request = prompt.trim();
    if (!request || asking) return;
    setAsking(request);
    setError(null);
    try {
      const earlier = usable ? shown : null;
      const out = await askBuilder({
        workspaceId,
        workflowId: null,
        baseRevision: null,
        prompt: request,
        proposalId: earlier?.id ?? null,
      });
      setShown({
        id: out.proposalId,
        baseRevision: null,
        ops: out.ops,
        changes: out.summary,
        reply: out.reply,
        unsupported: out.unsupported,
        requests: [...(earlier?.requests ?? []), request],
        outdated: false,
      });
      setText('');
    } catch (e) {
      setError(builderErrorMessage(e));
    } finally {
      setAsking(null);
    }
  }

  async function create() {
    if (!shown || !usable || !name.trim()) return;
    setCreating(true);
    try {
      const out = unwrap(
        await apiBrowser().POST('/v1/commands/workflow_proposal.apply', {
          body: { workspaceId, proposalId: shown.id, name: name.trim() },
        }),
      );
      toast.success(`Created the draft “${name.trim()}”. Test it before you publish.`);
      router.push(`/app/w/${workspaceId}/workflows/${out.workflowId}`);
    } catch (e) {
      toast.error(errorMessage(e));
      setCreating(false);
    }
  }

  const steps = result ? result.steps.map((s) => describeStep(s, catalogs, result)) : [];
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-3" data-testid="describe-new">
      <div className="flex flex-col gap-0.5">
        <span className="text-xs text-text-3">Describe it · uses the daily AI limit</span>
        <h2 className="text-lg font-semibold tracking-tight">What should it do?</h2>
      </div>
      {!shown && !asking ? (
        <p className="text-[13px] text-text-2">
          Say it in a sentence. AI drafts the steps, and nothing is made until you create it.
        </p>
      ) : null}
      {!asking || usable
        ? shown?.requests.map((r, i) => <RequestBubble key={`${shown.id}-${i}`}>{r}</RequestBubble>)
        : null}
      {asking ? (
        <>
          <RequestBubble>{asking}</RequestBubble>
          <Drafting />
        </>
      ) : null}

      {shown && result && !asking ? (
        <div
          className="flex flex-col overflow-hidden rounded-[10px] border border-border bg-card"
          data-testid="describe-new-proposal"
        >
          {shown.reply ? (
            <p className="px-3 pt-2.5 text-[13px] text-text-2" data-testid="proposal-reply">
              {shown.reply}
            </p>
          ) : null}
          <div
            className="flex items-start gap-1.5 px-3 pt-2.5 text-[13px]"
            data-testid="describe-new-trigger"
          >
            <Zap className="mt-0.5 h-4 w-4 flex-none text-success-text" strokeWidth={1.75} />
            <span>{describeTrigger(result.trigger, catalogs)}</span>
          </div>
          <ol
            className="m-0 flex list-none flex-col gap-[7px] px-3 py-2.5"
            data-testid="describe-new-steps"
          >
            {steps.length ? (
              steps.map((s, i) => (
                <li key={i} className="flex items-start gap-2 text-[13px]">
                  <span className="inline-flex h-5 w-5 flex-none items-center justify-center rounded-full bg-card-2 text-[11px] font-semibold text-text-2">
                    {i + 1}
                  </span>
                  <span className="min-w-0 [overflow-wrap:anywhere]">{s}</span>
                </li>
              ))
            ) : (
              <li className="text-[13px] text-text-3">No steps yet.</li>
            )}
          </ol>
          {shown.unsupported.length ? <UnsupportedNote lines={shown.unsupported} /> : null}
          <div
            className={cn(
              'flex items-start gap-2 border-t border-border px-3 py-2 text-[12.5px]',
              errors.length ? 'bg-warning-soft text-warning-text' : 'text-text-2',
            )}
          >
            {errors.length ? (
              <TriangleAlert className="mt-0.5 h-3.5 w-3.5 flex-none" strokeWidth={1.5} />
            ) : (
              <CircleCheck
                className="mt-0.5 h-3.5 w-3.5 flex-none text-success-text"
                strokeWidth={1.5}
              />
            )}
            <span>
              {errors.length
                ? `${errors.length === 1 ? '1 thing' : `${errors.length} things`} to fix in Checks, like “${errors[0]!.message}”.`
                : 'Checks: nothing to fix. It still needs a test before you publish.'}
            </span>
          </div>
        </div>
      ) : null}

      {error ? (
        <div
          role="alert"
          className="rounded-control bg-danger-soft px-3 py-2 text-[13px] text-danger-text"
          data-testid="describe-error"
        >
          {error}
        </div>
      ) : null}

      <div className="flex flex-col gap-2">
        {!shown ? (
          <div className="flex flex-col gap-1.5">
            {NEW_EXAMPLES.map((x) => (
              <button
                key={x}
                type="button"
                disabled={!!asking}
                onClick={() => setText(x)}
                className="rounded-[9px] border border-border-strong bg-card px-2.5 py-2 text-left text-[12.5px] text-text-2 transition-colors hover:bg-card-2 disabled:opacity-60"
                data-testid="describe-example"
              >
                {x}
              </button>
            ))}
          </div>
        ) : null}
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void ask(text);
            }
          }}
          rows={3}
          maxLength={2000}
          disabled={!!asking}
          aria-label={usable ? 'Refine the workflow' : 'Describe the workflow'}
          placeholder={
            usable
              ? 'Refine it, like “and stop if they book”'
              : 'Like “text new leads within a minute”'
          }
          className="min-h-[76px] text-[14px]"
          data-testid="describe-new-input"
        />
        <div className="flex justify-end">
          <Button
            size="sm"
            variant={usable ? 'secondary' : 'primary'}
            onClick={() => void ask(text)}
            loading={!!asking}
            disabled={!text.trim()}
            data-testid="describe-new-send"
          >
            {usable ? 'Refine' : 'Draft it'}
          </Button>
        </div>
      </div>

      {usable ? (
        <div>
          <Label htmlFor="workflow-name-describe">Name</Label>
          <Input
            id="workflow-name-describe"
            inputSize="sm"
            aria-label="Workflow name"
            value={name}
            maxLength={120}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
      ) : null}
      <div className="flex-1" />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          loading={creating}
          disabled={!usable || !name.trim() || !!asking}
          onClick={() => void create()}
          data-testid="describe-new-create"
        >
          Create workflow
        </Button>
      </div>
    </div>
  );
}
