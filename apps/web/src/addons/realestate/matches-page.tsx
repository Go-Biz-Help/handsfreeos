'use client';
/**
 * A buyer's new matches (board 66, design/realestate/FeedMatches.dc.html): the homes their saved search found on the
 * MLS, each with how it fits what they want, for the agent to send or skip. Only the team sees one until it's sent;
 * sending puts it on the buyer's homes. Beside them, the search itself: what it asks, when it last ran, on or off.
 */
import { money } from '@hfos/core';
import Link from 'next/link';
import { useState } from 'react';
import { Callout } from '@/components/crm/chips';
import { PageHeader } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { useLiveRefresh } from '@/lib/realtime/live-provider';
import { cn, relativeTime } from '@/lib/utils';
import { dealHref } from './bits';
import { DealCrumb, firstNames, FitList, street } from './buyer-bits';
import { MlsNotice, MlsPhoto, roomsLine } from './mls-bits';
import type { Match, MatchList } from './types';
import { useAct } from './use-act';

type Tab = 'new' | 'sent' | 'dismissed';
const TABS: { key: Tab; label: string }[] = [
  { key: 'new', label: 'New' },
  { key: 'sent', label: 'Sent' },
  { key: 'dismissed', label: 'Skipped' },
];

const DAY = 24 * 60 * 60 * 1000;

/** What's new about it: "New today", "Changed on the MLS", "Found 3 days ago". */
function tagOf(m: Match): { words: string; variant: 'accent' | 'pending' | 'gray' } {
  if (m.changedAt) return { words: 'Changed on the MLS', variant: 'pending' };
  if (Date.now() - new Date(m.foundAt).getTime() < DAY)
    return { words: 'New today', variant: 'accent' };
  return { words: `Found ${relativeTime(m.foundAt)}`, variant: 'gray' };
}

