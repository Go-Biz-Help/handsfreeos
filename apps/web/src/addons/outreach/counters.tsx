'use client';
/**
 * The counters at the top of Today (docs/outreach.md, decision 140): everything the person's extension did on its
 * own, today, this week (from Monday) or this month (from the 1st), on each network and all together
 * (`outreach.counts`). Each group (Reached out, Looked at, Groups, Tidied up, Written by the AI) opens to show its
 * lines. Owners and admins can switch to the whole team's, all together and person by person.
 *
 * The numbers go up live: asked again each time the person's computer says something (every few seconds while the
 * ticker is on screen, ./ticker.tsx), and every minute in case it said nothing.
 */
import { NETWORKS, type Platform } from '@hfos/core/addons/outreach/networks';
import {
  COUNT_PERIOD_KEYS,
  COUNT_PERIODS,
  COUNTER_WORDS as CW,
  countedSinceWords,
  countWords,
  tallyNetworks,
  tallyView,
  type CountPeriod,
  type CountsOutput,
  type TallyGroup,
} from '@hfos/core/addons/outreach/tallies';
import { ChevronDown } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Card } from '@/components/ui/card';
import { Segmented } from '@/components/ui/segmented';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { useLiveVersion } from '@/lib/realtime/live-provider';
import { cn } from '@/lib/utils';

/** Asked again this often while the tab is shown, when nothing was heard. */
const AGAIN_MS = 60_000;

type Whose = 'me' | 'team';
type Net = Platform | 'all';

