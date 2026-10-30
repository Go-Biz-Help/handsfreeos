'use client';
/**
 * Find people (docs/outreach.md, decision 128): every way Social Outreach finds new people, in one place. A card for
 * each way (`find-page.ts` in core) with what it found for the person in the last week and how many the AI's check
 * called a good fit (`outreach.finds.week`), and what's changed about it where it's kept: the groups on their own list
 * (`/find/groups`), the words searched in the playbook, the accounts like the business's here. Then Find posts on a
 * network the extension doesn't work on its own, and Facebook's download file (Old friends and chats). The network
 * picker narrows the cards to one network.
 */
import { askableOn } from '@hfos/core/addons/outreach/asks';
import {
  FIND_PAGE_WORDS as F,
  FIND_WAY_KEYS,
  FIND_WAYS,
  findWayCounts,
  findWayLine,
  type FindWay,
} from '@hfos/core/addons/outreach/find-page';
import { prospectsWords } from '@hfos/core/addons/outreach/group-checks';
import { findPostsWordsOn } from '@hfos/core/addons/outreach/network-words';
import {
  PLATFORMS,
  runsOnItsOwn,
  WORKING_PLATFORMS,
  type Platform,
} from '@hfos/core/addons/outreach/networks';
import {
  FIND_WORDS_PARTS,
  ownWordsOn,
  WORDS_PLATFORM_KEYS,
} from '@hfos/core/addons/outreach/playbooks';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { useLiveRefresh } from '@/lib/realtime/live-provider';
import { cn } from '@/lib/utils';
import { outreachHref } from './address';
import { AskButton } from './asks';
import { DownloadCard } from './download-card';
import { FileAsksCard } from './file-asks';
import { LikeYoursPart } from './like-yours';
import type { Asks, FindsWeek, Groups, PlaybookList } from './types';

/** A way's card: its name, the networks it's on, the week's line, what it is, and where it's changed. */
function WayCard({ way, line, children }: { way: FindWay; line: string; children?: ReactNode }) {
  const w = FIND_WAYS[way];
  return (
    <Card className="flex flex-col gap-1.5 p-4" data-testid={`find-way-${way}`}>
      <div className="flex flex-wrap items-center gap-1.5">
        <h3 className="mr-auto text-[15px] font-semibold">{w.title}</h3>
        {w.on.length < WORKING_PLATFORMS.length
          ? w.on.map((p) => (
              <Badge key={p} variant="gray">
                {PLATFORMS[p]}
              </Badge>
            ))
          : null}
      </div>
      <p className="text-[14px] font-medium tabular-nums" data-testid={`find-way-${way}-line`}>
        {line}
      </p>
      <p className="text-[12.5px] text-text-2">{w.about}</p>
      {children}
    </Card>
  );
}

const linkClass = 'mt-1 text-[13px] font-medium text-accent-text hover:underline';

