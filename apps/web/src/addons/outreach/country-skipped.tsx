'use client';
/**
 * The Friends tab's **Skipped for country** list (docs/outreach.md, decision 60): everyone the business's country
 * setting skips, with their country and whether it was seen on their profile or guessed by the AI. **Unskip** lets one
 * through from then on, whatever the setting says. It shows only while the setting skips anyone, or someone was let
 * through.
 */
import {
  COUNTRY_HOW_WORDS,
  countryRuleWords,
  SKIPPED_PAGE,
  type CountriesSkippedOutput,
} from '@hfos/core/addons/outreach/countries';
import { useCallback, useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { relativeTime } from '@/lib/utils';
import { Pager } from './friends-view';
import { useAct } from './use-act';

export function SkippedCountryCard({ workspaceId }: { workspaceId: string }) {
  const [page, setPage] = useState(1);
  const [list, setList] = useState<CountriesSkippedOutput | null>(null);
  const load = useCallback(
    async (at: number) => {
      try {
        const got = unwrap(
          await apiBrowser().POST('/v1/queries/outreach.countries.skipped', {
            body: { workspaceId, page: at },
          }),
        );
        setList(got);
      } catch {
        setList(null);
      }
    },
    [workspaceId],
  );
  useEffect(() => {
    void load(page);
  }, [load, page]);
  const { busy, act } = useAct();
  if (!list || (list.rule.mode === 'anywhere' && list.total === 0)) return null;
  const unskip = (p: CountriesSkippedOutput['people'][number]) =>
    act(
      `unskip:${p.profileId}`,
      async () => {
        const done = unwrap(
          await apiBrowser().POST('/v1/commands/outreach.country.unskip', {
            body: { workspaceId, profileId: p.profileId, through: true },
          }),
        );
        await load(page);
        return done;
      },
      `${p.name} is let through from now on, whatever the country setting says.`,
    );
  const first = (list.page - 1) * SKIPPED_PAGE + 1;
  return (
    <Card className="mt-4 p-0" data-testid="outreach-country-skipped">
      <div className="px-5 pt-4">
        <div className="flex items-baseline justify-between gap-3">
          <h3 className="text-[15px] font-semibold">Skipped for country</h3>
          <span className="text-[12.5px] tabular-nums text-text-3">
            {list.total
              ? list.pages > 1
                ? `${first.toLocaleString()}–${(first + list.people.length - 1).toLocaleString()} of ${list.total.toLocaleString()}`
                : list.total.toLocaleString()
              : null}
          </span>
        </div>
        <p className="mt-0.5 text-[12.5px] text-text-2">
          Your business reaches: {countryRuleWords(list.rule)}. Nobody here is sent a friend request
          or a message, suggested on Today or listed as a good fit. Unskip lets someone through for
          good.
          {list.unskipped
            ? ` ${list.unskipped.toLocaleString()} ${list.unskipped === 1 ? 'person is' : 'people are'} let through.`
            : ''}
        </p>
      </div>
      {list.people.length ? (
        <ul className="mt-2">
          {list.people.map((p) => (
            <li
              key={p.profileId}
              className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-5 py-2.5"
              data-testid="country-skipped-row"
            >
              <div className="min-w-0">
                <a
                  href={p.url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-[13.5px] font-medium text-accent-text hover:underline"
                >
                  {p.name}
                </a>
                <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[12px] text-text-3">
                  <span>{p.countryName}</span>
                  <Badge variant={p.how === 'seen' ? 'ok' : 'gray'}>
                    {COUNTRY_HOW_WORDS[p.how]}
                  </Badge>
                  {p.at ? <span>{relativeTime(p.at)}</span> : null}
                </div>
              </div>
              <Button
                size="sm"
                variant="secondary"
                disabled={busy !== null}
                onClick={() => void unskip(p)}
                data-testid="country-unskip"
              >
                Unskip
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-5 pb-4 pt-2 text-[13px] text-text-2">
          Nobody is skipped yet. People show here once their country is known: seen on their
          profile, or guessed by the AI from their name, posts and groups.
        </p>
      )}
      {list.pages > 1 ? <Pager page={list.page} pages={list.pages} onPage={setPage} /> : null}
    </Card>
  );
}
