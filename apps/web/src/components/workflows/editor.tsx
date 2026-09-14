'use client';
import {
  parseDefinition,
  validateWorkflow,
  type WorkflowCatalogs,
  type WorkflowIssue,
  type WorkflowOp,
} from '@hfos/core';
import {
  AlertTriangle,
  ChevronRight,
  CornerDownRight,
  History,
  ListChecks,
  Play,
  Redo2,
  SlidersHorizontal,
  Undo2,
} from 'lucide-react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ApiError, apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { WorkflowCatalogsOut, WorkflowDetail, WorkflowVersion } from '@/lib/api/types';
import { useLiveRefresh } from '@/lib/realtime/live-provider';
import { useMatches } from '@/lib/use-media';
import { runOverlays, isLive } from '@/lib/workflows/run-words';
import { sampleValues, type SampleContact } from '@/lib/workflows/sample';
import { useWorkflowDraft, type WorkflowDraft } from '@/lib/workflows/use-draft';
import { useWorkflowTest } from '@/lib/workflows/use-test';
import { useWide } from '@/lib/workflows/use-wide';
import { cn } from '@/lib/utils';
import { ChecksCount, ChecksPanel, issueCounts } from './checks';
import { SourceChips, WorkflowStatusBadge } from './chips';
import {
  EditorProvider,
  SETTINGS_ID,
  TRIGGER_ID,
  type EditorContextValue,
  type QuietHours,
} from './editor-context';
import { HistorySheet } from './history';
import { MoveDialog } from './move-dialog';
import { StepPanel } from './panels';
import { PublishControls } from './publish';
import { StepList } from './step-list';
import { TestPanel } from './test-panel';

type RailTab = 'step' | 'checks' | 'test';
type EditorMode = 'steps' | 'canvas';

/** The canvas and its libraries load only when someone opens it, and only in the browser. */
const WorkflowCanvas = dynamic(() => import('./canvas/canvas').then((m) => m.WorkflowCanvas), {
  ssr: false,
  loading: () => <CanvasLoading />,
});

export interface WorkflowEditorProps {
  readonly workspaceId: string;
  readonly workflow: WorkflowDetail;
  readonly versions: readonly WorkflowVersion[];
  readonly catalogs: WorkflowCatalogsOut;
  /** Owners and admins edit; members read. */
  readonly canManage: boolean;
  readonly businessName: string;
  readonly quietHours: QuietHours | null;
  /** The first customer, for previews until someone picks another. */
  readonly sample: SampleContact | null;
  /** From `?step=`. */
  readonly initialStep: string | null;
}

/**
 * The workflow editor: the header (rename, status, saved state, History, Publish), the Steps | Canvas |
 * Describe switch, the step list, and a right rail with the selected step's settings, Checks and Test (a
 * bottom sheet on phones). Everything edits one draft (useWorkflowDraft), which saves as you go.
 */
