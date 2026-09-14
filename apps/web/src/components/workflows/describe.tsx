'use client';
import {
  describeStep,
  findStep,
  STEP_ID_RE,
  validateWorkflow,
  type WorkflowCatalogs,
  type WorkflowOp,
} from '@hfos/core';
import {
  CircleCheck,
  CircleSlash,
  LoaderCircle,
  Minus,
  Pencil,
  Plus,
  RotateCcw,
  TriangleAlert,
  Undo2,
  WandSparkles,
  X,
} from 'lucide-react';
import dynamic from 'next/dynamic';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { askBuilder, builderErrorMessage, EDIT_EXAMPLES } from '@/lib/workflows/builder';
import { proposalView } from '@/lib/workflows/diff';
import type { WorkflowDraft } from '@/lib/workflows/use-draft';
import { cn } from '@/lib/utils';
import { KindTile } from './chips';
import { StepList } from './step-list';

/** The canvas loads only when the preview shows it. */
const WorkflowCanvas = dynamic(() => import('./canvas/canvas').then((m) => m.WorkflowCanvas), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center bg-bg text-[13px] text-text-3">
      Loading the canvas…
    </div>
  ),
});

/** A proposal on screen: the builder's answer, or one opened from the Assistant's card (`?proposal=`). */
export interface ShownProposal {
  readonly id: string;
  readonly baseRevision: number | null;
  readonly ops: readonly WorkflowOp[];
  /** The ops in plain words. */
  readonly changes: readonly string[];
  /** The AI's own sentence about it. */
  readonly reply: string | null;
  readonly unsupported: readonly string[];
  /** What was asked, a request a line (a follow-up adds one). */
  readonly requests: readonly string[];
  /** The server says it can't be applied any more (the draft moved on, or it expired). */
  readonly outdated: boolean;
}

type Phase = 'pending' | 'applied' | 'undone' | 'discarded';

/** New, Changed or Removed, from how the line starts (describeOps words them this way). */
export function changeKind(line: string): 'added' | 'changed' | 'removed' {
  if (/^Add /.test(line)) return 'added';
  if (/^Remove /.test(line)) return 'removed';
  return 'changed';
}

const CHANGE_STYLE = {
  added: { icon: Plus, tag: 'New', tile: 'bg-success-soft text-success-text', badge: 'ok' },
  changed: {
    icon: Pencil,
    tag: 'Changed',
    tile: 'bg-warning-soft text-warning-text',
    badge: 'pending',
  },
  removed: {
    icon: Minus,
    tag: 'Removed',
    tile: 'bg-danger-soft text-danger-text',
    badge: 'danger',
  },
} as const;

export function ChangeRow({ line }: { line: string }) {
  const kind = changeKind(line);
  const style = CHANGE_STYLE[kind];
  const Icon = style.icon;
  return (
    <li
      className="flex items-start gap-2.5 border-t border-border py-2.5 first:border-t-0"
      data-testid="proposal-change"
      data-kind={kind}
    >
      <span
        aria-hidden
        className={cn(
          'mt-px inline-flex h-6 w-6 flex-none items-center justify-center rounded-[7px]',
          style.tile,
        )}
      >
        <Icon className="h-3.5 w-3.5" strokeWidth={1.75} />
      </span>
      <span className="min-w-0 flex-1 text-[13px] font-medium leading-[1.4] [overflow-wrap:anywhere]">
        {line}
      </span>
      <Badge variant={style.badge} className="h-5 flex-none text-[11px]">
        {style.tag}
      </Badge>
    </li>
  );
}

/** "I can’t do that yet": what was asked that workflows can't do. */
export function UnsupportedNote({ lines }: { lines: readonly string[] }) {
  return (
    <div
      role="note"
      className="flex items-start gap-2.5 border-t border-border bg-card-2 px-3.5 py-3 text-[13px]"
      data-testid="proposal-unsupported"
    >
      <CircleSlash className="mt-0.5 h-4 w-4 flex-none text-text-3" strokeWidth={1.5} />
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="font-semibold">I can’t do that yet</span>
        {lines.map((l, i) => (
          <span key={i} className="text-text-2 [overflow-wrap:anywhere]">
            {l}
          </span>
        ))}
      </span>
    </div>
  );
}

/** A request the person made, as a chat bubble. */
export function RequestBubble({ children }: { children: ReactNode }) {
  return (
    <div className="flex justify-end">
      <div
        className="max-w-[88%] rounded-[14px] rounded-br-[5px] bg-accent-soft px-3 py-2 text-[13.5px] leading-[1.45] text-text [overflow-wrap:anywhere]"
        data-testid="describe-request"
      >
        {children}
      </div>
    </div>
  );
}

