'use client';
/**
 * Social Outreach's Pipeline tab (docs/outreach.md, decision 47): everyone the person reached on Facebook, by where
 * they stand, worked out from what HandsFreeOS knows (packages/core/src/addons/outreach/stages.ts): found, warming up,
 * friends, talking, ready to pitch, pitched, booked, or not a fit. "All in play" lists who to act on first; each
 * stage has its count. The person marks someone ready to pitch (Today then offers Pitch), pitched, not a fit (nothing
 * on Today reaches them again but a reply) or back in play when they know better (`outreach.stage.mark`). Which stage,
 * a name searched for and the page are in the address (./address.ts).
 */
import {
  marksFor,
  markedWords,
  STAGE_MARKS,
  STAGE_VIEW_KEYS,
  STAGE_VIEWS,
  STAGE_WORDS,
  STAGES,
  STAGES_PAGE,
  type Stage,
  type StageMark,
  type StageView,
} from '@hfos/core/addons/outreach/stages';
import { messengerChatUrl } from '@hfos/core/addons/outreach/waiting-words';
import { OUTREACH_WORDS as W } from '@hfos/core/addons/outreach/words';
import { useRouter } from 'next/navigation';
import { useRef, useTransition } from 'react';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Segmented } from '@/components/ui/segmented';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { cn, relativeTime } from '@/lib/utils';
import { outreachHref } from './address';
import { Pager, SearchBox } from './friends-view';
import { PersonMenu } from './person-menu';
import type { Pipeline, PipelinePerson } from './types';
import { useAct } from './use-act';

/** Each stage's badge colour. */
export const STAGE_TONE: Record<Stage, BadgeVariant> = {
  found: 'gray',
  warming: 'gray',
  friends: 'member',
  talking: 'accent',
  ready: 'pending',
  pitched: 'accent',
  booked: 'ok',
  lost: 'danger',
};

export function PipelineView({
  workspaceId,
  pipeline,
  show,
  search,
}: {
  workspaceId: string;
  pipeline: Pipeline;
  show: StageView;
  search: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const asked = useRef({ show, search });
  const go = (to: { show?: StageView; search?: string; page?: number }) => {
    asked.current = {
      show: to.show ?? asked.current.show,
      search: to.search ?? asked.current.search,
    };
    const href = outreachHref(workspaceId, {
      view: 'pipeline',
      stages: asked.current.show,
      search: asked.current.search,
      page: to.page ?? 1,
    });
    startTransition(() => router.replace(href, { scroll: false }));
  };
  const { busy, act } = useAct();
  const mark = (p: PipelinePerson, m: StageMark) =>
    act(
      `${p.profileId}:${m}`,
      async () =>
        unwrap(
          await apiBrowser().POST('/v1/commands/outreach.stage.mark', {
            body: { workspaceId, profileId: p.profileId, mark: m },
          }),
        ),
      markedWords(p.name, m),
    );
  const first = (pipeline.page - 1) * STAGES_PAGE + 1;
  return (
    <div data-testid="outreach-pipeline">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="max-w-full overflow-x-auto">
          <Segmented
            ariaLabel="Which stage"
            value={show}
            onChange={(v) => go({ show: v })}
            options={STAGE_VIEW_KEYS.map((k) => ({
              value: k,
              label: (
                <>
                  {STAGE_VIEWS[k]}
                  <span className="tabular-nums text-text-3">
                    {pipeline.counts[k].toLocaleString()}
                  </span>
                </>
              ),
              testId: `pipeline-show-${k}`,
            }))}
          />
        </div>
        <SearchBox search={search} onSearch={(s) => go({ search: s })} />
      </div>
      <div
        className={cn('transition-opacity', pending && 'opacity-60')}
        aria-busy={pending || undefined}
      >
        {pipeline.people.length ? (
          <Card className="p-0" data-testid="pipeline-list">
            <div className="flex items-baseline justify-between gap-3 px-5 pt-4">
              <h3 className="text-[15px] font-semibold">{STAGE_VIEWS[show]}</h3>
              <span className="text-[12.5px] text-text-3">
                {pipeline.pages > 1
                  ? `${first.toLocaleString()}–${(first + pipeline.people.length - 1).toLocaleString()} of ${pipeline.total.toLocaleString()}`
                  : null}
              </span>
            </div>
            <p className="px-5 pt-1 text-[12.5px] text-text-3">
              {show === 'lost' ? STAGE_WORDS.lostNote : STAGE_WORDS.about}
            </p>
            <ul className="mt-2">
              {pipeline.people.map((p) => (
                <li
                  key={p.profileId}
                  className="border-t border-border px-5 py-3"
                  data-testid="pipeline-person"
                >
                  <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                    <div className="min-w-0 text-[13.5px]">
                      <a
                        href={messengerChatUrl(p.threadKey) ?? p.url}
                        target="_blank"
                        rel="noreferrer"
                        className="font-medium text-accent-text hover:underline"
                      >
                        {p.name}
                      </a>
                      {p.why.length ? (
                        <div className="text-[12.5px] text-text-3" data-testid="pipeline-why">
                          {p.why.join(' · ')}
                        </div>
                      ) : null}
                    </div>
                    <span className="flex items-center gap-1.5">
                      <Badge variant={STAGE_TONE[p.stage]} data-testid="pipeline-stage">
                        {STAGES[p.stage]}
                      </Badge>
                      <PersonMenu workspaceId={workspaceId} who={p} />
                    </span>
                  </div>
                  {p.nextStep ? (
                    <p className="mt-1 text-[12.5px] text-text-2">
                      {W.nextStepLabel}: {p.nextStep}
                    </p>
                  ) : null}
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    {marksFor(p.stage).map((m) => (
                      <Button
                        key={m}
                        variant="ghost"
                        size="sm"
                        disabled={busy !== null}
                        onClick={() => void mark(p, m)}
                        data-testid={`pipeline-mark-${m}`}
                      >
                        {STAGE_MARKS[m]}
                      </Button>
                    ))}
                    {p.lastAt ? (
                      <span className="text-[12px] text-text-3">
                        Latest {relativeTime(p.lastAt)}
                      </span>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
            {pipeline.pages > 1 ? (
              <Pager page={pipeline.page} pages={pipeline.pages} onPage={(page) => go({ page })} />
            ) : null}
          </Card>
        ) : (
          <Card data-testid="pipeline-empty">
            {search ? (
              <EmptyState title={`Nobody called “${search}” here`}>
                Check the spelling, or look in another stage.
              </EmptyState>
            ) : (
              <EmptyState title={STAGE_WORDS.empty.title}>{STAGE_WORDS.empty.body}</EmptyState>
            )}
          </Card>
        )}
      </div>
    </div>
  );
}
