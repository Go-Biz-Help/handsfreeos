'use client';
/**
 * The country setting's lists (docs/outreach.md, decisions 61 and 86), shown only while the business's country setting
 * picks countries:
 *
 * - **Not sure where they live**, under Needs you (decision 128): everyone a look couldn't place, while When we can't
 *   tell is Ask me. Each waits for a person's call: **Let through** or **Skip**, both for good.
 * - **Skipped for country**, People's Left alone (decision 128): everyone the setting skips, with what their profile
 *   and friends say, and how many still wait for a look. **Unskip** lets one through from then on, whatever the
 *   setting says; one a person skipped can be put back under the setting.
 */
import {
  COUNTRY_HOW_WORDS,
  COUNTRY_LIST_WORDS as LW,
  countryRuleWords,
  SKIPPED_PAGE,
  type CountriesSkippedOutput,
  type CountryChoice,
  type CountryList,
} from '@hfos/core/addons/outreach/countries';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { relativeTime } from '@/lib/utils';
import { Pager } from './friends-view';
import { useAct } from './use-act';

type Row = CountriesSkippedOutput['people'][number];

/** One of the lists, a page at a time, with what's done on a row; `reloadAll` loads both again after a change. */
function useCountryList(workspaceId: string, list: CountryList, version: number) {
  const [page, setPage] = useState(1);
  const [got, setGot] = useState<CountriesSkippedOutput | null>(null);
  const load = useCallback(
    async (at: number) => {
      try {
        setGot(
          unwrap(
            await apiBrowser().POST('/v1/queries/outreach.countries.skipped', {
              body: { workspaceId, list, page: at },
            }),
          ),
        );
      } catch {
        setGot(null);
      }
    },
    [workspaceId, list],
  );
  useEffect(() => {
    void load(page);
  }, [load, page, version]);
  return { got, setPage };
}

/** A call on someone in either list: both load again, since a change moves people between them. */
function useCountryDecide(workspaceId: string, done: () => void) {
  const { busy, act } = useAct();
  const decide = (p: Row, choice: CountryChoice | 'unskip', words: string) =>
    act(
      `${choice}:${p.profileId}`,
      async () => {
        const answer =
          choice === 'unskip'
            ? unwrap(
                await apiBrowser().POST('/v1/commands/outreach.country.unskip', {
                  body: { workspaceId, profileId: p.profileId, through: true },
                }),
              )
            : unwrap(
                await apiBrowser().POST('/v1/commands/outreach.country.decide', {
                  body: { workspaceId, profileId: p.profileId, choice },
                }),
              );
        done();
        return answer;
      },
      words,
    );
  return { busy, decide };
}

/** Not sure where they live, under Needs you: nothing while nobody waits for a call. */
export function UnsureCountryCard({ workspaceId }: { workspaceId: string }) {
  const [version, setVersion] = useState(0);
  const unsure = useCountryList(workspaceId, 'unsure', version);
  const { busy, decide } = useCountryDecide(workspaceId, () => setVersion((v) => v + 1));
  if (!unsure.got?.people.length) return null;
  return (
    <ListCard
      testId="outreach-country-unsure"
      title={LW.unsureTitle}
      note={LW.unsureNote}
      got={unsure.got}
      onPage={unsure.setPage}
      actions={(p) => (
        <>
          <Button
            size="sm"
            variant="secondary"
            disabled={busy !== null}
            onClick={() => void decide(p, 'through', `${p.name} is let through from now on.`)}
            data-testid="country-let-through"
          >
            {LW.through}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={busy !== null}
            onClick={() => void decide(p, 'skip', `${p.name} is skipped from now on.`)}
            data-testid="country-skip"
          >
            {LW.skip}
          </Button>
        </>
      )}
    />
  );
}

