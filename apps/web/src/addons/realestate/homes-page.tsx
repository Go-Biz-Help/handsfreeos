'use client';
/**
 * A buyer deal's homes (board 15, design/realestate/Homes.dc.html): each with its price and rooms, how it fits what
 * the buyer wants, what the clients said, and where the agent has it. `?add=1` opens Add a home (board 14) and
 * `?home=<id>` opens one home.
 */
import { HOME_STATUSES } from '@hfos/core/addons/realestate/homes';
import { money } from '@hfos/core';
import { Home as HomeIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { PageHeader } from '@/components/shell/page-header';
import { Button, ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { useLiveRefresh } from '@/lib/realtime/live-provider';
import { cn } from '@/lib/utils';
import { dealHref } from './bits';
import { HomeVoice } from './buyer-cards';
import { DealCrumb, firstNames, FitList, street } from './buyer-bits';
import { AddHomeDialog, HomeDialog } from './home-dialogs';
import { MlsPhoto } from './mls-bits';
import { SuggestionsCard } from './suggestions-card';
import type { Home, Suggestion } from './types';
import { useQueryState } from './use-query-state';

type Filter = 'all' | 'shortlisted' | 'saved' | 'passed' | 'facts';

export function HomesPage({
  workspaceId,
  dealId,
  dealName,
  timeZone,
  homes,
  clients,
  agentName,
  suggestions = [],
  feed = null,
  live,
}: {
  workspaceId: string;
  dealId: string;
  dealName: string;
  timeZone: string;
  homes: readonly Home[];
  /** The deal's clients' names. */
  clients: readonly string[];
  agentName: string | null;
  /** Our own listings that fit what they want (round three). */
  suggestions?: readonly Suggestion[];
  /** The business's listing feed (round five): connected, and what the buyer's saved search has waiting. */
  feed?: {
    readonly connected: boolean;
    readonly newMatches: number;
    readonly searchOn: boolean;
  } | null;
  live: boolean;
}) {
  useLiveRefresh(['custom_record']);
  const [adding, setAdding] = useQueryState('add');
  const [homeId, setHomeId] = useQueryState('home');
  const [filter, setFilter] = useState<Filter>('all');
  const who = firstNames(clients) || 'the client';
  const saved = (h: Home) => h.reactions.some((r) => r.reaction === 'saved');
  const passed = (h: Home) =>
    h.status === 'passed' || h.reactions.some((r) => r.reaction === 'passed');
  const facts = (h: Home) => h.factsState === 'suggested' || h.factsState === 'failed';
  const counts = {
    shortlisted: homes.filter((h) => h.status === 'shortlisted').length,
    saved: homes.filter(saved).length,
    passed: homes.filter(passed).length,
    facts: homes.filter(facts).length,
  };
  const shown = useMemo(
    () =>
      homes.filter((h) =>
        filter === 'all'
          ? true
          : filter === 'shortlisted'
            ? h.status === 'shortlisted'
            : filter === 'saved'
              ? saved(h)
              : filter === 'passed'
                ? passed(h)
                : facts(h),
      ),
    [homes, filter],
  );
  const open = homes.find((h) => h.id === homeId) ?? null;
  const chips: { key: Filter; label: string; n: number }[] = [
    { key: 'all', label: 'All', n: homes.length },
    { key: 'shortlisted', label: 'Shortlisted', n: counts.shortlisted },
    { key: 'saved', label: `Saved by ${who}`, n: counts.saved },
    { key: 'passed', label: 'Passed', n: counts.passed },
    { key: 'facts', label: 'Facts to confirm', n: counts.facts },
  ];
  const sub = (h: Home) =>
    h.mls
      ? `From the MLS · ${h.mls.statusWords}${h.factsState === 'suggested' ? ' · facts to confirm' : ''}`
      : h.mlsState === 'looking'
        ? 'Asking the MLS…'
        : h.factsState === 'suggested'
          ? 'Facts to confirm'
          : h.factsState === 'filling'
            ? 'Reading the listing…'
            : h.factsState === 'failed'
              ? 'Facts to type in'
              : h.addedByClient
                ? `Added by ${firstNames([h.addedByClient.name])}`
                : h.hasPastedText
                  ? `Pasted by ${firstNames([h.addedBy?.fullName ?? 'the team'])}`
                  : 'Address only';
  return (
    <div data-testid="realestate-homes">
      <DealCrumb workspaceId={workspaceId} dealId={dealId} dealName={dealName} here="Homes" />
      <PageHeader
        title="Homes"
        description={`${dealName} · fit is checked against what ${who} ${clients.length > 1 ? 'want' : 'wants'}`}
        actions={
          <>
            <ButtonLink href={dealHref(workspaceId, dealId, 'buyer')} variant="secondary">
              What they want
            </ButtonLink>
            {live ? (
              <Button onClick={() => setAdding('1')} data-testid="homes-add">
                Add a home
              </Button>
            ) : null}
          </>
        }
      />
      {feed?.connected && (feed.newMatches || !feed.searchOn) ? (
        <Card className="mb-4 flex flex-wrap items-center gap-3 p-4" data-testid="homes-matches">
          <div className="min-w-[12rem] flex-1">
            <p className="font-semibold">
              {feed.newMatches
                ? `${feed.newMatches} new ${feed.newMatches === 1 ? 'match' : 'matches'} from the MLS`
                : `${who}’s search is off`}
            </p>
            <p className="text-[13px] text-text-2">
              {feed.newMatches
                ? `From ${who}’s saved search. Only the team sees them until one is sent.`
                : `Turn it on and homes that fit what ${who} ${clients.length > 1 ? 'want' : 'wants'} come in from the MLS as they’re listed.`}
            </p>
          </div>
          <ButtonLink
            href={dealHref(workspaceId, dealId, 'matches')}
            variant={feed.newMatches ? 'primary' : 'secondary'}
            size="sm"
          >
            {feed.newMatches ? 'See them' : 'Their search'}
          </ButtonLink>
        </Card>
      ) : null}
      {suggestions.some((x) => x.state === 'new') ? (
        <div className="mb-4">
          <SuggestionsCard
            workspaceId={workspaceId}
            suggestions={suggestions}
            clients={firstNames(clients)}
            live={live}
          />
        </div>
      ) : null}
      <div className="mb-4 flex flex-wrap gap-2" role="tablist" aria-label="Which homes">
        {chips
          .filter((c) => c.key === 'all' || c.n > 0)
          .map((c) => (
            <button
              key={c.key}
              type="button"
              role="tab"
              aria-selected={filter === c.key}
              onClick={() => setFilter(c.key)}
              className={cn(
                'inline-flex h-8 items-center rounded-full border px-3 text-[13px]',
                filter === c.key
                  ? 'border-accent-soft bg-accent-soft text-accent-text'
                  : 'border-border-strong text-text-2 hover:bg-card-2',
              )}
            >
              {c.label} · {c.n}
            </button>
          ))}
      </div>
      <Card className="p-0">
        {shown.length === 0 ? (
          <p className="px-5 py-6 text-[13.5px] text-text-2">
            {homes.length === 0
              ? `No homes yet. ${feed?.connected ? 'Find one on the MLS, or paste' : 'Paste'} an address or a listing’s text, and ${who} can add the ones they find in their portal.`
              : 'No homes here.'}
          </p>
        ) : (
          <table className="w-full text-left text-[13.5px]">
            <thead className="hidden border-b border-border text-xs font-semibold uppercase tracking-wide text-text-3 md:table-header-group">
              <tr>
                <th className="px-5 py-3 font-semibold">Home</th>
                <th className="px-3 py-3 font-semibold">Price</th>
                <th className="px-3 py-3 font-semibold">Bd · Ba · Sq ft</th>
                <th className="px-3 py-3 font-semibold">Fit</th>
                <th className="px-3 py-3 font-semibold">{who}</th>
                <th className="px-5 py-3 font-semibold">Status</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((h) => (
                <tr
                  key={h.id}
                  onClick={() => setHomeId(h.id)}
                  className="flex cursor-pointer flex-wrap items-start gap-x-3 gap-y-1 border-b border-border px-4 py-3 last:border-b-0 hover:bg-card-2 md:table-row md:px-0 md:py-0"
                  data-testid={`home-row-${street(h.address)}`}
                >
                  <td className="w-full md:w-auto md:px-5 md:py-3">
                    <div className="flex items-center gap-3">
                      {h.mls?.photos[0] ? (
                        <MlsPhoto
                          url={h.mls.photos[0].url}
                          className="hidden h-11 w-11 flex-none rounded-control md:block"
                        />
                      ) : (
                        <span className="hidden h-11 w-11 flex-none items-center justify-center rounded-control bg-card-2 text-text-3 md:flex">
                          <HomeIcon className="h-4 w-4" strokeWidth={1.5} />
                        </span>
                      )}
                      <div className="min-w-0">
                        <button
                          type="button"
                          className="truncate text-left font-semibold hover:underline"
                          onClick={(e) => {
                            e.stopPropagation();
                            setHomeId(h.id);
                          }}
                        >
                          {street(h.address)}
                        </button>
                        <div className="text-[12.5px] text-text-2">{sub(h)}</div>
                      </div>
                    </div>
                  </td>
                  <td className="tabular-nums md:px-3 md:py-3">
                    {h.facts.price_cents !== undefined ? money(h.facts.price_cents) : '—'}
                  </td>
                  <td className="tabular-nums text-text-2 md:px-3 md:py-3 md:text-text">
                    {[h.facts.beds, h.facts.baths, h.facts.sqft?.toLocaleString('en-US')]
                      .map((x) => (x === undefined ? '—' : String(x)))
                      .join(' · ')}
                  </td>
                  <td className="w-full md:w-auto md:px-3 md:py-3">
                    <FitList fit={h.fit} />
                  </td>
                  <td className="md:px-3 md:py-3">
                    <HomeVoice home={h} />
                  </td>
                  <td className="text-text-2 md:px-5 md:py-3 md:text-text">
                    {HOME_STATUSES[h.status]}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      <p className="mt-3 text-[12.5px] text-text-3">
        Fit reads only what {agentName ? firstNames([agentName]) : 'the agent'} entered for {who}:
        the budget, the areas, the kind of home and the rooms. It never uses the neighborhood’s
        people, schools’ makeup or anything about who lives there.
      </p>
      <AddHomeDialog
        open={adding === '1'}
        onOpenChange={(o) => setAdding(o ? '1' : null)}
        workspaceId={workspaceId}
        dealId={dealId}
        feed={!!feed?.connected}
        who={who}
        onAdded={(id) => setHomeId(id)}
      />
      <HomeDialog
        home={open}
        onOpenChange={(o) => !o && setHomeId(null)}
        workspaceId={workspaceId}
        dealId={dealId}
        timeZone={timeZone}
        live={live}
        feed={!!feed?.connected}
      />
    </div>
  );
}
