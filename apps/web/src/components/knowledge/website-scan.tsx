'use client';
import { Check, CircleAlert, Globe, Info, LoaderCircle, ScanSearch } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { ApiError, errorMessage } from '@/lib/api/errors';
import type { KnowledgeScan, KnowledgeScanGet, KnowledgeSuggestion } from '@/lib/api/types';
import { formatDate } from '@/lib/format';
import { pagePath, scanProblemText, shortUrl } from '@/lib/knowledge/labels';
import { scanLive, scanPages, scanProblems, type ScanPageView } from '@/lib/knowledge/scan';
import { cn, relativeTime } from '@/lib/utils';
import { acceptMany, SuggestionCard, type CurrentItem, type Decision } from './suggestion-card';

/** How often the page checks on a running scan when live updates are slow (they usually arrive first). */
const POLL_MS = 3000;
/** The scan's page cap (apps/worker/src/knowledge/scan.ts SCAN_LIMITS.pages). */
const PAGE_CAP = 40;

type View = 'suggestions' | 'changed';

/** "Scan our website": the address, a scan with live progress, then its suggestions page by page. */
export function WebsiteScan({
  workspaceId,
  canManage,
  source,
  scan,
  suggestions,
  current,
  suggestedUrl,
}: {
  workspaceId: string;
  canManage: boolean;
  source: KnowledgeScanGet['source'];
  scan: KnowledgeScan | null;
  suggestions: readonly KnowledgeSuggestion[];
  current: Readonly<Record<string, CurrentItem>>;
  /** Before any website is saved here: the one the quick questions gave, ready to scan. */
  suggestedUrl?: string | null;
}) {
  const router = useRouter();
  const [url, setUrl] = useState(source?.url ?? suggestedUrl ?? '');
  const [urlError, setUrlError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'save' | 'scan' | null>(null);
  const live = scanLive(scan);
  const pages = useMemo(() => scanPages(scan), [scan]);
  const problems = useMemo(() => scanProblems(scan), [scan]);
  const changedUrl = url.trim() !== (source?.url ?? '');

  // A running scan refreshes the page as it goes (live updates usually get there first).
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => router.refresh(), POLL_MS);
    return () => clearInterval(t);
  }, [live, router]);

  async function saveSource(): Promise<boolean> {
    setUrlError(null);
    try {
      const out = unwrap(
        await apiBrowser().POST('/v1/commands/knowledge_source.set', {
          body: { workspaceId, url: url.trim() },
        }),
      );
      setUrl(out.url);
      return true;
    } catch (e) {
      setUrlError(
        e instanceof ApiError && (e.code === 'validation' || e.rule === 'website_url_invalid')
          ? e.message
          : errorMessage(e),
      );
      return false;
    }
  }
  async function save(e?: FormEvent) {
    e?.preventDefault();
    if (!changedUrl) return;
    setBusy('save');
    if (await saveSource()) {
      toast.success('Website saved.');
      router.refresh();
    }
    setBusy(null);
  }
  async function start() {
    if (!url.trim()) return setUrlError('Enter the website address.');
    setBusy('scan');
    try {
      if (changedUrl && !(await saveSource())) return;
      unwrap(
        await apiBrowser().POST('/v1/commands/knowledge_scan.start', { body: { workspaceId } }),
      );
      toast.success('Scanning your website. You can keep working.');
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-3.5" data-testid="website-scan">
      <Card className="px-[18px] py-4">
        <form onSubmit={save} className="flex flex-col gap-2.5 sm:flex-row sm:items-end">
          <div className="min-w-0 flex-1">
            <label htmlFor="kw-url" className="mb-1.5 block text-[13px] font-medium">
              Your website
            </label>
            <Input
              id="kw-url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://lonestarhvac.com"
              inputMode="url"
              autoComplete="url"
              readOnly={!canManage}
              invalid={!!urlError}
              aria-describedby={urlError ? 'kw-url-error' : undefined}
              data-testid="website-url"
            />
          </div>
          {canManage ? (
            <div className="flex gap-2">
              {changedUrl && source ? (
                <Button
                  type="submit"
                  variant="secondary"
                  loading={busy === 'save'}
                  disabled={!!busy}
                  data-testid="website-save"
                >
                  Save
                </Button>
              ) : null}
              <Button
                type="button"
                variant={scan ? 'secondary' : 'primary'}
                loading={busy === 'scan'}
                disabled={!!busy || live}
                onClick={() => void start()}
                data-testid="scan-start"
              >
                <ScanSearch className="h-4 w-4" strokeWidth={1.5} />
                {live ? 'Scanning…' : scan ? 'Scan again' : 'Scan website'}
              </Button>
            </div>
          ) : null}
        </form>
        {urlError ? (
          <p id="kw-url-error" role="alert" className="mt-1.5 text-[12.5px] text-danger-text">
            {urlError}
          </p>
        ) : null}
        {live && scan ? (
          <Progress scan={scan} pages={pages} problems={problems.length} />
        ) : (
          <p className="mt-2.5 text-xs text-text-3">
            {canManage
              ? 'Your own site only · follows robots.txt · up to 40 pages. Nothing from it is used until someone accepts it.'
              : 'Only owners and admins can scan the website. Nothing from it is used until someone accepts it.'}
          </p>
        )}
      </Card>

      {!source && !scan ? (
        <Card
          className="flex flex-col items-center gap-1.5 px-6 py-10 text-center"
          data-testid="website-empty"
        >
          <span className="mb-1 inline-flex h-11 w-11 items-center justify-center rounded-full bg-accent-soft text-accent-text">
            <Globe className="h-5 w-5" strokeWidth={1.5} />
          </span>
          <h3 className="text-[15px] font-semibold">Start from your website</h3>
          <p className="max-w-[420px] text-[13px] text-text-2">
            Enter your address and scan it. The AI reads your pages and suggests FAQs and facts for
            you to accept, edit or reject.
          </p>
        </Card>
      ) : !scan ? (
        <p className="text-[13px] text-text-2">
          Not scanned yet. Scan it to get suggested FAQs and facts from your pages.
        </p>
      ) : live ? (
        <LivePages pages={pages} />
      ) : (
        <ScanResult
          workspaceId={workspaceId}
          canManage={canManage}
          scan={scan}
          pages={pages}
          problems={problems}
          suggestions={suggestions}
          current={current}
        />
      )}
    </div>
  );
}

