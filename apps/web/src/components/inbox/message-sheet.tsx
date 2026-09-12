'use client';
import { X } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Sheet, SheetClose, SheetContent } from '@/components/ui/sheet';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { ConversationGet, ConversationThread } from '@/lib/api/types';
import { Composer } from './composer';
import { firstName } from './conversation-row';
import { useThread } from './hooks';
import { MessageLog } from './message-log';

type Loaded = { data: ConversationGet; thread: ConversationThread };

/** Text a customer without leaving their page: the thread and a composer in a side sheet. */
export function MessageSheet({
  workspaceId,
  person,
  open,
  onOpenChange,
}: {
  workspaceId: string;
  person: { id: string; fullName: string; phone: string | null; phoneE164: string | null };
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [state, setState] = useState<Loaded | { error: string } | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setState(null);
    void (async () => {
      try {
        const opened = unwrap(
          await apiBrowser().POST('/v1/commands/conversation.open', {
            body: { workspaceId, personId: person.id, channel: 'sms' },
          }),
        );
        const ref = { workspaceId, conversationId: opened.conversationId };
        const [data, thread] = await Promise.all([
          apiBrowser().POST('/v1/queries/conversation.get', { body: ref }).then(unwrap),
          apiBrowser()
            .POST('/v1/queries/conversation.thread', { body: { ...ref, limit: 30 } })
            .then(unwrap),
        ]);
        if (!cancelled) setState({ data, thread });
      } catch (e) {
        if (!cancelled) setState({ error: errorMessage(e) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, workspaceId, person.id]);

  const loaded = state && 'data' in state ? state : null;
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        title={`Text ${person.fullName}`}
        hideHeader
        className="overflow-hidden p-0 sm:p-0"
      >
        <div className="flex flex-none items-start justify-between gap-3 border-b border-border px-5 py-[18px]">
          <div className="min-w-0">
            <h2 className="truncate text-lg font-semibold tracking-tight">
              Text {person.fullName}
            </h2>
            <p className="truncate text-[13px] text-text-3">
              {person.phone ?? ''}
              {loaded?.data.fromNumber ? ` · from ${loaded.data.fromNumber}` : ''}
            </p>
          </div>
          <SheetClose asChild>
            <Button variant="ghost" size="icon" aria-label="Close" title="Close">
              <X className="h-[18px] w-[18px]" strokeWidth={1.5} />
            </Button>
          </SheetClose>
        </div>
        {state === null ? (
          <div className="px-5 py-8 text-center text-[13px] text-text-3" role="status">
            Loading the conversation…
          </div>
        ) : 'error' in state ? (
          <p className="px-5 py-6 text-[13px] text-danger-text" role="alert">
            {state.error}
          </p>
        ) : (
          <SheetThread
            key={state.data.conversation.id}
            workspaceId={workspaceId}
            loaded={state}
            personName={person.fullName}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

function SheetThread({
  workspaceId,
  loaded,
  personName,
}: {
  workspaceId: string;
  loaded: Loaded;
  personName: string;
}) {
  const router = useRouter();
  const { data } = loaded;
  const t = useThread(workspaceId, data.conversation.id, loaded.thread);
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="message-sheet">
      <MessageLog
        compact
        items={t.items}
        pending={t.pending}
        customerFirstName={firstName(personName)}
        hasEarlier={t.hasEarlier}
        loadingEarlier={t.loadingEarlier}
        onLoadEarlier={() => void t.loadEarlier()}
      />
      <Composer
        variant="sheet"
        target={{
          workspaceId,
          conversationId: data.conversation.id,
          personId: data.person?.id ?? null,
          firstName: firstName(personName),
          phoneDisplay: data.conversation.counterpartDisplay,
          canText: data.canText,
          quiet: data.quiet,
          fromNumber: data.fromNumber,
        }}
        onPending={t.addPending}
        onSettled={t.settlePending}
        onDropPending={t.dropPending}
        onSent={() => {
          t.refresh();
          router.refresh();
        }}
      />
      <div className="flex-none px-5 pb-4 pt-1">
        <Link
          href={`/app/w/${workspaceId}/inbox/${data.conversation.id}`}
          className="text-[13px] text-accent-text hover:underline"
        >
          Open the whole conversation in the inbox
        </Link>
      </div>
    </div>
  );
}
