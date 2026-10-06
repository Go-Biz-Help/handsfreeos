'use client';
/**
 * The AI teammate in the inbox: who it is (name, status, training progress), a conversation's drafts, which
 * conversations have one waiting, and the commands people run on them. Each follows live changes.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { useLiveVersion } from '@/lib/realtime/live-provider';
import type { TeammateDraft } from './inbox-types';
import { teammateBriefOf, type TeammateBrief } from './inbox-words';

export type { TeammateBrief };

/** The business's teammate (null when there isn't one; undefined until known). */
export function useTeammateBrief(
  workspaceId: string,
  initial?: TeammateBrief | null,
): TeammateBrief | null | undefined {
  const live = useLiveVersion(['ai_teammate', 'ai_teammate_draft'], 500);
  const [brief, setBrief] = useState<TeammateBrief | null | undefined>(initial);
  useEffect(() => {
    let cancelled = false;
    apiBrowser()
      .POST('/v1/queries/ai_teammate.get', { body: { workspaceId } })
      .then((r) => {
        if (!cancelled) setBrief(teammateBriefOf(unwrap(r)));
      })
      .catch(() => {
        // The inbox works without it: the teammate's parts stay hidden.
        if (!cancelled) setBrief((b) => b ?? null);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, live]);
  return brief;
}

/**
 * One conversation's drafts, newest first: the one waiting (at most one reply waits per conversation) and the
 * latest decided, so the thread can say what became of it.
 */
export function useConversationDrafts(workspaceId: string, conversationId: string) {
  const live = useLiveVersion(['ai_teammate_draft', 'conversation', 'message'], 250);
  const [state, setState] = useState<{ for: string; items: TeammateDraft[]; loaded: boolean }>({
    for: conversationId,
    items: [],
    loaded: false,
  });
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let cancelled = false;
    apiBrowser()
      .POST('/v1/queries/ai_teammate.draft_list', {
        body: { workspaceId, conversationId, status: 'all', limit: 10 },
      })
      .then((r) => {
        if (!cancelled) setState({ for: conversationId, items: unwrap(r).items, loaded: true });
      })
      .catch(() => {
        if (!cancelled) setState((s) => ({ ...s, for: conversationId, loaded: true }));
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, conversationId, live, nonce]);
  const items = state.for === conversationId ? state.items : [];
  return {
    items,
    loaded: state.for === conversationId && state.loaded,
    pending: items.find((d) => d.status === 'pending' && d.kind === 'reply') ?? null,
    /** A discount waiting for a manager. */
    approval: items.find((d) => d.status === 'pending' && d.kind === 'approval') ?? null,
    /** Round seven: what the teammate asked someone on the customer's record to do with an add-on. */
    ask: items.find((d) => d.status === 'pending' && d.kind === 'ask') ?? null,
    latest: items[0] ?? null,
    refresh: useCallback(() => setNonce((n) => n + 1), []),
    /** Local change before the server confirms (a decision this tab made). */
    patch: useCallback(
      (id: string, change: Partial<TeammateDraft>) =>
        setState((s) => ({
          ...s,
          items: s.items.map((d) => (d.id === id ? { ...d, ...change } : d)),
        })),
      [],
    ),
  };
}

/** The conversations whose teammate reply waits for someone's OK (the list's "draft waiting"). */
export function useConversationsWithDrafts(workspaceId: string, enabled: boolean): Set<string> {
  const live = useLiveVersion(['ai_teammate_draft', 'conversation'], 400);
  const [ids, setIds] = useState<string[]>([]);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    apiBrowser()
      .POST('/v1/queries/ai_teammate.draft_list', {
        body: { workspaceId, status: 'pending', kind: 'reply', limit: 100 },
      })
      .then((r) => {
        if (!cancelled)
          setIds(unwrap(r).items.flatMap((d) => (d.conversationId ? [d.conversationId] : [])));
      })
      .catch(() => {
        // A nicety on the rows: the thread itself shows the draft.
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, enabled, live]);
  return useMemo(() => new Set(ids), [ids]);
}

/** What people do with the teammate's work: decide a draft, take a conversation over, hand it back. */
export function teammateCommands(workspaceId: string) {
  const api = () => apiBrowser();
  return {
    decide: async (input: {
      draftId: string;
      decision: 'approve' | 'reject';
      edits?: { body?: string; subject?: string };
      reason?: string;
    }) =>
      unwrap(
        await api().POST('/v1/commands/ai_teammate.decide_draft', {
          body: { workspaceId, ...input },
        }),
      ),
    takeOver: async (conversationId: string) =>
      unwrap(
        await api().POST('/v1/commands/conversation.take_over', {
          body: { workspaceId, conversationId },
        }),
      ),
    handToAi: async (conversationId: string) =>
      unwrap(
        await api().POST('/v1/commands/conversation.hand_to_ai', {
          body: { workspaceId, conversationId },
        }),
      ),
    /** "Try again" after a rejection: the teammate answers the same messages again, with the reason. */
    retry: async (draftId: string) =>
      unwrap(
        await api().POST('/v1/commands/ai_teammate.retry', {
          body: { workspaceId, draftId },
        }),
      ),
  };
}