/** Skipped for country, Left alone's last list: says so when the business reaches anywhere and nobody is skipped. */
export function SkippedCountryCard({ workspaceId }: { workspaceId: string }) {
  const [version, setVersion] = useState(0);
  const skipped = useCountryList(workspaceId, 'skipped', version);
  const { busy, decide } = useCountryDecide(workspaceId, () => setVersion((v) => v + 1));
  const list = skipped.got;
  if (!list) return null;
  if (list.rule.mode === 'anywhere' && list.total === 0)
    return (
      <Card className="p-5" data-testid="outreach-country-anywhere">
        <h3 className="text-[15px] font-semibold">Skipped for country</h3>
        <p className="mt-1 text-[13px] text-text-2">{LW.anywhere}</p>
      </Card>
    );
  return (
    <ListCard
      testId="outreach-country-skipped"
      title="Skipped for country"
      note={[
        `Your business reaches: ${countryRuleWords(list.rule)}. Nobody here is sent a friend request or a message, suggested on Today or listed as a good fit. Unskip lets someone through for good.`,
        list.unskipped
          ? `${list.unskipped.toLocaleString()} ${list.unskipped === 1 ? 'person is' : 'people are'} let through.`
          : null,
        list.waiting ? LW.waiting(list.waiting) : null,
      ]
        .filter(Boolean)
        .join(' ')}
      got={list}
      onPage={skipped.setPage}
      empty="Nobody is skipped yet. People show here once a “Lives in” on their profile, or a look at their profile and mutual friends, says they’re outside the countries you reach."
      actions={(p) =>
        p.skippedByYou ? (
          <Button
            size="sm"
            variant="secondary"
            disabled={busy !== null}
            onClick={() =>
              void decide(p, 'setting', `${p.name} is back under the country setting.`)
            }
            data-testid="country-undo-skip"
          >
            {LW.undo}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="secondary"
            disabled={busy !== null}
            onClick={() =>
              void decide(
                p,
                'unskip',
                `${p.name} is let through from now on, whatever the country setting says.`,
              )
            }
            data-testid="country-unskip"
          >
            Unskip
          </Button>
        )
      }
    />
  );
}

function ListCard({
  testId,
  title,
  note,
  got,
  onPage,
  empty,
  actions,
}: {
  testId: string;
  title: string;
  note: string;
  got: CountriesSkippedOutput;
  onPage: (page: number) => void;
  empty?: string;
  actions: (p: Row) => ReactNode;
}) {
  const first = (got.page - 1) * SKIPPED_PAGE + 1;
  return (
    <Card className="p-0" data-testid={testId}>
      <div className="px-5 pt-4">
        <div className="flex items-baseline justify-between gap-3">
          <h3 className="text-[15px] font-semibold">{title}</h3>
          <span className="text-[12.5px] tabular-nums text-text-3">
            {got.total
              ? got.pages > 1
                ? `${first.toLocaleString()}–${(first + got.people.length - 1).toLocaleString()} of ${got.total.toLocaleString()}`
                : got.total.toLocaleString()
              : null}
          </span>
        </div>
        <p className="mt-0.5 text-[12.5px] text-text-2">{note}</p>
      </div>
      {got.people.length ? (
        <ul className="mt-2">
          {got.people.map((p) => (
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
                  {p.countryName ? <span>{p.countryName}</span> : null}
                  {p.skippedByYou ? (
                    <Badge variant="gray">{LW.skippedByYou}</Badge>
                  ) : p.how ? (
                    <Badge variant={p.how === 'seen' || p.how === 'friends' ? 'ok' : 'gray'}>
                      {COUNTRY_HOW_WORDS[p.how]}
                    </Badge>
                  ) : null}
                  {p.at ? <span>{relativeTime(p.at)}</span> : null}
                </div>
                {p.reason.length ? (
                  <p className="mt-0.5 text-[12px] text-text-2">{p.reason.join(' · ')}</p>
                ) : null}
                {p.why ? <p className="mt-0.5 text-[12px] text-text-3">{p.why}</p> : null}
              </div>
              <div className="flex gap-2">{actions(p)}</div>
            </li>
          ))}
        </ul>
      ) : empty ? (
        <p className="px-5 pb-4 pt-2 text-[13px] text-text-2">{empty}</p>
      ) : null}
      {got.pages > 1 ? <Pager page={got.page} pages={got.pages} onPage={onPage} /> : null}
    </Card>
  );
}
