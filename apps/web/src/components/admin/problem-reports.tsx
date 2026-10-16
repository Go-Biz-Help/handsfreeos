'use client';
import {
  DESK_PROBLEM_WORDS,
  deskSectionLabel,
  PROBLEM_STATE_WORDS,
  PROBLEM_STATES,
  problemForClaude,
  problemFrom,
  problemOutlineFile,
  problemWhere,
  type ProblemReportFull,
  type ProblemReportRow,
  type ProblemState,
} from '@hfos/core';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { whenWords } from '@/components/admin/ticket-bits';
import { Button } from '@/components/ui/button';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import { cn } from '@/lib/utils';

/** Marks reports handled or open again, and reads the page again. */
function useMark() {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const mark = async (key: string, reportIds: readonly string[], handled: boolean) => {
    if (busy) return;
    setBusy(key);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/problem_report.set_handled', {
          body: { reportIds: [...reportIds], handled },
        }),
      );
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  return { busy, mark };
}

const href = (next: { state?: ProblemState; area?: string | null; before?: string | null }) => {
  const q = new URLSearchParams();
  if (next.state && next.state !== 'open') q.set('state', next.state);
  if (next.area) q.set('area', next.area);
  if (next.before) q.set('before', next.before);
  const s = q.toString();
  return s ? `/admin/problems?${s}` : '/admin/problems';
};

const chip = (on: boolean) =>
  cn(
    'inline-flex h-8 items-center rounded-control px-3 text-[13px] font-medium',
    on ? 'bg-accent-soft text-accent-text' : 'text-text-2 hover:bg-card-2',
  );

/**
 * The desk's Problem reports: what our own tools saw when something didn't go, from every business, newest first.
 * Open, handled or all; one area or every one; each opens with its outline, and the open ones shown can be marked
 * handled together.
 */
