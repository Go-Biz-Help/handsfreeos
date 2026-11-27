'use client';
/**
 * The buttons on a row of Today's Plan (docs/outreach.md, decision 195, step 3): **Do now**, **Skip today** and
 * **Move to a time**, in the row's menu, and **Put back** on a row that was put first or moved, and under "Skipped or
 * moved today". Each press is `outreach.plan.change`, and the plan is asked for again at once. What a row can be told
 * is the plan's own say (`can`): a row under way, or one HandsFreeOS doesn't order there, offers less or nothing.
 * The words are core's (`PLAN_CHANGE_UI`), the same on the phone.
 */
import {
  PLAN_CHANGE_UI as U,
  PLAN_CHANGE_WORDS,
  planMoveStart,
  type PlanChangeAsk,
} from '@hfos/core/addons/outreach/plan-changes';
import type { Platform } from '@hfos/core/addons/outreach/networks';
import { rowWords } from '@hfos/core/addons/outreach/plan';
import { MoreHorizontal } from 'lucide-react';
import { useCallback, useId, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { Plan } from './types';

type Row = Plan['coming'][number];

/**
 * Sends a change to a row, says what happened in the answer's own line, and calls `after` so the plan is asked for
 * again. `busy` is the row's key while its press runs.
 */
export function usePlanChange(workspaceId: string, platform: Platform, after: () => void) {
  const [busy, setBusy] = useState<string | null>(null);
  const change = useCallback(
    async (key: string, what: PlanChangeAsk, time?: string): Promise<boolean> => {
      setBusy(key);
      try {
        const out = unwrap(
          await apiBrowser().POST('/v1/commands/outreach.plan.change', {
            body: { workspaceId, platform, key, change: what, ...(time ? { time } : {}) },
          }),
        );
        toast.success(out.words);
        after();
        return true;
      } catch (e) {
        toast.error(errorMessage(e));
        return false;
      } finally {
        setBusy(null);
      }
    },
    [workspaceId, platform, after],
  );
  return { busy, change };
}

/** A row's menu: what it can be told, and Put back when a change of the person's is in force on it. */
export function PlanRowMenu({
  row,
  busy,
  onChange,
  onMove,
}: {
  row: Row;
  /** A press is running, on this row or another. */
  busy: boolean;
  onChange: (what: PlanChangeAsk) => void;
  /** Opens the box for Move to a time. */
  onMove: () => void;
}) {
  const can = row.can ?? [];
  if (!row.key || (!can.length && !row.changed)) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={busy}
          aria-label={U.menu(rowWords(row))}
          className="-my-1 rounded-control p-1 text-text-3 hover:bg-card-2 hover:text-text disabled:opacity-50"
          data-testid="plan-row-menu"
        >
          <MoreHorizontal className="h-4 w-4" strokeWidth={1.5} aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        {can.includes('now') && row.changed !== 'now' ? (
          <DropdownMenuItem onSelect={() => onChange('now')} data-testid="plan-row-now">
            {PLAN_CHANGE_WORDS.now}
          </DropdownMenuItem>
        ) : null}
        {can.includes('at') ? (
          <DropdownMenuItem onSelect={onMove} data-testid="plan-row-move">
            {PLAN_CHANGE_WORDS.at}
          </DropdownMenuItem>
        ) : null}
        {can.includes('skip') ? (
          <DropdownMenuItem onSelect={() => onChange('skip')} data-testid="plan-row-skip">
            {PLAN_CHANGE_WORDS.skip}
          </DropdownMenuItem>
        ) : null}
        {row.changed ? (
          <DropdownMenuItem onSelect={() => onChange('back')} data-testid="plan-row-back">
            {U.back}
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The box for Move to a time: a time today on the business's clock, starting at the next half hour. */
export function PlanMoveBox({
  now,
  timeZone,
  busy,
  onMove,
  onCancel,
}: {
  /** The plan's own now, so the box starts from HandsFreeOS's clock and not this computer's. */
  now: string;
  timeZone: string;
  busy: boolean;
  onMove: (time: string) => void;
  onCancel: () => void;
}) {
  const id = useId();
  const [time, setTime] = useState(() => planMoveStart(now, timeZone));
  return (
    <form
      className="mt-2 flex flex-wrap items-center gap-2 sm:pl-[108px]"
      onSubmit={(e) => {
        e.preventDefault();
        onMove(time);
      }}
      data-testid="plan-move-box"
    >
      <label htmlFor={id} className="text-[13px] text-text-2">
        {U.timeLabel}
      </label>
      <Input
        id={id}
        type="time"
        inputSize="sm"
        required
        autoFocus
        value={time}
        onChange={(e) => setTime(e.target.value.slice(0, 5))}
        className="w-[120px]"
        aria-describedby={`${id}-hint`}
      />
      <Button type="submit" size="sm" loading={busy} disabled={!time} data-testid="plan-move-go">
        {U.move}
      </Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
        {U.cancel}
      </Button>
      <span id={`${id}-hint`} className="text-[12.5px] text-text-3">
        {U.timeHint}
      </span>
    </form>
  );
}
