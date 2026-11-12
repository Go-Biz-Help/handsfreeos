'use client';
/**
 * Time on a job (docs/contractor.md, "Time and job costing"; the owner's decision 10): each stretch of travel, work
 * or break, whose it is and how long. Time starts and stops with the visit's On the way, Started, Waiting on parts
 * and Done buttons, so nobody fills in a timesheet; this card shows it, lets someone on the clock take a break, and
 * lets the people who may (`contractor.fix_time`) fix, add and remove time, always with a reason. On the job's page
 * it's all the job's time; on a visit's work order it's that visit's.
 *
 * It never shows what the time cost: that's on the job's Costs so far card, for people who may see job costs (the
 * owner's decision 11). How long a stretch is and the totals come worked out from the server.
 */
import { LIMITS } from '@hfos/core/addons/contractor/schemas';
import { durationWords, TIME_KINDS, type TimeKind } from '@hfos/core/addons/contractor/time';
import { CONTRACTOR_WORDS, TIME_KIND_WORDS } from '@hfos/core/addons/contractor/words';
import { formatDate, instantOfInput, timeOfDay, zonedInputValue } from '@hfos/core';
import { AlertTriangle, Clock, MoreHorizontal } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Field } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { dateOf } from '@/lib/calendar/time';
import { jobHref } from './bits';
import { ReasonDialog } from './job-dialogs';
import type { Teammate, TimeEntry, TimeList } from './types';
import { useAct } from './use-act';

const T = CONTRACTOR_WORDS.time;
/** How many stretches show before "Show all". */
const FIRST = 8;

/** A visit time can be on, as the card names it and the Add dialog picks it. */
export interface TimeVisit {
  readonly appointmentId: string;
  readonly label: string;
}

