'use client';
/**
 * **Save to their card** (docs/outreach.md, "A chat saves to"): a chat brought in on the Chats tab, or the one a reply
 * waiting for the person answers, copied onto the customer's Social card (`outreach.chat.keep`). Nothing is read on
 * Facebook for it. When nobody in Contacts is them yet, customers with the same name are offered first
 * (./same-name.tsx), as Add to Contacts does; with none, they're added.
 */
import { MessageSquare } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { ApiError, apiBrowser, unwrap } from '@/lib/api/client';
import { SameNameDialog, sameNamesFor, type SameName } from './same-name';
import { useAct } from './use-act';

type Kept = { personName: string; addedPerson: boolean; added: number };

function keptWords(k: Kept): string {
  if (k.addedPerson) return `${k.personName} is in Contacts now, with your chat on their card.`;
  if (!k.added) return `${k.personName}’s card has every message from this chat already.`;
  return `Saved ${k.added} ${k.added === 1 ? 'message' : 'messages'} to ${k.personName}’s card.`;
}

export function KeepChatButton({
  workspaceId,
  chatId,
  name,
  onCard = false,
  withProfile,
}: {
  workspaceId: string;
  chatId: string;
  /** Who the chat is with, as it shows them. */
  name: string;
  /** Saved to their card before: pressing it again adds what's new. */
  onCard?: boolean;
  /** The chat is with someone kept as a profile: a customer with a Facebook profile of their own is someone else. */
  withProfile: boolean;
}) {
  const { busy, act } = useAct();
  const [same, setSame] = useState<readonly SameName[] | null>(null);
  const keep = async (who: { personId?: string; add?: boolean }) => {
    const kept = unwrap(
      await apiBrowser().POST('/v1/commands/outreach.chat.keep', {
        body: { workspaceId, chatId, ...who },
      }),
    );
    setSame(null);
    toast.success(keptWords(kept));
  };
  const start = () =>
    void act('keep', async () => {
      try {
        await keep({});
      } catch (e) {
        // Nobody in Contacts is them yet: the same name first, else someone new.
        if (!(e instanceof ApiError) || e.rule !== 'outreach_chat_who') throw e;
        const people = await sameNamesFor(workspaceId, name, { withoutProfile: withProfile });
        if (people.length) setSame(people);
        else await keep({ add: true });
      }
    });
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        disabled={busy !== null}
        loading={busy === 'keep'}
        onClick={start}
        data-testid="chat-keep"
      >
        <MessageSquare className="h-3.5 w-3.5" strokeWidth={1.5} />
        {onCard ? 'Update their card' : 'Save to their card'}
      </Button>
      {same ? (
        <SameNameDialog
          name={name}
          people={same}
          busy={busy !== null}
          onPick={(personId) => void act('keep', () => keep({ personId }))}
          onNew={() => void act('keep', () => keep({ add: true }))}
          onClose={() => setSame(null)}
        />
      ) : null}
    </>
  );
}
