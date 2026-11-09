'use client';
/**
 * Creators (docs/socialcontent.md): what the reading computer is doing (./activity-card.tsx), the niches searched,
 * then the creators found, studied and skipped. Anyone on the team picks niches and creators (one list for the whole
 * business, decision 12): **Suggest niches** has the AI find the business's own niche (what it sells, never its
 * customers' trade) and 3 to 5 like it, **Find creators now** asks the reading computer to search the ticked ones, and
 * **Add a creator** studies someone from a link. A studied creator's posts open under them, each with how many times
 * the posts around it it did.
 */
import { CONTENT_NETWORK_INFO, networkName } from '@hfos/core/addons/socialcontent/networks';
import { DONE_WELL } from '@hfos/core/addons/socialcontent/standouts';
import { SOCIALCONTENT_WORDS as W, daysAgo } from '@hfos/core/addons/socialcontent/words';
import { Check, Sparkles, X } from 'lucide-react';
import { useState } from 'react';
import { PageHeader } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button, ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { workerPost } from '@/lib/api/worker';
import { useLiveRefresh } from '@/lib/realtime/live-provider';
import { cn } from '@/lib/utils';
import { ActivityCard } from './activity-card';
import { PostCard } from './post-card';
import type { Creator, Niche, Overview, Post } from './types';
import { useAct } from './use-act';

type Tab = 'suggested' | 'studying' | 'skipped';