export function OutreachCounters({
  workspaceId,
  working,
  canManage,
}: {
  workspaceId: string;
  /** The networks the person works: a tab each, beside All networks. */
  working: readonly Platform[];
  /** Owners and admins: the whole team's counts too. */
  canManage: boolean;
}) {
  const [period, setPeriod] = useState<CountPeriod>('today');
  const [whose, setWhose] = useState<Whose>('me');
  const [net, setNet] = useState<Net>('all');
  const [open, setOpen] = useState<ReadonlySet<TallyGroup>>(new Set());
  const [out, setOut] = useState<CountsOutput | null>(null);
  const [failed, setFailed] = useState(false);
  // The person's computer said something: a step done, or its line while the ticker shows.
  const heard = useLiveVersion(['outreach_computer', 'outreach_line'], 4000);
  const [beat, setBeat] = useState(0);
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') setBeat((n) => n + 1);
    }, AGAIN_MS);
    return () => clearInterval(t);
  }, []);
  const everyone = canManage && whose === 'team';
  useEffect(() => {
    let gone = false;
    apiBrowser()
      .POST('/v1/queries/outreach.counts', { body: { workspaceId, period, everyone } })
      .then(unwrap)
      .then((got) => {
        if (gone) return;
        setOut(got);
        setFailed(false);
      })
      .catch(() => {
        if (!gone) setFailed(true);
      });
    return () => {
      gone = true;
    };
  }, [workspaceId, period, everyone, heard, beat]);

  // What was had for another stretch or person isn't shown as this one's.
  const shown = out && out.period === period && out.everyone === everyone ? out : null;
  const networks = tallyNetworks(shown?.counts ?? [], working);
  const platform = net !== 'all' && networks.includes(net) ? net : null;
  const view = tallyView(shown?.counts ?? [], platform);
  const since = shown ? countedSinceWords(shown) : '';
  const toggle = (key: TallyGroup) =>
    setOpen((had) => {
      const next = new Set(had);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <Card className="mb-4 p-4" data-testid="outreach-counters">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold">{CW.title}</h2>
          <p className="text-[12.5px] text-text-3">{CW.about}</p>
        </div>
        <Segmented
          value={period}
          onChange={setPeriod}
          ariaLabel={CW.title}
          options={COUNT_PERIOD_KEYS.map((p) => ({
            value: p,
            label: COUNT_PERIODS[p],
            testId: `counters-period-${p}`,
          }))}
        />
      </div>
      {networks.length > 1 || canManage ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {networks.length > 1 ? (
            <Segmented<Net>
              value={platform ?? 'all'}
              onChange={setNet}
              className="max-w-full overflow-x-auto"
              options={[
                { value: 'all', label: CW.all, testId: 'counters-net-all' },
                ...networks.map((p) => ({
                  value: p,
                  label: NETWORKS[p].name,
                  testId: `counters-net-${p}`,
                })),
              ]}
            />
          ) : null}
          {canManage ? (
            <Segmented<Whose>
              value={whose}
              onChange={setWhose}
              options={[
                { value: 'me', label: CW.you, testId: 'counters-you' },
                { value: 'team', label: CW.team, testId: 'counters-team' },
              ]}
            />
          ) : null}
        </div>
      ) : null}

      {!shown ? (
        <p className="mt-4 text-[13px] text-text-3" data-testid="counters-loading">
          {failed ? CW.failed : '…'}
        </p>
      ) : (
        <>
          <p className="mt-4 flex flex-wrap items-baseline gap-x-2" data-testid="counters-total">
            <span className="text-[28px] font-semibold leading-none tabular-nums">
              {countWords(view.total)}
            </span>
            <span className="text-[13px] text-text-2">{CW.things(view.total)}</span>
            {since ? <span className="text-[12.5px] text-text-3">{since}</span> : null}
          </p>
          {view.total === 0 ? (
            <p className="mt-1 text-[12.5px] text-text-3" data-testid="counters-none">
              {period === 'today' ? CW.noneToday : CW.noneStretch(period)}
            </p>
          ) : null}
          <ul className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
            {view.groups.map((g) => {
              const isOpen = open.has(g.key);
              return (
                <li key={g.key} className={cn(isOpen && 'col-span-2 sm:col-span-3 lg:col-span-5')}>
                  <button
                    type="button"
                    onClick={() => toggle(g.key)}
                    aria-expanded={isOpen}
                    data-testid={`counters-group-${g.key}`}
                    className="flex w-full items-center justify-between gap-2 rounded-[9px] border border-border bg-card-2 px-3 py-2 text-left hover:border-border-strong"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-[12.5px] text-text-2">{g.label}</span>
                      <span className="block text-[18px] font-semibold tabular-nums">
                        {countWords(g.total)}
                      </span>
                    </span>
                    <ChevronDown
                      aria-hidden
                      className={cn(
                        'h-4 w-4 flex-none text-text-3 transition-transform',
                        isOpen && 'rotate-180',
                      )}
                    />
                  </button>
                  {isOpen ? (
                    <ul
                      className="mt-1.5 grid gap-x-6 gap-y-1 px-3 pb-1 text-[13px] sm:grid-cols-2"
                      data-testid={`counters-rows-${g.key}`}
                    >
                      {g.rows.length ? (
                        g.rows.map((r) => (
                          <li key={r.kind} className="flex items-baseline justify-between gap-3">
                            <span className="text-text-2">{r.label}</span>
                            <span className="font-medium tabular-nums">{countWords(r.n)}</span>
                          </li>
                        ))
                      ) : (
                        <li className="text-text-3">{CW.nothing}</li>
                      )}
                    </ul>
                  ) : null}
                </li>
              );
            })}
          </ul>
          {shown.people ? (
            <div className="mt-4" data-testid="counters-people">
              <h3 className="text-[13px] font-semibold">{CW.person}</h3>
              <ul className="mt-1.5 divide-y divide-border">
                {shown.people.map((p) => {
                  const theirs = tallyView(p.counts, platform);
                  return (
                    <li key={p.userId} className="py-2 text-[13px]" data-testid="counters-person">
                      <p className="flex items-baseline justify-between gap-3">
                        <span className="min-w-0 truncate font-medium">{p.name}</span>
                        <span className="font-semibold tabular-nums">
                          {countWords(theirs.total)}
                        </span>
                      </p>
                      {theirs.total ? (
                        <p className="mt-0.5 text-[12px] text-text-3">
                          {theirs.groups
                            .filter((g) => g.total > 0)
                            .map((g) => `${g.label} ${countWords(g.total)}`)
                            .join(' · ')}
                        </p>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}
        </>
      )}
    </Card>
  );
}
