'use client';
import {
  ADDON_CATEGORY_WORDS,
  ADDON_PICK_HOW_WORDS,
  ADDON_RACE_SHOWN,
  ADDON_VOTES_WORDS,
  addonPickDay,
  addonVotesCount,
  addonWeekChoices,
  addonWeekResult,
  deskCountHeading,
  deskSectionLabel,
  filterAddonRace,
  type AddonCategory,
} from '@hfos/core';
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

  const race = useMemo(() => filterAddonRace(overview.race, query), [overview.race, query]);

  const choose = async (weekId: string, addonId: string) => {
    setBusy(weekId);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/addon_pick.choose', { body: { weekId, addonId } }),
      );
      toast.success(ADDON_VOTES_WORDS.chosen(nameOf(addonId)));
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mx-auto w-full max-w-5xl" data-testid="addon-picks-admin">
      <h1 className="text-xl font-semibold md:text-2xl">{deskSectionLabel('add-ons')}</h1>
      <p className="mt-1 max-w-[70ch] text-[13.5px] text-text-2">
        {ADDON_VOTES_WORDS.intro} {ADDON_VOTES_WORDS.nextPick}{' '}
        <span className="font-medium text-text">
          {ADDON_VOTES_WORDS.nextPickAt(overview.nextPickAt)}
        </span>
        .
      </p>

      <h2 className="mt-8 text-base font-semibold">
        {deskCountHeading(ADDON_VOTES_WORDS.waiting, overview.waiting.length)}
      </h2>
      {overview.waiting.length === 0 ? (
        <p className="mt-2 text-[13px] text-text-3" data-testid="addon-picks-none-waiting">
          {ADDON_VOTES_WORDS.noneWaiting}
        </p>
      ) : (
        <ul className="mt-3 divide-y divide-border overflow-hidden rounded-card border border-border bg-card">
          {overview.waiting.map((w) => {
            const options = addonWeekChoices(w, overview.race);
            const pick = chosen[w.weekId] ?? options[0] ?? '';
            return (
              <li
                key={w.weekId}
                className="flex flex-col gap-3 px-4 py-3.5"
                data-testid={`addon-week-${w.weekId}`}
              >
                <div>
                  <p className="text-sm font-semibold">{ADDON_VOTES_WORDS.weekEnding(w.endsAt)}</p>
                  <p className="text-[13px] text-text-2">
                    {w.outcome === 'tie'
                      ? ADDON_VOTES_WORDS.tie(w.tied.map(nameOf), w.topVotes)
                      : ADDON_VOTES_WORDS.noVotes}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Select
                    selectSize="sm"
                    aria-label={ADDON_VOTES_WORDS.choiceLabel}
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
                          {r ? ` (${addonVotesCount(r.votes)})` : ''}
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
                    {ADDON_VOTES_WORDS.choose}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <h2 className="mt-8 text-base font-semibold">
        {deskCountHeading(ADDON_VOTES_WORDS.comingSoon, overview.comingSoon.length, true)}
      </h2>
      {overview.comingSoon.length === 0 ? (
        <p className="mt-2 text-[13px] text-text-3">{ADDON_VOTES_WORDS.nothingPicked}</p>
      ) : (
        <ul className="mt-3 divide-y divide-border overflow-hidden rounded-card border border-border bg-card">
          {overview.comingSoon.map((c) => (
            <li key={c.addonId} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3">
              <span className="min-w-0 flex-1 text-sm font-semibold">{c.name}</span>
              <Badge variant={c.how === 'votes' ? 'accent' : 'gray'}>
                {ADDON_PICK_HOW_WORDS[c.how]}
              </Badge>
              <span className="text-[13px] tabular-nums text-text-3">
                {ADDON_VOTES_WORDS.picked(c.votes, c.pickedAt)}
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-8 flex flex-wrap items-end justify-between gap-3">
        <h2 className="text-base font-semibold">
          {deskCountHeading(ADDON_VOTES_WORDS.race, overview.race.length, true)}
        </h2>
        <Input
          inputSize="sm"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={ADDON_VOTES_WORDS.find}
          aria-label={ADDON_VOTES_WORDS.find}
          className="w-full sm:w-64"
        />
      </div>
      <div className="mt-3 overflow-x-auto rounded-card border border-border bg-card">
        <table className="w-full text-[13.5px]">
          <thead>
            <tr className="border-b border-border text-left text-xs text-text-3">
              <th className="px-4 py-2 font-medium">{ADDON_VOTES_WORDS.addOn}</th>
              <th className="px-4 py-2 font-medium">{ADDON_VOTES_WORDS.category}</th>
              <th className="px-4 py-2 text-right font-medium">{ADDON_VOTES_WORDS.votes}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {(all || query ? race : race.slice(0, ADDON_RACE_SHOWN)).map((r) => (
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
      {!all && !query && race.length > ADDON_RACE_SHOWN ? (
        <Button variant="ghost" size="sm" className="mt-2" onClick={() => setAll(true)}>
          {ADDON_VOTES_WORDS.showAll(race.length)}
        </Button>
      ) : null}

      <h2 className="mt-8 text-base font-semibold">{ADDON_VOTES_WORDS.recentWeeks}</h2>
      {overview.weeks.length === 0 ? (
        <p className="mt-2 text-[13px] text-text-3">{ADDON_VOTES_WORDS.noWeeks}</p>
      ) : (
        <ul className="mt-3 divide-y divide-border overflow-hidden rounded-card border border-border bg-card">
          {overview.weeks.map((w) => {
            const result = addonWeekResult(w);
            return (
              <li
                key={w.weekId}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-[13.5px]"
              >
                <span className="w-32 flex-none text-text-2">{addonPickDay(w.endsAt)}</span>
                <span className="min-w-0 flex-1">{result.what}</span>
                <span className="text-text-3">{result.how}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
