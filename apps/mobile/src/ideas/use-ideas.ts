import type { paths } from '@hfos/api-client';
import { IDEAS_WORDS, type IdeaMine, type IdeaSort, type IdeaStatus } from '@hfos/core';
import * as React from 'react';

import { api, errorMessage, unwrap } from '@/lib/api';
import { useNetwork } from '@/lib/network';

/**
 * Ideas, the roadmap and What's new on the phone (0102): what `idea.*` and `whats_new.*` answer, and the things a
 * person does there.
 *
 * **None of it is in the phone's copy.** The board belongs to HandsFreeOS rather than to the business, so the sync
 * service never carries it, and a board from yesterday would show votes that have since moved. Every screen here is
 * live or says it needs a signal, as the balance and the Assistant's chats are. For the same reason nothing here goes
 * into the queue of changes: a vote or a comment goes straight out, and says so when it can't.
 */

type Ok<P extends keyof paths> = paths[P] extends {
  post: { responses: { 200: { content: { 'application/json': infer R } } } };
}
  ? R
  : never;

export type IdeaList = Ok<'/v1/queries/idea.list'>;
export type IdeaRow = IdeaList['ideas'][number];
export type IdeaFull = Ok<'/v1/queries/idea.get'>;
export type IdeaUpdate = IdeaFull['updates'][number];
export type IdeaComment = IdeaFull['comments'][number];
export type Roadmap = Ok<'/v1/queries/idea.roadmap'>;
export type RoadmapCard = Roadmap['planned'][number];
export type IdeaArea = Ok<'/v1/queries/idea.areas'>['areas'][number];
export type WhatsNewEntry = Ok<'/v1/queries/whats_new.list'>['entries'][number];
export type SimilarIdea = Ok<'/v1/queries/idea.similar'>['ideas'][number];

/** What the board shows: the web's filters, which live in its address there and in the screen's state here. */
export interface BoardFilters {
  readonly sort: IdeaSort;
  readonly status: 'open' | 'all' | IdeaStatus;
  readonly areaId: string | null;
  readonly search: string;
  readonly mine: IdeaMine | null;
}

export const DEFAULT_FILTERS: BoardFilters = {
  sort: 'trending',
  status: 'open',
  areaId: null,
  search: '',
  mine: null,
};

/** Anything but the board as it first opens: the empty board then says "No ideas match that". */
export const isFiltered = (f: BoardFilters): boolean =>
  f.status !== 'open' || f.areaId !== null || f.search !== '' || f.mine !== null;

/** How many ideas and What's new entries come down at a time. */
const PAGE = 20;

export interface Live<T> {
  readonly data: T | null;
  /** Nothing to show yet, and an answer on its way. */
  readonly loading: boolean;
  /** Something to show, and a fresher answer on its way (pulled down to refresh). */
  readonly refreshing: boolean;
  /** Words for what went wrong, or that it needs a signal. Null while it's fine. */
  readonly error: string | null;
  reload(): void;
  /** Puts a changed copy in place (a vote, a follow) without asking again. */
  update(change: (was: T) => T): void;
}

/**
 * One answer from HandsFreeOS, asked again when `key` changes, when somebody presses Try again, and when the phone
 * comes back into signal on the screen, so the "needs a signal" card doesn't sit there once it has one.
 */
function useLive<T>(load: () => Promise<T>, key: string): Live<T> {
  const { online } = useNetwork();
  const [data, setData] = React.useState<{ key: string; value: T } | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [round, setRound] = React.useState(0);
  const latest = React.useRef(load);
  latest.current = load;

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    latest
      .current()
      .then((value) => {
        if (!cancelled) setData({ key, value });
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(online ? errorMessage(e) : IDEAS_WORDS.needsSignal);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [key, online, round]);

  // An answer for other filters is not an answer for these: the list waits for its own.
  const value = data && data.key === key ? data.value : null;
  return {
    data: value,
    loading: loading && value === null,
    refreshing: loading && value !== null,
    error,
    reload: React.useCallback(() => setRound((r) => r + 1), []),
    update: React.useCallback(
      (change: (was: T) => T) =>
        setData((was) => (was ? { key: was.key, value: change(was.value) } : was)),
      [],
    ),
  };
}

// ---------- the board ----------

export interface Board extends Live<IdeaList> {
  /** Another page is there to ask for, and whether one is on its way. */
  readonly hasMore: boolean;
  readonly loadingMore: boolean;
  more(): void;
}

const listBody = (f: BoardFilters) => ({
  sort: f.sort,
  status: f.status,
  limit: PAGE,
  ...(f.areaId ? { areaId: f.areaId } : {}),
  ...(f.search ? { search: f.search } : {}),
  ...(f.mine ? { mine: f.mine } : {}),
});

export function useIdeaBoard(filters: BoardFilters): Board {
  const key = JSON.stringify(filters);
  const live = useLive(
    async () => unwrap(await api.POST('/v1/queries/idea.list', { body: listBody(filters) })),
    key,
  );
  const [loadingMore, setLoadingMore] = React.useState(false);
  const cursor = live.data?.nextCursor ?? null;
  const { update } = live;

  const more = React.useCallback(() => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    api
      .POST('/v1/queries/idea.list', { body: { ...listBody(filters), cursor } })
      .then(unwrap)
      .then((page) =>
        update((was) =>
          // A reload that landed while this page was in the air wins: its cursor is no longer this one.
          was.nextCursor === cursor
            ? {
                ideas: [
                  ...was.ideas,
                  ...page.ideas.filter((i) => !was.ideas.some((w) => w.id === i.id)),
                ],
                nextCursor: page.nextCursor,
              }
            : was,
        ),
      )
      .catch(() => undefined)
      .finally(() => setLoadingMore(false));
  }, [cursor, loadingMore, filters, update]);

  return { ...live, hasMore: cursor !== null, loadingMore, more };
}