export function CreatorsPage({
  workspaceId,
  overview,
  niches,
  creators,
}: {
  workspaceId: string;
  overview: Overview;
  niches: readonly Niche[];
  creators: readonly Creator[];
}) {
  useLiveRefresh(['socialcontent_creator', 'socialcontent_niche', 'socialcontent_work']);
  const { busy, act } = useAct();
  const [tab, setTab] = useState<Tab>(
    creators.some((c) => c.state === 'suggested') ? 'suggested' : 'studying',
  );
  const [link, setLink] = useState('');
  const api = apiBrowser();
  const by = (s: Tab) => creators.filter((c) => c.state === s);
  const shown = by(tab);
  const settingsHref = `/app/w/${workspaceId}/a/socialcontent/settings`;

  const findNow = () =>
    act(
      'find',
      () => api.POST('/v1/commands/socialcontent.find.now', { body: { workspaceId } }).then(unwrap),
      (out) => W.creators.finding(out.networks.map(networkName).join(', '), out.niches),
    );
  const add = async () => {
    const out = await act(
      'add',
      () =>
        api
          .POST('/v1/commands/socialcontent.creator.add', { body: { workspaceId, link } })
          .then(unwrap),
      (c) => W.creators.added(c.shown),
    );
    if (out) {
      setLink('');
      setTab('studying');
    }
  };

  return (
    <div data-testid="socialcontent-creators" className="space-y-5">
      <PageHeader
        title={W.creators.title}
        description={W.creators.intro}
        actions={
          <Button
            onClick={() => void findNow()}
            loading={busy === 'find'}
            data-testid="socialcontent-find"
          >
            {W.creators.find}
          </Button>
        }
      />
      {!overview.settings.readerUserId ? (
        <Card className="flex flex-wrap items-center gap-3 border-warning-soft bg-warning-soft/40 p-4 text-[13.5px]">
          <span className="min-w-0 flex-1">{W.needsReader}</span>
          {overview.mayManage ? (
            <ButtonLink href={settingsHref} size="sm">
              {W.settings.title}
            </ButtonLink>
          ) : null}
        </Card>
      ) : null}
      <ActivityCard overview={overview} />
      <NichesCard workspaceId={workspaceId} niches={niches} />
      <Card className="p-4 md:p-5">
        <h2 className="text-[15px] font-semibold">{W.creators.add}</h2>
        <form
          className="mt-3 flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (link.trim()) void add();
          }}
        >
          <Input
            value={link}
            onChange={(e) => setLink(e.target.value)}
            placeholder={W.creators.addPlaceholder}
            aria-label={W.creators.addPlaceholder}
            className="min-w-[220px] flex-1"
            data-testid="socialcontent-add-link"
          />
          <Button
            type="submit"
            variant="secondary"
            loading={busy === 'add'}
            disabled={!link.trim()}
          >
            {W.creators.add}
          </Button>
        </form>
      </Card>
      <div>
        <Segmented<Tab>
          value={tab}
          onChange={setTab}
          ariaLabel={W.creators.title}
          options={(['suggested', 'studying', 'skipped'] as const).map((t) => ({
            value: t,
            label: `${W.creators.tabs[t]} (${by(t).length})`,
            testId: `socialcontent-tab-${t}`,
          }))}
        />
        <div className="mt-3 space-y-3">
          {shown.length === 0 ? (
            <Card>
              <EmptyState title={W.creators.tabs[tab]} className="py-8">
                {tab === 'suggested'
                  ? W.creators.noneSuggested
                  : tab === 'studying'
                    ? W.creators.noneStudying
                    : W.creators.noneSkipped}
              </EmptyState>
            </Card>
          ) : (
            shown.map((c) => (
              <CreatorRow key={c.id} workspaceId={workspaceId} creator={c} busy={busy} act={act} />
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function NichesCard({ workspaceId, niches }: { workspaceId: string; niches: readonly Niche[] }) {
  const { busy, act } = useAct();
  const [name, setName] = useState('');
  const api = apiBrowser();
  const own = niches.filter((n) => n.own);
  const similar = niches.filter((n) => !n.own);
  const suggest = () =>
    act(
      'suggest',
      () =>
        workerPost<{ added: number }>(
          '/v1/addons/socialcontent/actions/socialcontent.niches.suggest',
          { workspaceId, input: {} },
        ),
      (out) => W.niches.suggested(out.added),
    );
  const add = async () => {
    const out = await act(
      'add',
      () =>
        api
          .POST('/v1/commands/socialcontent.niche.add', { body: { workspaceId, name } })
          .then(unwrap),
      (n) => W.niches.added(n.name),
    );
    if (out) setName('');
  };
  const decide = (n: Niche, state: 'picked' | 'skipped') =>
    act(`niche:${n.id}`, () =>
      api
        .POST('/v1/commands/socialcontent.niche.decide', {
          body: { workspaceId, nicheId: n.id, state },
        })
        .then(unwrap),
    );
  const row = (n: Niche) => (
    <li
      key={n.id}
      className="flex flex-wrap items-center gap-2 border-b border-border py-2.5 last:border-b-0"
      data-testid={`socialcontent-niche-${n.name}`}
    >
      <div className="min-w-0 flex-1">
        <div
          className={cn(
            'text-[14px] font-medium',
            n.state === 'skipped' && 'text-text-3 line-through',
          )}
        >
          {n.name}
        </div>
        {n.why ? <div className="text-[12.5px] text-text-3">{n.why}</div> : null}
      </div>
      {n.state === 'picked' ? (
        <Badge variant="ok">{W.niches.picked}</Badge>
      ) : n.state === 'skipped' ? (
        <Badge>{W.niches.skipped}</Badge>
      ) : null}
      {n.state !== 'picked' ? (
        <Button
          size="sm"
          variant="secondary"
          loading={busy === `niche:${n.id}`}
          onClick={() => void decide(n, 'picked')}
        >
          <Check className="h-3.5 w-3.5" aria-hidden /> {W.niches.pick}
        </Button>
      ) : null}
      {n.state !== 'skipped' ? (
        <Button
          size="sm"
          variant="ghost"
          loading={busy === `niche:${n.id}`}
          onClick={() => void decide(n, 'skipped')}
        >
          <X className="h-3.5 w-3.5" aria-hidden /> {W.niches.skip}
        </Button>
      ) : null}
    </li>
  );
  return (
    <Card className="p-4 md:p-5" data-testid="socialcontent-niches">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-[15px] font-semibold">{W.niches.title}</h2>
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto"
          loading={busy === 'suggest'}
          onClick={() => void suggest()}
          data-testid="socialcontent-suggest-niches"
        >
          <Sparkles className="h-3.5 w-3.5" aria-hidden />
          {busy === 'suggest' ? W.niches.suggesting : W.niches.suggest}
        </Button>
      </div>
      <p className="mt-1 text-[13px] text-text-2">{W.niches.intro}</p>
      {niches.length === 0 ? (
        <p className="mt-3 text-[13.5px] text-text-2">{W.niches.none}</p>
      ) : (
        <div className="mt-2 space-y-3">
          {own.length ? (
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-text-3">
                {W.niches.own}
              </div>
              <ul>{own.map(row)}</ul>
            </div>
          ) : null}
          {similar.length ? (
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-text-3">
                {W.niches.similar}
              </div>
              <ul>{similar.map(row)}</ul>
            </div>
          ) : null}
        </div>
      )}
      <form
        className="mt-3 flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) void add();
        }}
      >
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={W.niches.addPlaceholder}
          aria-label={W.niches.add}
          maxLength={80}
          className="min-w-[200px] flex-1"
          data-testid="socialcontent-add-niche"
        />
        <Button type="submit" variant="secondary" loading={busy === 'add'} disabled={!name.trim()}>
          {W.niches.add}
        </Button>
      </form>
    </Card>
  );
}

function CreatorRow({
  workspaceId,
  creator: c,
  busy,
  act,
}: {
  workspaceId: string;
  creator: Creator;
  busy: string | null;
  act: ReturnType<typeof useAct>['act'];
}) {
  const api = apiBrowser();
  const [posts, setPosts] = useState<readonly Post[] | null>(null);
  const [open, setOpen] = useState(false);
  const decide = (study: boolean) =>
    act(`creator:${c.id}`, () =>
      api
        .POST('/v1/commands/socialcontent.creator.decide', {
          body: { workspaceId, creatorId: c.id, study },
        })
        .then(unwrap),
    );
  const readAgain = () =>
    act(
      `read:${c.id}`,
      () =>
        api
          .POST('/v1/commands/socialcontent.read.now', { body: { workspaceId, creatorId: c.id } })
          .then(unwrap),
      () => W.creators.readingAgain(c.shown),
    );
  const toggle = async () => {
    if (open) return setOpen(false);
    setOpen(true);
    const got = await act(`posts:${c.id}`, () =>
      api
        .POST('/v1/queries/socialcontent.post.list', {
          body: { workspaceId, creatorId: c.id, limit: 200 },
        })
        .then(unwrap),
    );
    setPosts(got?.posts ?? []);
  };
  const facts = [
    networkName(c.network),
    c.followers !== null ? W.creators.followers(c.followers) : null,
    c.lastPostAt ? W.creators.posted(daysAgo(c.lastPostAt) ?? '') : null,
    c.nicheName,
  ].filter(Boolean);
  const read =
    c.state === 'studying'
      ? [
          c.postsReadAt
            ? `${W.creators.postsRead(c.postsCount)} · ${W.creators.standouts(c.standoutsCount)} · ${W.creators.readWhen(daysAgo(c.postsReadAt) ?? '')}`
            : W.creators.notRead,
        ]
      : [];
  return (
    <Card className="p-4" data-testid={`socialcontent-creator-${c.handle}`}>
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <a
              href={c.link}
              target="_blank"
              rel="noreferrer"
              className="text-[14.5px] font-semibold hover:underline"
            >
              {c.name ?? c.shown}
            </a>
            {c.name ? <span className="text-[13px] text-text-3">{c.shown}</span> : null}
            {c.reading ? <Badge variant="pending">{W.creators.reading}</Badge> : null}
          </div>
          <div className="text-[12.5px] text-text-3">{facts.join(' · ')}</div>
          {c.state === 'suggested' && c.why ? (
            <div className="mt-1 text-[13px] text-text-2">{c.why}</div>
          ) : null}
          {read.map((r) => (
            <div key={r} className="mt-1 text-[13px] text-text-2">
              {r}
            </div>
          ))}
          {c.foundBy === 'person' &&
          c.followers !== null &&
          c.followers < DONE_WELL.followersAtLeast ? (
            <div className="mt-1 text-[12.5px] text-text-3">{W.creators.smaller}</div>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2">
          {c.state === 'suggested' ? (
            <>
              <Button
                size="sm"
                loading={busy === `creator:${c.id}`}
                onClick={() => void decide(true)}
              >
                {W.creators.study}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void decide(false)}>
                {W.creators.skip}
              </Button>
            </>
          ) : c.state === 'studying' ? (
            <>
              <Button size="sm" variant="secondary" onClick={() => void toggle()}>
                {open ? W.creators.hidePosts : W.creators.seePosts}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                loading={busy === `read:${c.id}`}
                disabled={c.reading || !CONTENT_NETWORK_INFO[c.network].ready}
                onClick={() => void readAgain()}
              >
                {W.creators.readAgain}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void decide(false)}>
                {W.creators.stop}
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              variant="secondary"
              loading={busy === `creator:${c.id}`}
              onClick={() => void decide(true)}
            >
              {W.creators.studyAgain}
            </Button>
          )}
        </div>
      </div>
      {open ? (
        <div className="mt-3 space-y-2" data-testid={`socialcontent-posts-${c.handle}`}>
          <div className="text-xs font-semibold uppercase tracking-wide text-text-3">
            {W.creators.posts.title}
          </div>
          {posts === null ? (
            <p className="text-[13px] text-text-3">…</p>
          ) : posts.length === 0 ? (
            <p className="text-[13px] text-text-2">{W.creators.posts.none}</p>
          ) : (
            posts.map((p) => <PostCard key={p.id} post={p} showCreator={false} />)
          )}
        </div>
      ) : null}
    </Card>
  );
}
