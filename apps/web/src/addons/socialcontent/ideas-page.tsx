'use client';
/**
 * Ideas (docs/socialcontent.md, part 3): posts the AI suggests the business makes, from the Playbook and what
 * HandsFreeOS knows about the business, each with its hook, format, network, an outline, why it should work and the
 * standouts it's based on. New ones come on their own when the Playbook is written; **Get ideas** asks for more.
 * Anyone on the team saves one, marks it used once posted, or skips it, and can put it back to new.
 */
import { networkName } from '@hfos/core/addons/socialcontent/networks';
import { SOCIALCONTENT_WORDS as W, daysAgo } from '@hfos/core/addons/socialcontent/words';
import { Lightbulb, PenLine } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { PageHeader } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Segmented } from '@/components/ui/segmented';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { workerPost } from '@/lib/api/worker';
import { useLiveRefresh } from '@/lib/realtime/live-provider';
import { StandoutLinks } from './standout-links';
import type { Idea, StandoutRef } from './types';
import { useAct } from './use-act';

type State = Idea['state'];
const STATES: readonly State[] = ['new', 'saved', 'used', 'skipped'];
const NONE: Record<State, string> = {
  new: W.ideas.noneNew,
  saved: W.ideas.noneSaved,
  used: W.ideas.noneUsed,
  skipped: W.ideas.noneSkipped,
};

export function IdeasPage({
  workspaceId,
  ideas,
  examples,
  hasPlaybook,
}: {
  workspaceId: string;
  ideas: readonly Idea[];
  examples: readonly StandoutRef[];
  hasPlaybook: boolean;
}) {
  useLiveRefresh(['socialcontent_idea', 'socialcontent_playbook']);
  const { busy, act } = useAct();
  const [tab, setTab] = useState<State>(
    ideas.some((i) => i.state === 'new') || !ideas.some((i) => i.state === 'saved')
      ? 'new'
      : 'saved',
  );
  const api = apiBrowser();
  const byId = new Map(examples.map((e) => [e.id, e]));
  const shown = ideas.filter((i) => i.state === tab);
  const countOf = (s: State) => ideas.filter((i) => i.state === s).length;

  const get = () =>
    act(
      'get',
      () =>
        workerPost<{ added: number }>(
          '/v1/addons/socialcontent/actions/socialcontent.ideas.suggest',
          { workspaceId, input: {} },
        ),
      (out) => W.ideas.got(out.added),
    );
  const router = useRouter();
  const write = (i: Idea) =>
    act(
      `${i.id}:write`,
      () =>
        workerPost<{ postId: string }>(
          '/v1/addons/socialcontent/actions/socialcontent.content.write',
          { workspaceId, input: { ideaId: i.id } },
        ),
      W.calendar.written,
    ).then((out) => {
      if (out?.postId)
        router.push(`/app/w/${workspaceId}/a/socialcontent/calendar?post=${out.postId}`);
    });
  const decide = (i: Idea, state: State) =>
    act(
      `${i.id}:${state}`,
      () =>
        api
          .POST('/v1/commands/socialcontent.idea.decide', {
            body: { workspaceId, ideaId: i.id, state },
          })
          .then(unwrap),
      W.ideas.decided,
    );

  return (
    <div data-testid="socialcontent-ideas" className="space-y-5">
      <PageHeader
        title={W.ideas.title}
        description={W.ideas.intro}
        actions={
          hasPlaybook ? (
            <Button
              loading={busy === 'get'}
              onClick={() => void get()}
              data-testid="socialcontent-ideas-get"
            >
              <Lightbulb className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
              {busy === 'get' ? W.ideas.getting : W.ideas.get}
            </Button>
          ) : null
        }
      />
      {!ideas.length ? (
        <Card>
          <EmptyState title={W.ideas.title} className="py-10">
            {hasPlaybook ? W.ideas.none : W.ideas.needsPlaybook}
          </EmptyState>
        </Card>
      ) : (
        <>
          <Segmented
            value={tab}
            onChange={setTab}
            options={STATES.map((s) => ({
              value: s,
              label: `${W.ideas.tabs[s]} (${countOf(s)})`,
              testId: `socialcontent-ideas-tab-${s}`,
            }))}
          />
          {shown.length === 0 ? (
            <p className="text-[13.5px] text-text-2">{NONE[tab]}</p>
          ) : (
            <div className="space-y-3">
              {shown.map((i) => (
                <IdeaCard
                  key={i.id}
                  idea={i}
                  examples={byId}
                  busy={busy}
                  onDecide={(state) => void decide(i, state)}
                  onWrite={() => void write(i)}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function IdeaCard({
  idea: i,
  examples,
  busy,
  onDecide,
  onWrite,
}: {
  idea: Idea;
  examples: ReadonlyMap<string, StandoutRef>;
  busy: string | null;
  onDecide: (state: State) => void;
  onWrite: () => void;
}) {
  const writeIt =
    i.state === 'new' || i.state === 'saved' ? (
      <Button
        size="sm"
        variant="secondary"
        loading={busy === `${i.id}:write`}
        disabled={busy !== null && busy !== `${i.id}:write`}
        onClick={onWrite}
        data-testid="socialcontent-idea-write"
      >
        <PenLine className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
        {busy === `${i.id}:write` ? W.calendar.writing : W.ideas.write}
      </Button>
    ) : null;
  const button = (state: State, label: string, variant: 'primary' | 'secondary' | 'ghost') => (
    <Button
      size="sm"
      variant={variant}
      loading={busy === `${i.id}:${state}`}
      disabled={busy !== null && busy !== `${i.id}:${state}`}
      onClick={() => onDecide(state)}
      data-testid={`socialcontent-idea-${state}`}
    >
      {label}
    </Button>
  );
  return (
    <Card className="p-4 md:p-5" data-testid={`socialcontent-idea-${i.id}`}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-text-3">
        {i.network ? <span>{networkName(i.network)}</span> : null}
        {i.format ? <Badge>{i.format}</Badge> : null}
        <span>{daysAgo(i.createdAt)}</span>
      </div>
      <h2 className="mt-1.5 text-[15px] font-semibold text-text">{i.title}</h2>
      {i.hook ? (
        <p className="mt-1.5 text-[13.5px] text-text">
          <span className="text-text-3">{W.ideas.hook}: </span>“{i.hook}”
        </p>
      ) : null}
      {i.outline ? (
        <div className="mt-2">
          <div className="text-[12.5px] text-text-3">{W.ideas.outline}</div>
          <p className="mt-0.5 whitespace-pre-line text-[13.5px] text-text">{i.outline}</p>
        </div>
      ) : null}
      {i.why ? (
        <p className="mt-2 text-[13px] text-text-2">
          <span className="text-text-3">{W.ideas.why}: </span>
          {i.why}
        </p>
      ) : null}
      <StandoutLinks
        label={W.ideas.basedOn(i.basedOn.length)}
        ids={i.basedOn}
        examples={examples}
      />
      <div className="mt-3 flex flex-wrap gap-2">
        {writeIt}
        {i.state === 'new' ? (
          <>
            {button('saved', W.ideas.save, 'primary')}
            {button('used', W.ideas.use, 'secondary')}
            {button('skipped', W.ideas.skip, 'ghost')}
          </>
        ) : i.state === 'saved' ? (
          <>
            {button('used', W.ideas.use, 'primary')}
            {button('skipped', W.ideas.skip, 'ghost')}
          </>
        ) : (
          button('new', W.ideas.again, 'ghost')
        )}
      </div>
    </Card>
  );
}