export function FindView({
  workspaceId,
  week,
  groups,
  playbooks,
  asks,
  net,
}: {
  workspaceId: string;
  /** What each way found this week. */
  week: FindsWeek;
  /** The groups' counts and the people left in them: null when they couldn't be had. */
  groups: Groups | null;
  /** The playbooks, for the words searched: null when they couldn't be had. */
  playbooks: PlaybookList | null;
  asks: Asks;
  /** The network picked: null for every network. */
  net: Platform | null;
}) {
  // An ask's progress and end: Find posts' line and the file's steps follow it.
  useLiveRefresh(['outreach_ask'], 800);
  const counts = findWayCounts(week);
  const shownOn = (on: readonly Platform[]) => !net || on.includes(net);
  const ways = FIND_WAY_KEYS.filter((way) => shownOn(FIND_WAYS[way].on));
  // Each network's words from the playbooks in use: hashtags, LinkedIn's post searches, Alignable's kinds of business.
  const inUse = playbooks?.playbooks.filter((p) => !p.archivedAt) ?? [];
  const words = WORDS_PLATFORM_KEYS.filter((p) => !net || p === net).flatMap((platform) => {
    const all = [
      ...new Set(
        inUse.flatMap((p) => ownWordsOn(p.details, platform, FIND_WORDS_PARTS[platform]) ?? []),
      ),
    ];
    return all.length ? [{ platform, words: all }] : [];
  });
  const postsOn = (net ? [net] : WORKING_PLATFORMS).filter(
    (p) => askableOn(p, 'posts') && !runsOnItsOwn(p),
  );
  return (
    <div className="space-y-6" data-testid="outreach-find">
      <section aria-labelledby="find-week-title" className="space-y-3">
        <div>
          <h2 id="find-week-title" className="text-lg font-semibold tracking-tight">
            {F.week}
          </h2>
          <p className="text-[13px] text-text-2">{F.weekAbout}</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {ways.map((way) => (
            <WayCard key={way} way={way} line={findWayLine(way, counts[way])}>
              {way === 'groups' ? (
                <>
                  {groups ? (
                    <p className="text-[12.5px] text-text-2" data-testid="find-groups-left">
                      {`${groups.counts.work.toLocaleString()} to work. `}
                      {prospectsWords(groups.prospects, groups.joinsOnItsOwn)}
                    </p>
                  ) : null}
                  <Link
                    href={outreachHref(workspaceId, { view: 'groups' })}
                    className={linkClass}
                    data-testid="find-open-groups"
                  >
                    {F.openGroups}
                  </Link>
                </>
              ) : way === 'searches' ? (
                <>
                  {words.length ? (
                    <ul className="grid gap-1 text-[12.5px]" data-testid="find-words">
                      {words.map((w) => (
                        <li key={w.platform}>
                          <span className="font-medium">{PLATFORMS[w.platform]}:</span>{' '}
                          <span className="text-text-2">
                            {w.words
                              .map((x) => (w.platform === 'instagram' ? `#${x}` : `“${x}”`))
                              .join(', ')}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-[12.5px] text-text-3">{F.wordsNone}</p>
                  )}
                  <Link
                    href={outreachHref(workspaceId, { view: 'playbooks' })}
                    className={linkClass}
                  >
                    {F.editWords}
                  </Link>
                </>
              ) : way === 'partners' ? (
                <Link
                  href={outreachHref(workspaceId, { view: 'partners' })}
                  className={linkClass}
                  data-testid="find-see-partners"
                >
                  {F.seePartners}
                </Link>
              ) : null}
            </WayCard>
          ))}
        </div>
      </section>

      {shownOn(['instagram']) ? (
        <div data-testid="find-like-yours">
          <LikeYoursPart workspaceId={workspaceId} />
        </div>
      ) : null}

      {postsOn.length ? (
        <section aria-labelledby="find-posts-title" className="space-y-3">
          <h2 id="find-posts-title" className="text-lg font-semibold tracking-tight">
            {F.postsTitle}
          </h2>
          <div className={cn('grid gap-3', postsOn.length > 1 && 'sm:grid-cols-2')}>
            {postsOn.map((platform) => (
              <FindPostsCard
                key={platform}
                workspaceId={workspaceId}
                platform={platform}
                asks={asks}
              />
            ))}
          </div>
        </section>
      ) : null}

      {/* Facebook's download file is Facebook's alone yet: shown where it can be asked for. */}
      {shownOn(['facebook']) && askableOn('facebook', 'file_in') ? (
        <section aria-labelledby="find-file-title" className="space-y-3">
          <div>
            <h2 id="find-file-title" className="text-lg font-semibold tracking-tight">
              {F.fileTitle}
            </h2>
            <p className="text-[13px] text-text-2">{F.fileAbout}</p>
          </div>
          <div className="grid gap-3 lg:grid-cols-2">
            <FileAsksCard workspaceId={workspaceId} asks={asks} />
            <DownloadCard workspaceId={workspaceId} download={week.download} />
          </div>
        </section>
      ) : null}
    </div>
  );
}

/**
 * Find posts, on a network the extension doesn't work on its own: the person asks for it here, and the good ones come
 * onto Today's list. Where a runner works the network (Alignable's), it reads the town's posts once a day itself, so
 * the card doesn't show.
 */
function FindPostsCard({
  workspaceId,
  platform,
  asks,
}: {
  workspaceId: string;
  platform: Platform;
  asks: Asks;
}) {
  const words = findPostsWordsOn(platform);
  return (
    <Card className="p-5" data-testid="find-posts">
      <h3 className="text-[15px] font-semibold">{words.title}</h3>
      <p className="mt-1 text-[13px] text-text-2">{words.body}</p>
      <div className="mt-3">
        <AskButton
          workspaceId={workspaceId}
          asks={asks}
          ask={{ kind: 'posts' }}
          platform={platform}
          label={words.title}
          testId="find-posts-ask"
        />
      </div>
    </Card>
  );
}
