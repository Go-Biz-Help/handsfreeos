'use client';
import { X } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Sheet, SheetClose, SheetContent } from '@/components/ui/sheet';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { ConversationGet, ConversationThread, EmailComposeOptions } from '@/lib/api/types';
import { Composer } from './composer';
import { firstName } from './conversation-row';
import { useThread } from './hooks';
import { MessageLog } from './message-log';

type Channel = 'sms' | 'email';
type Loaded = {
  data: ConversationGet;
  thread: ConversationThread;
  email: EmailComposeOptions | null;
};

/** Text or email a customer without leaving their page: the thread and a composer in a side sheet. */
export function MessageSheet({
  workspaceId,
  person,
  channel = 'sms',
  open,
  onOpenChange,
  onEditPerson,
}: {
  workspaceId: string;
  person: {
    id: string;
    fullName: string;
    phone: string | null;
    phoneE164: string | null;
    email?: string | null;
  };
  channel?: Channel;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Opens the customer's edit dialog (offered when their email address bounced). */
  onEditPerson?: () => void;
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
            body: { workspaceId, personId: person.id, channel },
          }),
        );
        const ref = { workspaceId, conversationId: opened.conversationId };
        const [data, thread, email] = await Promise.all([
          apiBrowser().POST('/v1/queries/conversation.get', { body: ref }).then(unwrap),
          apiBrowser()
            .POST('/v1/queries/conversation.thread', { body: { ...ref, limit: 30 } })
            .then(unwrap),
          channel === 'email'
            ? apiBrowser().POST('/v1/queries/email.compose_options', { body: ref }).then(unwrap)
            : Promise.resolve(null),
        ]);
        if (!cancelled) setState({ data, thread, email });
      } catch (e) {
        if (!cancelled) setState({ error: errorMessage(e) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, workspaceId, person.id, channel]);

  const loaded = state && 'data' in state ? state : null;
  const heading = `${channel === 'email' ? 'Email' : 'Text'} ${person.fullName}`;
  const defaultFrom = loaded?.email?.addresses.find((a) => a.id === loaded.email?.fromAddressId);
  const sub =
    channel === 'email'
      ? `${person.email ?? ''}${defaultFrom ? ` · from ${defaultFrom.address}` : ''}`
      : `${person.phone ?? ''}${loaded?.data.fromNumber ? ` · from ${loaded.data.fromNumber}` : ''}`;
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent title={heading} hideHeader className="overflow-hidden p-0 sm:p-0">
        <div className="flex flex-none items-start justify-between gap-3 border-b border-border px-5 py-[18px]">
          <div className="min-w-0">
            <h2 className="truncate text-lg font-semibold tracking-tight">{heading}</h2>
            <p className="truncate text-[13px] text-text-3">{sub}</p>
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
            channel={channel}
            person={person}
            onEditPerson={onEditPerson}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

function SheetThread({
  workspaceId,
  loaded,
  channel,
  person,
  onEditPerson,
}: {
  workspaceId: string;
  loaded: Loaded;
  channel: Channel;
  person: { fullName: string; phone: string | null; email?: string | null };
  onEditPerson?: () => void;
}) {
  const router = useRouter();
  const { data } = loaded;
  const t = useThread(workspaceId, data.conversation.id, loaded.thread);
  const first = firstName(person.fullName);
  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      data-testid="message-sheet"
      data-channel={channel}
    >
      <MessageLog
        compact
        items={t.items}
        pending={t.pending}
        customerFirstName={first}
        customerName={person.fullName}
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
          firstName: first,
          channel,
          phoneDisplay:
            channel === 'email' ? (person.phone ?? '') : data.conversation.counterpartDisplay,
          email: channel === 'email' ? data.conversation.counterpart : (person.email ?? null),
          canText: data.canText,
          quiet: data.quiet,
          fromNumber: data.fromNumber,
        }}
        onPending={t.addPending}
        onSettled={t.settlePending}
        onDropPending={t.dropPending}
        onEditPerson={onEditPerson}
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