export function Drafting() {
  return (
    <div
      className="flex items-center gap-2 text-[13px] text-text-3"
      role="status"
      data-testid="describe-working"
    >
      <LoaderCircle className="h-4 w-4 animate-spin" strokeWidth={1.5} />
      Drafting it…
    </div>
  );
}

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r(null)));

function replaceParam(key: string, value: string | null) {
  const params = new URLSearchParams(window.location.search);
  if (value) params.set(key, value);
  else params.delete(key);
  window.history.replaceState(null, '', `?${params.toString()}`);
}

export interface DescribePaneProps {
  readonly workspaceId: string;
  readonly workflowId: string;
  readonly draft: WorkflowDraft;
  readonly catalogs: WorkflowCatalogs;
  readonly canManage: boolean;
  /** The step selected in the editor: "this step" or "it" means it. */
  readonly selectedId: string | null;
  readonly onSelect: (id: string | null) => void;
  /** The mode the preview draws in: the one used last. */
  readonly previewMode: 'steps' | 'canvas';
  readonly onPreviewMode: (mode: 'steps' | 'canvas') => void;
  readonly wide: boolean;
  readonly phone: boolean;
  /** The live version runs already going keep. */
  readonly liveVersion: number | null;
  /** From `?proposal=`: the Assistant's draft of a change to open. */
  readonly initialProposalId: string | null;
}

/**
 * Describe, the third editor (design/m6/Describe.dc.html): ask for a change in plain words; the AI builder
 * drafts a proposal, shown as the changes in plain words next to a preview of the result in the mode used
 * last, with new, changed and removed steps marked. Apply is one edit to the same draft (one Undo); a
 * follow-up refines the proposal; Discard leaves the draft alone. A proposal made for an older revision is
 * never applied: it offers Ask again.
 */
