'use client';
/**
 * Social Outreach's panel on a customer's page: the Facebook profile the extension saved for them, and the chats
 * saved with them, newest messages last. Drawn by <AddonSlot> only while the add-on runs and for people with
 * `outreach.use`; a customer nobody saved from Facebook shows nothing.
 */
import { PLATFORMS, type Platform } from '@hfos/core/addons/outreach/playbooks';
import { Handshake } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { cn, relativeTime } from '@/lib/utils';
import type { SlotProps } from '../registry';
import type { PersonSocial } from './types';

const FRIENDSHIP: Record<string, string | null> = {
  friends: 'Friends',
  request_sent: 'Friend request sent',
  request_received: 'They sent a friend request',
  not_friends: 'Not friends',
  unknown: null,
};

/** A chat shows this many of its latest messages until it's opened up. */
const LATEST = 4;

export default function PersonPanel({ workspaceId, personId }: SlotProps<'person.panels'>) {
  const [social, setSocial] = useState<PersonSocial | null>(null);
  useEffect(() => {
    let live = true;
    void apiBrowser()
      .POST('/v1/queries/outreach.person', { body: { workspaceId, personId } })
      .then(unwrap)
      .then((s) => live && setSocial(s))
      .catch(() => live && setSocial({ profiles: [], chats: [] }));
    return () => {
      live = false;
    };
  }, [workspaceId, personId]);

  if (!social || (social.profiles.length === 0 && social.chats.length === 0)) return null;
  return (
    <Card className="p-4 md:p-5" data-testid="outreach-panel">
      <h3 className="mb-2.5 flex items-center gap-2 text-[15px] font-semibold">
        <Handshake className="h-4 w-4 text-accent-text" strokeWidth={1.75} />
        Social
      </h3>
      <div className="space-y-3">
        {social.profiles.map((p) => (
          <div key={p.id} className="text-[13.5px]">
            <div className="flex flex-wrap items-center gap-2">
              <a
                href={p.url}
                target="_blank"
                rel="noreferrer"
                className="font-medium text-accent-text hover:underline"
              >
                {p.name} on {PLATFORMS[p.platform as Platform]}
              </a>
              {FRIENDSHIP[p.friendship] ? <Badge>{FRIENDSHIP[p.friendship]}</Badge> : null}
            </div>
            {p.intro.length ? (
              <ul className="mt-1 text-[13px] text-text-2">
                {p.intro.slice(0, 4).map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            ) : null}
            <div className="mt-0.5 text-[12px] text-text-3">
              {p.mutualFriends !== null ? `${p.mutualFriends} mutual friends · ` : ''}
              Seen {relativeTime(p.lastSeenAt)}
            </div>
          </div>
        ))}
        {social.chats.map((c) => (
          <Chat key={c.id} chat={c} />
        ))}
      </div>
    </Card>
  );
}

function Chat({ chat }: { chat: PersonSocial['chats'][number] }) {
  const [all, setAll] = useState(false);
  const shown = all ? chat.messages : chat.messages.slice(-LATEST);
  return (
    <div className="border-t border-border pt-3 text-[13.5px]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <a
          href={chat.url}
          target="_blank"
          rel="noreferrer"
          className="font-medium text-accent-text hover:underline"
        >
          {PLATFORMS[chat.platform as Platform]} chat
        </a>
        <span className="text-[12px] text-text-3">
          {chat.ownerName ? `${chat.ownerName}’s · ` : ''}saved {relativeTime(chat.lastSavedAt)}
        </span>
      </div>
      <ul className="mt-2 space-y-1.5">
        {shown.map((m, i) => (
          <li
            key={`${i}-${m.savedAt}`}
            className={cn(
              'max-w-[90%] rounded-card px-2.5 py-1.5',
              m.from === 'me' ? 'ml-auto bg-accent-soft' : 'bg-card-2',
            )}
          >
            <div className="text-[11.5px] text-text-3">
              {m.from === 'me' ? (chat.ownerName ?? 'You') : (m.sender ?? 'Them')}
              {m.when ? ` · ${m.when}` : ''}
            </div>
            <div className="whitespace-pre-wrap">{m.text}</div>
          </li>
        ))}
      </ul>
      {chat.messages.length > LATEST ? (
        <button
          type="button"
          className="mt-1.5 text-[12.5px] text-accent-text hover:underline"
          onClick={() => setAll(!all)}
        >
          {all ? 'Show the latest only' : `Show all ${chat.messages.length}`}
        </button>
      ) : null}
    </div>
  );
}
