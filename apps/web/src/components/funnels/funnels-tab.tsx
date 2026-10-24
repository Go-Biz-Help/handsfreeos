'use client';
/**
 * AI teammate → Funnels (HANDSFREEOS_TEAMMATE_FUNNELS_IMPLEMENTATION_PLAN.md, step 3): each funnel with its pipeline,
 * how many people are at each stage, and its switch. New funnel opens the steps.
 */
import { FUNNEL_STATUS_WORDS } from '@hfos/core';
import { ChevronRight, Plus } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { TeammateTabShell } from '@/components/ai-team/tab-shell';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
import { ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Switch } from '@/components/ui/switch';
import type { TeammateGet } from '@/lib/ai-team/types';
import { errorMessage } from '@/lib/api/client';
import { funnelActions, type FunnelList, type FunnelSummaryOut } from '@/lib/funnels/actions';

const STATUS_BADGE: Readonly<Record<FunnelSummaryOut['status'], BadgeVariant>> = {
  on: 'ok',
  paused: 'pending',
  draft: 'gray',
  archived: 'gray',
};

export function FunnelsTab({
  workspaceId,
  data,
  list,
  suggestions,
}: {
  workspaceId: string;
  data: TeammateGet;
  list: FunnelList;
  /** The teammate's suggestions waiting on Approvals. */
  suggestions: number;
}) {
  return (
    <TeammateTabShell
      workspaceId={workspaceId}
      data={data}
      emptyBody="Funnels are run by the AI teammate. Once it’s set up, make one here."
      testId="teammate-funnels-tab"
    >
      {data.teammate ? (
        <Funnels
          workspaceId={workspaceId}
          name={data.teammate.name}
          canManage={data.canManage}
          initial={list.funnels}
          suggestions={suggestions}
        />
      ) : null}
    </TeammateTabShell>
  );
}

function Funnels({
  workspaceId,
  name,
  canManage,
  initial,
  suggestions,
}: {
  workspaceId: string;
  name: string;
  canManage: boolean;
  initial: readonly FunnelSummaryOut[];
  suggestions: number;
}) {
  const base = `/app/w/${workspaceId}/ai-team/funnels`;
  return (
    <div className="flex flex-col gap-3" data-testid="funnels">
      <Card className="flex flex-wrap items-start gap-3 p-4">
        <div className="min-w-0 flex-1">
          <h2 className="text-[15px] font-semibold">Funnels</h2>
          <p className="mt-1 max-w-[640px] text-[13px] text-text-2">
            {name} takes each person through a funnel’s stages. It sends each stage’s messages at
            the right time, answers their questions knowing where they are, and moves them on.
          </p>
        </div>
        {canManage ? (
          <ButtonLink href={`${base}/new`} size="sm" data-testid="funnel-new">
            <Plus className="h-4 w-4" aria-hidden />
            New funnel
          </ButtonLink>
        ) : null}
      </Card>
      {suggestions > 0 ? (
        <Card className="flex flex-wrap items-center gap-3 border-accent/40 bg-accent-soft p-3.5">
          <p className="flex-1 text-[13px] text-accent-text">
            {name} thinks {suggestions === 1 ? 'someone fits' : `${suggestions} people fit`} a
            funnel. Someone on the team says yes or no first.
          </p>
          <ButtonLink
            href={`/app/w/${workspaceId}/ai-team/approvals`}
            size="sm"
            variant="secondary"
          >
            Review on Approvals
          </ButtonLink>
        </Card>
      ) : null}
      {initial.length === 0 ? (
        <Card>
          <EmptyState
            title="No funnels yet"
            actions={
              canManage ? (
                <ButtonLink href={`${base}/new`} size="sm">
                  Make your first funnel
                </ButtonLink>
              ) : undefined
            }
          >
            A funnel is the path you want people to take, from first hearing about you to where you
            want them. {name} follows it for you, so nobody has to build workflows.
          </EmptyState>
        </Card>
      ) : (
        initial.map((f) => (
          <FunnelCard key={f.id} workspaceId={workspaceId} funnel={f} canManage={canManage} />
        ))
      )}
    </div>
  );
}

function FunnelCard({
  workspaceId,
  funnel,
  canManage,
}: {
  workspaceId: string;
  funnel: FunnelSummaryOut;
  canManage: boolean;
}) {
  const router = useRouter();
  const actions = useMemo(() => funnelActions(workspaceId), [workspaceId]);
  const [busy, setBusy] = useState(false);
  const href = `/app/w/${workspaceId}/ai-team/funnels/${funnel.id}`;
  const inFunnel = funnel.stages.filter((s) => s.inFunnel);
  const draft = funnel.status === 'draft';

  async function flip(on: boolean) {
    setBusy(true);
    try {
      if (on) await actions.turnOn(funnel.id, false);
      else await actions.pause(funnel.id);
      toast.success(
        on
          ? `${funnel.name} is on.`
          : `${funnel.name} is paused. Nothing goes out until it’s back on.`,
      );
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="p-4" data-testid={`funnel-${funnel.id}`}>
      <div className="flex flex-wrap items-center gap-2">
        <a href={href} className="text-[15px] font-semibold hover:underline">
          {funnel.name}
        </a>
        <Badge variant={STATUS_BADGE[funnel.status]}>{FUNNEL_STATUS_WORDS[funnel.status]}</Badge>
        <span className="flex-1" />
        {canManage && !draft ? (
          <Switch
            checked={funnel.status === 'on'}
            onChange={(on) => void flip(on)}
            busy={busy}
            label={funnel.status === 'on' ? `Pause ${funnel.name}` : `Turn ${funnel.name} on`}
            testId={`funnel-switch-${funnel.id}`}
          />
        ) : null}
        <ButtonLink href={href} size="sm" variant={draft ? 'primary' : 'secondary'}>
          {draft ? 'Finish setting it up' : 'Open map'}
        </ButtonLink>
      </div>
      <p className="mt-1 text-[12.5px] text-text-2">
        Pipeline: {funnel.pipelineName} · {inFunnel.length}{' '}
        {inFunnel.length === 1 ? 'stage' : 'stages'}
        {draft
          ? ' · Not on yet. Next: try it as a lead, then turn it on'
          : ` · ${funnel.people} ${funnel.people === 1 ? 'person' : 'people'} in it${
              funnel.paused ? ` · ${funnel.paused} paused while your team talks to them` : ''
            }`}
      </p>
      {!draft ? (
        <ol
          className="mt-3 flex flex-wrap items-center gap-1"
          aria-label={`${funnel.name}’s stages`}
        >
          {inFunnel.map((s, i) => (
            <li key={s.id} className="flex items-center gap-1">
              <span
                className={
                  s.kind === 'open'
                    ? 'inline-flex h-7 items-center gap-1.5 rounded-full border border-border bg-card-2 px-2.5 text-[12.5px]'
                    : 'inline-flex h-7 items-center gap-1.5 rounded-full border border-dashed border-border-strong px-2.5 text-[12.5px] text-text-2'
                }
              >
                {s.name}
                {s.kind === 'open' ? (
                  <span className="font-semibold tabular-nums text-text">{s.people}</span>
                ) : null}
              </span>
              {i < inFunnel.length - 1 ? (
                <ChevronRight className="h-3.5 w-3.5 text-text-3" aria-hidden />
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}
      {funnel.updatedBy ? (
        <p className="mt-2 text-[12px] text-text-3">Changed by {funnel.updatedBy}</p>
      ) : null}
    </Card>
  );
}
