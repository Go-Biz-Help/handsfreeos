import {
  approvedToast,
  decideRefusal,
  DRAFT_WORDS,
  rejectedToast,
  type TeammateDraftShape,
} from '@hfos/core';
import * as React from 'react';

import { toast } from '@/components/ui/toast';
import { change, ChangeError } from '@/changes';
import { useChange } from '@/changes/hooks';
import { refusalOf } from '@/changes/rules';
import { useNetwork } from '@/lib/network';

import { DECIDE_DRAFT } from './use-drafts';

export type DraftMode = 'view' | 'editing' | 'rejecting';

/**
 * Deciding one of the AI teammate's drafts on the phone, as the web's `useDraftDecision` does: approve it as it is,
 * edit its message (and an email's subject) then send, or reject it with an optional reason. The decision is a change
 * like any other (`ai_teammate.decide_draft`, fresh for 30 minutes): the draft leaves at once, goes when there's signal,
 * and says what it did once HandsFreeOS has it, in the web's words.
 */
export function useDraftDecision({
  workspaceId,
  draft,
  who,
}: {
  workspaceId: string;
  draft: TeammateDraftShape | null;
  /** The customer's first name, for the words ("texts Mike"). */
  who: string;
}) {
  const { online } = useNetwork();
  const original = draft?.preview.message?.body ?? '';
  const originalSubject = draft?.preview.message?.subject ?? '';
  const [forId, setForId] = React.useState<string | null>(draft?.id ?? null);
  const [mode, setMode] = React.useState<DraftMode>('view');
  const [body, setBody] = React.useState(original);
  const [subject, setSubject] = React.useState(originalSubject);
  const [reason, setReason] = React.useState('');
  const [busy, setBusy] = React.useState<'approve' | 'reject' | null>(null);
  const [made, setMade] = React.useState<{
    id: string;
    draft: TeammateDraftShape;
    decision: 'approve' | 'reject';
    edited: boolean;
  } | null>(null);
  if ((draft?.id ?? null) !== forId) {
    setForId(draft?.id ?? null);
    setMode('view');
    setBody(original);
    setSubject(originalSubject);
    setReason('');
  }

  // Once HandsFreeOS has the decision: what it did, or why it didn't, in the web's words.
  const row = useChange(made?.id ?? '');
  const told = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!made || !row || told.current === `${row.id}:${row.state}`) return;
    if (row.state === 'sent') {
      told.current = `${row.id}:${row.state}`;
      if (made.decision === 'reject') toast.show(rejectedToast(made.draft, who));
      else {
        const answer = row.answer ? (JSON.parse(row.answer) as { progress?: unknown }) : null;
        const progress = answer?.progress as Parameters<typeof approvedToast>[1] | undefined;
        if (progress) toast.show(approvedToast(made.draft, progress, made.edited, who));
      }
    } else if (row.state === 'refused') {
      told.current = `${row.id}:${row.state}`;
      const error = refusalOf(row.answer);
      toast.error(
        decideRefusal(error?.rule ?? row.rule, who, made.draft.teammate.name) ??
          row.reason ??
          DRAFT_WORDS.notDecided,
      );
    }
  }, [made, row, who]);

  async function decide(decision: 'approve' | 'reject', withEdits: boolean) {
    if (!draft || busy) return;
    const edits: { body?: string; subject?: string } = {};
    if (withEdits) {
      if (body.trim() !== original.trim()) edits.body = body.trim();
      if (draft.channel === 'email' && subject.trim() !== originalSubject.trim())
        edits.subject = subject.trim();
    }
    const edited = Object.keys(edits).length > 0;
    setBusy(decision);
    try {
      const result = await change(
        DECIDE_DRAFT,
        {
          workspaceId,
          draftId: draft.id,
          decision,
          ...(edited ? { edits } : {}),
          ...(decision === 'reject' && reason.trim() ? { reason: reason.trim() } : {}),
        },
        {
          // The draft leaves the phone's list at once; the server's own row (or none) comes back at the next sync.
          optimistic: (tx) =>
            tx.execute('UPDATE ai_teammate_drafts SET status = ? WHERE id = ?', [
              decision === 'approve' ? 'approved' : 'rejected',
              draft.id,
            ]),
        },
      );
      setMade({ id: result.id, draft, decision, edited });
      setMode('view');
      if (!online)
        toast.show(
          decision === 'approve' ? DRAFT_WORDS.approvedOffline : DRAFT_WORDS.rejectedOffline,
        );
    } catch (error) {
      toast.error(
        error instanceof ChangeError || error instanceof Error ? error.message : String(error),
      );
    } finally {
      setBusy(null);
    }
  }

  return {
    draft,
    mode,
    setMode,
    body,
    setBody,
    subject,
    setSubject,
    reason,
    setReason,
    busy,
    blank: !body.trim(),
    approve: () => void decide('approve', false),
    sendEdit: () => {
      if (!body.trim()) {
        toast.error(DRAFT_WORDS.writeIt);
        return;
      }
      void decide('approve', true);
    },
    reject: () => void decide('reject', false),
    cancelEdit: () => {
      setBody(original);
      setSubject(originalSubject);
      setMode('view');
    },
  };
}

export type DraftDecision = ReturnType<typeof useDraftDecision>;