export function DescribePane(props: DescribePaneProps) {
  const { draft, catalogs, workspaceId, workflowId } = props;
  const def = draft.definition;
  const latest = useRef(draft);
  useEffect(() => {
    latest.current = draft;
  }, [draft]);
  const [shown, setShown] = useState<ShownProposal | null>(null);
  const [phase, setPhase] = useState<Phase>('pending');
  const [asking, setAsking] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);

  // A proposal the Assistant drafted, opened from its card.
  useEffect(() => {
    const proposalId = props.initialProposalId;
    if (!proposalId) return;
    let cancelled = false;
    void (async () => {
      try {
        const { proposal } = unwrap(
          await apiBrowser().POST('/v1/queries/workflow.proposal_get', {
            body: { workspaceId, proposalId },
          }),
        );
        if (cancelled || proposal.workflowId !== workflowId) return;
        if (proposal.appliedAt) {
          setError('That change was already applied.');
          return;
        }
        setShown({
          id: proposal.id,
          baseRevision: proposal.baseRevision,
          ops: proposal.ops as unknown as WorkflowOp[],
          changes: proposal.changes,
          reply: proposal.summary,
          unsupported: proposal.unsupported,
          requests: proposal.prompt.split('\n').filter((l) => l.trim()),
          outdated: proposal.stale || proposal.expired,
        });
        setPhase('pending');
      } catch (e) {
        if (!cancelled) setError(builderErrorMessage(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [props.initialProposalId, workspaceId, workflowId]);

  const stale =
    !!shown &&
    phase === 'pending' &&
    (shown.outdated || draft.unsaved || draft.revision !== shown.baseRevision);
  const view = useMemo(
    () => (shown && phase === 'pending' && !stale ? proposalView(def, shown.ops) : null),
    [shown, phase, stale, def],
  );
  const cantApply = !!shown && phase === 'pending' && (stale || !view);
  const resultIssues = useMemo(
    () => (view ? validateWorkflow(view.result, catalogs) : []),
    [view, catalogs],
  );
  const errors = resultIssues.filter((i) => i.severity === 'error');
  const selected =
    props.selectedId && STEP_ID_RE.test(props.selectedId)
      ? (findStep(def, props.selectedId)?.step ?? null)
      : null;
  const refining = !!shown && phase === 'pending' && !cantApply;

  /** Saves what's waiting, then the revision the server has (null when a save is refused). */
  async function savedRevision(): Promise<number | null> {
    if (!(await latest.current.flush())) return null;
    for (let i = 0; i < 40 && latest.current.unsaved; i++) await nextFrame();
    return latest.current.unsaved ? null : latest.current.revision;
  }

  async function ask(prompt: string, refine: boolean) {
    const request = prompt.trim();
    if (!request || asking) return;
    setAsking(request);
    setError(null);
    try {
      const revision = await savedRevision();
      if (revision === null) {
        setError(
          'Your latest changes aren’t saved yet, so nothing was asked. Try again in a moment.',
        );
        return;
      }
      const earlier = refine && refining ? shown : null;
      const out = await askBuilder({
        workspaceId,
        workflowId,
        baseRevision: revision,
        prompt: request,
        selectedStepId: selected?.id ?? null,
        proposalId: earlier?.id ?? null,
      });
      setShown({
        id: out.proposalId,
        baseRevision: out.baseRevision,
        ops: out.ops,
        changes: out.summary,
        reply: out.reply,
        unsupported: out.unsupported,
        requests: [...(earlier?.requests ?? []), request],
        outdated: false,
      });
      setPhase('pending');
      setText('');
      replaceParam('proposal', out.proposalId);
    } catch (e) {
      setError(builderErrorMessage(e));
    } finally {
      setAsking(null);
    }
  }

  function apply() {
    if (!shown || !view) return;
    const label =
      shown.changes.length === 1 ? shown.changes[0]! : `Apply ${shown.changes.length} AI changes`;
    const out = draft.apply(shown.ops, label);
    if (!out.ok) return;
    const proposalId = shown.id;
    setPhase('applied');
    replaceParam('proposal', null);
    toast.success('Applied. Steps and Canvas show the changes too.');
    void markApplied(proposalId);
  }

  /** Once the change is saved, the proposal counts as applied: the Assistant's card stops offering it. */
  async function markApplied(proposalId: string) {
    if (!(await latest.current.flush())) return;
    try {
      await apiBrowser().POST('/v1/commands/workflow_proposal.mark_applied', {
        body: { workspaceId, proposalId },
      });
    } catch {
      // Bookkeeping only: the change itself is saved.
    }
  }

  const count = shown?.changes.length ?? 0;
  const title = !shown
    ? ''
    : phase === 'applied'
      ? 'Changes applied'
      : phase === 'discarded'
        ? 'Proposal discarded'
        : phase === 'undone'
          ? 'Changes undone'
          : cantApply
            ? 'Drafted for an older version'
            : 'Here’s what would change';
  const preview = view?.shown ?? def;
  const overlays = view?.overlays ?? {};
  const mode = props.previewMode;
  const other = mode === 'canvas' ? 'steps' : 'canvas';

  return (
    <div
      className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(340px,440px)_minmax(0,1fr)]"
      data-testid="describe-pane"
    >
      <section
        aria-label="Describe a change"
        className="flex min-w-0 flex-col overflow-hidden rounded-card border border-border bg-card"
      >
        <header className="flex items-center gap-2.5 border-b border-border px-4 py-3.5">
          <KindTile tone="ai" icon={WandSparkles} />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="text-[15px] font-semibold leading-tight">Describe a change</span>
            <span className="text-xs text-text-3">
              AI drafts it. Nothing is saved until you apply it.
            </span>
          </span>
          <span className="hidden text-xs text-text-3 sm:inline">Uses the daily AI limit</span>
        </header>

        <div className="flex flex-col gap-3.5 p-4">
          {!shown && !asking ? (
            <p className="text-[13px] leading-[1.5] text-text-2" data-testid="describe-intro">
              Say what to change, the way you’d tell a teammate. You see exactly what would change
              before anything is saved.
            </p>
          ) : null}
          {/* A follow-up adds to the conversation; a fresh request starts a new one. */}
          {!asking || refining
            ? shown?.requests.map((r, i) => (
                <RequestBubble key={`${shown.id}-${i}`}>{r}</RequestBubble>
              ))
            : null}
          {asking ? (
            <>
              <RequestBubble>{asking}</RequestBubble>
              <Drafting />
            </>
          ) : null}

          {shown && !asking ? (
            <div
              className="overflow-hidden rounded-card border border-border bg-card shadow-1"
              data-testid="proposal-card"
              data-phase={phase}
              data-stale={cantApply ? 'true' : 'false'}
            >
              {shown.reply ? (
                <p
                  className="px-3.5 pt-3 text-[13px] leading-[1.45] text-text-2"
                  data-testid="proposal-reply"
                >
                  {shown.reply}
                </p>
              ) : null}
              <div className="flex items-center gap-2 px-3.5 pb-1 pt-3">
                <span
                  className="min-w-0 flex-1 text-[15px] font-semibold"
                  data-testid="proposal-title"
                >
                  {title}
                </span>
                <Badge
                  variant={phase === 'pending' && !cantApply ? 'owner' : 'gray'}
                  className="h-5 flex-none text-[11.5px]"
                  data-testid="proposal-count"
                >
                  {count === 1 ? '1 change' : `${count} changes`}
                </Badge>
              </div>
              {phase !== 'discarded' && count ? (
                <ul className="m-0 list-none px-3.5 pb-1">
                  {shown.changes.map((line, i) => (
                    <ChangeRow key={i} line={line} />
                  ))}
                </ul>
              ) : null}
              {!count ? (
                <p className="px-3.5 pb-3 text-[13px] text-text-3">
                  Nothing in the workflow changes.
                </p>
              ) : null}
              {shown.unsupported.length ? <UnsupportedNote lines={shown.unsupported} /> : null}
              {phase === 'pending' && view && count ? (
                <div
                  className={cn(
                    'flex items-start gap-2 border-t border-border px-3.5 py-2.5 text-[13px]',
                    errors.length ? 'bg-warning-soft text-warning-text' : 'text-text-2',
                  )}
                  data-testid="proposal-checks"
                >
                  {errors.length ? (
                    <TriangleAlert className="mt-0.5 h-4 w-4 flex-none" strokeWidth={1.5} />
                  ) : (
                    <CircleCheck
                      className="mt-0.5 h-4 w-4 flex-none text-success-text"
                      strokeWidth={1.5}
                    />
                  )}
                  <span>
                    {errors.length
                      ? `Checks: ${errors.length === 1 ? '1 thing' : `${errors.length} things`} to fix after this, like “${errors[0]!.message}”.`
                      : 'Checks: nothing to fix. It still needs a test before you publish.'}
                  </span>
                </div>
              ) : null}
              <ProposalFooter
                phase={phase}
                cantApply={cantApply}
                canApply={props.canManage && !!view && count > 0}
                count={count}
                liveVersion={props.liveVersion}
                canUndo={draft.canUndo}
                onApply={apply}
                onDiscard={() => {
                  setPhase('discarded');
                  replaceParam('proposal', null);
                }}
                onShowAgain={() => setPhase('pending')}
                onUndo={() => {
                  draft.undo();
                  setPhase('undone');
                }}
                onAskAgain={() => void ask(shown.requests.join('\n'), false)}
              />
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

          <div className="flex flex-col gap-2 border-t border-border pt-3.5">
            <div className="flex flex-wrap gap-1.5">
              {EDIT_EXAMPLES.map((x) => (
                <button
                  key={x}
                  type="button"
                  disabled={!props.canManage || !!asking}
                  onClick={() => setText(x)}
                  className="inline-flex min-h-8 items-center rounded-full border border-border-strong bg-card px-3 text-[12.5px] text-text-2 transition-colors hover:bg-card-2 disabled:opacity-60 max-md:min-h-10"
                  data-testid="describe-example"
                >
                  {x}
                </button>
              ))}
            </div>
            <Textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void ask(text, refining);
                }
              }}
              rows={3}
              maxLength={2000}
              disabled={!props.canManage || !!asking}
              aria-label={refining ? 'Refine the change' : 'Describe a change'}
              placeholder={
                props.canManage
                  ? refining
                    ? 'Refine it, like “and stop if they book”'
                    : 'Like “wait two days instead”'
                  : 'Only owners and admins can change workflows.'
              }
              className="min-h-[76px] text-[14px]"
              data-testid="describe-input"
            />
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 text-xs text-text-3" data-testid="describe-selected">
                {selected ? (
                  <span className="inline-flex max-w-full items-center gap-1">
                    <span className="truncate">
                      About the selected step:{' '}
                      <strong className="font-medium text-text-2">
                        {describeStep(selected, catalogs, def)}
                      </strong>
                    </span>
                    <button
                      type="button"
                      onClick={() => props.onSelect(null)}
                      aria-label="Don’t send the selected step"
                      className="inline-flex h-6 w-6 flex-none items-center justify-center rounded-full hover:bg-card-2"
                    >
                      <X className="h-3.5 w-3.5" strokeWidth={1.5} />
                    </button>
                  </span>
                ) : (
                  'The selected step goes along as context.'
                )}
              </span>
              <Button
                size="sm"
                onClick={() => void ask(text, refining)}
                loading={!!asking}
                disabled={!text.trim() || !props.canManage}
                data-testid="describe-send"
              >
                {refining ? 'Refine' : 'Draft it'}
              </Button>
            </div>
          </div>
        </div>
      </section>

      <section
        aria-label="Preview"
        className="flex min-w-0 flex-col gap-2"
        data-testid="describe-preview"
      >
        <div className="flex flex-wrap items-end justify-between gap-2">
          <span className="flex min-w-0 flex-col">
            <span className="text-[15px] font-semibold" data-testid="describe-preview-title">
              {view
                ? 'Preview with the changes'
                : phase === 'applied'
                  ? 'The draft, now'
                  : 'The draft'}
            </span>
            <span className="text-xs text-text-3">
              Shown in {mode === 'canvas' ? 'Canvas' : 'Steps'}, the mode you last used
            </span>
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => props.onPreviewMode(other)}
            data-testid="describe-preview-mode"
          >
            Show in {other === 'canvas' ? 'Canvas' : 'Steps'}
          </Button>
        </div>
        {mode === 'canvas' ? (
          <div className="relative h-[calc(100dvh-280px)] min-h-[380px] min-w-0 overflow-hidden rounded-card border border-border md:min-h-[520px]">
            <WorkflowCanvas
              definition={preview}
              names={catalogs}
              issues={resultIssues}
              selectedId={props.selectedId}
              onSelect={props.onSelect}
              phone={props.phone}
              overlays={overlays}
            />
          </div>
        ) : (
          <div className="min-w-0 overflow-x-auto rounded-card border border-border bg-card-2 px-3 pb-3 pt-3 md:px-4">
            <StepList
              definition={preview}
              names={catalogs}
              issues={resultIssues}
              selectedId={props.selectedId}
              onSelect={props.onSelect}
              phone={!props.wide}
              overlays={overlays}
              testId="describe-step-list"
            />
          </div>
        )}
      </section>
    </div>
  );
}

function ProposalFooter(props: {
  phase: Phase;
  cantApply: boolean;
  canApply: boolean;
  count: number;
  liveVersion: number | null;
  canUndo: boolean;
  onApply: () => void;
  onDiscard: () => void;
  onShowAgain: () => void;
  onUndo: () => void;
  onAskAgain: () => void;
}) {
  const row = 'flex flex-wrap items-center gap-2 border-t border-border px-3.5 py-2.5 text-[13px]';
  if (props.phase === 'applied')
    return (
      <div
        className={cn(row, 'bg-success-soft text-success-text')}
        role="status"
        data-testid="proposal-result"
      >
        <CircleCheck className="h-4 w-4 flex-none" strokeWidth={1.5} />
        <span className="min-w-0 flex-1">
          Applied {props.count === 1 ? 'the change' : `${props.count} changes`} to the draft. One
          Undo takes {props.count === 1 ? 'it' : 'them all'} back.
        </span>
        {props.canUndo ? (
          <Button variant="secondary" size="sm" onClick={props.onUndo} data-testid="proposal-undo">
            <Undo2 className="h-3.5 w-3.5" strokeWidth={1.75} />
            Undo
          </Button>
        ) : null}
      </div>
    );
  if (props.phase === 'discarded' || props.phase === 'undone')
    return (
      <div className={cn(row, 'bg-card-2 text-text-2')} role="status" data-testid="proposal-result">
        <span className="min-w-0 flex-1">
          {props.phase === 'discarded'
            ? 'Discarded. The draft didn’t change.'
            : 'Undone. The draft is back to how it was.'}
        </span>
        {props.phase === 'discarded' ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={props.onShowAgain}
            data-testid="proposal-show-again"
          >
            Show it again
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            onClick={props.onAskAgain}
            data-testid="proposal-ask-again"
          >
            <RotateCcw className="h-3.5 w-3.5" strokeWidth={1.75} />
            Ask again
          </Button>
        )}
      </div>
    );
  if (props.cantApply)
    return (
      <div
        className={cn(row, 'bg-warning-soft text-warning-text')}
        role="status"
        data-testid="proposal-stale"
      >
        <span className="min-w-0 flex-1">
          The workflow changed since this was drafted, so it can’t be applied.
        </span>
        <Button
          variant="secondary"
          size="sm"
          onClick={props.onAskAgain}
          data-testid="proposal-ask-again"
        >
          <RotateCcw className="h-3.5 w-3.5" strokeWidth={1.75} />
          Ask again
        </Button>
      </div>
    );
  return (
    <div className={row}>
      <Button
        size="sm"
        onClick={props.onApply}
        disabled={!props.canApply}
        data-testid="proposal-apply"
      >
        Apply changes
      </Button>
      <Button variant="ghost" size="sm" onClick={props.onDiscard} data-testid="proposal-discard">
        Discard
      </Button>
      <span className="flex-1" />
      {props.liveVersion ? (
        <span className="text-xs text-text-3">
          Runs already going keep version {props.liveVersion}
        </span>
      ) : null}
    </div>
  );
}
