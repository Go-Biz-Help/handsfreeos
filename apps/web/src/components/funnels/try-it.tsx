'use client';
/**
 * Trying a funnel as a lead (step 7, HANDSFREEOS_TEAMMATE_FUNNELS_IMPLEMENTATION_PLAN.md): a pretend person ("Sam")
 * walks the funnel. At each fork the step asks what Sam does, and each message shows with its time, worked out from
 * a pretend booking. Exact messages show as written; the ones the teammate writes show their brief. Nothing is sent,
 * booked or moved: core's playFunnel works out the path, so this and the tests agree.
 */
import {
  addDays,
  fillFunnelText,
  funnelAtWords,
  funnelOnlyIfWords,
  localDateOf,
  localInstant,
  playFunnel,
  type FunnelDefinition,
  type FunnelMessage,
  type FunnelNames,
  type FunnelPlayEntry,
} from '@hfos/core';
import { Bot, CornerDownRight, Flag, MessageSquare, RotateCcw, Undo2, Users } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import type { MapStage } from './funnel-map';

const SAM = 'Sam';

export function TryIt({
  definition,
  stages,
  names,
  timeZone,
  businessName,
  teammateName,
}: {
  definition: FunnelDefinition;
  stages: readonly MapStage[];
  names: FunnelNames;
  timeZone: string;
  businessName: string;
  teammateName: string;
}) {
  const id = useId();
  const inFunnel = definition.stages.map((s) => s.stageId);
  const open = stages.filter((s) => s.kind === 'open' && inFunnel.includes(s.id));
  const [startStageId, setStart] = useState(
    definition.entry.startStageId && inFunnel.includes(definition.entry.startStageId)
      ? definition.entry.startStageId
      : (open[0]?.id ?? ''),
  );
  // The pretend booking: two days from now at 7:00 PM where the business is.
  const [now] = useState(() => Date.now());
  const [bookingDay, setBookingDay] = useState(() => addDays(localDateOf(now, timeZone), 2));
  const [bookingAt, setBookingAt] = useState('19:00');
  const [choices, setChoices] = useState<string[]>([]);
  const bookingMs = useMemo(() => {
    try {
      return localInstant(bookingDay, bookingAt, timeZone);
    } catch {
      return now + 2 * 86_400_000;
    }
  }, [bookingDay, bookingAt, timeZone, now]);

  const play = useMemo(
    () =>
      startStageId
        ? playFunnel({
            definition,
            names,
            closedStageIds: new Set(stages.filter((s) => s.kind !== 'open').map((s) => s.id)),
            startStageId,
            startAt: now,
            bookingAt: bookingMs,
            timeZone,
            choices,
          })
        : null,
    [definition, names, stages, startStageId, now, bookingMs, timeZone, choices],
  );

  const messageOf = (stageId: string, messageId: string) =>
    definition.stages
      .find((s) => s.stageId === stageId)
      ?.messages.find((m) => m.id === messageId) ?? null;
  const stageName = (sid: string) => names.stages.get(sid) ?? 'a stage';
  const fills = {
    first_name: SAM,
    session_time: funnelAtWords(bookingMs, timeZone),
    join_link: 'https://book.example.com/j/Ab3dE6gHk2Lm4Np6Qr',
    business: businessName,
  };

  if (!play)
    return (
      <p className="text-[13px] text-text-2">Add an open stage to the funnel first, in step 2.</p>
    );

  return (
    <div className="flex flex-col gap-4" data-testid="funnel-try">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <Label htmlFor={`${id}-start`}>{SAM} starts at</Label>
          <Select
            id={`${id}-start`}
            selectSize="sm"
            value={startStageId}
            onChange={(e) => {
              setStart(e.target.value);
              setChoices([]);
            }}
            className="w-[200px]"
          >
            {open.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label htmlFor={`${id}-day`}>Their pretend booking</Label>
          <span className="flex gap-1.5">
            <Input
              id={`${id}-day`}
              type="date"
              inputSize="sm"
              value={bookingDay}
              onChange={(e) => e.target.value && setBookingDay(e.target.value)}
              className="w-[150px]"
            />
            <Input
              type="time"
              inputSize="sm"
              aria-label="Its time"
              value={bookingAt}
              onChange={(e) => e.target.value && setBookingAt(e.target.value.slice(0, 5))}
              className="w-[110px]"
            />
          </span>
        </div>
        <span className="flex-1" />
        <Button
          size="sm"
          variant="ghost"
          disabled={!choices.length}
          onClick={() => setChoices((c) => c.slice(0, -1))}
        >
          <Undo2 className="h-4 w-4" aria-hidden />
          Back one
        </Button>
        <Button size="sm" variant="ghost" disabled={!choices.length} onClick={() => setChoices([])}>
          <RotateCcw className="h-4 w-4" aria-hidden />
          Start over
        </Button>
      </div>

      <ol className="flex flex-col gap-2" aria-label={`What happens to ${SAM}`}>
        {play.entries.map((e, i) => (
          <Entry
            key={i}
            entry={e}
            timeZone={timeZone}
            stageName={stageName}
            teammateName={teammateName}
            message={'messageId' in e ? messageOf(e.stageId, e.messageId) : null}
            fills={fills}
          />
        ))}
      </ol>

      {play.fork ? (
        <div
          className="rounded-menu border border-accent/40 bg-accent-soft p-3.5"
          data-testid="funnel-try-fork"
        >
          <p className="text-[13.5px] font-semibold text-accent-text">
            At {stageName(play.fork.stageId)}, what does {SAM} do?
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {play.fork.options.map((o) => (
              <Button
                key={o.moveId}
                size="sm"
                variant="secondary"
                onClick={() => setChoices((c) => [...c, o.moveId])}
              >
                {o.label.charAt(0).toUpperCase()}
                {o.label.slice(1)} → {stageName(o.to)}
              </Button>
            ))}
          </div>
          <p className="mt-2 text-[12px] text-accent-text/80">
            Or nothing: the messages above are what they’d get.
          </p>
        </div>
      ) : (
        <p className="text-[13px] text-text-2">
          That’s the end of the path. Go back one, or start over to try another way.
        </p>
      )}
    </div>
  );
}

function Entry({
  entry,
  timeZone,
  stageName,
  teammateName,
  message,
  fills,
}: {
  entry: FunnelPlayEntry;
  timeZone: string;
  stageName: (id: string) => string;
  teammateName: string;
  message: FunnelMessage | null;
  fills: Parameters<typeof fillFunnelText>[1];
}) {
  const at = funnelAtWords(entry.at, timeZone);
  const row = 'flex items-start gap-2.5 text-[13px]';
  const icon = 'mt-0.5 h-4 w-4 flex-none';
  switch (entry.kind) {
    case 'arrive':
      return (
        <li className={cn(row, 'pt-1 font-semibold')}>
          <CornerDownRight className={cn(icon, 'text-text-3')} aria-hidden />
          <span className="flex-1">
            {SAM} reaches {stageName(entry.stageId)}
          </span>
          <span className="text-[12px] font-normal text-text-3">{at}</span>
        </li>
      );
    case 'message':
    case 'skipped': {
      if (!message) return null;
      const exact = message.wording === 'exact';
      return (
        <li
          className={cn(
            row,
            'rounded-menu border border-border bg-card px-3 py-2',
            entry.kind === 'skipped' && 'opacity-60',
          )}
        >
          {exact ? (
            <MessageSquare className={cn(icon, 'text-accent')} aria-hidden />
          ) : (
            <Bot className={cn(icon, 'text-accent')} aria-hidden />
          )}
          <span className="min-w-0 flex-1">
            <span className={cn('block', entry.kind === 'skipped' && 'line-through')}>
              {exact ? fillFunnelText(message.text, fills) : message.text}
            </span>
            <span className="mt-0.5 block text-[12px] text-text-3">
              {entry.kind === 'skipped'
                ? `Not sent: what ${SAM} did rules it out`
                : exact
                  ? 'Your exact words'
                  : `${teammateName} writes this from your brief`}
              {entry.kind === 'message' && entry.maybe && message.onlyIf
                ? ` · ${funnelOnlyIfWords(message.onlyIf)}`
                : ''}
            </span>
          </span>
          <span className="text-[12px] text-text-3">{at}</span>
        </li>
      );
    }
    case 'did':
      return (
        <li className={cn(row, 'text-text-2')}>
          <Flag className={cn(icon, 'text-text-3')} aria-hidden />
          <span className="flex-1">
            {SAM}: {entry.label}
          </span>
          <span className="text-[12px] text-text-3">{at}</span>
        </li>
      );
    case 'handoff':
      return (
        <li className={cn(row, 'text-text-2')}>
          <Users className={cn(icon, 'text-text-3')} aria-hidden />
          <span className="flex-1">Then your team takes over</span>
        </li>
      );
    case 'end':
      return (
        <li className={cn(row, 'text-text-2')}>
          <Flag className={cn(icon, 'text-success-text')} aria-hidden />
          <span className="flex-1">
            {SAM} leaves the funnel at {stageName(entry.stageId)}
          </span>
        </li>
      );
  }
}
