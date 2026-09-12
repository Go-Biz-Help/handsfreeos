'use client';
import { Mail, MessageCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Card } from '@/components/ui/card';
import { apiBrowser, unwrap } from '@/lib/api/client';
import type { ConversationSummary } from '@/lib/api/types';
import { minutesWaiting } from '@/lib/inbox';
import { useLiveVersion } from '@/lib/realtime/live-provider';
import { useUnread } from '@/lib/realtime/unread-provider';
import { ChannelIcon, WaitChip } from './bits';
import { firstName } from './conversation-row';

/** On the customer's page: their conversations, one per channel; a click opens the message sheet in that channel. */
export function ConversationsCard({
  workspaceId,
  person,
  onOpen,
}: {
  workspaceId: string;
  person: { id: string; fullName: string; phoneE164: string | null; email?: string | null };
  onOpen: (channel: 'sms' | 'email') => void;
}) {
  const live = useLiveVersion(['conversation', 'message'], 300);
  const threshold = useUnread().summary?.waitingThresholdMinutes ?? 10;
  const [items, setItems] = useState<ConversationSummary[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiBrowser()
      .POST('/v1/queries/inbox.list', {
        body: { workspaceId, personId: person.id, box: 'all', limit: 5 },
      })
      .then((r) => {
        if (!cancelled) setItems(unwrap(r).items.filter((c) => c.lastMessageAt));
      })
      .catch(() => {
        if (!cancelled) setItems([]);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, person.id, live]);

  return (
    <Card className="px-5 py-[18px]" data-testid="conversations-card">
      <h3 className="mb-2 text-[15px] font-semibold">Conversations</h3>
      {items === null ? (
        <div className="text-[13px] text-text-3">Loading…</div>
      ) : items.length === 0 ? (
        <div className="text-[13px] text-text-3">
          {person.email ? 'No messages yet.' : 'No texts yet.'}
          {person.phoneE164 ? (
            <>
              {' '}
              <button
                type="button"
                onClick={() => onOpen('sms')}
                className="font-medium text-accent-text hover:underline"
              >
                Text {firstName(person.fullName)}
              </button>
            </>
          ) : null}
          {person.email ? (
            <>
              {person.phoneE164 ? ' or ' : ' '}
              <button
                type="button"
                onClick={() => onOpen('email')}
                className="font-medium text-accent-text hover:underline"
              >
                {person.phoneE164 ? 'email' : 'Email'}{' '}
                {person.phoneE164 ? 'them' : firstName(person.fullName)}
              </button>
            </>
          ) : null}
        </div>
      ) : (
        <div className="-mx-2.5 flex flex-col gap-0.5">
          {items.map((c) => {
            const waited = c.status === 'open' ? minutesWaiting(c.awaitingReplySince) : null;
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => onOpen(c.channel)}
                data-testid={`customer-conversation-${c.id}`}
                className="flex items-start gap-2.5 rounded-[6px] p-2.5 text-left hover:bg-card-2"
              >
                <ChannelIcon icon={c.channel === 'email' ? Mail : MessageCircle} />
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-medium">
                    {c.channel === 'email'
                      ? `Email · ${c.counterpart}`
                      : `Texts · ${c.counterpartDisplay}`}
                  </span>
                  <span className="block truncate text-xs text-text-3">{c.lastPreview}</span>
                </span>
                {waited !== null && waited >= threshold ? <WaitChip minutes={waited} /> : null}
              </button>
            );
          })}
        </div>
      )}
    </Card>
  );
}
