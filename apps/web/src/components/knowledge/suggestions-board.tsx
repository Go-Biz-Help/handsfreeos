'use client';
import { Inbox } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button, ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import type { KnowledgeSuggestion } from '@/lib/api/types';
import { cn } from '@/lib/utils';
import { acceptMany, SuggestionCard, type CurrentItem, type Decision } from './suggestion-card';

export type ReasonFilter = 'all' | 'scan' | 'gap' | 'pack';

const SHOW_AT_ONCE = 20;

/** Every suggestion waiting, grouped by where it came from, with a bulk accept for the website scan's. */
export function SuggestionsBoard({
  workspaceId,
  canManage,
  items,
  more,
  current,
  initialFilter,
}: {
  workspaceId: string;
  canManage: boolean;
  items: readonly KnowledgeSuggestion[];
  more: boolean;
  current: Readonly<Record<string, CurrentItem>>;
  initialFilter: ReasonFilter;
}) {
  const router = useRouter();
  const base = `/app/w/${workspaceId}/knowledge`;
  const [filter, setFilter] = useState<ReasonFilter>(initialFilter);
  const [gone, setGone] = useState<ReadonlySet<string>>(new Set());
  const [shown, setShown] = useState(SHOW_AT_ONCE);
  const [bulk, setBulk] = useState<{ open: boolean; done: number; running: boolean }>({
    open: false,
    done: 0,
    running: false,
  });
  const live = items.filter((s) => !gone.has(s.id));
  const of = (r: Exclude<ReasonFilter, 'all'>) => live.filter((s) => s.reason === r);
  const scan = of('scan');
  const gaps = of('gap');
  const packs = of('pack');

  function decided(s: KnowledgeSuggestion, _d: Decision, message: string) {
    setGone((g) => new Set(g).add(s.id));
    toast.success(message);
    router.refresh();
  }
  async function acceptAllScan() {
    setBulk({ open: true, done: 0, running: true });
    const ids = scan.map((s) => s.id);
    const out = await acceptMany(workspaceId, ids, (done) => setBulk((b) => ({ ...b, done })));
    setGone((g) => new Set([...g, ...ids]));
    setBulk({ open: false, done: 0, running: false });
    if (out.failed)
      toast.error(
        `Accepted ${out.accepted}. ${out.failed} couldn’t be accepted; try them one by one.`,
      );
    else toast.success(`Accepted ${out.accepted} and published them.`);
    router.refresh();
  }

  const chips: { value: ReasonFilter; label: string; n: number }[] = [
    { value: 'all', label: 'All', n: live.length },
    { value: 'scan', label: 'Website scan', n: scan.length },
    { value: 'gap', label: 'Gaps', n: gaps.length },
    { value: 'pack', label: 'Go Biz Help', n: packs.length },
  ];

  if (!live.length)
    return (
      <Card
        className="flex flex-col items-center gap-1.5 px-6 py-10 text-center"
        data-testid="suggestions-empty"
      >
        <span className="mb-1 inline-flex h-11 w-11 items-center justify-center rounded-full bg-accent-soft text-accent-text">
          <Inbox className="h-5 w-5" strokeWidth={1.5} />
        </span>
        <h3 className="text-[15px] font-semibold">Nothing waiting</h3>
        <p className="max-w-[400px] text-[13px] text-text-2">
          Suggestions come from scanning your website, from questions the AI couldn’t answer, and
          from Go Biz Help. Nothing joins the knowledge base until someone accepts it.
        </p>
        {canManage ? (
          <ButtonLink href={`${base}/website`} size="sm" className="mt-2.5">
            Scan your website
          </ButtonLink>
        ) : null}
      </Card>
    );

  const section = (title: string, list: readonly KnowledgeSuggestion[], extra?: React.ReactNode) =>
    list.length ? (
      <section className="flex flex-col gap-2" aria-label={title}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3">
            {title}
          </h3>
          {extra}
        </div>
        <div className="flex flex-col gap-2.5">
          {list.slice(0, shown).map((s) => (
            <SuggestionCard
              key={s.id}
              workspaceId={workspaceId}
              s={s}
              canManage={canManage}
              current={s.itemId ? (current[s.itemId] ?? null) : null}
              onDecided={decided}
            />
          ))}
          {list.length > shown ? (
            <button
              type="button"
              onClick={() => setShown((n) => n + SHOW_AT_ONCE)}
              className="self-start text-[13px] font-medium text-accent-text hover:underline"
            >
              Show {Math.min(SHOW_AT_ONCE, list.length - shown)} more
            </button>
          ) : null}
        </div>
      </section>
    ) : null;

  return (
    <div className="flex flex-col gap-4" data-testid="suggestions-board">
      <div className="flex flex-wrap items-center gap-1.5">
        {chips.map((c) => (
          <button
            key={c.value}
            type="button"
            aria-pressed={filter === c.value}
            onClick={() => setFilter(c.value)}
            data-testid={`reason-${c.value}`}
            className={cn(
              'inline-flex h-7 items-center whitespace-nowrap rounded-full border px-3 text-[12.5px] font-medium transition-colors',
              filter === c.value
                ? 'border-transparent bg-accent-soft text-accent-text'
                : 'border-border-strong bg-card text-text-2 hover:bg-card-2',
            )}
          >
            {c.label} · {c.n}
          </button>
        ))}
        {more ? <span className="text-xs text-text-3">Showing the newest 100</span> : null}
      </div>
      <div className="grid gap-5 xl:grid-cols-2 xl:items-start">
        {filter === 'all' || filter === 'scan'
          ? section(
              'From the website scan',
              scan,
              canManage && scan.length > 1 ? (
                <span className="flex items-center gap-3">
                  <Link
                    href={`${base}/website`}
                    className="text-[13px] font-medium text-accent-text hover:underline"
                  >
                    Review page by page
                  </Link>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setBulk({ open: true, done: 0, running: false })}
                    data-testid="accept-all-scan"
                  >
                    Accept all {scan.length}
                  </Button>
                </span>
              ) : null,
            )
          : null}
        <div className="flex flex-col gap-5">
          {filter === 'all' || filter === 'gap'
            ? section('Gaps: questions the AI couldn’t answer', gaps)
            : null}
          {filter === 'all' || filter === 'pack' ? section('From Go Biz Help', packs) : null}
        </div>
      </div>
      <Dialog
        open={bulk.open}
        onOpenChange={(open) => {
          if (!bulk.running) setBulk((b) => ({ ...b, open }));
        }}
      >
        <DialogContent
          title={`Accept all ${scan.length} from the website scan?`}
          description="Each one is published, so AI steps and the Assistant can use it right away. Changes to existing items update them."
        >
          <div className="mt-5 flex items-center justify-end gap-2">
            {bulk.running ? (
              <span className="mr-auto text-[13px] text-text-2" aria-live="polite">
                Accepting {bulk.done} of {scan.length}…
              </span>
            ) : null}
            <Button
              variant="ghost"
              disabled={bulk.running}
              onClick={() => setBulk((b) => ({ ...b, open: false }))}
            >
              Cancel
            </Button>
            <Button
              loading={bulk.running}
              onClick={() => void acceptAllScan()}
              data-testid="accept-all-confirm"
            >
              Accept all
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