export function ProblemReports({
  reports,
  areas,
  state,
  area,
  nextBefore,
  older,
}: {
  reports: readonly ProblemReportRow[];
  areas: readonly { area: string; open: number }[];
  state: ProblemState;
  area: string | null;
  nextBefore: string | null;
  older: boolean;
}) {
  const { busy, mark } = useMark();
  const open = reports.filter((r) => r.handledAt === null);
  return (
    <div className="mx-auto w-full max-w-5xl">
      <h1 className="text-xl font-semibold md:text-2xl">{deskSectionLabel('problems')}</h1>
      <p className="mt-1 text-[13px] text-text-3">{DESK_PROBLEM_WORDS.intro}</p>

      <div className="mt-4 flex flex-wrap items-center gap-1.5" data-testid="problems-states">
        {PROBLEM_STATES.map((s) => (
          <Link
            key={s}
            href={href({ state: s, area })}
            className={chip(state === s)}
            aria-current={state === s ? 'page' : undefined}
            data-testid={`problems-state-${s}`}
          >
            {PROBLEM_STATE_WORDS[s]}
          </Link>
        ))}
        <span className="mx-1 h-5 w-px bg-border" aria-hidden />
        <Link href={href({ state })} className={chip(area === null)}>
          {DESK_PROBLEM_WORDS.everyArea}
        </Link>
        {areas.map((a) => (
          <Link
            key={a.area}
            href={href({ state, area: a.area })}
            className={chip(area === a.area)}
            data-testid={`problems-area-${a.area}`}
          >
            {a.area}
            {a.open > 0 ? <span className="ml-1.5 tabular-nums text-text-3">{a.open}</span> : null}
          </Link>
        ))}
      </div>

      {open.length > 1 ? (
        <div className="mt-3">
          <Button
            variant="secondary"
            size="sm"
            loading={busy === 'all'}
            onClick={() =>
              void mark(
                'all',
                open.map((r) => r.reportId),
                true,
              )
            }
            data-testid="problems-mark-all"
          >
            {DESK_PROBLEM_WORDS.markAllHandled(open.length)}
          </Button>
        </div>
      ) : null}

      <ul
        className="mt-3 divide-y divide-border overflow-hidden rounded-card border border-border bg-card"
        data-testid="problems-list"
      >
        {reports.map((r) => (
          <li key={r.reportId} className="flex items-start gap-3 px-4 py-3.5 hover:bg-card-2">
            <Link
              href={`/admin/problems/${r.reportId}`}
              className="min-w-0 flex-1"
              data-testid={`problem-row-${r.reportId}`}
            >
              <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span className="text-sm font-semibold">{problemWhere(r)}</span>
                <span className="text-[13px] text-text-3">
                  {r.business} · {whenWords(r.at)}
                </span>
                {r.hasOutline ? (
                  <span className="rounded-full bg-card-2 px-2 py-0.5 text-[11px] font-medium text-text-2">
                    {DESK_PROBLEM_WORDS.withOutline}
                  </span>
                ) : null}
              </span>
              <span className="mt-0.5 block break-words text-[13px] text-text-2">
                {r.note ?? DESK_PROBLEM_WORDS.noNote}
              </span>
              <span className="mt-0.5 block text-[12px] text-text-3">{problemFrom(r)}</span>
            </Link>
            <Button
              variant="ghost"
              size="sm"
              loading={busy === r.reportId}
              onClick={() => void mark(r.reportId, [r.reportId], r.handledAt === null)}
              data-testid={`problem-mark-${r.reportId}`}
            >
              {r.handledAt === null ? DESK_PROBLEM_WORDS.markHandled : DESK_PROBLEM_WORDS.reopen}
            </Button>
          </li>
        ))}
        {reports.length === 0 ? (
          <li className="px-4 py-10 text-center text-[13px] text-text-3">
            {DESK_PROBLEM_WORDS.none[state]}
          </li>
        ) : null}
      </ul>

      {nextBefore || older ? (
        <div className="mt-4 flex justify-center gap-2">
          {older ? (
            <Link href={href({ state, area })} className={chip(false)}>
              {DESK_PROBLEM_WORDS.newest}
            </Link>
          ) : null}
          {nextBefore ? (
            <Link
              href={href({ state, area, before: nextBefore })}
              className={chip(false)}
              data-testid="problems-older"
            >
              {DESK_PROBLEM_WORDS.older}
            </Link>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** One report: what the tool said and found, its outline, and handing it to Claude. */
export function ProblemReportView({ report: r }: { report: ProblemReportFull }) {
  const { busy, mark } = useMark();
  const shown = DESK_PROBLEM_WORDS.shown(r.shown);
  const found = Object.entries(r.found);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(problemForClaude(r));
      toast.success(DESK_PROBLEM_WORDS.copied);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  const download = () => {
    if (!r.outline) return;
    const url = URL.createObjectURL(new Blob([r.outline], { type: 'text/plain;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = problemOutlineFile(r);
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="mx-auto w-full max-w-5xl" data-testid="problem-report">
      <Link
        href="/admin/problems"
        className="inline-flex items-center gap-1.5 text-[13px] font-medium text-text-2 hover:text-text"
      >
        <ArrowLeft className="h-4 w-4" strokeWidth={1.5} />
        {DESK_PROBLEM_WORDS.back}
      </Link>
      <h1 className="mt-2 break-words text-xl font-semibold md:text-2xl">{problemWhere(r)}</h1>
      <p className="mt-1 text-[13px] text-text-3">
        {r.business} · {whenWords(r.at)} · {problemFrom(r)}
      </p>

      <div className="mt-4 flex flex-wrap gap-2">
        <Button onClick={() => void copy()} data-testid="problem-copy">
          {DESK_PROBLEM_WORDS.copyForClaude}
        </Button>
        {r.outline ? (
          <Button variant="secondary" onClick={download} data-testid="problem-download">
            {DESK_PROBLEM_WORDS.downloadOutline}
          </Button>
        ) : null}
        <Button
          variant="secondary"
          loading={busy !== null}
          onClick={() => void mark(r.reportId, [r.reportId], r.handledAt === null)}
          data-testid="problem-mark"
        >
          {r.handledAt === null ? DESK_PROBLEM_WORDS.markHandled : DESK_PROBLEM_WORDS.reopen}
        </Button>
      </div>

      <section className="mt-5 rounded-card border border-border bg-card p-4 text-[13px]">
        <p className="break-words text-sm">{r.note ?? DESK_PROBLEM_WORDS.noNote}</p>
        {r.path ? (
          <p className="mt-1 break-all font-mono text-[12px] text-text-2">{r.path}</p>
        ) : null}
        {shown ? <p className="mt-2 text-text-2">{shown}</p> : null}
        {r.handledAt ? (
          <p className="mt-2 text-text-3">
            {DESK_PROBLEM_WORDS.handled(whenWords(r.handledAt), r.handledBy)}
          </p>
        ) : null}
      </section>

      <section className="mt-4 rounded-card border border-border bg-card p-4">
        <h2 className="text-sm font-semibold">{DESK_PROBLEM_WORDS.found}</h2>
        {found.length === 0 ? (
          <p className="mt-2 text-[13px] text-text-3">{DESK_PROBLEM_WORDS.nothingFound}</p>
        ) : (
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[13px]">
            {found.map(([key, value]) => (
              <div key={key} className="contents">
                <dt className="text-text-3">{key}</dt>
                <dd className="break-words">
                  {Array.isArray(value) ? value.join(', ') : String(value)}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </section>

      <section className="mt-4 rounded-card border border-border bg-card p-4">
        <h2 className="text-sm font-semibold">{DESK_PROBLEM_WORDS.outline}</h2>
        {r.outline ? (
          <pre
            className="mt-2 max-h-[60vh] overflow-auto whitespace-pre rounded-control bg-card-2 p-3 font-mono text-[12px] leading-[18px]"
            data-testid="problem-outline"
          >
            {r.outline}
          </pre>
        ) : (
          <p className="mt-2 text-[13px] text-text-3">{DESK_PROBLEM_WORDS.noOutline}</p>
        )}
      </section>
    </div>
  );
}
