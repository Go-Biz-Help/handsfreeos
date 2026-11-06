'use client';
import {
  DESK_LEDGER_WORDS,
  LEDGER_GAP_STATES,
  LEDGER_ITEM_STATES,
  LEDGER_VIEWS,
  type LedgerGapState,
  type LedgerItemState,
  type LedgerView,
} from '@hfos/core';
import { useEffect, useState } from 'react';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { Ok } from '@/lib/api/types';

type Ledger = Ok<'/v1/queries/platform.assistant_ledger'>;

const PAGE = 50;
const W = DESK_LEDGER_WORDS;

const coveredBadge: Record<string, BadgeVariant> = {
  yes: 'ok',
  partly: 'pending',
  no: 'danger',
  never: 'gray',
  person: 'gray',
};
const severityBadge: Record<string, BadgeVariant> = {
  high: 'danger',
  medium: 'pending',
  low: 'gray',
};

/**
 * Every item on every screen, every level down, and how the Assistant covers it (platform.assistant_ledger), with the
 * audit's gaps and the screens nobody has checked: filtered by area and state, fifty at a time, like a table.
 */
export function AssistantLedger() {
  const [view, setView] = useState<LedgerView>('items');
  const [area, setArea] = useState<string | null>(null);
  const [itemState, setItemState] = useState<LedgerItemState>('unmarked');
  const [gapState, setGapState] = useState<LedgerGapState>('open');
  const [q, setQ] = useState('');
  const [data, setData] = useState<Ledger | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const shown =
    view === 'items'
      ? data?.items.length
      : view === 'gaps'
        ? data?.gaps.length
        : data?.screens.length;

  const fetchPage = async (offset: number) =>
    unwrap(
      await apiBrowser().POST('/v1/queries/platform.assistant_ledger', {
        body: { view, area, itemState, gapState, q, offset, limit: PAGE },
      }),
    );

  // A new filter starts at the first page again; typing waits for a pause.
  useEffect(() => {
    let live = true;
    const t = setTimeout(async () => {
      try {
        const next = await fetchPage(0);
        if (live) {
          setData(next);
          setError(null);
        }
      } catch (e) {
        if (live) setError(errorMessage(e));
      }
    }, 200);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [view, area, itemState, gapState, q]);

  const more = async () => {
    if (!data) return;
    setBusy(true);
    try {
      const next = await fetchPage(shown ?? 0);
      setData({
        ...next,
        items: [...data.items, ...next.items],
        gaps: [...data.gaps, ...next.gaps],
        screens: [...data.screens, ...next.screens],
      });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mt-6 rounded-card border border-border bg-card p-4" data-testid="ledger">
      <h2 className="text-sm font-semibold">{W.title}</h2>
      <p className="mt-1 max-w-3xl text-[13px] text-text-3">{W.intro}</p>

      {data ? (
        <dl className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4" data-testid="ledger-cards">
          {(
            [
              ['unmarked', data.totals.unmarked, `${data.totals.items}`],
              ['changed', data.totals.changed, null],
              ['newScreens', data.totals.newScreens, null],
              ['gapsOpen', data.totals.gapsOpen, `${data.totals.gapsOpen + data.totals.gapsFixed}`],
            ] as const
          ).map(([key, value, of]) => (
            <div key={key} className="rounded-card border border-border px-3 py-2.5">
              <dt className="text-[12.5px] text-text-3">{W.cards[key]}</dt>
              <dd
                className={
                  value
                    ? 'mt-0.5 text-xl font-semibold tabular-nums text-danger-text'
                    : 'mt-0.5 text-xl font-semibold tabular-nums'
                }
              >
                {of ? W.showing(value, Number(of)) : value}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Segmented
          value={view}
          onChange={setView}
          ariaLabel={W.title}
          options={LEDGER_VIEWS.map((v) => ({
            value: v,
            label: W.views[v],
            testId: `ledger-view-${v}`,
          }))}
        />
        <Select
          value={area ?? ''}
          onChange={(e) => setArea(e.target.value || null)}
          className="w-auto max-w-[260px]"
          data-testid="ledger-area"
          aria-label={W.anyArea}
        >
          <option value="">{W.anyArea}</option>
          {data?.areas.map((a) => (
            <option key={a.key} value={a.key}>
              {a.title.split(':')[0]} ({view === 'gaps' ? a.gapsOpen : a.unmarked})
            </option>
          ))}
        </Select>
        {view === 'items' ? (
          <Select
            value={itemState}
            onChange={(e) => setItemState(e.target.value as LedgerItemState)}
            className="w-auto"
            data-testid="ledger-item-state"
            aria-label={W.itemStates.all}
          >
            {LEDGER_ITEM_STATES.map((s) => (
              <option key={s} value={s}>
                {W.itemStates[s]}
              </option>
            ))}
          </Select>
        ) : view === 'gaps' ? (
          <Select
            value={gapState}
            onChange={(e) => setGapState(e.target.value as LedgerGapState)}
            className="w-auto"
            data-testid="ledger-gap-state"
            aria-label={W.gapStates.all}
          >
            {LEDGER_GAP_STATES.map((s) => (
              <option key={s} value={s}>
                {W.gapStates[s]}
              </option>
            ))}
          </Select>
        ) : null}
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={W.search}
          className="w-full md:w-[220px]"
          data-testid="ledger-search"
        />
        {data ? (
          <span className="text-[12.5px] text-text-3" data-testid="ledger-count">
            {W.showing(shown ?? 0, data.total)}
          </span>
        ) : null}
      </div>

      {error ? <p className="mt-3 text-[13px] text-danger-text">{error}</p> : null}

      {data && view === 'items' ? (
        data.items.length === 0 ? (
          <p className="mt-3 text-[13px] text-text-3">{W.none}</p>
        ) : (
          <ul className="mt-3 divide-y divide-border text-[13px]" data-testid="ledger-items">
            {data.items.map((i, n) => (
              <li key={`${i.area}-${n}-${i.path}`} className="flex flex-col gap-1 py-2">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge variant={coveredBadge[i.covered] ?? 'gray'}>
                    {W.itemStates[i.covered]}
                  </Badge>
                  {i.changed ? <Badge variant="pending">{W.itemStates.changed}</Badge> : null}
                  <span className="text-text-3">{W.kind[i.kind]}</span>
                  <span className="min-w-0 break-words font-medium">{i.path}</span>
                </div>
                <p className="break-words text-text-2">{i.by}</p>
                <p className="break-all font-mono text-[11.5px] text-text-3">{i.file}</p>
              </li>
            ))}
          </ul>
        )
      ) : null}

      {data && view === 'gaps' ? (
        data.gaps.length === 0 ? (
          <p className="mt-3 text-[13px] text-text-3">{W.noGaps}</p>
        ) : (
          <ul className="mt-3 divide-y divide-border text-[13px]" data-testid="ledger-gaps">
            {data.gaps.map((g) => (
              <li key={`${g.area}-${g.id}`} className="flex flex-col gap-1 py-2">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge variant={severityBadge[g.severity] ?? 'gray'}>
                    {W.severity[g.severity]}
                  </Badge>
                  {g.status !== 'open' ? <Badge variant="ok">{W.gapStates[g.status]}</Badge> : null}
                  {g.pr ? <span className="text-text-3">{W.fixedIn(g.pr)}</span> : null}
                  <span className="font-mono text-[11.5px] text-text-3">{g.id}</span>
                  <span className="min-w-0 break-words font-medium">{g.where}</span>
                </div>
                <p className="break-words text-text-2">{g.gap}</p>
              </li>
            ))}
          </ul>
        )
      ) : null}

      {data && view === 'screens' ? (
        data.screens.length === 0 ? (
          <p className="mt-3 text-[13px] text-text-3">{W.noScreens}</p>
        ) : (
          <ul className="mt-3 divide-y divide-border text-[13px]" data-testid="ledger-screens">
            {data.screens.map((s) => (
              <li key={s.file} className="flex flex-wrap items-center gap-1.5 py-1.5">
                <Badge variant={s.state === 'new' ? 'pending' : 'danger'}>
                  {W.screenStates[s.state]}
                </Badge>
                <span className="break-all font-mono text-[12px] text-text-2">{s.file}</span>
              </li>
            ))}
          </ul>
        )
      ) : null}

      {data && (shown ?? 0) < data.total ? (
        <Button
          variant="secondary"
          className="mt-3"
          onClick={() => void more()}
          disabled={busy}
          data-testid="ledger-more"
        >
          {W.more}
        </Button>
      ) : null}
    </section>
  );
}
