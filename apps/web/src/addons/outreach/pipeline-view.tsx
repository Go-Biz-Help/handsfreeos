'use client';
/**
 * The People tab's Pipeline (docs/outreach.md, decisions 47 and 59): everyone the person reached on Facebook, by where
 * they stand, worked out from what HandsFreeOS knows (packages/core/src/addons/outreach/stages.ts): found, warming up,
 * friends, talking, ready to pitch, pitched, booked, a client (decision 91), or not a fit. "All in play" is a board, a
 * column for each stage the person acts on, side by side; found and warming up are the extension's own work, so
 * they're counted above it, with links to the clients and Not a fit. One stage, or a name searched for, is a list with
 * its count. The person marks someone ready to pitch (Today then offers Pitch), pitched, not a fit (nothing on Today
 * reaches them again but a reply) or back in play when they know better (`outreach.stage.mark`), from the person menu
 * on their name (./person-menu.tsx), which also has Mark as client; the icon beside the name opens their chat or page.
 * Which stage, a name searched for and the page are in the address (./address.ts). Every network's people, each row
 * naming its network, or one network's (`?net=`).
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
import { chatUrlOn, openChatWords, openPageWords } from '@hfos/core/addons/outreach/network-words';
import type { Platform } from '@hfos/core/addons/outreach/networks';
import { OUTREACH_WORDS as W } from '@hfos/core/addons/outreach/words';
import { ExternalLink } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRef, useTransition } from 'react';
import { useLiveRefresh } from '@/lib/realtime/live-provider';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Segmented } from '@/components/ui/segmented';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { cn, relativeTime } from '@/lib/utils';
import { outreachHref } from './address';
import { BOARD_STAGES, type Board } from './board';
import { Pager, SearchBox } from './friends-view';
import { NetworkFilterControl, NetworkName } from './network-ui';
import { PersonName, type MenuMove, type MenuPerson } from './person-menu';
import { ResearchSlot } from './research';
import type { Asks, Pipeline, PipelinePerson } from './types';
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
  client: 'ok',
  lost: 'danger',
};

/** The AI's answer for Research's slot: a fit's why is the row's already. */
const researchCheck = (p: PipelinePerson) =>
  p.check && { ...p.check, why: p.check.verdict === 'not' ? p.check.why : [] };

/** How many people a column shows before "See all". */
const COLUMN_MOST = 8;

/** Who a row's person menu is for: their page, their chat, and what the list knows of Contacts and demos. */
const menuPerson = (p: PipelinePerson): MenuPerson => ({
  profileId: p.profileId,
  name: p.name,
  platform: p.platform,
  url: p.url,
  threadKey: p.threadKey,
  personId: p.personId,
  demoBooked: p.demoBooked,
});

/** The stages someone can be moved to from their menu: none for a client or someone booked. */
const movesFor = (p: PipelinePerson, onMark: (m: StageMark) => void): MenuMove[] =>
  marksFor(p.stage).map((m) => ({
    key: m,
    label: STAGE_MARKS[m],
    onSelect: () => onMark(m),
    danger: m === 'lost',
  }));

/** Beside the name, which opens the person menu: their chat on its network, else their page. */
function OpenIcon({ person: p }: { person: PipelinePerson }) {
  const chat = chatUrlOn(p.platform, p.threadKey);
  const words = chat ? openChatWords(p.platform) : openPageWords(p.platform);
  return (
    <a
      href={chat ?? p.url}
      target="_blank"
      rel="noreferrer"
      aria-label={words}
      title={words}
      className="inline-flex h-6 w-6 flex-none items-center justify-center rounded-[4px] text-text-3 hover:bg-card-3 hover:text-text focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring"
      data-testid="pipeline-open"
    >
      <ExternalLink className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden />
    </a>
  );
}

