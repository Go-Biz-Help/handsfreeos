'use client';
import { ADDON_CATEGORY_WORDS, type AddonCategory } from '@hfos/core';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/input';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { AddonPickOverview } from '@/lib/api/types';

/**
 * Voting on what's next (0109), the team's side. Every Sunday at midnight Eastern the planned add-on with the most
 * votes becomes Coming soon on its own; a week with nothing voted for, or a tie, waits here for one of us to choose
 * (the owner's decision, 2026-09-28), and the businesses that voted for our choice are emailed as for a winner.
 */

const when = (iso: string) =>
  new Date(iso).toLocaleString('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
const day = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', {
    timeZone: 'America/New_York',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
const votes = (n: number) => `${n} ${n === 1 ? 'vote' : 'votes'}`;
const HOW: Record<'votes' | 'team' | 'plan', string> = {
  votes: 'Won the vote',
  team: 'Chosen by the team',
  plan: 'Already planned',
};
/** The race shows this many until "Show all". */
const RACE_SHOWN = 25;

export function AddonPicksAdmin({ overview }: { overview: AddonPickOverview }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const [query, setQuery] = useState('');
  const [all, setAll] = useState(false);
  const nameOf = useMemo(() => {
    const names = new Map(overview.race.map((r) => [r.addonId, r.name]));
    return (id: string) => names.get(id) ?? id;
  }, [overview.race]);

  const race = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? overview.race.filter((r) => r.name.toLowerCase().includes(q)) : overview.race;
  }, [overview.race, query]);

  const choose = async (weekId: string, addonId: string) => {
    setBusy(weekId);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/addon_pick.choose', { body: { weekId, addonId } }),
      );
      toast.success(
        `${nameOf(addonId)} is coming soon. The businesses that voted for it are being told.`,
      );
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mx-auto w-full max-w-5xl" data-testid="addon-picks-admin">
      <h1 className="text-xl font-semibold md:text-2xl">Add-on votes</h1>
      <p className="mt-1 max-w-[70ch] text-[13.5px] text-text-2">
        Businesses vote for the planned add-ons they want. Every Sunday at midnight Eastern, the one
        with the most votes becomes Coming soon. When nobody voted, or there’s a tie, you choose.
        Next pick:{' '}
        <span className="font-medium text-text">{when(overview.nextPickAt)} Eastern</span>.
      </p>

      <h2 className="mt-8 text-base font-semibold">
        Waiting on you{overview.waiting.length ? ` · ${overview.waiting.length}` : ''}
      </h2>
      {overview.waiting.length === 0 ? (
        <p className="mt-2 text-[13px] text-text-3" data-testid="addon-picks-none-waiting">
          Nothing to choose. A week with no votes or a tie lands here, and you get an email.
        </p>
      ) : (
        <ul className="mt-3 divide-y divide-border overflow-hidden rounded-card border border-border bg-card">
          {overview.waiting.map((w) => {
            const options = w.outcome === 'tie' ? w.tied : overview.race.map((r) => r.addonId);
            const pick = chosen[w.weekId] ?? options[0] ?? '';
            return (
              <li
                key={w.weekId}
                className="flex flex-col gap-3 px-4 py-3.5"
                data-testid={`addon-week-${w.weekId}`}
              >
                <div>
                  <p className="text-sm font-semibold">Week ending {day(w.endsAt)}</p>
                  <p className="text-[13px] text-text-2">
                    {w.outcome === 'tie'
                      ? `A tie between ${w.tied.map(nameOf).join(', ')}, with ${votes(w.topVotes)} each. Choose one of them.`
                      : 'Nobody voted. Choose any planned add-on to come next.'}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Select
                    selectSize="sm"
                    aria-label="Add-on to make Coming soon"
                    value={pick}
                    onChange={(e) => setChosen((c) => ({ ...c, [w.weekId]: e.target.value }))}
                    className="w-auto min-w-0 max-w-full"
                    data-testid={`addon-week-choice-${w.weekId}`}
                  >
                    {options.map((id) => {
                      const r = overview.race.find((x) => x.addonId === id);
                      return (
                        <option key={id} value={id}>
                          {nameOf(id)}
                          {r ? ` (${votes(r.votes)})` : ''}
                        </option>
                      );
                    })}
                  </Select>
                  <Button
                    size="sm"
                    loading={busy === w.weekId}
                    disabled={!pick || busy !== null}
                    onClick={() => void choose(w.weekId, pick)}
                    data-testid={`addon-week-choose-${w.weekId}`}
                  >
                    Make it Coming soon
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <h2 className="mt-8 text-base font-semibold">Coming soon · {overview.comingSoon.length}</h2>
      {overview.comingSoon.length === 0 ? (
        <p className="mt-2 text-[13px] text-text-3">Nothing picked yet.</p>
      ) : (
        <ul className="mt-3 divide-y divide-border overflow-hidden rounded-card border border-border bg-card">
          {overview.comingSoon.map((c) => (
            <li key={c.addonId} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3">
              <span className="min-w-0 flex-1 text-sm font-semibold">{c.name}</span>
              <Badge variant={c.how === 'votes' ? 'accent' : 'gray'}>{HOW[c.how]}</Badge>
              <span className="text-[13px] tabular-nums text-text-3">
                {votes(c.votes)} · picked {day(c.pickedAt)}
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-8 flex flex-wrap items-end justify-between gap-3">
        <h2 className="text-base font-semibold">The race · {overview.race.length}</h2>
        <Input
          inputSize="sm"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Find an add-on"
          aria-label="Find an add-on"
          className="w-full sm:w-64"
        />
      </div>
      <div className="mt-3 overflow-x-auto rounded-card border border-border bg-card">
        <table className="w-full text-[13.5px]">
          <thead>
            <tr className="border-b border-border text-left text-xs text-text-3">
              <th className="px-4 py-2 font-medium">Add-on</th>
              <th className="px-4 py-2 font-medium">Category</th>
              <th className="px-4 py-2 text-right font-medium">Votes</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {(all || query ? race : race.slice(0, RACE_SHOWN)).map((r) => (
              <tr key={r.addonId}>
                <td className="px-4 py-2">{r.name}</td>
                <td className="px-4 py-2 text-text-2">
                  {ADDON_CATEGORY_WORDS[r.category as AddonCategory] ?? r.category}
                </td>
                <td className="px-4 py-2 text-right tabular-nums">{r.votes}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!all && !query && race.length > RACE_SHOWN ? (
        <Button variant="ghost" size="sm" className="mt-2" onClick={() => setAll(true)}>
          Show all {race.length}
        </Button>
      ) : null}

      <h2 className="mt-8 text-base font-semibold">Recent weeks</h2>
      {overview.weeks.length === 0 ? (
        <p className="mt-2 text-[13px] text-text-3">No week has closed yet.</p>
      ) : (
        <ul className="mt-3 divide-y divide-border overflow-hidden rounded-card border border-border bg-card">
          {overview.weeks.map((w) => (
            <li
              key={w.weekId}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-[13.5px]"
            >
              <span className="w-32 flex-none text-text-2">{day(w.endsAt)}</span>
              <span className="min-w-0 flex-1">
                {w.name ??
                  (w.outcome === 'tie' ? 'Tie, waiting on you' : 'No votes, waiting on you')}
              </span>
              <span className="text-text-3">
                {w.outcome === 'votes'
                  ? `Won with ${votes(w.topVotes)}`
                  : w.decidedBy
                    ? `Chosen by ${w.decidedBy}`
                    : w.name
                      ? 'Chosen by the team'
                      : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
