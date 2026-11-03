'use client';
import {
  DESK_HELPER_WORDS,
  DESK_PROBLEM_SECTION_WORDS,
  DESK_PROBLEM_WORDS,
  deskSectionLabel,
  helperBadge,
  helperMoveWords,
  HELPER_VERDICT_WORDS,
  HELPER_RESULT_WORDS,
  PROBLEM_LIMIT_BADGE,
  PROBLEM_STATE_WORDS,
  PROBLEM_STATES,
  problemClearedWords,
  problemForClaude,
  problemFrom,
  problemOutlineFile,
  problemWhere,
  type ProblemFixGroup,
  type ProblemGroups,
  type ProblemLimitGroup,
  type ProblemReportFull,
  type ProblemReportRow,
  type ProblemState,
  type ProblemStep,
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

const href = (next: {
  state?: ProblemState;
  area?: string | null;
  job?: string | null;
  before?: string | null;
}) => {
  const q = new URLSearchParams();
  if (next.state && next.state !== 'open') q.set('state', next.state);
  if (next.area) q.set('area', next.area);
  if (next.job) q.set('job', next.job);
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
 * The desk's Problem reports: what our own tools saw when something didn't go, from every business. The open ones as
 * two sections (20261027023100): the limits each business hit, on top, and what needs a fix grouped by problem, each
 * opening to its reports. Handled or all, or one problem's, as a list, newest first; each opens with its outline, and
 * the open ones shown can be marked handled together.
 */
export function ProblemReports({
  reports,
  groups,
  areas,
  steps,
  state,
  area,
  job,
  nextBefore,
  older,
}: {
  reports: readonly ProblemReportRow[];
  /** The open ones grouped, or null when this is a list. */
  groups: ProblemGroups | null;
  areas: readonly { area: string; open: number }[];
  steps: readonly ProblemStep[];
  state: ProblemState;
  area: string | null;
  job: string | null;
  nextBefore: string | null;
  older: boolean;
}) {
  const { busy, mark } = useMark();
  const open = reports.filter((r) => r.handledAt === null);
  return (
    <div className="mx-auto w-full max-w-5xl">
      {job ? (
        <Link
          href={href({ state, area })}
          className="inline-flex items-center gap-1.5 text-[13px] font-medium text-text-2 hover:text-text"
          data-testid="problems-all"
        >
          <ArrowLeft className="h-4 w-4" strokeWidth={1.5} />
          {DESK_PROBLEM_WORDS.allProblems}
        </Link>
      ) : null}
      <h1 className="text-xl font-semibold md:text-2xl">{deskSectionLabel('problems')}</h1>
      <p className="mt-1 text-[13px] text-text-3">
        {DESK_PROBLEM_WORDS.intro}{' '}
        <Link
          href="/admin/problems/ways"
          className="font-medium text-accent-text hover:underline"
          data-testid="problems-ways-link"
        >
          {DESK_HELPER_WORDS.ways}
        </Link>
      </p>

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
            href={href({ state, area: a.area, job })}
            className={chip(area === a.area)}
            data-testid={`problems-area-${a.area}`}
          >
            {a.area}
            {a.open > 0 ? <span className="ml-1.5 tabular-nums text-text-3">{a.open}</span> : null}
          </Link>
        ))}
      </div>

      {groups ? (
        <>
          <LimitsSection limits={groups.limits} />
          <FixesSection fixes={groups.fixes} area={area} />
          <ProblemSteps steps={area ? steps.filter((t) => t.area === area) : steps} />
        </>
      ) : (
        <ReportList
          reports={reports}
          state={state}
          area={area}
          job={job}
          nextBefore={nextBefore}
          older={older}
          open={open}
          busy={busy}
          mark={mark}
        />
      )}
    </div>
  );
}

