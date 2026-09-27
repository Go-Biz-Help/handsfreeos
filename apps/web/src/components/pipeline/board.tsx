'use client';
import {
  closestCorners,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { arrayMove, sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { KanbanSquare, List, MoreHorizontal, Plus } from 'lucide-react';
import { usePathname, useRouter } from 'next/navigation';
import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { NextActionChip, StageBadge } from '@/components/crm/chips';
import { LeadDialog } from '@/components/crm/lead-dialog';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Select } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import {
  BOARD_LEADS_PER_STAGE,
  boardStages,
  moveToast,
  PIPELINE_WORDS,
  pipelineSummary,
  RECORD_WORDS,
  totalsAfterMove,
} from '@hfos/core';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { LeadBoard, LeadCard, Pipeline, Stage, Tag } from '@/lib/api/types';
import { formatMoney } from '@/lib/format';
import { useLiveVersion } from '@/lib/realtime/live-provider';
import { cn } from '@/lib/utils';
import { LeadCardView } from './lead-card';
import { LeadDetail } from './lead-detail';
import { LostReasonDialog } from './lost-reason-dialog';
import { StageColumn } from './stage-column';

type View = 'board' | 'list';
interface PendingMove {
  leadId: string;
  stageId: string;
  afterLeadId: string | null | undefined;
  stage: LeadBoard['stages'][number];
  lead: LeadCard;
}

/** The pipeline: a drag-and-drop board (or a list with a stage picker), a lead sheet, and live updates. */
export function PipelineBoard({
  workspaceId,
  initial,
  pipelines,
  members,
  tags,
  permissions,
  myUserId,
  initialView,
}: {
  workspaceId: string;
  initial: LeadBoard;
  pipelines: Pipeline[];
  members: { id: string; fullName: string }[];
  tags: Tag[];
  /** What the business lets them do (0106), for the lead sheet. */
  permissions: readonly string[];
  myUserId: string;
  initialView: View | null;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const dndId = useId();
  const [board, setBoard] = useState<LeadBoard>(initial);
  const [view, setView] = useState<View>(initialView ?? 'board');
  const [selected, setSelected] = useState<string | null>(null);
  const [active, setActive] = useState<LeadCard | null>(null);
  const [pendingLost, setPendingLost] = useState<PendingMove | null>(null);
  const [newLead, setNewLead] = useState(false);
  const [busy, setBusy] = useState(false);
  const version = useLiveVersion(['lead', 'pipeline', 'pipeline_stage', 'tag']);
  // How many cards of a stage to ask for once someone has shown more of it, kept across live refreshes.
  const shown = useRef<Record<string, number>>({});

  useEffect(() => setBoard(initial), [initial]);
  // Phones get the list by default: dragging fights with scrolling there.
  useEffect(() => {
    if (!initialView && window.matchMedia('(max-width: 767px)').matches) setView('list');
  }, [initialView]);

  const refetch = useCallback(async () => {
    try {
      const more = Object.entries(shown.current).map(([stageId, limit]) => ({ stageId, limit }));
      const out = unwrap(
        await apiBrowser().POST('/v1/queries/lead.board', {
          body: {
            workspaceId,
            pipelineId: board.pipeline.id,
            ...(more.length ? { shown: more } : {}),
          },
        }),
      );
      setBoard(out);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }, [workspaceId, board.pipeline.id]);
  useEffect(() => {
    if (version > 0) void refetch();
  }, [version, refetch]);
  function showMore(stage: LeadBoard['stages'][number]) {
    shown.current = { ...shown.current, [stage.id]: stage.leads.length + BOARD_LEADS_PER_STAGE };
    void refetch();
  }

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 220, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const leadsById = useMemo(
    () => new Map(board.stages.flatMap((s) => s.leads.map((l) => [l.id, l] as const))),
    [board],
  );
  const stageOf = (leadId: string) =>
    board.stages.find((s) => s.leads.some((l) => l.id === leadId));
  const open = board.stages.filter((s) => s.kind === 'open');
  const openCount = open.reduce((a, s) => a + s.count, 0);
  const openValue = open.reduce((a, s) => a + s.valueCents, 0);
  const stagesForDetail: Stage[] = board.stages.map((s) => ({
    id: s.id,
    name: s.name,
    kind: s.kind,
    position: s.position,
    leadCount: s.count,
  }));

  /**
   * The move on screen before the command answers. The cards are re-dealt here and the counts and totals come from
   * core's `boardStages`, the very function `lead.board` uses, so the optimistic board and the reloaded one agree.
   */
  function applyLocal(leadId: string, stageId: string, index: number): LeadBoard {
    const lead = leadsById.get(leadId)!;
    const target = board.stages.find((s) => s.id === stageId)!;
    const moved: LeadCard = {
      ...lead,
      stageId,
      stageName: target.name,
      stageKind: target.kind,
      status: target.kind === 'open' ? 'open' : target.kind,
    };
    const dealt = board.stages.flatMap((s) => {
      const without = s.leads.filter((l) => l.id !== leadId);
      if (s.id !== stageId) return without;
      return [...without.slice(0, index), moved, ...without.slice(index)];
    });
    // A column may show only its first cards, so the counts move with the lead rather than being recounted.
    const totals = totalsAfterMove(board.stages, lead, stageId);
    const next: LeadBoard = { ...board, stages: boardStages(board.stages, dealt, totals) };
    setBoard(next);
    return next;
  }

  async function commitMove(move: PendingMove, lostReason?: string) {
    setBusy(true);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/lead.move_stage', {
          body: {
            workspaceId,
            leadId: move.leadId,
            stageId: move.stageId,
            afterLeadId: move.afterLeadId,
            ...(lostReason ? { lostReason } : {}),
          },
        }),
      );
      if (move.stage.kind !== move.lead.stageKind || move.stage.id !== move.lead.stageId)
        toast.success(moveToast(move.lead.title, move.stage));
      setPendingLost(null);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
      await refetch();
    }
  }

  function requestMove(leadId: string, stageId: string, index: number) {
    const lead = leadsById.get(leadId);
    const stage = board.stages.find((s) => s.id === stageId);
    if (!lead || !stage) return;
    const next = applyLocal(leadId, stageId, index);
    const target = next.stages.find((s) => s.id === stageId)!;
    const column = target.leads;
    const at = column.findIndex((l) => l.id === leadId);
    // The last card of a column showing only its top isn't the stage's last: the end of it is the bottom (undefined).
    const afterLeadId =
      at <= 0
        ? null
        : at === column.length - 1 && target.count > column.length
          ? undefined
          : column[at - 1]!.id;
    const move: PendingMove = { leadId, stageId, afterLeadId, stage, lead };
    if (stage.kind === 'lost' && lead.status !== 'lost') return setPendingLost(move);
    void commitMove(move);
  }

  function onDragStart(e: DragStartEvent) {
    setActive(leadsById.get(String(e.active.id)) ?? null);
  }
  function onDragEnd(e: DragEndEvent) {
    setActive(null);
    const { active: a, over } = e;
    if (!over) return;
    const leadId = String(a.id);
    const source = stageOf(leadId);
    if (!source) return;
    const overId = String(over.id);
    const overStage = board.stages.find((s) => s.id === overId) ?? stageOf(overId);
    if (!overStage) return;
    let index: number;
    if (overStage.id === source.id) {
      const from = source.leads.findIndex((l) => l.id === leadId);
      const to =
        overId === overStage.id
          ? source.leads.length - 1
          : source.leads.findIndex((l) => l.id === overId);
      if (from === to) return;
      index = arrayMove(source.leads, from, to).findIndex((l) => l.id === leadId);
    } else {
      index =
        overId === overStage.id
          ? overStage.leads.length
          : overStage.leads.findIndex((l) => l.id === overId);
    }
    requestMove(leadId, overStage.id, index);
  }

  function changePipeline(id: string) {
    const params = new URLSearchParams();
    params.set('pipeline', id);
    if (view === 'list') params.set('view', 'list');
    router.push(`${pathname}?${params.toString()}`);
  }
  function changeView(v: View) {
    setView(v);
    const params = new URLSearchParams();
    if (board.pipeline.id !== board.pipelines[0]?.id) params.set('pipeline', board.pipeline.id);
    if (v === 'list') params.set('view', 'list');
    router.replace(`${pathname}${params.size ? `?${params}` : ''}`);
  }

  const total = board.stages.reduce((a, s) => a + s.count, 0);

  return (
    <div data-testid="pipeline" data-view={view}>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3 md:mb-5">
        <div>
          <h1 className="text-[22px] font-semibold leading-tight tracking-[-0.01em] md:text-2xl">
            {PIPELINE_WORDS.title}
          </h1>
          <p className="mt-1 text-text-2" data-testid="pipeline-summary">
            {pipelineSummary(openCount, openValue)}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {board.pipelines.length > 1 ? (
            <Select
              selectSize="sm"
              className="w-[180px]"
              value={board.pipeline.id}
              onChange={(e) => changePipeline(e.target.value)}
              aria-label="Pipeline"
            >
              {board.pipelines.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          ) : null}
          <Segmented
            value={view}
            onChange={changeView}
            options={[
              { value: 'board', label: 'Board' },
              { value: 'list', label: 'List' },
            ]}
          />
          <Button onClick={() => setNewLead(true)} data-testid="pipeline-new-lead">
            <Plus className="h-[18px] w-[18px]" strokeWidth={1.5} />
            {PIPELINE_WORDS.newLead}
          </Button>
        </div>
      </div>

      {total === 0 ? (
        <Card>
          <EmptyState
            title={PIPELINE_WORDS.noLeadsTitle}
            actions={
              <Button size="sm" onClick={() => setNewLead(true)}>
                <Plus className="h-4 w-4" strokeWidth={1.75} />
                {PIPELINE_WORDS.newLead}
              </Button>
            }
          >
            {PIPELINE_WORDS.noLeadsBody}
          </EmptyState>
        </Card>
      ) : view === 'board' ? (
        <DndContext
          id={dndId}
          sensors={sensors}
          collisionDetection={closestCorners}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          onDragCancel={() => setActive(null)}
        >
          <div
            className="-mx-4 flex snap-x snap-mandatory items-start gap-3 overflow-x-auto px-4 pb-3 md:mx-0 md:snap-none md:gap-3.5 md:px-0"
            data-testid="board"
          >
            {board.stages.map((s) => (
              <StageColumn
                key={s.id}
                stage={s}
                selectedId={selected}
                onOpen={setSelected}
                onShowMore={() => showMore(s)}
                disabled={busy}
              />
            ))}
          </div>
          <DragOverlay dropAnimation={null}>
            {active ? (
              <div className="w-[262px]">
                <LeadCardView lead={active} dragging />
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      ) : (
        <BoardList
          board={board}
          onMove={(leadId, stageId) =>
            requestMove(leadId, stageId, board.stages.find((s) => s.id === stageId)!.leads.length)
          }
          onOpen={setSelected}
          onShowMore={showMore}
          busy={busy}
        />
      )}

      <Sheet open={selected !== null} onOpenChange={(o) => !o && setSelected(null)}>
        <SheetContent title="Lead" hideHeader className="sm:w-[520px]">
          {selected ? (
            <LeadDetail
              key={selected}
              workspaceId={workspaceId}
              leadId={selected}
              members={members}
              myUserId={myUserId}
              permissions={permissions}
              tags={tags}
              compact
              onChanged={() => void refetch()}
            />
          ) : null}
        </SheetContent>
      </Sheet>

      <LostReasonDialog
        open={pendingLost !== null}
        onOpenChange={(o) => {
          if (!o) {
            setPendingLost(null);
            void refetch();
          }
        }}
        leadTitle={pendingLost?.lead.title ?? ''}
        busy={busy}
        onConfirm={(reason) => pendingLost && void commitMove(pendingLost, reason)}
      />
      <LeadDialog
        workspaceId={workspaceId}
        open={newLead}
        onOpenChange={setNewLead}
        pipelines={pipelines}
        members={members}
        myUserId={myUserId}
        defaultPipelineId={board.pipeline.id}
        onCreated={() => void refetch()}
      />
      <span className="sr-only" data-testid="board-stages">
        {stagesForDetail.map((s) => s.name).join(',')}
      </span>
    </div>
  );
}

function BoardList({
  board,
  onMove,
  onOpen,
  onShowMore,
  busy,
}: {
  board: LeadBoard;
  onMove: (leadId: string, stageId: string) => void;
  onOpen: (id: string) => void;
  onShowMore: (stage: LeadBoard['stages'][number]) => void;
  busy: boolean;
}) {
  // A stage the board sends only the top of ends with a Show more row, as its column does.
  const more = (s: LeadBoard['stages'][number]) =>
    s.count > s.leads.length ? (
      <Button
        variant="ghost"
        size="sm"
        className="text-xs"
        onClick={() => onShowMore(s)}
        data-testid={`list-show-more-${s.id}`}
      >
        {s.name} · {PIPELINE_WORDS.showMore(s.count - s.leads.length)}
      </Button>
    ) : null;
  return (
    <Card className="overflow-hidden" data-testid="board-list">
      <table className="hidden w-full text-sm md:table">
        <thead>
          <tr className="bg-card-2 text-left text-xs font-medium text-text-2">
            <th className="w-[30%] px-4 py-2.5">Lead</th>
            <th className="px-3 py-2.5">Stage</th>
            <th className="px-3 py-2.5">Value</th>
            <th className="px-3 py-2.5">Assignee</th>
            <th className="px-3 py-2.5">Next action</th>
            <th className="w-10 px-3 py-2.5" />
          </tr>
        </thead>
        <tbody>
          {board.stages.map((s) => (
            <Fragment key={s.id}>
              {s.leads.map((l) => (
                <tr
                  key={l.id}
                  className="border-t border-border hover:bg-card-2/60"
                  data-testid={`lead-row-${l.id}`}
                >
                  <td className="px-4 py-2.5">
                    <button type="button" onClick={() => onOpen(l.id)} className="text-left">
                      <span className="block font-medium">{l.title}</span>
                      <span className="block text-xs text-text-3">
                        {l.person?.fullName ?? l.company?.name ?? ''}
                      </span>
                    </button>
                  </td>
                  <td className="px-3 py-2.5">
                    <StagePicker board={board} lead={l} onMove={onMove} busy={busy} />
                  </td>
                  <td className="px-3 py-2.5 text-[13px] font-semibold">
                    {formatMoney(l.valueCents)}
                  </td>
                  <td className="px-3 py-2.5">
                    <span className="flex items-center gap-2 text-[13px]">
                      {l.assignee ? (
                        <Avatar name={l.assignee.fullName} seed={l.assignee.id} size="sm" />
                      ) : null}
                      {l.assignee?.fullName ?? RECORD_WORDS.unassigned}
                    </span>
                  </td>
                  <td className="px-3 py-2.5">
                    {l.status === 'open' ? (
                      <NextActionChip text={l.nextAction} compact={!!l.nextAction} />
                    ) : (
                      <StageBadge name={l.stageName} kind={l.stageKind} />
                    )}
                  </td>
                  <td className="px-3 py-2.5">
                    <button
                      type="button"
                      onClick={() => onOpen(l.id)}
                      className="rounded-control p-1 text-text-3 hover:bg-card-2 hover:text-text"
                      aria-label="Open lead"
                    >
                      <MoreHorizontal className="h-4 w-4" strokeWidth={1.5} />
                    </button>
                  </td>
                </tr>
              ))}
              {more(s) ? (
                <tr className="border-t border-border">
                  <td colSpan={6} className="px-4 py-1.5">
                    {more(s)}
                  </td>
                </tr>
              ) : null}
            </Fragment>
          ))}
        </tbody>
      </table>
      <ul className="flex flex-col divide-y divide-border md:hidden">
        {board.stages.map((s) => (
          <Fragment key={s.id}>
            {s.leads.map((l) => (
              <li
                key={l.id}
                className="flex flex-col gap-2 px-4 py-3"
                data-testid={`lead-row-${l.id}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <button
                    type="button"
                    onClick={() => onOpen(l.id)}
                    className="min-w-0 flex-1 text-left"
                  >
                    <span className="block font-medium">{l.title}</span>
                    <span className="block text-xs text-text-3">
                      {l.person?.fullName ?? l.company?.name ?? ''} · {formatMoney(l.valueCents)}
                    </span>
                  </button>
                  <StagePicker board={board} lead={l} onMove={onMove} busy={busy} tall />
                </div>
                {l.status === 'open' ? (
                  <NextActionChip
                    text={l.nextAction}
                    compact={!!l.nextAction}
                    className="self-start"
                  />
                ) : null}
              </li>
            ))}
            {more(s) ? <li className="px-4 py-1.5">{more(s)}</li> : null}
          </Fragment>
        ))}
      </ul>
    </Card>
  );
}

function StagePicker({
  board,
  lead,
  onMove,
  busy,
  tall,
}: {
  board: LeadBoard;
  lead: LeadCard;
  onMove: (leadId: string, stageId: string) => void;
  busy: boolean;
  tall?: boolean;
}) {
  return (
    <Select
      selectSize="sm"
      className={cn('w-[150px]', tall && 'h-11 w-[140px]')}
      value={lead.stageId}
      disabled={busy}
      onChange={(e) => onMove(lead.id, e.target.value)}
      aria-label={`Stage of ${lead.title}`}
      data-testid={`stage-picker-${lead.id}`}
    >
      {board.stages.map((s) => (
        <option key={s.id} value={s.id}>
          {s.name}
        </option>
      ))}
    </Select>
  );
}

export { KanbanSquare, List };