// ---------- one idea ----------

export function useIdea(ideaId: string): Live<IdeaFull> {
  return useLive(
    async () => unwrap(await api.POST('/v1/queries/idea.get', { body: { ideaId } })),
    ideaId,
  );
}

// ---------- the roadmap ----------

export function useRoadmap(): Live<Roadmap> {
  return useLive(
    async () => unwrap(await api.POST('/v1/queries/idea.roadmap', { body: {} })),
    'roadmap',
  );
}

// ---------- What's new ----------

export interface WhatsNewView extends Live<Ok<'/v1/queries/whats_new.list'>> {
  readonly hasMore: boolean;
  readonly loadingMore: boolean;
  more(): void;
}

export function useWhatsNew(): WhatsNewView {
  const live = useLive(
    async () => unwrap(await api.POST('/v1/queries/whats_new.list', { body: { limit: PAGE } })),
    'whats-new',
  );
  const [loadingMore, setLoadingMore] = React.useState(false);
  const cursor = live.data?.nextCursor ?? null;
  const { update } = live;
  const more = React.useCallback(() => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    api
      .POST('/v1/queries/whats_new.list', { body: { limit: PAGE, cursor } })
      .then(unwrap)
      .then((page) =>
        update((was) =>
          was.nextCursor === cursor
            ? { entries: [...was.entries, ...page.entries], nextCursor: page.nextCursor }
            : was,
        ),
      )
      .catch(() => undefined)
      .finally(() => setLoadingMore(false));
  }, [cursor, loadingMore, update]);
  return { ...live, hasMore: cursor !== null, loadingMore, more };
}

// ---------- the parts of HandsFreeOS an idea can be about ----------

/** The areas change about once a quarter, so the phone asks for them once a session and keeps the answer. */
let keptAreas: readonly IdeaArea[] | null = null;

export function useIdeaAreas(): readonly IdeaArea[] {
  const { online } = useNetwork();
  const [areas, setAreas] = React.useState<readonly IdeaArea[]>(keptAreas ?? []);
  React.useEffect(() => {
    if (keptAreas || !online) return;
    let cancelled = false;
    api
      .POST('/v1/queries/idea.areas', { body: {} })
      .then(unwrap)
      .then((out) => {
        keptAreas = out.areas;
        if (!cancelled) setAreas(out.areas);
      })
      // Without them an idea shows no area, and sharing waits for them: nothing is worth an error here.
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [online]);
  return areas;
}

/** Forgets the kept areas (the tests, and the team renaming one mid-session is not worth more). */
export function forgetIdeaAreas(): void {
  keptAreas = null;
}

/** An area's name, or "Something else" for one the phone doesn't know. */
export function areaName(areas: readonly IdeaArea[], id: string | null): string {
  return areas.find((a) => a.id === id)?.name ?? IDEAS_WORDS.somethingElse;
}

// ---------- "Is it one of these?" ----------

/**
 * The ideas already on the board that sound like the title being typed, a moment after the typing stops. Only the
 * latest answer counts, and a failed one shows none: suggestions are a help, not a step.
 */
export function useSimilarIdeas(text: string): readonly SimilarIdea[] {
  const [ideas, setIdeas] = React.useState<readonly SimilarIdea[]>([]);
  const asked = React.useRef(0);
  React.useEffect(() => {
    const typed = text.trim();
    if (typed.length < 4) {
      asked.current += 1;
      setIdeas([]);
      return;
    }
    const n = ++asked.current;
    const timer = setTimeout(() => {
      api
        .POST('/v1/queries/idea.similar', { body: { text: typed } })
        .then(unwrap)
        .then((out) => {
          if (n === asked.current) setIdeas(out.ideas);
        })
        .catch(() => undefined);
    }, 300);
    return () => clearTimeout(timer);
  }, [text]);
  return ideas;
}

// ---------- what a person does ----------

/** Everything a person does on the board. Each goes straight out, and throws the API's own words when it can't. */
export const ideaCommands = {
  async share(input: {
    workspaceId: string;
    title: string;
    body: string;
    areaId: string;
  }): Promise<{ ideaId: string; number: number }> {
    return unwrap(await api.POST('/v1/commands/idea.share', { body: input }));
  },
  async edit(input: { ideaId: string; title: string; body: string; areaId: string }) {
    unwrap(await api.POST('/v1/commands/idea.edit', { body: input }));
  },
  /** A vote given or taken back, from the business the person is in. */
  async vote(
    ideaId: string,
    workspaceId: string,
    vote: boolean,
  ): Promise<{ voted: boolean; voteCount: number }> {
    return unwrap(
      await api.POST(vote ? '/v1/commands/idea.vote' : '/v1/commands/idea.unvote', {
        body: { ideaId, workspaceId },
      }),
    );
  },
  async follow(ideaId: string, following: boolean) {
    unwrap(await api.POST('/v1/commands/idea.follow', { body: { ideaId, following } }));
  },
  async comment(ideaId: string, body: string) {
    unwrap(await api.POST('/v1/commands/idea.comment', { body: { ideaId, body } }));
  },
  /** A person's own comment, taken down. */
  async takeDown(commentId: string) {
    unwrap(
      await api.POST('/v1/commands/idea.set_comment_hidden', {
        body: { commentId, hidden: true },
      }),
    );
  },
  /** They have read What's new. */
  async markSeen() {
    unwrap(await api.POST('/v1/commands/whats_new.mark_seen', { body: {} }));
  },
};
