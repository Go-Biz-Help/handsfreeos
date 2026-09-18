import {
  boardStages,
  fileOfSynced,
  leadCardOfSynced,
  taskOfSynced,
  timelineEntryOfSynced,
  timelineOrder,
  type FileOut,
  type LeadCard,
  type StageRef,
  type StageWithLeads,
  type TaskOut,
  type TimelineEntry,
} from '@hfos/core';
import { useQuery } from '@powersync/react-native';
import * as React from 'react';

import { useBusiness } from '@/components/shell/business-context';
import { useNames } from '@/customers/names';
import { stateOf, useRecordChanges, type RecordState } from '@/customers/outbox';
import { useTimeZone } from '@/customers/use-record';

import {
  LEAD_FILES_SQL,
  LEAD_SQL,
  LEAD_TASKS_SQL,
  LEAD_TIMELINE_SQL,
  PIPELINES_SQL,
  PIPELINE_LEADS_SQL,
  STAGES_SQL,
} from './queries';

/**
 * The pipeline from the phone's copy, one stage at a time (the canvas: a board can't fit a phone). Everything is
 * `lead.board`'s own answer, worked out here: core's `leadCardOfSynced` builds each card and `boardStages` counts and
 * totals each stage, which is the very function the query uses, so the phone's "4 leads · $21,850" is the web's.
 */

export interface PipelineRef {
  readonly id: string;
  readonly name: string;
}

export interface Board {
  readonly loading: boolean;
  readonly pipelines: readonly PipelineRef[];
  readonly pipeline: PipelineRef | null;
  readonly stages: readonly StageWithLeads<LeadCard>[];
  /** The open stages only, for the line over the chips. */
  readonly openCount: number;
  readonly openValueCents: number;
}

const stageRefsOf = (
  rows: readonly {
    id: string;
    pipeline_id: string | null;
    name: string | null;
    kind: string | null;
    position: number | null;
  }[],
  pipelineId: string | null,
): StageRef[] =>
  rows
    .filter((s) => s.pipeline_id === pipelineId)
    .map((s) => ({
      id: s.id,
      name: s.name ?? '',
      kind: s.kind === 'won' ? 'won' : s.kind === 'lost' ? 'lost' : 'open',
      position: Number(s.position ?? 0),
    }));

/** Every pipeline the business keeps, in the order the web shows them. */
export function usePipelines(): readonly PipelineRef[] {
  const { business } = useBusiness();
  const { data } = useQuery<{ id: string; name: string | null }>(PIPELINES_SQL, [business.id]);
  return React.useMemo(() => data.map((p) => ({ id: p.id, name: p.name ?? '' })), [data]);
}

export function useBoard(pipelineId: string | null): Board {
  const { business } = useBusiness();
  const names = useNames();
  const pipelines = usePipelines();
  const pipeline = pipelines.find((p) => p.id === pipelineId) ?? pipelines[0] ?? null;
  const { data: stageRows } = useQuery<{
    id: string;
    pipeline_id: string | null;
    name: string | null;
    kind: string | null;
    position: number | null;
  }>(STAGES_SQL, [business.id]);
  const { data: leadRows, isLoading } = useQuery<Record<string, string | null>>(
    PIPELINE_LEADS_SQL,
    [business.id, pipeline?.id ?? ''],
  );

  return React.useMemo(() => {
    const stageRefs = stageRefsOf(stageRows, pipeline?.id ?? null);
    const byId = new Map(stageRows.map((s) => [s.id, s]));
    const cards = leadRows.map((row) => {
      const stage = byId.get((row.stage_id as string) ?? '');
      return leadCardOfSynced(
        row as never,
        stage
          ? {
              id: stage.id,
              pipeline_id: stage.pipeline_id,
              name: stage.name,
              kind: stage.kind,
              position: stage.position,
            }
          : null,
        names,
      );
    });
    const stages = boardStages(stageRefs, cards);
    const open = stages.filter((s) => s.kind === 'open');
    return {
      loading: isLoading,
      pipelines,
      pipeline,
      stages,
      openCount: open.reduce((a, s) => a + s.count, 0),
      openValueCents: open.reduce((a, s) => a + s.valueCents, 0),
    };
  }, [stageRows, leadRows, names, pipeline, pipelines, isLoading]);
}

export interface LeadData {
  readonly loading: boolean;
  readonly lead: LeadCard | null;
  readonly pipelineName: string;
  readonly stages: readonly StageRef[];
  readonly timeline: readonly TimelineEntry[];
  readonly tasks: readonly TaskOut[];
  readonly files: readonly FileOut[];
  readonly timeZone: string;
  readonly state: RecordState;
}

/** One lead with its pipeline's stages and everything on it, as `lead.get` answers. */
export function useLead(leadId: string): LeadData {
  const { business } = useBusiness();
  const names = useNames();
  const timeZone = useTimeZone();
  const pipelines = usePipelines();
  const changes = useRecordChanges();
  const { data: rows, isLoading } = useQuery<Record<string, string | null>>(LEAD_SQL, [leadId]);
  const { data: stageRows } = useQuery<{
    id: string;
    pipeline_id: string | null;
    name: string | null;
    kind: string | null;
    position: number | null;
  }>(STAGES_SQL, [business.id]);
  const { data: timelineRows } = useQuery<Record<string, string | null>>(LEAD_TIMELINE_SQL, [
    business.id,
    leadId,
  ]);
  const { data: taskRows } = useQuery<Record<string, string | null>>(LEAD_TASKS_SQL, [
    business.id,
    leadId,
  ]);
  const { data: fileRows } = useQuery<Record<string, string | null>>(LEAD_FILES_SQL, [
    business.id,
    leadId,
  ]);

  return React.useMemo(() => {
    const row = rows[0];
    const stage = row ? stageRows.find((s) => s.id === row.stage_id) : undefined;
    const lead = row
      ? leadCardOfSynced(
          row as never,
          stage
            ? {
                id: stage.id,
                pipeline_id: stage.pipeline_id,
                name: stage.name,
                kind: stage.kind,
                position: stage.position,
              }
            : null,
          names,
        )
      : null;
    return {
      loading: isLoading,
      lead,
      pipelineName: pipelines.find((p) => p.id === lead?.pipelineId)?.name ?? '',
      stages: stageRefsOf(stageRows, lead?.pipelineId ?? null),
      timeline: timelineOrder(timelineRows.map((r) => timelineEntryOfSynced(r as never, names))),
      tasks: taskRows.map((r) => taskOfSynced(r as never, names, timeZone)),
      files: fileRows.map((r) => fileOfSynced(r as never, names)),
      timeZone,
      state: stateOf(changes, leadId),
    };
  }, [
    rows,
    stageRows,
    timelineRows,
    taskRows,
    fileRows,
    names,
    pipelines,
    timeZone,
    changes,
    leadId,
    isLoading,
  ]);
}