export function PipelineView({
  workspaceId,
  pipeline,
  board = null,
  show,
  search,
  net = null,
  asks = null,
}: {
  workspaceId: string;
  pipeline: Pipeline;
  /** The network it's narrowed to: null for every network. */
  net?: Platform | null;
  /** What the person asked their computer here: Research's asks. Null when they couldn't be had. */
  asks?: Asks | null;
  /** Everyone in play by stage: shown in place of the list. */
  board?: Board | null;
  show: StageView;
  search: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  // A Research ask's progress and end.
  useLiveRefresh(['outreach_ask'], 800);
  const asked = useRef({ show, search, net });
  const go = (to: { show?: StageView; search?: string; page?: number; net?: Platform | null }) => {
    asked.current = {
      show: to.show ?? asked.current.show,
      search: to.search ?? asked.current.search,
      net: to.net === undefined ? asked.current.net : to.net,
    };
    const href = outreachHref(workspaceId, {
      view: 'pipeline',
      stages: asked.current.show,
      search: asked.current.search,
      page: to.page ?? 1,
      net: asked.current.net,
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
        <NetworkFilterControl value={net} onChange={(n) => go({ net: n })} />
        <SearchBox search={search} onSearch={(s) => go({ search: s })} />
      </div>
      <div
        className={cn('transition-opacity', pending && 'opacity-60')}
        aria-busy={pending || undefined}
      >
        {board && pipeline.counts.all ? (
          <BoardView
            workspaceId={workspaceId}
            net={net}
            board={board}
            counts={pipeline.counts}
            asks={asks}
            busy={busy !== null}
            onMark={(p, m) => void mark(p, m)}
          />
        ) : pipeline.people.length ? (
          <Card className="p-0" data-testid="pipeline-list">
            <div className="flex items-baseline justify-between gap-3 px-5 pt-4">
              <h3 className="text-[15px] font-semibold">{STAGE_VIEWS[show]}</h3>
              <span className="text-[12.5px] text-text-3">
                {pipeline.pages > 1
                  ? `${first.toLocaleString()}–${(first + pipeline.people.length - 1).toLocaleString()} of ${pipeline.total.toLocaleString()}`
                  : null}
              </span>
            </div>
            <p className="px-5 pt-1 text-[12.5px] text-text-3" data-testid="pipeline-note">
              {show === 'lost'
                ? STAGE_WORDS.lostNote
                : show === 'client'
                  ? STAGE_WORDS.clientNote
                  : STAGE_WORDS.about}
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
                      <span className="inline-flex max-w-full items-center gap-1 align-top">
                        <PersonName
                          workspaceId={workspaceId}
                          who={menuPerson(p)}
                          moves={movesFor(p, (m) => void mark(p, m))}
                          disabled={busy !== null}
                          className="font-medium text-accent-text"
                        />
                        <OpenIcon person={p} />
                      </span>{' '}
                      <NetworkName platform={p.platform} />
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
                    </span>
                  </div>
                  <ResearchSlot
                    workspaceId={workspaceId}
                    asks={asks}
                    profileId={p.profileId}
                    platform={p.platform}
                    name={p.name}
                    check={researchCheck(p)}
                    neverPitched={false}
                  />
                  {p.nextStep ? (
                    <p className="mt-1 text-[12.5px] text-text-2">
                      {W.nextStepLabel}: {p.nextStep}
                    </p>
                  ) : null}
                  {p.lastAt ? (
                    <p className="mt-1 text-[12px] text-text-3">Latest {relativeTime(p.lastAt)}</p>
                  ) : null}
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

/**
 * Everyone in play, a column for each stage the person acts on: the first few of each, who to act on first, with
 * "See all" opening that stage's list. Found and warming up are counted above, with the links to the clients (left out
 * of the board, as they get no outreach) and to Not a fit.
 */
function BoardView({
  workspaceId,
  net,
  board,
  counts,
  asks,
  busy,
  onMark,
}: {
  workspaceId: string;
  net: Platform | null;
  board: Board;
  counts: Pipeline['counts'];
  asks: Asks | null;
  busy: boolean;
  onMark: (p: PipelinePerson, m: StageMark) => void;
}) {
  return (
    <div className="space-y-3" data-testid="pipeline-board">
      <p className="text-[13px] text-text-2" data-testid="pipeline-before">
        {STAGES.found} {counts.found.toLocaleString()} · {STAGES.warming}{' '}
        {counts.warming.toLocaleString()} · the extension works on these itself.{' '}
        {counts.client ? (
          <Link
            href={outreachHref(workspaceId, { view: 'pipeline', stages: 'client', net })}
            className="font-medium text-accent-text hover:underline"
            data-testid="pipeline-clients"
          >
            {STAGE_WORDS.clients} {counts.client.toLocaleString()}
          </Link>
        ) : null}
        {counts.client && counts.lost ? ' · ' : null}
        {counts.lost ? (
          <Link
            href={outreachHref(workspaceId, { view: 'pipeline', stages: 'lost', net })}
            className="font-medium text-accent-text hover:underline"
          >
            {STAGES.lost} {counts.lost.toLocaleString()}
          </Link>
        ) : null}
      </p>
      <div className="-mx-1 overflow-x-auto px-1 pb-2">
        <div className="flex items-start gap-3">
          {BOARD_STAGES.map((stage) => {
            const column = board[stage];
            const people = column.people.slice(0, COLUMN_MOST);
            const count = counts[stage];
            return (
              <section
                key={stage}
                aria-label={STAGES[stage]}
                className="flex w-[262px] flex-none flex-col gap-2 rounded-card bg-card-2 p-2.5"
                data-testid={`pipeline-column-${stage}`}
              >
                <div className="flex items-baseline justify-between px-1 pt-0.5">
                  <h3 className="text-[14px] font-semibold">{STAGES[stage]}</h3>
                  <span className="text-[13px] tabular-nums text-text-3">
                    {count.toLocaleString()}
                  </span>
                </div>
                {people.map((p) => (
                  <BoardCard
                    key={p.profileId}
                    workspaceId={workspaceId}
                    person={p}
                    asks={asks}
                    busy={busy}
                    onMark={onMark}
                  />
                ))}
                {count === 0 ? (
                  <p className="rounded-menu border border-dashed border-border-strong px-3 py-4 text-center text-[12.5px] text-text-3">
                    Nobody yet
                  </p>
                ) : count > people.length ? (
                  <Link
                    href={outreachHref(workspaceId, { view: 'pipeline', stages: stage, net })}
                    className="flex h-8 items-center justify-center rounded-control text-[13px] font-medium text-text-2 hover:bg-card-3 hover:text-text"
                    data-testid={`pipeline-column-all-${stage}`}
                  >
                    See all {count.toLocaleString()}
                  </Link>
                ) : null}
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function BoardCard({
  workspaceId,
  person: p,
  asks,
  busy,
  onMark,
}: {
  workspaceId: string;
  person: PipelinePerson;
  asks: Asks | null;
  busy: boolean;
  onMark: (p: PipelinePerson, m: StageMark) => void;
}) {
  return (
    <article
      className="grid gap-1 rounded-menu border border-border bg-card p-3 shadow-1"
      data-testid="pipeline-person"
    >
      <div className="flex items-start justify-between gap-2">
        <PersonName
          workspaceId={workspaceId}
          who={menuPerson(p)}
          moves={movesFor(p, (m) => onMark(p, m))}
          disabled={busy}
          className="min-w-0 text-[14px] font-medium"
          truncate
        />
        <span className="-mr-1 flex-none">
          <OpenIcon person={p} />
        </span>
      </div>
      {p.why[0] ? (
        <p className="line-clamp-2 text-[12.5px] text-text-2" data-testid="pipeline-why">
          {p.why[0]}
        </p>
      ) : null}
      {p.nextStep ? (
        <p className="mt-1 line-clamp-2 self-start rounded-[6px] bg-accent-soft px-2 py-1 text-[12px] font-medium text-accent-text">
          {p.nextStep}
        </p>
      ) : null}
      <p className="text-[12px] text-text-3">
        <NetworkName platform={p.platform} />
        {p.lastAt ? ` · Latest ${relativeTime(p.lastAt)}` : null}
      </p>
      <ResearchSlot
        workspaceId={workspaceId}
        asks={asks}
        profileId={p.profileId}
        platform={p.platform}
        name={p.name}
        check={researchCheck(p)}
        neverPitched={false}
      />
    </article>
  );
}