export function WorkflowEditor(props: WorkflowEditorProps) {
  const { workspaceId, workflow, canManage } = props;
  const router = useRouter();
  useLiveRefresh(['workflow']);
  const draft = useWorkflowDraft({
    workspaceId,
    workflowId: workflow.id,
    revision: workflow.revision,
    definition: workflow.definition,
    readOnly: !canManage,
  });
  const def = draft.definition;
  const catalogs = props.catalogs as WorkflowCatalogs;
  /** Room for the rail (1024px). Yes on the server, so a desktop gets the rail from the first paint. */
  const wide = useWide();
  /** Under 768px the canvas only views; editing happens in Steps. */
  const phone = !useMatches('(min-width: 768px)');
  const searchParams = useSearchParams();
  const [mode, setMode] = useState<EditorMode>(() =>
    searchParams.get('mode') === 'canvas' ? 'canvas' : 'steps',
  );

  const [now] = useState(() => Date.now());
  const issues = useMemo(() => validateWorkflow(def, catalogs, now), [def, catalogs, now]);
  const { errors } = issueCounts(issues);
  /** This exact draft passed a test: its saved revision, with nothing unsaved. */
  const tested = workflow.tested && !draft.unsaved && draft.revision === workflow.testedRevision;
  const test = useWorkflowTest({
    workspaceId,
    workflowId: workflow.id,
    flush: draft.flush,
    onEnded: () => router.refresh(),
  });

  const [selected, setSelected] = useState<string | null>(props.initialStep);
  const [tab, setTab] = useState<RailTab>('step');
  const [sheet, setSheet] = useState<'step' | 'checks' | 'test' | null>(null);
  /** The newest test's marks on the steps, while Test is open (or it runs) and the draft is what it tested. */
  const testRun = test.result;
  const showMarks = tab === 'test' || sheet === 'test' || (!!testRun && isLive(testRun.run.status));
  const marks = useMemo(
    () =>
      showMarks && testRun && testRun.run.testRevision === draft.revision && !draft.unsaved
        ? runOverlays(def, testRun.run, testRun.steps, {
            timeZone: catalogs.timeZone,
            names: catalogs,
          })
        : undefined,
    [showMarks, testRun, draft.revision, draft.unsaved, def, catalogs],
  );
  const [moveId, setMoveId] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [lastFix, setLastFix] = useState<{ label: string; def: typeof def } | null>(null);
  const [sample, setSample] = useState<SampleContact | null>(props.sample);
  const [name, setName] = useState(workflow.name);
  const [seenName, setSeenName] = useState(workflow.name);
  if (workflow.name !== seenName) {
    setSeenName(workflow.name);
    setName(workflow.name);
  }

  const select = useCallback(
    (id: string | null) => {
      setSelected(id);
      setTab('step');
      if (!wide) setSheet(id ? 'step' : null);
      const params = new URLSearchParams(window.location.search);
      params.set('mode', mode);
      if (id) params.set('step', id);
      else params.delete('step');
      window.history.replaceState(null, '', `?${params.toString()}`);
    },
    [wide, mode],
  );

  // Undo and Redo from the keyboard, except while typing (fields keep their own undo).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.closest('input, textarea, select, [contenteditable="true"]') || t.isContentEditable)
      )
        return;
      const key = e.key.toLowerCase();
      if (key === 'z' && !e.shiftKey) {
        e.preventDefault();
        draft.undo();
      } else if ((key === 'z' && e.shiftKey) || key === 'y') {
        e.preventDefault();
        draft.redo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [draft]);

  /** "Move to…" opens over the page, so a phone's step sheet closes first. */
  const openMove = useCallback((stepId: string) => {
    setSheet(null);
    setMoveId(stepId);
  }, []);
  /** The canvas edits the way the step list does; one object, so a save doesn't redraw it. */
  const canvasEditing = useMemo(
    () =>
      canManage
        ? { apply: draft.apply, catalogs, workflowId: workflow.id, onMoveTo: openMove }
        : undefined,
    [canManage, draft.apply, catalogs, workflow.id, openMove],
  );

  /** Steps or Canvas: both edit this one draft, so switching never saves anything, and the selection stays. */
  const switchMode = (next: EditorMode) => {
    if (next === mode) return;
    setMode(next);
    const params = new URLSearchParams(window.location.search);
    params.set('mode', next);
    window.history.replaceState(null, '', `?${params.toString()}`);
  };

  const values = useMemo(
    () => sampleValues({ person: sample, businessName: props.businessName, workflowName: name }),
    [sample, props.businessName, name],
  );
  const context: EditorContextValue = {
    workspaceId,
    workflowId: workflow.id,
    workflowName: name,
    businessName: props.businessName,
    def,
    catalogs,
    names: catalogs,
    apply: draft.apply,
    readOnly: draft.readOnly,
    sample,
    setSample,
    values,
    quietHours: props.quietHours,
    timeZone: catalogs.timeZone,
    select,
    openMove,
  };

  function applyFix(issue: WorkflowIssue, fix: WorkflowIssue['fixes'][number]) {
    void issue;
    const out = draft.apply(fix.ops as readonly WorkflowOp[], fix.label);
    if (out.ok) setLastFix({ label: fix.label, def: out.definition });
  }

  async function restore(version: number): Promise<boolean> {
    if (!(await draft.flush())) {
      toast.error('Your latest changes aren’t saved yet, so nothing was restored.');
      return false;
    }
    try {
      const out = unwrap(
        await apiBrowser().POST('/v1/commands/workflow.restore_version', {
          body: { workspaceId, workflowId: workflow.id, version, baseRevision: draft.revision },
        }),
      );
      const got = unwrap(
        await apiBrowser().POST('/v1/queries/workflow.get', {
          body: { workspaceId, workflowId: workflow.id },
        }),
      );
      draft.reset(parseDefinition(got.workflow.definition), got.workflow.revision);
      toast.success(
        out.changed
          ? `Restored version ${version} as revision ${out.revision}. Test it before you publish.`
          : `The draft already matched version ${version}.`,
      );
      router.refresh();
      return true;
    } catch (e) {
      toast.error(errorMessage(e));
      if (e instanceof ApiError && e.rule === 'revision_conflict') void draft.loadTheirs();
      return false;
    }
  }

  const base = `/app/w/${workspaceId}/workflows`;
  const panel = <StepPanel selection={selected} />;
  const testPanel = (
    <TestPanel
      test={test}
      def={def}
      names={catalogs}
      timeZone={catalogs.timeZone}
      revision={draft.revision}
      unsaved={draft.unsaved}
      errors={errors}
      canManage={canManage}
    />
  );
  const checks = (
    <ChecksPanel
      issues={issues}
      def={def}
      names={catalogs}
      readOnly={draft.readOnly}
      tested={tested}
      liveVersion={workflow.activeVersion?.version ?? null}
      lastFix={lastFix && lastFix.def === def ? lastFix.label : null}
      onFix={applyFix}
      onUndoFix={() => {
        draft.undo();
        setLastFix(null);
      }}
      onSelectStep={(id) => select(id ?? TRIGGER_ID)}
    />
  );

  return (
    <EditorProvider value={context}>
      <div data-testid="workflow-editor" data-workflow-id={workflow.id} className="pb-6">
        <div className="mb-1.5 flex items-center gap-1 text-xs text-text-3">
          <Link href={base} className="text-accent-text hover:underline">
            Workflows
          </Link>
          <ChevronRight className="h-3.5 w-3.5" strokeWidth={1.5} />
          <span className="truncate">{name}</span>
        </div>

        <div className="mb-3.5 flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 flex-wrap items-center gap-2.5">
            <InlineName
              name={name}
              canEdit={canManage}
              onSave={async (next) => {
                const prev = name;
                setName(next);
                try {
                  unwrap(
                    await apiBrowser().POST('/v1/commands/workflow.rename', {
                      body: { workspaceId, workflowId: workflow.id, name: next },
                    }),
                  );
                } catch (e) {
                  setName(prev);
                  toast.error(errorMessage(e));
                }
              }}
            />
            <WorkflowStatusBadge status={workflow.status} />
            <SourceChips source={workflow.source} />
            <span className="text-[13px] text-text-3" data-testid="version-note">
              {workflow.activeVersion
                ? `Version ${workflow.activeVersion.version} is live`
                : 'Not published yet'}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setHistoryOpen(true)}
              data-testid="history-open"
            >
              <History className="h-4 w-4" strokeWidth={1.5} />
              History
            </Button>
            {canManage ? (
              <PublishControls
                workspaceId={workspaceId}
                workflow={workflow}
                versions={props.versions}
                def={def}
                names={catalogs}
                draft={draft}
                errors={errors}
                tested={tested}
              />
            ) : null}
          </div>
        </div>

        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-3 max-sm:w-full">
            <Segmented<EditorMode | 'describe'>
              ariaLabel="Editor"
              value={mode}
              onChange={(next) => {
                if (next !== 'describe') switchMode(next);
              }}
              className="max-sm:w-full"
              fill={!wide}
              options={[
                { value: 'steps', label: 'Steps', testId: 'mode-steps' },
                { value: 'canvas', label: 'Canvas', testId: 'mode-canvas' },
                {
                  value: 'describe',
                  label: 'Describe',
                  disabled: true,
                  title: 'Describe it and AI edits the steps: coming soon',
                },
              ]}
            />
            {canManage ? (
              <span className="hidden text-xs text-text-3 2xl:inline">
                {mode === 'canvas'
                  ? 'Same draft as Steps. Drag a step onto a + to move it.'
                  : 'Drag a step by its handle, or select it and press Alt + ↑ or ↓'}
              </span>
            ) : (
              <span className="text-xs text-text-3">
                Only owners and admins can change workflows.
              </span>
            )}
          </div>
          {canManage ? (
            <div className="flex items-center gap-1">
              <SaveState draft={draft} />
              <Button
                variant="ghost"
                size="icon"
                aria-label={draft.undoLabel ? `Undo: ${draft.undoLabel}` : 'Undo'}
                title={draft.undoLabel ? `Undo: ${draft.undoLabel}` : 'Nothing to undo'}
                disabled={!draft.canUndo}
                onClick={draft.undo}
                data-testid="undo"
              >
                <Undo2 className="h-4 w-4" strokeWidth={1.75} />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label={draft.redoLabel ? `Redo: ${draft.redoLabel}` : 'Redo'}
                title={draft.redoLabel ? `Redo: ${draft.redoLabel}` : 'Nothing to redo'}
                disabled={!draft.canRedo}
                onClick={draft.redo}
                data-testid="redo"
              >
                <Redo2 className="h-4 w-4" strokeWidth={1.75} />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => select(SETTINGS_ID)}
                data-testid="workflow-settings"
                aria-label="Workflow settings"
              >
                <SlidersHorizontal className="h-4 w-4" strokeWidth={1.5} />
                <span className="max-sm:hidden">Settings</span>
              </Button>
            </div>
          ) : null}
        </div>

        {draft.conflict ? (
          <div
            className="mb-4 flex flex-wrap items-center gap-3 rounded-menu bg-warning-soft px-3.5 py-2.5 text-[13px] text-warning-text"
            data-testid="conflict-banner"
          >
            <AlertTriangle className="h-4 w-4 flex-none" strokeWidth={1.75} />
            <span className="flex-1">
              Someone saved this workflow while you were editing. Your changes since then aren’t
              saved.
            </span>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void draft.loadTheirs().then(() => router.refresh())}
              data-testid="load-their-version"
            >
              Load their version
            </Button>
          </div>
        ) : draft.saveState === 'failed' ? (
          <div
            className="mb-4 flex flex-wrap items-center gap-3 rounded-menu bg-danger-soft px-3.5 py-2.5 text-[13px] text-danger-text"
            data-testid="save-failed-banner"
          >
            <AlertTriangle className="h-4 w-4 flex-none" strokeWidth={1.75} />
            <span className="flex-1">Your last change couldn’t be saved: {draft.error}</span>
            <Button variant="secondary" size="sm" onClick={draft.retryNow}>
              Try again
            </Button>
            <Button variant="ghost" size="sm" onClick={() => void draft.loadTheirs()}>
              Load the saved version
            </Button>
          </div>
        ) : null}

        {/* Checks and Test open as sheets below 1024px; CSS hides them on wider screens from the first paint. */}
        <div className="mb-3 flex gap-2 lg:hidden">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setSheet('checks')}
            data-testid="checks-open"
          >
            <ListChecks className="h-4 w-4" strokeWidth={1.5} />
            Checks
            <ChecksCount issues={issues} />
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setSheet('test')}
            data-testid="test-open"
          >
            <Play className="h-4 w-4" strokeWidth={1.5} />
            Test
          </Button>
        </div>

        <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,1fr)_336px]">
          {mode === 'canvas' ? (
            <div
              className="relative h-[calc(100dvh-280px)] min-h-[380px] min-w-0 overflow-hidden rounded-card border border-border md:h-[calc(100dvh-196px)] md:min-h-[520px]"
              data-testid="canvas-frame"
            >
              <WorkflowCanvas
                definition={def}
                names={catalogs}
                issues={issues}
                selectedId={selected}
                onSelect={select}
                phone={phone}
                editing={canvasEditing}
              />
            </div>
          ) : (
            <div className="min-w-0 overflow-x-auto rounded-card border border-border bg-card-2 px-3 pb-3 pt-3 md:px-4">
              <StepList
                definition={def}
                names={catalogs}
                issues={issues}
                selectedId={selected}
                onSelect={select}
                phone={!wide}
                overlays={marks}
                editing={
                  canManage
                    ? {
                        apply: draft.apply,
                        catalogs,
                        workflowId: workflow.id,
                        onMoveTo: setMoveId,
                      }
                    : undefined
                }
              />
            </div>
          )}

          {wide ? (
            // Server-rendered on a desktop (no pop-in); CSS hides it below 1024px until a phone unmounts it.
            <Card
              className="hidden overflow-hidden lg:sticky lg:top-4 lg:block"
              data-testid="workflow-rail"
            >
              <Tabs value={tab} onValueChange={(v) => setTab(v as RailTab)}>
                <TabsList className="px-2.5">
                  <TabsTrigger value="step" className="h-11" data-testid="rail-step">
                    Step
                  </TabsTrigger>
                  <TabsTrigger value="checks" className="h-11" data-testid="rail-checks">
                    Checks
                    <ChecksCount issues={issues} />
                  </TabsTrigger>
                  <TabsTrigger value="test" className="h-11" data-testid="rail-test">
                    Test
                  </TabsTrigger>
                </TabsList>
                <div className="max-h-[calc(100vh-150px)] overflow-y-auto px-[18px] py-4">
                  <TabsContent value="step">{panel}</TabsContent>
                  <TabsContent value="checks">{checks}</TabsContent>
                  <TabsContent value="test">{testPanel}</TabsContent>
                </div>
              </Tabs>
            </Card>
          ) : null}
        </div>

        {!wide ? (
          <Sheet open={sheet !== null} onOpenChange={(o) => !o && setSheet(null)}>
            <SheetContent
              title={sheet === 'checks' ? 'Checks' : sheet === 'test' ? 'Test' : 'Step settings'}
              hideHeader
              className="pb-6"
            >
              <div data-testid="step-sheet">
                {sheet === 'checks' ? (
                  checks
                ) : sheet === 'test' ? (
                  <>
                    {testPanel}
                    <Button
                      size="lg"
                      className="mt-4 w-full"
                      onClick={() => setSheet(null)}
                      data-testid="test-sheet-done"
                    >
                      Done
                    </Button>
                  </>
                ) : mode === 'canvas' && phone ? (
                  // The phone canvas only views, so a tapped step's settings open read-only.
                  <EditorProvider
                    value={{
                      ...context,
                      readOnly: true,
                      apply: () => ({ ok: false, message: 'Edit this in Steps.', error: null }),
                    }}
                  >
                    {panel}
                  </EditorProvider>
                ) : (
                  panel
                )}
                {sheet === 'step' ? (
                  <div className="mt-4 flex gap-2">
                    {canManage &&
                    !(mode === 'canvas' && phone) &&
                    selected &&
                    selected !== TRIGGER_ID &&
                    selected !== SETTINGS_ID ? (
                      <Button
                        variant="ghost"
                        size="lg"
                        className="flex-1"
                        onClick={() => openMove(selected)}
                        data-testid="sheet-move"
                      >
                        <CornerDownRight className="h-4 w-4" strokeWidth={1.5} />
                        Move to…
                      </Button>
                    ) : null}
                    <Button
                      size="lg"
                      className="flex-1"
                      onClick={() => setSheet(null)}
                      data-testid="sheet-done"
                    >
                      Done
                    </Button>
                  </div>
                ) : null}
              </div>
            </SheetContent>
          </Sheet>
        ) : null}

        <MoveDialog
          open={moveId !== null}
          onOpenChange={(o) => !o && setMoveId(null)}
          def={def}
          stepId={moveId}
          names={catalogs}
          onMove={(stepId, to) => draft.apply([{ op: 'move_step', stepId, ...to }], 'Move a step')}
        />
        <HistorySheet
          open={historyOpen}
          onOpenChange={setHistoryOpen}
          workspaceId={workspaceId}
          workflowId={workflow.id}
          workflowName={name}
          versions={props.versions}
          liveVersionId={workflow.activeVersion?.id ?? null}
          draftRevision={draft.revision}
          draft={def}
          names={catalogs}
          timeZone={catalogs.timeZone}
          canRestore={canManage}
          onRestore={restore}
        />
      </div>
    </EditorProvider>
  );
}