export function MatchesPage({
  workspaceId,
  dealId,
  dealName,
  clients,
  agentName,
  list,
  live,
}: {
  workspaceId: string;
  dealId: string;
  dealName: string;
  clients: readonly string[];
  agentName: string | null;
  list: MatchList;
  live: boolean;
}) {
  useLiveRefresh(['custom_record']);
  const [tab, setTab] = useState<Tab>('new');
  const { busy, act } = useAct();
  const who = firstNames(clients) || 'the client';
  const { search, counts } = list;
  const shown = list.matches.filter((m) => m.state === tab);
  // The MLS's notice once under the list; each home's "courtesy of" line on the home itself.
  const notices = [
    ...new Map(
      shown.filter((m) => m.mls.display.notice).map((m) => [m.mls.display.notice!, m.mls.display]),
    ).values(),
  ];
  const send = (m: Match) =>
    act(
      `send:${m.id}`,
      async () =>
        unwrap(
          await apiBrowser().POST('/v1/commands/realestate.match.send', {
            body: { workspaceId, matchId: m.id },
          }),
        ),
      `Sent to ${who}. It’s with their homes now.`,
    );
  const skip = (m: Match) =>
    act(
      `skip:${m.id}`,
      async () =>
        unwrap(
          await apiBrowser().POST('/v1/commands/realestate.match.dismiss', {
            body: { workspaceId, matchId: m.id },
          }),
        ),
      `Skipped. ${who} never saw it.`,
    );
  const turn = (on: boolean) =>
    act(
      'search',
      async () =>
        unwrap(
          await apiBrowser().POST('/v1/commands/realestate.search.set', {
            body: { workspaceId, dealId, on },
          }),
        ),
      on ? `${who}’s search is on. New homes from the MLS come here.` : `${who}’s search is off.`,
    );
  const source = list.matches[0]?.mls.sourceWords;
  return (
    <div data-testid="realestate-matches">
      <DealCrumb
        workspaceId={workspaceId}
        dealId={dealId}
        dealName={dealName}
        middle={{ label: 'What they want', path: 'buyer' }}
        here="New matches"
      />
      <PageHeader
        title={`New matches for ${who}`}
        description={[dealName, source ? source.replace(/^From/, 'from') : 'from the MLS'].join(
          ' · ',
        )}
      />
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2" role="tablist" aria-label="Which matches">
            {TABS.map((t) => (
              <button
                key={t.key}
                type="button"
                role="tab"
                aria-selected={tab === t.key}
                onClick={() => setTab(t.key)}
                className={cn(
                  'inline-flex h-8 items-center rounded-full border px-3 text-[13px]',
                  tab === t.key
                    ? 'border-accent-soft bg-accent-soft text-accent-text'
                    : 'border-border-strong text-text-2 hover:bg-card-2',
                )}
                data-testid={`matches-tab-${t.key}`}
              >
                {t.label} · {counts[t.key]}
              </button>
            ))}
          </div>
          {tab === 'new' && counts.new ? (
            <p className="text-[13px] text-text-2">
              Only the team sees these until one is sent to {who}.
            </p>
          ) : null}
          {shown.length === 0 ? (
            <Card className="px-5 py-6 text-[13.5px] text-text-2">
              {tab === 'new'
                ? search.on
                  ? `Nothing new. ${who}’s search runs every time the MLS changes, and new homes come here.`
                  : `Nothing new. Turn on ${who}’s search and new homes from the MLS come here.`
                : tab === 'sent'
                  ? 'None sent yet.'
                  : 'None skipped.'}
            </Card>
          ) : (
            <ul className="space-y-3">
              {shown.map((m) => {
                const tag = tagOf(m);
                const price =
                  m.mls.status === 'sold' && m.mls.soldPriceCents !== null
                    ? `Sold for ${money(m.mls.soldPriceCents)}`
                    : m.mls.listPriceCents !== null
                      ? money(m.mls.listPriceCents)
                      : null;
                return (
                  <li key={m.id}>
                    <Card
                      className="flex flex-col gap-3.5 p-3.5 sm:flex-row"
                      data-testid={`match-${street(m.address)}`}
                    >
                      <MlsPhoto
                        url={m.mls.photos[0]?.url}
                        alt={m.mls.photos[0]?.caption ?? ''}
                        className="h-36 w-full flex-none rounded-control sm:h-28 sm:w-40"
                      />
                      <div className="min-w-0 flex-1 space-y-1.5">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-semibold">{street(m.address)}</span>
                          {m.state === 'new' ? (
                            <Badge variant={tag.variant}>{tag.words}</Badge>
                          ) : null}
                          <span className="text-[12.5px] text-text-3">
                            {m.mls.statusWords} · #{m.mls.mlsNumber}
                          </span>
                        </div>
                        <p className="text-[13.5px]">
                          {[price, roomsLine(m.mls.facts)].filter(Boolean).join(' · ')}
                        </p>
                        <FitList fit={m.fit} />
                        {m.mls.display.courtesy ? (
                          <p className="text-[11.5px] text-text-3">{m.mls.display.courtesy}</p>
                        ) : null}
                        {m.state === 'new' && live ? (
                          <div className="flex flex-wrap gap-2 pt-1">
                            <Button
                              size="sm"
                              loading={busy === `send:${m.id}`}
                              onClick={() => void send(m)}
                              data-testid="match-send"
                            >
                              Send to {who}
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              loading={busy === `skip:${m.id}`}
                              onClick={() => void skip(m)}
                              data-testid="match-skip"
                            >
                              Skip
                            </Button>
                          </div>
                        ) : m.state !== 'new' ? (
                          <p className="text-[12.5px] text-text-3">
                            {m.state === 'sent' ? 'Sent' : 'Skipped'}
                            {m.decidedBy ? ` by ${m.decidedBy.fullName}` : ''}
                            {m.decidedAt ? ` ${relativeTime(m.decidedAt)}` : ''}
                            {m.state === 'sent' && m.homeId ? (
                              <>
                                {' · '}
                                <Link
                                  href={dealHref(workspaceId, dealId, `homes?home=${m.homeId}`)}
                                  className="text-accent-text hover:underline"
                                >
                                  Open the home
                                </Link>
                              </>
                            ) : null}
                          </p>
                        ) : null}
                      </div>
                    </Card>
                  </li>
                );
              })}
            </ul>
          )}
          {notices.map((d, i) => (
            <MlsNotice
              key={i}
              notice={d.notice}
              courtesy={null}
              logoUrl={d.logoUrl}
              className="px-1"
            />
          ))}
        </div>
        <Card className="order-first p-4 md:p-5 lg:order-none" data-testid="buyer-search">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-[15px] font-semibold">{who}’s search</h2>
            <Link
              href={dealHref(workspaceId, dealId, 'buyer')}
              className="text-[13px] text-accent-text hover:underline"
            >
              Change
            </Link>
          </div>
          {!search.feedConnected ? (
            <Callout tone="warning" className="mt-3">
              No listing data is connected for this business, so the search can’t run. An owner can
              connect it in Deal settings → Connections.
            </Callout>
          ) : search.missing ? (
            <Callout tone="info" className="mt-3">
              {search.missing}
            </Callout>
          ) : null}
          {search.failure ? (
            <Callout tone="warning" className="mt-3">
              {search.failure}
            </Callout>
          ) : null}
          <dl className="mt-3 space-y-2 text-[13.5px]">
            <div>
              <dt className="text-[12px] font-semibold uppercase tracking-wide text-text-3">
                Asks for
              </dt>
              <dd>{search.words}</dd>
            </div>
            <div>
              <dt className="text-[12px] font-semibold uppercase tracking-wide text-text-3">
                Runs
              </dt>
              <dd>
                {search.on ? 'On every MLS update' : 'Off'}
                {search.checkedAt ? ` · last ${relativeTime(search.checkedAt)}` : ''}
              </dd>
            </div>
          </dl>
          {live ? (
            <div className="mt-4 flex items-center justify-between gap-3 border-t border-border pt-3 text-[13.5px]">
              <span>{search.on ? 'The search is on' : 'The search is off'}</span>
              <Switch
                checked={search.on}
                onChange={(on) => void turn(on)}
                label={`Run ${who}’s search`}
                disabled={
                  busy === 'search' || !search.feedConnected || (!search.on && !!search.missing)
                }
                testId="search-switch"
              />
            </div>
          ) : null}
          <p className="mt-4 text-[12.5px] text-text-3">
            From what {who} {clients.length > 1 ? 'want' : 'wants'}, confirmed by{' '}
            {agentName ? firstNames([agentName]) : 'the agent'}. It never looks at who lives
            somewhere.
          </p>
        </Card>
      </div>
    </div>
  );
}