export function TimeCard({
  workspaceId,
  jobId,
  time,
  visits,
  people,
  timeZone,
  forVisit,
}: {
  workspaceId: string;
  jobId: string;
  time: TimeList;
  /** The job's visits, to say which one a stretch was on. */
  visits: readonly TimeVisit[];
  /** The people time can be added for. */
  people: readonly Teammate[];
  timeZone: string;
  /** On a visit's work order: the visit, whose time this is. */
  forVisit?: string;
}) {
  const { busy, act } = useAct();
  const [all, setAll] = useState(false);
  const [adding, setAdding] = useState(false);
  const [fixing, setFixing] = useState<TimeEntry | null>(null);
  const [removing, setRemoving] = useState<TimeEntry | null>(null);
  const { entries, totals, mine } = time;
  const mayFix = time.may.fix;
  const shown = all ? entries : entries.slice(0, FIRST);
  const visitLabel = (appointmentId: string | null) =>
    appointmentId ? (visits.find((v) => v.appointmentId === appointmentId)?.label ?? null) : null;
  const sums = [
    totals.workSeconds ? `${T.work} ${durationWords(totals.workSeconds)}` : null,
    totals.travelSeconds ? `${T.travel} ${durationWords(totals.travelSeconds)}` : null,
    totals.breakSeconds ? `${T.breaks} ${durationWords(totals.breakSeconds)}` : null,
  ].filter(Boolean);
  // The Break button is for someone working (or on a break) on a visit right now: here, that visit.
  const breakOn =
    mine &&
    mine.appointmentId &&
    mine.kind !== 'travel' &&
    (!forVisit || mine.appointmentId === forVisit)
      ? { appointmentId: mine.appointmentId, onBreak: mine.kind === 'work' }
      : null;
  return (
    <Card className="p-0" data-testid="time-card">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-5 py-3.5">
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold">{forVisit ? T.visitTitle : T.title}</h2>
          {entries.length ? (
            <p className="text-[12.5px] text-text-3" data-testid="time-totals">
              {sums.join(' · ')}
              {totals.running ? (
                <span className="text-text-2">
                  {sums.length ? ' · ' : ''}
                  {T.onClock(totals.running)}
                </span>
              ) : null}
            </p>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          {breakOn ? (
            <Button
              size="sm"
              variant="secondary"
              loading={busy === 'break'}
              onClick={() =>
                void act(
                  'break',
                  async () =>
                    unwrap(
                      await apiBrowser().POST('/v1/commands/contractor.time.set_break', {
                        body: { workspaceId, ...breakOn },
                      }),
                    ),
                  breakOn.onBreak ? T.breakStarted : T.breakEnded,
                )
              }
              data-testid="time-break"
            >
              {breakOn.onBreak ? T.takeBreak : T.backToWork}
            </Button>
          ) : null}
          {mayFix ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setAdding(true)}
              data-testid="time-add"
            >
              {T.add}
            </Button>
          ) : null}
        </div>
      </div>
      {entries.length === 0 ? (
        <p className="px-5 py-4 text-[13.5px] text-text-2">{forVisit ? T.noneForVisit : T.none}</p>
      ) : (
        <ul>
          {shown.map((e) => {
            const visit = forVisit ? null : visitLabel(e.appointmentId);
            const sameDay =
              e.endedAt !== null && dateOf(e.startedAt, timeZone) === dateOf(e.endedAt, timeZone);
            return (
              <li
                key={e.id}
                className="flex flex-wrap items-start gap-x-3 gap-y-1 border-b border-border px-5 py-3 last:border-b-0"
                data-testid="time-entry"
              >
                <Clock className="mt-0.5 h-4 w-4 flex-none text-text-3" strokeWidth={1.75} />
                <div className="min-w-[160px] flex-1">
                  <div className="flex flex-wrap items-center gap-2 text-[14px] font-medium">
                    <span>{e.name}</span>
                    <span className="font-normal text-text-2">{TIME_KIND_WORDS[e.kind]}</span>
                    {e.endedAt === null ? (
                      <Badge variant="pending" data-testid="time-running">
                        {T.running}
                      </Badge>
                    ) : null}
                  </div>
                  <div className="mt-0.5 flex flex-wrap gap-x-3 text-[12.5px] text-text-3">
                    <span className="text-text-2">
                      {formatDate(e.startedAt, { time: true, timeZone })}
                      {e.endedAt === null
                        ? null
                        : ` to ${sameDay ? timeOfDay(e.endedAt, timeZone) : formatDate(e.endedAt, { time: true, timeZone })}`}
                    </span>
                    {visit ? <span>{visit}</span> : null}
                  </div>
                  {e.autoStopped ? (
                    <p
                      className="mt-1 flex items-start gap-1.5 text-[12.5px] text-danger-text"
                      data-testid="time-auto-stopped"
                    >
                      <AlertTriangle className="mt-px h-3.5 w-3.5 flex-none" strokeWidth={2} />
                      <span>
                        {T.autoStopped} {mayFix ? T.autoStoppedFix : T.onlyFixers}
                      </span>
                    </p>
                  ) : null}
                  {e.fixed ? (
                    <p className="mt-1 text-[12.5px] text-text-2" data-testid="time-fixed">
                      {T.fixedBy(e.fixed.by, e.fixed.reason)}
                    </p>
                  ) : null}
                </div>
                <span
                  className="flex-none pt-0.5 text-[13.5px] font-medium tabular-nums"
                  data-testid="time-length"
                >
                  {durationWords(e.seconds)}
                </span>
                {mayFix ? (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        className="rounded p-1.5 text-text-3 hover:bg-card-2 hover:text-text"
                        aria-label={T.menu(e.name)}
                        data-testid="time-menu"
                      >
                        <MoreHorizontal className="h-4 w-4" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent>
                      <DropdownMenuItem onSelect={() => setFixing(e)}>{T.fix}</DropdownMenuItem>
                      <DropdownMenuItem danger onSelect={() => setRemoving(e)}>
                        {T.remove}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {entries.length > FIRST || time.truncated || forVisit ? (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-5 py-2.5 text-[12.5px] text-text-2">
          {entries.length > FIRST ? (
            <button
              type="button"
              className="hover:text-text hover:underline"
              onClick={() => setAll(!all)}
              data-testid="time-show-all"
            >
              {all ? T.showFewer : T.showAll(entries.length)}
            </button>
          ) : null}
          {time.truncated && all ? <span>{T.truncated(entries.length)}</span> : null}
          {forVisit ? (
            <Link href={jobHref(workspaceId, jobId)} className="hover:text-text hover:underline">
              {T.seeAll}
            </Link>
          ) : null}
        </div>
      ) : null}
      <Dialog open={adding} onOpenChange={setAdding}>
        <DialogContent title={T.addTitle} description={T.addHint}>
          {adding ? (
            <TimeForm
              workspaceId={workspaceId}
              jobId={jobId}
              entry={null}
              visits={visits}
              people={people}
              timeZone={timeZone}
              forVisit={forVisit}
              onClose={() => setAdding(false)}
            />
          ) : null}
        </DialogContent>
      </Dialog>
      <Dialog open={fixing !== null} onOpenChange={(o) => !o && setFixing(null)}>
        <DialogContent title={fixing ? T.fixTitle(fixing.name) : T.fix}>
          {fixing ? (
            <TimeForm
              workspaceId={workspaceId}
              jobId={jobId}
              entry={fixing}
              visits={visits}
              people={people}
              timeZone={timeZone}
              forVisit={forVisit}
              onClose={() => setFixing(null)}
            />
          ) : null}
        </DialogContent>
      </Dialog>
      <ReasonDialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={removing ? T.removeTitle(removing.name) : T.remove}
        description={T.removeAsk}
        placeholder={T.reasonPlaceholder}
        submit={T.remove}
        danger
        done={removing ? T.removed(removing.name) : ''}
        run={async (reason) =>
          removing &&
          unwrap(
            await apiBrowser().POST('/v1/commands/contractor.time.remove', {
              body: { workspaceId, entryId: removing.id, reason },
            }),
          )
        }
      />
    </Card>
  );
}

/**
 * Fixing a stretch (its start, end and what it was) or adding one that wasn't tracked. Times are typed on the
 * business's clock. A fix sends only what was changed, so a start nobody touched keeps its seconds.
 */
function TimeForm({
  workspaceId,
  jobId,
  entry,
  visits,
  people,
  timeZone,
  forVisit,
  onClose,
}: {
  workspaceId: string;
  jobId: string;
  entry: TimeEntry | null;
  visits: readonly TimeVisit[];
  people: readonly Teammate[];
  timeZone: string;
  forVisit?: string;
  onClose: () => void;
}) {
  const startWas = entry ? zonedInputValue(entry.startedAt, timeZone) : '';
  const endWas = entry?.endedAt ? zonedInputValue(entry.endedAt, timeZone) : '';
  const [userId, setUserId] = useState('');
  const [kind, setKind] = useState<TimeKind>(entry?.kind ?? 'work');
  const [appointmentId, setAppointmentId] = useState(forVisit ?? '');
  const [start, setStart] = useState(startWas);
  const [end, setEnd] = useState(endWas);
  const [reason, setReason] = useState('');
  const { busy, errors, setErrors, act } = useAct(onClose);
  const submit = () => {
    const bad: Record<string, string> = {};
    const startMs = start ? instantOfInput(start, timeZone) : null;
    const endMs = end ? instantOfInput(end, timeZone) : null;
    if (!entry && !userId) bad.userId = T.needPerson;
    if (startMs === null) bad.startedAt = T.needStart;
    if (endMs === null) bad.endedAt = T.needEnd;
    if (Object.keys(bad).length || startMs === null || endMs === null) return setErrors(bad);
    const startedAt = new Date(startMs).toISOString();
    const endedAt = new Date(endMs).toISOString();
    void act(
      'save',
      async () =>
        entry
          ? unwrap(
              await apiBrowser().POST('/v1/commands/contractor.time.fix', {
                body: {
                  workspaceId,
                  entryId: entry.id,
                  ...(start !== startWas ? { startedAt } : {}),
                  ...(end !== endWas ? { endedAt } : {}),
                  ...(kind !== entry.kind ? { kind } : {}),
                  reason: reason.trim(),
                },
              }),
            )
          : unwrap(
              await apiBrowser().POST('/v1/commands/contractor.time.add', {
                body: {
                  workspaceId,
                  jobId,
                  userId,
                  kind,
                  ...(appointmentId ? { appointmentId } : {}),
                  startedAt,
                  endedAt,
                  reason: reason.trim(),
                },
              }),
            ),
      entry ? T.fixed : T.added(people.find((p) => p.userId === userId)?.name ?? ''),
    );
  };
  return (
    <form
      className="mt-4 space-y-3.5"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      data-testid="time-form"
    >
      {entry ? null : (
        <Field label={T.person} htmlFor="time-person" error={errors.userId}>
          <Select
            id="time-person"
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            data-testid="time-person"
          >
            <option value="">Pick someone…</option>
            {people.map((p) => (
              <option key={p.userId} value={p.userId}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={T.kind} htmlFor="time-kind" error={errors.kind}>
          <Select
            id="time-kind"
            value={kind}
            onChange={(e) => setKind(e.target.value as TimeKind)}
            data-testid="time-kind"
          >
            {TIME_KINDS.map((k) => (
              <option key={k} value={k}>
                {TIME_KIND_WORDS[k]}
              </option>
            ))}
          </Select>
        </Field>
        {entry ? null : (
          <Field label={T.visit} htmlFor="time-visit" error={errors.appointmentId}>
            <Select
              id="time-visit"
              value={appointmentId}
              onChange={(e) => setAppointmentId(e.target.value)}
              data-testid="time-visit"
            >
              <option value="">{T.noVisit}</option>
              {visits.map((v) => (
                <option key={v.appointmentId} value={v.appointmentId}>
                  {v.label}
                </option>
              ))}
            </Select>
          </Field>
        )}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={T.started} htmlFor="time-start" error={errors.startedAt}>
          <Input
            id="time-start"
            type="datetime-local"
            value={start}
            onChange={(e) => setStart(e.target.value)}
            data-testid="time-start"
          />
        </Field>
        <Field label={T.ended} htmlFor="time-end" error={errors.endedAt}>
          <Input
            id="time-end"
            type="datetime-local"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
            data-testid="time-end"
          />
        </Field>
      </div>
      <Field label={T.reason} htmlFor="time-reason" hint={T.reasonHint} error={errors.reason}>
        <Textarea
          id="time-reason"
          rows={2}
          value={reason}
          maxLength={LIMITS.reason}
          placeholder={T.reasonPlaceholder}
          onChange={(e) => setReason(e.target.value)}
          data-testid="time-reason"
        />
      </Field>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          {T.cancel}
        </Button>
        <Button
          type="submit"
          loading={busy === 'save'}
          disabled={!reason.trim()}
          data-testid="time-save"
        >
          {T.save}
        </Button>
      </div>
    </form>
  );
}
