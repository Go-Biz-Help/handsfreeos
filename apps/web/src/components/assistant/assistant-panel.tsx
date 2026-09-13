'use client';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { History, SquarePen, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { toast } from 'sonner';
import { MessageSheet } from '@/components/inbox/message-sheet';
import { Button } from '@/components/ui/button';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import { handDraft } from '@/lib/assistant/drafts';
import { cancelToolCall } from '@/lib/assistant/stream';
import { useMatches } from '@/lib/use-media';
import { useAssistant } from './assistant-provider';
import { AssistantComposer } from './composer';
import type { ConfirmCardData } from './confirm-card';
import { AssistantMark } from './mark';
import { MessageList } from './message-list';
import { NotSetUp } from './notices';
import { ThreadList } from './thread-list';

interface Editing {
  readonly card: ConfirmCardData;
  readonly channel: 'sms' | 'email';
  readonly person: {
    readonly id: string;
    readonly fullName: string;
    readonly phone: string | null;
    readonly phoneE164: string | null;
    readonly email: string | null;
  };
}

const round =
  'flex h-11 w-11 flex-none items-center justify-center rounded-full text-text-2 hover:bg-card-2';

/** The header, the chat or the history, the composer, and Edit's message sheet. */
function PanelContent({ phone, titleId }: { phone: boolean; titleId?: string }) {
  const a = useAssistant();
  const router = useRouter();
  const [editing, setEditing] = useState<Editing | null>(null);
  const chat = a.view === 'chat';
  const title = chat ? 'Ask HandsFreeOS' : 'Your chats';
  const toggleHistory = () => a.setView(chat ? 'history' : 'chat');
  const close = () => a.setOpen(false);

  /** Edit on a text or email card: the customer's message sheet, or the conversation's own composer. */
  async function edit(card: ConfirmCardData) {
    const channel = card.tool === 'send_email' ? 'email' : 'sms';
    const subject = card.fields.find((f) => f.label === 'Subject')?.value;
    // Their own version goes out instead: the card's draft never will.
    const sentOwn = () => {
      void cancelToolCall(card.toolCallId, a.workspaceId).catch(() => undefined);
      a.setCall(card.toolCallId, {
        status: 'cancelled',
        note: 'You sent your own version instead.',
      });
    };
    if (card.personId) {
      try {
        const { person } = unwrap(
          await apiBrowser().POST('/v1/queries/person.get', {
            body: { workspaceId: a.workspaceId, personId: card.personId },
          }),
        );
        setEditing({
          card,
          channel,
          person: {
            id: person.id,
            fullName: person.fullName,
            phone: person.phone,
            phoneE164: person.phoneE164,
            email: person.email,
          },
        });
      } catch (e) {
        toast.error(errorMessage(e));
      }
      return;
    }
    if (card.conversationId) {
      // A number that isn't in Customers: its conversation in the inbox takes the draft.
      handDraft(card.conversationId, { text: card.body ?? '', subject, onSent: sentOwn });
      const href = `/app/w/${a.workspaceId}/inbox/${card.conversationId}`;
      a.closeIfCovering(href);
      router.push(href);
      return;
    }
    toast('Open the conversation to edit this.');
  }

  return (
    <>
      {phone ? (
        <div className="flex h-14 flex-none items-center gap-0.5 border-b border-border bg-card px-1">
          <button type="button" onClick={close} title="Close" aria-label="Close" className={round}>
            <X className="h-5 w-5" strokeWidth={1.5} />
          </button>
          <AssistantMark size={22} className="ml-0.5" />
          <DialogPrimitive.Title className="ml-2 min-w-0 flex-1 truncate text-base font-semibold">
            {title}
          </DialogPrimitive.Title>
          <button
            type="button"
            onClick={toggleHistory}
            title="Your chats"
            aria-label="Your chats"
            aria-pressed={!chat}
            className={round}
          >
            <History className="h-5 w-5" strokeWidth={1.5} />
          </button>
          <button
            type="button"
            onClick={a.newChat}
            title="New chat"
            aria-label="New chat"
            className={round}
          >
            <SquarePen className="h-5 w-5" strokeWidth={1.5} />
          </button>
        </div>
      ) : (
        <div className="flex h-14 flex-none items-center gap-1.5 border-b border-border pl-4 pr-2">
          <AssistantMark size={22} />
          <h2
            id={titleId}
            className="ml-1 min-w-0 flex-1 truncate text-[15px] font-semibold tracking-[-0.005em]"
          >
            {title}
          </h2>
          <Button
            variant="ghost"
            size="icon"
            title="Your chats"
            aria-label="Your chats"
            aria-pressed={!chat}
            onClick={toggleHistory}
          >
            <History className="h-[18px] w-[18px]" strokeWidth={1.5} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            title="New chat"
            aria-label="New chat"
            onClick={a.newChat}
          >
            <SquarePen className="h-[18px] w-[18px]" strokeWidth={1.5} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            title={a.shortcut ? `Close (${a.shortcut.title})` : 'Close'}
            aria-label="Close"
            onClick={close}
          >
            <X className="h-[18px] w-[18px]" strokeWidth={1.5} />
          </Button>
        </div>
      )}

      {!chat ? (
        <ThreadList phone={phone} />
      ) : a.setup === 'missing' ? (
        <NotSetUp />
      ) : (
        <MessageList phone={phone} onEdit={(card) => void edit(card)} />
      )}
      {chat ? <AssistantComposer phone={phone} /> : null}

      {editing ? (
        <MessageSheet
          key={editing.card.toolCallId}
          workspaceId={a.workspaceId}
          person={editing.person}
          channel={editing.channel}
          open
          onOpenChange={(open) => {
            if (!open) setEditing(null);
          }}
          initialText={editing.card.body ?? ''}
          initialSubject={editing.card.fields.find((f) => f.label === 'Subject')?.value}
          onSent={() => {
            void cancelToolCall(editing.card.toolCallId, a.workspaceId).catch(() => undefined);
            a.setCall(editing.card.toolCallId, {
              status: 'cancelled',
              note: 'You sent your own version instead.',
            });
          }}
        />
      ) : null}
    </>
  );
}

/** Beside the page (docked) or over its right edge (tablets, and the inbox below 1600 px). */
function SidePanel() {
  const a = useAssistant();
  const ref = useRef<HTMLElement>(null);
  const titleId = useId();

  // Focus goes back where it was when the panel closes.
  useEffect(() => {
    const before = document.activeElement;
    return () => {
      if (before instanceof HTMLElement && before.isConnected && before !== document.body)
        before.focus({ preventScroll: true });
    };
  }, []);

  function onKeyDown(e: KeyboardEvent<HTMLElement>) {
    // Dialogs and menus opened from the panel sit outside it and close themselves first.
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    if (!(e.target instanceof Node) || !ref.current?.contains(e.target)) return;
    e.preventDefault();
    a.setOpen(false);
  }

  return (
    <section
      ref={ref}
      role={a.docked ? 'complementary' : 'dialog'}
      aria-labelledby={titleId}
      data-testid="assistant-panel"
      onKeyDown={onKeyDown}
      className={
        a.docked
          ? 'sticky top-0 flex h-dvh w-[400px] flex-none flex-col self-start border-l border-border bg-card'
          : 'fixed inset-y-0 right-0 z-40 flex w-[400px] max-w-full flex-col border-l border-border bg-card shadow-3'
      }
    >
      <PanelContent phone={false} titleId={titleId} />
    </section>
  );
}

/**
 * The Assistant: docked 400 px beside the page from 1024 px wide (1600 px on the inbox), over the page
 * below that, and full screen on phones, where it's a modal dialog: focus stays inside, Escape closes it,
 * and focus goes back to the H in the header.
 */
export function AssistantPanel() {
  const a = useAssistant();
  const phone = useMatches('(max-width: 767.98px)');
  if (!a.enabled) return null;
  if (phone)
    return (
      <DialogPrimitive.Root open={a.open} onOpenChange={a.setOpen}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Content
            aria-describedby={undefined}
            data-testid="assistant-panel"
            onCloseAutoFocus={(e) => {
              // A tap doesn't always leave focus on the button, so say where it goes.
              e.preventDefault();
              a.triggerRef.current?.focus();
            }}
            className="fixed inset-0 z-50 flex flex-col bg-card focus:outline-none"
          >
            <PanelContent phone />
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    );
  return a.open ? <SidePanel /> : null;
}