/** The limits each business hit (20261027023100): what each is, what can be done, and that it clears itself. */
function LimitsSection({ limits }: { limits: readonly ProblemLimitGroup[] }) {
  const w = DESK_PROBLEM_SECTION_WORDS;
  return (
    <section className="mt-5" data-testid="problems-limits">
      <h2 className="text-base font-semibold">
        {w.limits}
        {limits.length ? (
          <span className="ml-2 tabular-nums text-text-3">{limits.length}</span>
        ) : null}
      </h2>
      <p className="mt-0.5 text-[13px] text-text-3">{w.limitsIntro}</p>
      {limits.length === 0 ? (
        <p className="mt-2 rounded-card border border-border bg-card px-4 py-3 text-[13px] text-text-3">
          {w.noLimits}
        </p>
      ) : (
        <ul className="mt-2 divide-y divide-warning-border overflow-hidden rounded-card border border-warning-border bg-warning-soft">
          {limits.map((g) => (
            <li
              key={`${g.workspaceId}:${g.limitKind}:${g.area ?? ''}`}
              className="px-4 py-3"
              data-testid={`problems-limit-${g.limitKind}`}
            >
              <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span className="text-sm font-semibold text-warning-text">{w.limitTitle(g)}</span>
                <span className="text-[13px] text-text-3">
                  {w.limitCounts(g, whenWords(g.firstAt), whenWords(g.lastAt))}
                </span>
              </span>
              <span className="mt-0.5 block break-words text-[13px] text-text-2">
                {w.limitSaid(g)}
              </span>
              <Link
                href={`/admin/problems/${g.reportId}`}
                className="mt-1 inline-block text-[12px] font-medium text-accent-text hover:underline"
              >
                {w.seeNewest}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** What needs a fix, by problem (20261027023100): each opens to its step's reports. */
function FixesSection({ fixes, area }: { fixes: readonly ProblemFixGroup[]; area: string | null }) {
  const w = DESK_PROBLEM_SECTION_WORDS;
  return (
    <section className="mt-5" data-testid="problems-fixes">
      <h2 className="text-base font-semibold">
        {w.fixes}
        {fixes.length ? (
          <span className="ml-2 tabular-nums text-text-3">{fixes.length}</span>
        ) : null}
      </h2>
      <p className="mt-0.5 text-[13px] text-text-3">{w.fixesIntro}</p>
      {fixes.length === 0 ? (
        <p className="mt-2 rounded-card border border-border bg-card px-4 py-3 text-[13px] text-text-3">
          {w.noFixes}
        </p>
      ) : (
        <ul className="mt-2 divide-y divide-border overflow-hidden rounded-card border border-border bg-card">
          {fixes.map((g) => {
            const helper = w.fixHelper(g);
            return (
              <li key={`${g.area}:${g.job}:${g.note ?? ''}`} className="hover:bg-card-2">
                <Link
                  href={href({ area: area ?? g.area, job: g.job })}
                  className="block px-4 py-3"
                  data-testid={`problems-fix-${g.area}-${g.job}`}
                >
                  <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                    <span className="text-sm font-semibold">{w.fixTitle(g)}</span>
                    <span className="text-[13px] text-text-3">
                      {w.fixCounts(g, whenWords(g.lastAt))}
                    </span>
                  </span>
                  <span className="mt-0.5 block break-words text-[13px] text-text-2">
                    {g.note ?? DESK_PROBLEM_WORDS.noNote}
                  </span>
                  {helper ? (
                    <span className="mt-0.5 block text-[12px] text-text-3">{helper}</span>
                  ) : null}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** Reports one by one: one problem's, the handled ones, or all, a page at a time. */
function ReportList({
  reports,
  state,
  area,
  job,
  nextBefore,
  older,
  open,
  busy,
  mark,
}: {
  reports: readonly ProblemReportRow[];
  state: ProblemState;
  area: string | null;
  job: string | null;
  nextBefore: string | null;
  older: boolean;
  open: readonly ProblemReportRow[];
  busy: string | null;
  mark: (key: string, reportIds: readonly string[], handled: boolean) => Promise<void>;
}) {
  return (
    <>
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
                {r.kind === 'limit' ? (
                  <span
                    className="rounded-full bg-warning-soft px-2 py-0.5 text-[11px] font-medium text-warning-text"
                    data-testid={`problem-limit-${r.reportId}`}
                  >
                    {PROBLEM_LIMIT_BADGE}
                  </span>
                ) : null}
                {r.helper ? (
                  <span
                    className="rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-medium text-accent-text"
                    data-testid={`problem-helper-${r.reportId}`}
                  >
                    {helperBadge(r.helper)}
                  </span>
                ) : null}
              </span>
              <span className="mt-0.5 block break-words text-[13px] text-text-2">
                {r.note ?? DESK_PROBLEM_WORDS.noNote}
              </span>
              <span className="mt-0.5 block text-[12px] text-text-3">
                {problemFrom(r)}
                {problemClearedWords(r) ? ` · ${problemClearedWords(r)}` : ''}
              </span>
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
            <Link href={href({ state, area, job })} className={chip(false)}>
              {DESK_PROBLEM_WORDS.newest}
            </Link>
          ) : null}
          {nextBefore ? (
            <Link
              href={href({ state, area, job, before: nextBefore })}
              className={chip(false)}
              data-testid="problems-older"
            >
              {DESK_PROBLEM_WORDS.older}
            </Link>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

/**
 * The last week's reports by step (decision 142): which steps fail most, and how the AI helper sorted them, so a
 * layout change on one network shows as a run of "layout changed" on its step.
 */
function ProblemSteps({ steps }: { steps: readonly ProblemStep[] }) {
  return (
    <section
      className="mt-4 rounded-card border border-border bg-card p-4"
      data-testid="problems-steps"
    >
      <h2 className="text-sm font-semibold">{DESK_HELPER_WORDS.steps}</h2>
      {steps.length === 0 ? (
        <p className="mt-2 text-[13px] text-text-3">{DESK_HELPER_WORDS.noSteps}</p>
      ) : (
        <ul className="mt-2 space-y-1 text-[13px]">
          {steps.slice(0, 12).map((t) => (
            <li key={`${t.area}:${t.job}`} className="flex flex-wrap gap-x-2">
              <span className="font-medium">
                {t.area} · {t.job}
              </span>
              <span className="text-text-2">{DESK_HELPER_WORDS.step(t)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** What the AI helper found on a report, and what it did. */
function HelperFound({ helper }: { helper: NonNullable<ProblemReportFull['helper']> }) {
  return (
    <section
      className="mt-4 rounded-card border border-border bg-card p-4 text-[13px]"
      data-testid="problem-helper"
    >
      <h2 className="text-sm font-semibold">{DESK_HELPER_WORDS.heading}</h2>
      <p className="mt-2 font-medium">
        {HELPER_VERDICT_WORDS[helper.verdict]} · {HELPER_RESULT_WORDS[helper.result]}
      </p>
      {helper.looks === 0 && !helper.learned ? (
        <>
          <p className="mt-1 text-text-2" data-testid="problem-helper-not-looked">
            {helper.notLooked
              ? DESK_HELPER_WORDS.notLooked[helper.notLooked]
              : DESK_HELPER_WORDS.notAsked}
          </p>
          {helper.said ? <p className="mt-1 break-words">{helper.said}</p> : null}
        </>
      ) : (
        <p className="mt-1 break-words">{helper.said || DESK_HELPER_WORDS.nothingSaid}</p>
      )}
      {helper.learned ? (
        <p className="mt-1 text-text-2">{DESK_HELPER_WORDS.learned[helper.learned]}</p>
      ) : null}
      <h3 className="mt-3 text-[13px] font-semibold">{DESK_HELPER_WORDS.moves}</h3>
      {helper.moves.length === 0 ? (
        <p className="mt-1 text-text-3">{DESK_HELPER_WORDS.noMoves}</p>
      ) : (
        <ol className="mt-1 list-decimal space-y-0.5 pl-5">
          {helper.moves.map((m, i) => (
            <li key={i} className="break-words">
              {helperMoveWords(m)}
            </li>
          ))}
        </ol>
      )}
      {helper.looks > 0 ? (
        <p className="mt-2 text-text-3">{DESK_HELPER_WORDS.looks(helper.looks)}</p>
      ) : null}
    </section>
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
        {r.kind === 'limit' ? (
          <p className="mt-2 font-medium text-warning-text">{PROBLEM_LIMIT_BADGE}</p>
        ) : null}
        {r.handledAt ? (
          <p className="mt-2 text-text-3">
            {problemClearedWords(r) ??
              DESK_PROBLEM_WORDS.handled(whenWords(r.handledAt), r.handledBy)}
          </p>
        ) : null}
      </section>

      {r.helper ? <HelperFound helper={r.helper} /> : null}

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