function Progress({
  scan,
  pages,
  problems,
}: {
  scan: KnowledgeScan;
  pages: readonly ScanPageView[];
  problems: number;
}) {
  const read = pages.filter((p) => p.status !== 'error' && p.status !== 'removed').length;
  const steps = [
    { label: 'Reading robots.txt', done: scan.status === 'running' },
    { label: `${read} ${read === 1 ? 'page' : 'pages'} read`, done: read > 0 },
    {
      label: `${scan.suggestionCount} ${scan.suggestionCount === 1 ? 'suggestion' : 'suggestions'}`,
      done: scan.suggestionCount > 0,
    },
  ];
  return (
    <div className="mt-3 flex flex-col gap-2.5" data-testid="scan-progress" aria-live="polite">
      <div className="flex items-center gap-3">
        <span className="block h-1.5 flex-1 overflow-hidden rounded-full bg-card-3">
          <span
            className="block h-full rounded-full bg-accent transition-[width] duration-300"
            style={{ width: `${Math.max(6, Math.min(100, Math.round((read / PAGE_CAP) * 100)))}%` }}
          />
        </span>
        <span className="whitespace-nowrap text-[13px] font-medium">
          {scan.status === 'queued' ? 'Starting…' : `Read ${read} ${read === 1 ? 'page' : 'pages'}`}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
        {steps.map((s) => (
          <span key={s.label} className="flex items-center gap-2 text-[12.5px] text-text-2">
            {s.done ? (
              <Check className="h-3.5 w-3.5 text-success-text" strokeWidth={2.2} />
            ) : (
              <LoaderCircle className="h-3.5 w-3.5 animate-spin text-text-3" strokeWidth={2} />
            )}
            {s.label}
          </span>
        ))}
        {problems ? (
          <span className="flex items-center gap-2 text-[12.5px] text-warning-text">
            <CircleAlert className="h-3.5 w-3.5" strokeWidth={2} />
            {problems} couldn’t be read
          </span>
        ) : null}
      </div>
    </div>
  );
}

function LivePages({ pages }: { pages: readonly ScanPageView[] }) {
  const latest = [...pages].reverse().slice(0, 10);
  return (
    <Card className="px-4 py-3.5" data-testid="scan-live">
      <h3 className="mb-2 text-[15px] font-semibold">Reading your pages</h3>
      {latest.length ? (
        latest.map((p) => (
          <div
            key={`${p.url}:${p.status}`}
            className="flex items-center gap-2.5 border-t border-border py-1.5 text-[13px]"
          >
            <PageIcon status={p.status} />
            <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">
              {pagePath(p.url)}
            </span>
            <span className="text-xs text-text-3">{pageNote(p)}</span>
          </div>
        ))
      ) : (
        <p className="border-t border-border py-2 text-[13px] text-text-2">Finding your pages…</p>
      )}
      <p className="mt-2 text-[12.5px] text-text-3">
        Keep working. This page updates as it goes. Website text is only used as information, never
        as instructions.
      </p>
    </Card>
  );
}

