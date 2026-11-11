'use client';
/**
 * Dispatch (docs/contractor.md, "Dispatch"): one day's visits on jobs by who's on them, the ones nobody is on yet,
 * where each stands (on the way, started, done), and the open jobs with nothing booked. A visit opens its work
 * order, where a crew is put on it. The day is in the address (`?day=`), so a link to a day stays that day.
 */
import { CONTRACTOR_WORDS, lateWords } from '@hfos/core/addons/contractor/words';
import { addDays, fmtDateLong, fmtRange, formatDateOnly } from '@hfos/core';
import { ChevronLeft, ChevronRight, UserX } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { PageHeader } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button, ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { useLiveRefresh } from '@/lib/realtime/live-provider';
import { cn } from '@/lib/utils';
import {
  ChecklistLine,
  contractorHref,
  jobHref,
  StageBadge,
  StatusBadge,
  workOrderHref,
} from './bits';
import type { Dispatch, DispatchVisit } from './types';

const D = CONTRACTOR_WORDS.dispatch;

export function DispatchPage({
  workspaceId,
  dispatch,
  myUserId,
}: {
  workspaceId: string;
  dispatch: Dispatch;
  myUserId: string;
}) {
  useLiveRefresh(['custom_record', 'appointment', 'job']);
  const router = useRouter();
  const { day, today, timeZone } = dispatch;
  const go = (to: string) =>
    router.push(contractorHref(workspaceId, to === today ? 'dispatch' : `dispatch?day=${to}`));
  const nobody = dispatch.visits.filter((v) => v.userIds.length === 0);
  // The person looking comes first, then everyone else by name (the server's order).
  const people = [...dispatch.people].sort(
    (a, b) => Number(b.userId === myUserId) - Number(a.userId === myUserId),
  );
  return (
    <div data-testid="contractor-dispatch">
      <PageHeader
        title={D.title}
        description={D.lede}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              aria-label={D.previous}
              onClick={() => go(addDays(day, -1))}
              data-testid="dispatch-previous"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Input
              type="date"
              inputSize="sm"
              className="w-[150px]"
              value={day}
              aria-label={D.pickDay}
              onChange={(e) => e.target.value && go(e.target.value)}
              data-testid="dispatch-day"
            />
            <Button
              variant="secondary"
              size="sm"
              aria-label={D.next}
              onClick={() => go(addDays(day, 1))}
              data-testid="dispatch-next"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={day === today}
              onClick={() => go(today)}
              data-testid="dispatch-today"
            >
              {D.today}
            </Button>
          </div>
        }
      />
      <h2 className="mb-3 text-[15px] font-semibold" data-testid="dispatch-day-name">
        {fmtDateLong(day)}
        {day === today ? <span className="ml-2 font-normal text-text-3">{D.today}</span> : null}
      </h2>

      {dispatch.visits.length === 0 ? (
        <Card
          className="px-5 py-8 text-center text-[13.5px] text-text-2"
          data-testid="dispatch-empty"
        >
          {D.noVisits}
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {nobody.length ? (
            <Column
              title={D.nobody}
              hint={D.nobodyHint}
              warn
              visits={nobody}
              workspaceId={workspaceId}
              timeZone={timeZone}
              testId="dispatch-nobody"
            />
          ) : null}
          {people.map((p) => (
            <Column
              key={p.userId}
              title={p.userId === myUserId ? `${p.name} (me)` : p.name}
              visits={dispatch.visits.filter((v) => v.userIds.includes(p.userId))}
              workspaceId={workspaceId}
              timeZone={timeZone}
              testId="dispatch-person"
            />
          ))}
        </div>
      )}
      {dispatch.truncated ? <p className="mt-3 text-[12.5px] text-text-3">{D.more}</p> : null}

      <Card className="mt-6 p-0" data-testid="dispatch-needs-visit">
        <div className="border-b border-border px-5 py-3.5">
          <h2 className="text-[15px] font-semibold">{D.needsVisit}</h2>
          <p className="mt-0.5 text-[12.5px] text-text-3">{D.needsVisitHint}</p>
        </div>
        {dispatch.needsVisit.length === 0 ? (
          <p className="px-5 py-4 text-[13.5px] text-text-2">{D.needsVisitNone}</p>
        ) : (
          <ul>
            {dispatch.needsVisit.map((j) => (
              <li
                key={j.id}
                className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-5 py-3 text-[13.5px] last:border-b-0"
              >
                <span className="min-w-0">
                  <span className="flex flex-wrap items-center gap-2">
                    <Link href={jobHref(workspaceId, j.id)} className="font-medium hover:underline">
                      {j.name}
                    </Link>
                    <StatusBadge status={j.status} />
                    {j.daysLate ? <Badge variant="danger">{lateWords(j.daysLate)}</Badge> : null}
                  </span>
                  <span className="block truncate text-[12.5px] text-text-3">
                    {[
                      j.customer?.name,
                      j.property,
                      j.dueOn ? `Due ${formatDateOnly(j.dueOn)}` : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </span>
                <ButtonLink href={jobHref(workspaceId, j.id)} size="sm" variant="secondary">
                  {D.openJob}
                </ButtonLink>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

/** One person's day, or the visits nobody is on yet. */
function Column({
  title,
  hint,
  warn,
  visits,
  workspaceId,
  timeZone,
  testId,
}: {
  title: string;
  hint?: string;
  warn?: boolean;
  visits: readonly DispatchVisit[];
  workspaceId: string;
  timeZone: string;
  testId: string;
}) {
  return (
    <Card className={cn('p-0', warn && 'border-warning-text/40')} data-testid={testId}>
      <div className="border-b border-border px-4 py-3">
        <h3 className="flex items-center gap-2 text-[14px] font-semibold">
          {warn ? <UserX className="h-4 w-4 text-warning-text" strokeWidth={1.75} /> : null}
          {title}
          <span className="font-normal text-text-3">{visits.length}</span>
        </h3>
        {hint ? <p className="mt-0.5 text-[12.5px] text-text-3">{hint}</p> : null}
      </div>
      <ul>
        {visits.map((v) => (
          <li key={v.appointmentId} className="border-b border-border last:border-b-0">
            <Link
              href={workOrderHref(workspaceId, v.appointmentId)}
              className="block px-4 py-3 text-[13.5px] hover:bg-card-2"
              data-testid="dispatch-visit"
            >
              <span className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium tabular-nums">
                  {fmtRange(v.startsAt, v.endsAt, timeZone)}
                </span>
                <StageBadge stage={v.stage} />
              </span>
              <span className="mt-1 block font-medium">{v.job.name}</span>
              <span className="block truncate text-[12.5px] text-text-3">
                {[v.customer, v.property].filter(Boolean).join(' · ') || v.title}
              </span>
              <span className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px]">
                {v.crew ? <Badge variant="member">{v.crew}</Badge> : null}
                {v.subs.total ? (
                  <span className="text-text-2">{D.subs(v.subs.done, v.subs.total)}</span>
                ) : null}
                <ChecklistLine checklist={v.checklist} />
                {v.materialsMissing && v.stage !== 'done' ? (
                  <span className="text-danger-text" data-testid="dispatch-materials-missing">
                    {D.materialsMissing(v.materialsMissing)}
                  </span>
                ) : null}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}
