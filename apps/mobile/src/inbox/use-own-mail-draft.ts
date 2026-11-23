import * as React from 'react';
import { AppState } from 'react-native';

import { toast } from '@/components/ui/toast';
import { api, errorMessage, unwrap } from '@/lib/api';
import { useNetwork } from '@/lib/network';

/**
 * The answer the AI teammate drafted on someone's own mail ("Let Ava read this mail", the owner 2026-11-22), in a
 * thread on the phone. The draft lives on the thread at HandsFreeOS and isn't in the phone's copy, so it is asked for
 * while there's signal: when the thread opens, when new mail shows, and when the app comes back to the front.
 */
export interface OwnMailDraft {
  readonly body: string;
  /** The mail it answers. */
  readonly forMessageId: string;
  /** The AI teammate's name. */
  readonly by: string;
}

/**
 * The AI teammate writes its draft a little after the mail lands, and nothing tells the phone when it has. So when
 * the newest mail has no draft yet, it is asked for again after these waits, then left until something changes.
 */
const ASK_AGAIN_MS = [8_000, 30_000] as const;

/**
 * `newestMailId` is the thread's newest message when it is mail to their own address that they haven't answered, else
 * null and nothing is asked. The draft comes back only while it answers that mail.
 */
export function useOwnMailDraft(
  workspaceId: string,
  conversationId: string,
  newestMailId: string | null,
): {
  readonly draft: OwnMailDraft | null;
  /** No thanks: the draft goes. Nothing was sent, and new mail gets a new one. */
  readonly dismiss: () => Promise<void>;
  readonly dismissing: boolean;
} {
  const { online } = useNetwork();
  const [got, setGot] = React.useState<OwnMailDraft | null>(null);
  const [gone, setGone] = React.useState<string | null>(null);
  const [dismissing, setDismissing] = React.useState(false);
  const [front, setFront] = React.useState(0);

  React.useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') setFront((n) => n + 1);
    });
    return () => sub.remove();
  }, []);

  React.useEffect(() => {
    if (!newestMailId || !online) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const ask = (again: number) => {
      api
        .POST('/v1/queries/conversation.get', { body: { workspaceId, conversationId } })
        .then((r) => {
          if (cancelled) return;
          const d = unwrap(r).aiDraft ?? null;
          setGot(d ? { body: d.body, forMessageId: d.forMessageId, by: d.by } : null);
          const wait = ASK_AGAIN_MS[again];
          if (d?.forMessageId !== newestMailId && wait !== undefined)
            timer = setTimeout(() => ask(again + 1), wait);
        })
        .catch(() => {
          // The draft is a head start: without it, they write their own answer.
        });
    };
    ask(0);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [workspaceId, conversationId, newestMailId, online, front]);

  const dismiss = React.useCallback(async () => {
    if (!got) return;
    setDismissing(true);
    try {
      unwrap(
        await api.POST('/v1/commands/conversation.ai_draft_dismiss', {
          body: { workspaceId, conversationId },
        }),
      );
      setGone(got.forMessageId);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setDismissing(false);
    }
  }, [workspaceId, conversationId, got]);

  const draft =
    got && newestMailId && got.forMessageId === newestMailId && gone !== got.forMessageId
      ? got
      : null;
  return { draft, dismiss, dismissing };
}
