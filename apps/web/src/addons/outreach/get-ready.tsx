'use client';
/**
 * Get ready for your best results (docs/outreach.md, decision 63; packages/core/src/addons/outreach/readiness.ts): the
 * card on Today while the person isn't ready, and the setup's step. Each item says what's left and opens where it's
 * done: the main offer in Settings, a playbook's niche on the Playbooks tab, and the person's own two in a sheet here,
 * their profile list to tick and their goal with the math worked as they change it.
 */
import { WEEKDAY_WORDS } from '@hfos/core/addons/outreach/automation';
import {
  numbersLines,
  numbersMath,
  numbersVerdict,
  PROFILE_ITEMS,
  READY_WORDS as R,
  tickCounts,
  CALLS_GOAL,
  type ReadyItem,
  type ReadyState,
} from '@hfos/core/addons/outreach/readiness';
import { Check, CheckCircle2, Circle, Clock, RefreshCw } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { ButtonLink, Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { Stepper } from '@/components/ui/stepper';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import { cn } from '@/lib/utils';
import { outreachHref } from './address';
import type { Readiness } from './types';

/** Monday first, as the working week reads. */
const WEEK = [1, 2, 3, 4, 5, 6, 0] as const;

const STATE_ICON: Record<ReadyState, { icon: typeof Circle; className: string }> = {
  done: { icon: CheckCircle2, className: 'text-success' },
  todo: { icon: Circle, className: 'text-text-3' },
  look_again: { icon: RefreshCw, className: 'text-warning' },
  waiting: { icon: Clock, className: 'text-warning' },
};

/** The four items, each with what's left and where it's done. Used on Today's card and in the setup's step. */
export function ReadyItems({
  workspaceId,
  readiness,
  onChange,
}: {
  workspaceId: string;
  readiness: Readiness;
  /** The person's own two changed: what the server says now. */
  onChange?: (next: Readiness) => void;
}) {
  const [open, setOpen] = useState<'profile' | 'numbers' | null>(null);
  const go = (item: ReadyItem): ReactNode => {
    const label = R.items[item].go;
    if (item === 'offer')
      return (
        <ButtonLink
          size="sm"
          variant="secondary"
          href={`/app/w/${workspaceId}/settings/main-offer`}
        >
          {label}
        </ButtonLink>
      );
    if (item === 'playbook')
      return (
        <ButtonLink
          size="sm"
          variant="secondary"
          href={outreachHref(workspaceId, { view: 'playbooks' })}
        >
          {label}
        </ButtonLink>
      );
    return (
      <Button
        size="sm"
        variant="secondary"
        onClick={() => setOpen(item)}
        data-testid={`ready-open-${item}`}
      >
        {label}
      </Button>
    );
  };
  return (
    <>
      <ul className="divide-y divide-border">
        {readiness.items.map((i) => {
          const { icon: Icon, className } = STATE_ICON[i.state];
          return (
            <li
              key={i.item}
              className="grid grid-cols-[20px_minmax(0,1fr)] gap-3 py-4 sm:grid-cols-[20px_minmax(0,1fr)_auto] sm:items-start"
              data-testid={`ready-${i.item}`}
              data-state={i.state}
            >
              <Icon
                className={cn('mt-0.5 h-5 w-5', className)}
                strokeWidth={1.75}
                aria-label={R.states[i.state]}
                role="img"
              />
              <div className="min-w-0">
                <p className="font-semibold">{R.items[i.item].label}</p>
                {i.state === 'done' ? null : (
                  <p className="text-[13px] text-text-2">{R.items[i.item].why}</p>
                )}
                {i.left ? <p className="mt-1 text-[13px]">{i.left}</p> : null}
                {i.item === 'profile' && i.state === 'look_again' && readiness.changed.length ? (
                  <p className="text-[13px] text-text-2">{R.changed(readiness.changed)}</p>
                ) : null}
              </div>
              <div className="col-start-2 sm:col-start-3">
                {i.state === 'done' ? (
                  <span className="inline-flex h-[22px] items-center rounded-full bg-success-soft px-2 text-[12px] font-medium text-success-text">
                    {R.states.done}
                  </span>
                ) : i.state === 'waiting' ? (
                  <span className="inline-flex h-[22px] items-center rounded-full bg-warning-soft px-2 text-[12px] font-medium text-warning-text">
                    {R.states.waiting}
                  </span>
                ) : (
                  go(i.item)
                )}
              </div>
            </li>
          );
        })}
      </ul>
      <ProfileSheet
        workspaceId={workspaceId}
        readiness={readiness}
        open={open === 'profile'}
        onClose={() => setOpen(null)}
        onChange={onChange}
      />
      <NumbersSheet
        workspaceId={workspaceId}
        readiness={readiness}
        open={open === 'numbers'}
        onClose={() => setOpen(null)}
        onChange={onChange}
      />
    </>
  );
}

/** Today's card while the person isn't ready: in place of the day's list. */
export function GetReadyCard({
  workspaceId,
  readiness: start,
}: {
  workspaceId: string;
  readiness: Readiness;
}) {
  const router = useRouter();
  const [readiness, setReadiness] = useState(start);
  const done = readiness.items.filter((i) => i.state === 'done').length;
  const of = readiness.items.length;
  const waitingOnBusiness = readiness.items.some((i) => i.state === 'waiting');
  return (
    <Card className="p-0" data-testid="get-ready">
      <div className="grid gap-3 p-5 pb-1">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3">
              {R.card}
            </p>
            <h2 className="mt-1 text-lg font-semibold tracking-tight">{R.title}</h2>
            <p className="mt-1 text-[13px] text-text-2">
              {R.cardHint(of - done)}
              {waitingOnBusiness ? ` ${R.waitingBusiness}` : ''}
            </p>
          </div>
          <span className="text-[13px] tabular-nums text-text-2">{R.progress(done, of)}</span>
        </div>
        <div
          className="h-1.5 overflow-hidden rounded-full bg-card-2"
          role="progressbar"
          aria-label={R.progress(done, of)}
          aria-valuemin={0}
          aria-valuemax={of}
          aria-valuenow={done}
        >
          <div
            className="h-full rounded-full bg-accent"
            style={{ width: `${(done / of) * 100}%` }}
          />
        </div>
      </div>
      <div className="px-5 pb-1">
        <ReadyItems
          workspaceId={workspaceId}
          readiness={readiness}
          onChange={(next) => {
            setReadiness(next);
            // Ready now: Today's list comes back.
            if (next.ready) router.refresh();
          }}
        />
      </div>
    </Card>
  );
}

function ProfileSheet({
  workspaceId,
  readiness,
  open,
  onClose,
  onChange,
}: {
  workspaceId: string;
  readiness: Readiness;
  open: boolean;
  onClose: () => void;
  onChange?: (next: Readiness) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const live = readiness.offer?.version ?? null;
  const on = (item: (typeof PROFILE_ITEMS)[number]) => tickCounts(readiness.profile[item], live);
  const ticked = PROFILE_ITEMS.filter(on).length;
  const again = readiness.items.find((i) => i.item === 'profile')?.state === 'look_again';
  const tick = async (item: (typeof PROFILE_ITEMS)[number]) => {
    setBusy(item);
    try {
      const next = unwrap(
        await apiBrowser().POST('/v1/commands/outreach.readiness.profile', {
          body: { workspaceId, item, done: !on(item) },
        }),
      );
      onChange?.(next);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent title={R.profile.title} description={R.profile.hint}>
        <div className="grid gap-4" data-testid="ready-profile-sheet">
          {again ? (
            <p
              role="status"
              className="rounded-menu bg-warning-soft p-3 text-[13px] text-warning-text"
            >
              <span className="font-semibold">{R.left.profileAgain}</span>
              {readiness.changed.length ? ` ${R.changed(readiness.changed)}` : null}
            </p>
          ) : null}
          {readiness.offer ? (
            <div className="grid gap-1.5">
              <div className="flex justify-between text-[13px] text-text-2">
                <span>{R.profile.offer}</span>
                <span className="tabular-nums">
                  {R.profile.ticked(ticked, PROFILE_ITEMS.length)}
                </span>
              </div>
              <p className="text-[13px] font-medium">“{readiness.offer.line}”</p>
            </div>
          ) : null}
          <ul className="divide-y divide-border">
            {PROFILE_ITEMS.map((item) => {
              const words = R.profile.items[item];
              const checked = on(item);
              return (
                <li key={item} className="grid grid-cols-[24px_minmax(0,1fr)] gap-3 py-3.5">
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={checked}
                    aria-label={words.label}
                    disabled={busy !== null}
                    onClick={() => void tick(item)}
                    data-testid={`ready-profile-${item}`}
                    className={cn(
                      'mt-0.5 inline-flex h-5 w-5 items-center justify-center rounded-[6px] border-[1.5px] focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring disabled:cursor-wait',
                      checked
                        ? 'border-accent bg-accent text-white'
                        : 'border-border-strong bg-card',
                    )}
                  >
                    {checked ? <Check className="h-3.5 w-3.5" strokeWidth={2.5} /> : null}
                  </button>
                  <div className="min-w-0">
                    <p className="font-semibold">{words.label}</p>
                    <p className="text-[13px] text-text-2">{words.tip}</p>
                  </div>
                </li>
              );
            })}
          </ul>
          <div className="flex justify-end">
            <Button onClick={onClose} data-testid="ready-profile-done">
              {R.profile.done}
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function NumbersSheet({
  workspaceId,
  readiness,
  open,
  onClose,
  onChange,
}: {
  workspaceId: string;
  readiness: Readiness;
  open: boolean;
  onClose: () => void;
  onChange?: (next: Readiness) => void;
}) {
  const [goal, setGoal] = useState(readiness.numbers.goal ?? 8);
  const [days, setDays] = useState<number[]>(readiness.numbers.days);
  const [busy, setBusy] = useState(false);
  const m = numbersMath({ goal, daysAWeek: days.length, canSend: readiness.numbers.canSend });
  const toggle = (d: number) =>
    setDays((now) =>
      now.includes(d) ? (now.length > 1 ? now.filter((x) => x !== d) : now) : [...now, d],
    );
  const save = async () => {
    setBusy(true);
    try {
      const next = unwrap(
        await apiBrowser().POST('/v1/commands/outreach.readiness.numbers', {
          body: { workspaceId, goal, days },
        }),
      );
      toast.success(R.numbers.saved);
      onChange?.(next);
      onClose();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent title={R.numbers.title} description={R.numbers.hint}>
        <div className="grid gap-6" data-testid="ready-numbers-sheet">
          <div className="grid gap-2">
            <span className="text-[13px] font-medium" id="ready-goal">
              {R.numbers.goal}
            </span>
            <Stepper
              value={goal}
              onChange={setGoal}
              min={CALLS_GOAL.min}
              max={CALLS_GOAL.max}
              label={R.numbers.goal}
              testId="ready-goal"
            />
          </div>
          <div className="grid gap-2">
            <span className="text-[13px] font-medium" id="ready-days">
              {R.numbers.days}
            </span>
            <div className="flex flex-wrap gap-1.5" role="group" aria-labelledby="ready-days">
              {WEEK.map((d) => {
                const picked = days.includes(d);
                return (
                  <button
                    key={d}
                    type="button"
                    aria-pressed={picked}
                    onClick={() => toggle(d)}
                    data-testid={`ready-day-${d}`}
                    className={cn(
                      'h-9 min-w-[52px] rounded-full border px-2.5 text-[13px] font-medium focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring',
                      picked
                        ? 'border-accent bg-accent-soft text-accent-text'
                        : 'border-border-strong bg-card text-text-2 hover:bg-card-2',
                    )}
                  >
                    {WEEKDAY_WORDS[d]}
                  </button>
                );
              })}
            </div>
            {days.includes(0) ? (
              <p className="text-[12.5px] text-warning-text">{R.numbers.sunday}</p>
            ) : null}
          </div>
          <div className="grid gap-3" data-testid="ready-math">
            <span className="text-[13px] font-medium">{R.numbers.takes}</span>
            <div className="flex flex-wrap gap-6">
              <div>
                <p className="text-[28px] font-semibold tabular-nums tracking-tight">
                  {m.messagesADay.low} to {m.messagesADay.high}
                </p>
                <p className="text-[13px] text-text-2">{R.numbers.messagesADay}</p>
              </div>
              <div>
                <p className="text-[28px] font-semibold tabular-nums tracking-tight">
                  {Math.round(m.yesesADay * 10) / 10}
                </p>
                <p className="text-[13px] text-text-2">{R.numbers.yesesADay}</p>
              </div>
            </div>
            <ol className="grid list-decimal gap-1.5 rounded-menu bg-card-2 py-3 pl-8 pr-4 text-[13px] tabular-nums">
              {numbersLines(goal, m).map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ol>
            <p
              role="status"
              data-testid="ready-verdict"
              data-fits={m.fits}
              className={cn(
                'rounded-menu p-3 text-[13px]',
                m.fits === 'yes'
                  ? 'bg-success-soft text-success-text'
                  : 'bg-warning-soft text-warning-text',
              )}
            >
              {numbersVerdict(m)}
            </p>
            <p className="text-[12px] text-text-3">
              {R.numbers.rates} {R.numbers.notMessages}
            </p>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={() => void save()} loading={busy} data-testid="ready-numbers-save">
              {R.numbers.save}
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