function PageIcon({ status }: { status: ScanPageView['status'] }) {
  return status === 'error' ? (
    <span className="inline-flex h-5 w-5 flex-none items-center justify-center rounded-full bg-danger-soft text-danger-text">
      <CircleAlert className="h-3 w-3" strokeWidth={2.2} />
    </span>
  ) : (
    <span className="inline-flex h-5 w-5 flex-none items-center justify-center rounded-full bg-success-soft text-success-text">
      <Check className="h-3 w-3" strokeWidth={2.2} />
    </span>
  );
}

function pageNote(p: ScanPageView): string {
  if (p.status === 'error') return p.error ?? 'Couldn’t read it';
  if (p.status === 'unchanged') return 'Same as last time';
  if (p.status === 'removed') return 'Gone since last time';
  const n = p.suggestions;
  return `${n ? `${n} ${n === 1 ? 'suggestion' : 'suggestions'}` : 'Nothing to suggest'}${p.truncated ? ' · first 2 MB' : ''}`;
}

function ScanResult({
  workspaceId,
  canManage,
  scan,
  pages,
  problems,
  suggestions,
  current,
}: {
  workspaceId: string;
  canManage: boolean;
  scan: KnowledgeScan;
  pages: readonly ScanPageView[];
  problems: ReturnType<typeof scanProblems>;
  suggestions: readonly KnowledgeSuggestion[];
  current: Readonly<Record<string, CurrentItem>>;
}) {
  const router = useRouter();
  const [gone, setGone] = useState<ReadonlySet<string>>(new Set());
  const [bulk, setBulk] = useState<number | null>(null);
  const waiting = suggestions.filter((s) => !gone.has(s.id));
  const rescan = pages.some(
    (p) => p.status === 'changed' || p.status === 'unchanged' || p.status === 'removed',
  );
  const [view, setView] = useState<View>('suggestions');
  const byPage = useMemo(() => {
    const m = new Map<string, KnowledgeSuggestion[]>();
    for (const s of waiting) {
      const u = typeof s.source.url === 'string' ? s.source.url : '';
      m.set(u, [...(m.get(u) ?? []), s]);
    }
    return m;
  }, [waiting]);
  const read = pages.filter((p) => p.status !== 'error' && p.status !== 'removed');
  const withSuggestions = read.filter((p) => byPage.has(p.url));
  const [picked, setPicked] = useState<string | null>(null);
  const page = picked && byPage.has(picked) ? picked : (withSuggestions[0]?.url ?? null);
  const pageList = page ? (byPage.get(page) ?? []) : [];
  const siteProblems = problems.filter((p) => !p.url);
  const pageProblems = problems.filter((p) => p.url);

  function decided(s: KnowledgeSuggestion, _d: Decision, message: string) {
    setGone((g) => new Set(g).add(s.id));
    toast.success(message);
    router.refresh();
  }
  async function acceptAll(list: readonly KnowledgeSuggestion[]) {
    setBulk(0);
    const ids = list.map((s) => s.id);
    const out = await acceptMany(workspaceId, ids, setBulk);
    setGone((g) => new Set([...g, ...ids]));
    setBulk(null);
    if (out.failed) toast.error(`Accepted ${out.accepted}. ${out.failed} couldn’t be accepted.`);
    else toast.success(`Accepted ${out.accepted} and published them.`);
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-3.5" data-testid="scan-result" data-scan-status={scan.status}>
      {scan.status === 'failed' ? (
        <div
          role="alert"
          className="flex items-start gap-2.5 rounded-[10px] bg-danger-soft px-3.5 py-3 text-[13.5px] text-danger-text"
          data-testid="scan-failed"
        >
          <CircleAlert className="mt-0.5 h-4 w-4 flex-none" strokeWidth={1.75} />
          <span>
            {siteProblems.length
              ? siteProblems.map((p) => p.message).join(' ')
              : 'The scan stopped before it finished. Scan again to try once more.'}
          </span>
        </div>
      ) : siteProblems.length ? (
        <div className="flex items-start gap-2 rounded-[9px] bg-warning-soft px-3 py-2.5 text-[13px] text-warning-text">
          <Info className="mt-0.5 h-4 w-4 flex-none" strokeWidth={1.75} />
          <span>{siteProblems.map((p) => p.message).join(' ')}</span>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-2.5">
        {rescan ? (
          <Segmented<View>
            ariaLabel="Show"
            value={view}
            onChange={setView}
            options={[
              {
                value: 'suggestions',
                label: `Suggestions · ${waiting.length}`,
                testId: 'view-suggestions',
              },
              { value: 'changed', label: 'What changed', testId: 'view-changed' },
            ]}
          />
        ) : (
          <h3 className="text-[15px] font-semibold">
            {waiting.length
              ? `${waiting.length} ${waiting.length === 1 ? 'suggestion' : 'suggestions'} to review`
              : 'Nothing left to review'}
          </h3>
        )}
        <span className="text-xs text-text-3" data-testid="scan-tally">
          Read {read.length} {read.length === 1 ? 'page' : 'pages'}
          {scan.finishedAt ? ` ${relativeTime(scan.finishedAt)}` : ''} · {scan.suggestionCount}{' '}
          {scan.suggestionCount === 1 ? 'suggestion' : 'suggestions'}
          {scan.startedBy ? ` · started by ${scan.startedBy.fullName}` : ''}
        </span>
      </div>

      {view === 'suggestions' ? (
        waiting.length && page ? (
          <div className="grid gap-4 lg:grid-cols-[250px_minmax(0,1fr)] lg:items-start">
            <nav
              aria-label="Pages"
              className="flex gap-1.5 overflow-x-auto rounded-card border border-border bg-card p-1.5 shadow-1 [scrollbar-width:none] lg:flex-col lg:gap-0.5"
            >
              <span className="hidden px-2.5 pb-1.5 pt-2 text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3 lg:block">
                {read.length} {read.length === 1 ? 'page' : 'pages'} read
              </span>
              {withSuggestions.map((p) => (
                <button
                  key={p.url}
                  type="button"
                  onClick={() => setPicked(p.url)}
                  aria-current={p.url === page ? 'true' : undefined}
                  className={cn(
                    'flex min-h-[38px] flex-none items-center gap-2 rounded-lg px-2.5 text-left text-[13px] transition-colors',
                    p.url === page
                      ? 'bg-accent-soft text-accent-text'
                      : 'text-text hover:bg-card-2',
                  )}
                >
                  <span className="min-w-0 flex-1 truncate font-mono text-[12px]">
                    {pagePath(p.url)}
                  </span>
                  <span className="inline-flex h-[18px] min-w-[18px] flex-none items-center justify-center rounded-full bg-card-2 px-[5px] text-[11px] font-semibold text-text-2">
                    {byPage.get(p.url)?.length ?? 0}
                  </span>
                </button>
              ))}
            </nav>
            <div className="flex min-w-0 flex-col gap-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="flex min-w-0 flex-col">
                  <span className="text-[15px] font-semibold">
                    {read.find((p) => p.url === page)?.title || pagePath(page)}
                  </span>
                  <span className="truncate text-xs text-text-3">{shortUrl(page)}</span>
                </span>
                {canManage ? (
                  <span className="flex gap-2">
                    {pageList.length > 1 ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        loading={bulk !== null}
                        disabled={bulk !== null}
                        onClick={() => void acceptAll(pageList)}
                      >
                        Accept all on this page
                      </Button>
                    ) : null}
                    {waiting.length > pageList.length ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={bulk !== null}
                        onClick={() => void acceptAll(waiting)}
                        data-testid="accept-all-scan"
                      >
                        {bulk !== null ? `Accepting ${bulk}…` : `Accept all ${waiting.length}`}
                      </Button>
                    ) : null}
                  </span>
                ) : null}
              </div>
              {pageList.map((s) => (
                <SuggestionCard
                  key={s.id}
                  workspaceId={workspaceId}
                  s={s}
                  canManage={canManage}
                  current={s.itemId ? (current[s.itemId] ?? null) : null}
                  onDecided={decided}
                />
              ))}
            </div>
          </div>
        ) : (
          <Card className="px-6 py-8 text-center">
            <h3 className="text-[15px] font-semibold">
              {scan.suggestionCount
                ? 'All of this scan’s suggestions are decided'
                : 'Nothing to suggest from this scan'}
            </h3>
            <p className="mt-1 text-[13px] text-text-2">
              {scan.suggestionCount
                ? 'Accepted ones are in Items. Scan again after you change your website.'
                : rescan
                  ? 'Your pages are the same as last time, so there’s nothing new.'
                  : 'The pages were read, but they didn’t say anything customers ask about.'}
            </p>
          </Card>
        )
      ) : (
        <WhatChanged
          workspaceId={workspaceId}
          canManage={canManage}
          scan={scan}
          pages={pages}
          byPage={byPage}
          current={current}
          onDecided={decided}
        />
      )}

      {pageProblems.length ? (
        <details
          className="rounded-card border border-border bg-card px-4 py-3 shadow-1"
          data-testid="scan-problems"
        >
          <summary className="cursor-pointer text-[13.5px] font-medium">
            {pageProblems.length} {pageProblems.length === 1 ? 'page' : 'pages'} couldn’t be read
          </summary>
          <ul className="mt-2 flex flex-col">
            {pageProblems.map((p, i) => (
              <li
                key={`${p.url}:${i}`}
                className="flex flex-col gap-0.5 border-t border-border py-2 text-[13px] sm:flex-row sm:items-center sm:gap-3"
              >
                <span className="min-w-0 truncate font-mono text-[12px] sm:w-[260px] sm:flex-none">
                  {pagePath(p.url!)}
                </span>
                <span className="text-text-2">{scanProblemText(p)}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

function WhatChanged({
  workspaceId,
  canManage,
  scan,
  pages,
  byPage,
  current,
  onDecided,
}: {
  workspaceId: string;
  canManage: boolean;
  scan: KnowledgeScan;
  pages: readonly ScanPageView[];
  byPage: ReadonlyMap<string, KnowledgeSuggestion[]>;
  current: Readonly<Record<string, CurrentItem>>;
  onDecided: (s: KnowledgeSuggestion, d: Decision, message: string) => void;
}) {
  const changed = pages.filter((p) => p.status === 'changed');
  const added = pages.filter((p) => p.status === 'new');
  const removed = pages.filter((p) => p.status === 'removed');
  const same = pages.filter((p) => p.status === 'unchanged');
  const when = scan.finishedAt ? formatDate(scan.finishedAt, { time: true }) : null;
  return (
    <div className="flex flex-col gap-3" data-testid="what-changed">
      <div className="flex items-start gap-2 rounded-[9px] bg-card-2 px-3 py-2.5 text-[13px] text-text-2">
        <Info className="mt-0.5 h-4 w-4 flex-none" strokeWidth={1.5} />
        <span>
          {when ? `Rescanned ${when}. ` : ''}
          {changed.length} {changed.length === 1 ? 'page changed' : 'pages changed'} and{' '}
          {added.length} {added.length === 1 ? 'is' : 'are'} new. {same.length}{' '}
          {same.length === 1 ? 'page is' : 'pages are'} the same, so{' '}
          {same.length === 1 ? 'it has' : 'they have'} no new suggestions.
        </span>
      </div>
      {changed.map((p) => (
        <Card key={p.url} className="flex flex-col gap-2.5 px-4 py-3.5">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="pending">Changed</Badge>
            <span className="min-w-0 truncate font-mono text-[12.5px]">{pagePath(p.url)}</span>
          </div>
          {(byPage.get(p.url) ?? []).length ? (
            (byPage.get(p.url) ?? []).map((s) => (
              <SuggestionCard
                key={s.id}
                workspaceId={workspaceId}
                s={s}
                canManage={canManage}
                current={s.itemId ? (current[s.itemId] ?? null) : null}
                onDecided={onDecided}
                compact
              />
            ))
          ) : (
            <p className="text-[13px] text-text-2">No suggestions waiting from this page.</p>
          )}
        </Card>
      ))}
      {added.map((p) => (
        <Card key={p.url} className="flex flex-wrap items-center gap-2.5 px-4 py-3">
          <Badge variant="accent">New page</Badge>
          <span className="min-w-0 truncate font-mono text-[12.5px]">{pagePath(p.url)}</span>
          <span className="flex-1 text-[13px] text-text-2">
            {p.suggestions
              ? `${p.suggestions} ${p.suggestions === 1 ? 'suggestion' : 'suggestions'}`
              : 'Nothing customers ask about.'}
          </span>
        </Card>
      ))}
      {removed.length ? (
        <p className="text-[13px] text-text-2">
          Gone since last time: {removed.map((p) => pagePath(p.url)).join(', ')}. Items that came
          from them stay until you archive them.
        </p>
      ) : null}
      {same.length ? (
        <p className="text-xs text-text-3">
          {same.length} {same.length === 1 ? 'page didn’t' : 'pages didn’t'} change:{' '}
          {same
            .slice(0, 4)
            .map((p) => pagePath(p.url))
            .join(', ')}
          {same.length > 4 ? ` and ${same.length - 4} more` : ''}
        </p>
      ) : null}
    </div>
  );
}