/** Saved / Saving… / Couldn't save, retrying. */
function SaveState({ draft }: { draft: WorkflowDraft }) {
  const text = {
    saved: 'Saved',
    saving: 'Saving…',
    retrying: 'Couldn’t save, retrying',
    failed: 'Couldn’t save',
    conflict: 'Not saved',
  }[draft.saveState];
  const bad =
    draft.saveState === 'retrying' ||
    draft.saveState === 'failed' ||
    draft.saveState === 'conflict';
  return (
    <span
      className={cn(
        'mr-1 whitespace-nowrap text-xs',
        bad ? 'font-medium text-warning-text' : 'text-text-3',
      )}
      data-testid="save-state"
      data-state={draft.saveState}
      aria-live="polite"
    >
      {text}
      {draft.saveState === 'retrying' ? (
        <button
          type="button"
          onClick={draft.retryNow}
          className="ml-1.5 text-accent-text hover:underline"
        >
          Try now
        </button>
      ) : null}
    </span>
  );
}

/** The name as a heading; owners and admins click it to rename. */
function InlineName({
  name,
  canEdit,
  onSave,
}: {
  name: string;
  canEdit: boolean;
  onSave: (next: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name);
  if (editing)
    return (
      <Input
        autoFocus
        aria-label="Workflow name"
        data-testid="workflow-name-input"
        className="h-9 w-[min(420px,80vw)] text-lg font-semibold"
        value={value}
        maxLength={120}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => {
          setEditing(false);
          const next = value.trim();
          if (next && next !== name) onSave(next);
          else setValue(name);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') {
            setValue(name);
            setEditing(false);
          }
        }}
      />
    );
  return (
    <h1 className="min-w-0 text-[22px] font-semibold leading-tight tracking-[-0.01em] md:text-2xl">
      {canEdit ? (
        <button
          type="button"
          title="Rename"
          data-testid="workflow-name"
          onClick={() => {
            setValue(name);
            setEditing(true);
          }}
          className="rounded-control text-left hover:bg-card-2 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring"
        >
          {name}
        </button>
      ) : (
        <span data-testid="workflow-name">{name}</span>
      )}
    </h1>
  );
}

/** While the canvas's code loads, the first time it opens. */
function CanvasLoading() {
  return (
    <div className="flex h-full items-center justify-center bg-bg text-[13px] text-text-3">
      Loading the canvas…
    </div>
  );
}
