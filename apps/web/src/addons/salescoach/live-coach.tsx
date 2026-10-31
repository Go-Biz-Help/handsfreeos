'use client';
/**
 * The coach on the person's call right now (`salescoach.live`): where the call is in the script and the cards, the
 * newest on top. It reads them again the moment the worker adds one (the live update for `salescoach_call`). Drawn
 * above the web's call bar (./call-panel.tsx, `compact`) and on the Live call tab, for a call on someone's cell.
 *
 * A script whose steps name the method's stages (round five) shows the stage bar: the stages it goes through, the
 * one the call is in now, and the step. A card can carry a tip on how to say it, and a nudge stands out.
 */
import type { CardKind } from '@hfos/core/addons/salescoach/coach';
import { playbookStages, SALES_STAGE_LABELS, stageAt } from '@hfos/core/addons/salescoach/method';
import { SALESCOACH_WORDS as W } from '@hfos/core/addons/salescoach/words';
import {
  AlertTriangle,
  Headset,
  MessageCircleQuestion,
  ShieldAlert,
  Sparkles,
  StepForward,
} from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import { useLiveVersion } from '@/lib/realtime/live-provider';
import { cn } from '@/lib/utils';

type Live = Awaited<ReturnType<typeof readLive>>;
type LiveCall = NonNullable<Live['call']>;

const readLive = (workspaceId: string) =>
  apiBrowser().POST('/v1/queries/salescoach.live', { body: { workspaceId } }).then(unwrap);

const KIND_ICON: Record<CardKind, typeof Sparkles> = {
  objection: ShieldAlert,
  fact: Sparkles,
  step: StepForward,
  question: MessageCircleQuestion,
  nudge: AlertTriangle,
};

/** The person's call the coach hears now, kept fresh. Undefined while it's first read. */
export function useLiveCall(workspaceId: string): LiveCall | null | undefined {
  const version = useLiveVersion(['salescoach_call'], 150, { whileHidden: true });
  const [call, setCall] = useState<LiveCall | null | undefined>(undefined);
  useEffect(() => {
    let current = true;
    void readLive(workspaceId)
      .then((l) => current && setCall(l.call))
      .catch(() => current && setCall((c) => c ?? null));
    return () => {
      current = false;
    };
  }, [workspaceId, version]);
  return call;
}

/** Where the call is in the method: the script's stages as a bar, the one it's in now named. */
function StageBar({ call }: { call: LiveCall }) {
  const steps = call.playbook?.details.steps ?? [];
  const stages = playbookStages(steps);
  if (stages.length === 0) return null;
  const now = stageAt(steps, call.step) ?? stages[0]!;
  const at = stages.indexOf(now);
  return (
    <div className="space-y-1.5" data-testid="coach-stage">
      <div className="flex items-center gap-2 text-[12.5px] text-text-2">
        <span className="font-medium text-text">{W.live.stage}:</span>
        <span className="truncate">{SALES_STAGE_LABELS[now]}</span>
        <span className="ml-auto flex-none tabular-nums text-text-3">
          {W.live.stageOf(at + 1, stages.length)}
        </span>
      </div>
      <ol className="flex gap-1" aria-hidden>
        {stages.map((st, i) => (
          <li
            key={st}
            title={SALES_STAGE_LABELS[st]}
            className={cn(
              'h-1.5 flex-1 rounded-full',
              i < at ? 'bg-accent' : i === at ? 'bg-accent ring-2 ring-accent-soft' : 'bg-border',
            )}
          />
        ))}
      </ol>
    </div>
  );
}

function StepLine({ call }: { call: LiveCall }) {
  const steps = call.playbook?.details.steps ?? [];
  const at = steps.findIndex((s) => s.id === call.step);
  if (steps.length === 0) return null;
  return (
    <div className="flex items-center gap-2 text-[12.5px] text-text-2" data-testid="coach-step">
      <span className="font-medium text-text">{W.live.step}:</span>
      <span className="truncate">{at >= 0 ? steps[at]!.title : steps[0]!.title}</span>
      <span className="ml-auto flex-none tabular-nums text-text-3">
        {Math.max(1, at + 1)}/{steps.length}
      </span>
    </div>
  );
}

function CoachCard({
  workspaceId,
  card,
  top,
}: {
  workspaceId: string;
  card: LiveCall['cards'][number];
  top: boolean;
}) {
  const [gone, setGone] = useState(false);
  const Icon = KIND_ICON[card.kind];
  if (gone) return null;
  const dismiss = async () => {
    setGone(true);
    try {
      await apiBrowser()
        .POST('/v1/commands/salescoach.card.dismiss', { body: { workspaceId, cardId: card.id } })
        .then(unwrap);
    } catch (e) {
      setGone(false);
      toast.error(errorMessage(e));
    }
  };
  return (
    <div
      data-testid="coach-card"
      className={cn(
        'rounded-control border p-3',
        card.kind === 'nudge'
          ? 'border-warning bg-warning-soft'
          : top
            ? 'border-accent bg-accent-soft'
            : 'border-border bg-card',
      )}
    >
      <div className="flex items-center gap-2">
        <Icon
          className={cn(
            'h-4 w-4 flex-none',
            card.kind === 'nudge' ? 'text-warning-text' : 'text-accent-text',
          )}
          strokeWidth={1.75}
          aria-hidden
        />
        <Badge variant={card.kind === 'objection' || card.kind === 'nudge' ? 'pending' : 'accent'}>
          {W.cardKinds[card.kind]}
        </Badge>
        <span className="truncate text-[13.5px] font-semibold">{card.title}</span>
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto flex-none"
          onClick={() => void dismiss()}
        >
          {W.live.dismiss}
        </Button>
      </div>
      <p className={cn('mt-1.5 leading-snug', top ? 'text-[15px]' : 'text-[13.5px]')}>{card.say}</p>
      {card.tip ? (
        <p className="mt-1 text-[12.5px] text-text-2" data-testid="coach-tip">
          <span className="font-medium text-text">{W.live.how}:</span> {card.tip}
        </p>
      ) : null}
      {card.heard && top ? (
        <p className="mt-1 text-[12px] text-text-3">
          {W.live.heard}: “{card.heard}”
        </p>
      ) : null}
    </div>
  );
}

export function LiveCoach({
  workspaceId,
  compact = false,
  idle,
  ownStop = true,
}: {
  workspaceId: string;
  /** Above the call bar: the newest cards only, and nothing at all with no call. */
  compact?: boolean;
  /** What shows before the call is heard, instead of "no call right now" (the Zoom panel, while Zoom starts). */
  idle?: string;
  /** Its own button to stop the coach on the call; the Zoom panel stops Zoom's stream instead. */
  ownStop?: boolean;
}) {
  const call = useLiveCall(workspaceId);
  if (call === undefined) return null;
  if (!call) {
    if (compact) return null;
    if (idle)
      return (
        <Card className="p-4 text-[13px] text-text-2" data-testid="coach-idle">
          {idle}
        </Card>
      );
    return (
      <Card className="p-6 text-center" data-testid="coach-idle">
        <Headset className="mx-auto mb-2 h-6 w-6 text-text-3" strokeWidth={1.5} aria-hidden />
        <p className="text-[14px]">{W.live.none}</p>
        <p className="mt-1.5 text-[13px] text-text-3">{W.live.noneHow}</p>
      </Card>
    );
  }
  const cards = call.state === 'stopped' ? [] : compact ? call.cards.slice(0, 2) : call.cards;
  const status =
    call.state === 'live'
      ? W.live.listening
      : call.state === 'writing'
        ? W.live.writing
        : call.state === 'stopped'
          ? W.live.stopped
          : W.live.ended;
  const stop = async () => {
    try {
      await apiBrowser()
        .POST('/v1/commands/salescoach.call.stop', {
          body: { workspaceId, coachedCallId: call.id },
        })
        .then(unwrap);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  return (
    <Card
      className={cn('space-y-2.5', compact ? 'p-3 shadow-3' : 'p-4 md:p-5')}
      data-testid="coach-live"
      aria-live="polite"
    >
      <div className="flex items-center gap-2 text-[13px]">
        <span
          className={cn(
            'inline-block h-2 w-2 rounded-full',
            call.state === 'live' ? 'animate-pulse bg-success' : 'bg-text-3',
          )}
          aria-hidden
        />
        <span className="font-semibold">{W.title}</span>
        <span className="text-text-2">· {status}</span>
        {call.person ? (
          <span className="ml-auto truncate text-text-2">{call.person.name}</span>
        ) : null}
      </div>
      <StageBar call={call} />
      <StepLine call={call} />
      {cards.length ? (
        <div className="space-y-2">
          {cards.map((c, i) => (
            <CoachCard key={c.id} workspaceId={workspaceId} card={c} top={i === 0} />
          ))}
        </div>
      ) : call.state === 'live' ? (
        <p className="text-[13px] text-text-2">
          {call.playbook ? W.live.waiting : W.live.noPlaybook}
        </p>
      ) : null}
      {call.state === 'live' && ownStop ? (
        <Button variant="ghost" size="sm" onClick={() => void stop()} data-testid="coach-stop">
          {W.live.stop}
        </Button>
      ) : null}
      {call.state !== 'live' && call.state !== 'stopped' && !compact ? (
        <Link
          href={`/app/w/${workspaceId}/a/salescoach?view=calls&call=${call.id}`}
          className="inline-block text-[13px] font-medium text-accent-text hover:underline"
        >
          {W.live.seeCall}
        </Link>
      ) : null}
    </Card>
  );
}
