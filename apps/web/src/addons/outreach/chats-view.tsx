'use client';
/**
 * Social Outreach's Chats tab (docs/outreach.md, decision 3): the person's own chats brought in from Facebook's
 * download, as the AI read them: a short summary, the playbooks' tags that fit, whether they look like a prospect
 * and a next step. The likely prospects first, then the tagged, every chat read, and the ones not read yet; a tag
 * and a name narrow it. Which, the tag, the name and the page are in the address (./address.ts), so the page asks
 * HandsFreeOS for them. Who goes in Contacts is the business's setting, on the Add-ons page.
 */
import { ASK_WORDS, READ_CHATS_WORDS } from '@hfos/core/addons/outreach/asks';
import {
  CHAT_VIEW_KEYS,
  CHAT_VIEWS,
  CHATS_PAGE,
  CONTACTS_FROM_CHATS_WORDS,
  type ChatView,
} from '@hfos/core/addons/outreach/chat-read';
import { messengerChatUrl } from '@hfos/core/addons/outreach/waiting-words';
import { OUTREACH_WORDS as W } from '@hfos/core/addons/outreach/words';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useTransition } from 'react';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Segmented } from '@/components/ui/segmented';
import { useLiveRefresh } from '@/lib/realtime/live-provider';
import { cn } from '@/lib/utils';
import { outreachHref } from './address';
import { AskButton, ComputerNote } from './asks';
import { KeepChatButton } from './chat-keep';
import { dayWords, Pager, SearchBox } from './friends-view';
import { PersonMenu } from './person-menu';
import type { Asks, Chat, Chats } from './types';

/** How Read my chats goes, under its button and in the empty lists. */

const EMPTY = W.chatsEmpty;

export function ChatsView({
  workspaceId,
  chats,
  show,
  tag,
  search,
  canManage,
  asks,
}: {
  workspaceId: string;
  chats: Chats;
  show: ChatView;
  tag: string;
  search: string;
  /** Owners and admins change who goes in Contacts. */
  canManage: boolean;
  /** What the person asked their computer to do on this tab. */
  asks: Asks;
}) {
  // An ask's progress and end: the chats it read show once it ends.
  useLiveRefresh(['outreach_ask'], 800);
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  // What was last asked for, ahead of the address while it loads (as the Friends tab).
  const asked = useRef({ chats: show, tag, search });
  useEffect(() => {
    asked.current = { chats: show, tag, search };
  }, [show, tag, search]);
  const go = (to: { chats?: ChatView; tag?: string; search?: string; page?: number }) => {
    asked.current = {
      chats: to.chats ?? asked.current.chats,
      tag: to.tag ?? asked.current.tag,
      search: to.search ?? asked.current.search,
    };
    const href = outreachHref(workspaceId, { view: 'chats', ...asked.current, page: to.page ?? 1 });
    startTransition(() => router.replace(href, { scroll: false }));
  };
  const first = (chats.page - 1) * CHATS_PAGE + 1;
  return (
    <div data-testid="outreach-chats">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="max-w-full overflow-x-auto">
          <Segmented
            ariaLabel="Which chats"
            value={show}
            onChange={(v) => go({ chats: v })}
            options={CHAT_VIEW_KEYS.map((k) => ({
              value: k,
              label: (
                <>
                  {CHAT_VIEWS[k]}
                  <span className="tabular-nums text-text-3">
                    {chats.counts[k].toLocaleString()}
                  </span>
                </>
              ),
              testId: `chats-show-${k}`,
            }))}
          />
        </div>
        <SearchBox search={search} onSearch={(s) => go({ search: s })} />
      </div>
      <Card className="mb-4 p-4" data-testid="chats-asks">
        <ComputerNote asks={asks} className="mb-3" />
        <AskButton
          workspaceId={workspaceId}
          asks={asks}
          ask={{ kind: 'chats' }}
          label={ASK_WORDS.readChats}
          testId="ask-chats"
        />
        <p className="mt-2 text-[12.5px] text-text-3">{READ_CHATS_WORDS}</p>
      </Card>
      {chats.tags.length ? (
        <div
          className="mb-4 flex flex-wrap items-center gap-1.5"
          role="group"
          aria-label="Tags"
          data-testid="chats-tags"
        >
          {chats.tags.map((t) => {
            const on = t.name.toLowerCase() === tag.toLowerCase();
            return (
              <button
                key={t.name}
                type="button"
                aria-pressed={on}
                onClick={() => go({ tag: on ? '' : t.name })}
                className={cn(
                  'inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[12.5px] transition-colors max-md:h-9',
                  on
                    ? 'border-transparent bg-accent-soft text-accent-text'
                    : 'border-border-strong bg-card text-text-2 hover:text-text',
                )}
              >
                {t.name}
                <span className="tabular-nums text-text-3">{t.count.toLocaleString()}</span>
              </button>
            );
          })}
        </div>
      ) : null}
      <div
        className={cn(
          'grid gap-4 transition-opacity lg:grid-cols-[minmax(0,1fr)_300px]',
          pending && 'opacity-60',
        )}
        aria-busy={pending || undefined}
      >
        <div className="min-w-0">
          {chats.chats.length ? (
            <Card className="p-0" data-testid="chats-list">
              <div className="flex items-baseline justify-between gap-3 px-5 pt-4">
                <h3 className="text-[15px] font-semibold">
                  {CHAT_VIEWS[show]}
                  {tag ? ` · ${tag}` : ''}
                </h3>
                <span className="text-[12.5px] text-text-3">
                  The latest first
                  {chats.pages > 1
                    ? ` · ${first.toLocaleString()}–${(first + chats.chats.length - 1).toLocaleString()} of ${chats.total.toLocaleString()}`
                    : ''}
                </span>
              </div>
              <ul className="mt-2">
                {chats.chats.map((c) => (
                  <ChatRow key={c.chatId} workspaceId={workspaceId} chat={c} />
                ))}
              </ul>
              {chats.pages > 1 ? (
                <Pager page={chats.page} pages={chats.pages} onPage={(page) => go({ page })} />
              ) : null}
            </Card>
          ) : (
            <Card data-testid="chats-empty">
              {search || tag ? (
                <EmptyState title={W.chatsNoMatch.title}>{W.chatsNoMatch.body}</EmptyState>
              ) : (
                <EmptyState title={EMPTY[show].title}>{EMPTY[show].body}</EmptyState>
              )}
            </Card>
          )}
        </div>
        <aside className="space-y-4">
          <Card className="p-4" data-testid="chats-contacts">
            <h3 className="text-[15px] font-semibold">Who goes in Contacts</h3>
            <p className="mt-1.5 text-[13px] text-text-2">
              {CONTACTS_FROM_CHATS_WORDS[chats.contactsFromChats]}. Anyone already in Contacts gets
              the tags there too.{' '}
              {canManage ? (
                <Link
                  href={`/app/w/${workspaceId}/add-ons?addon=outreach`}
                  className="text-accent-text hover:underline"
                >
                  Change it in Add-ons
                </Link>
              ) : (
                'An owner or admin can change this in Add-ons.'
              )}
            </p>
          </Card>
          <Card className="p-4">
            <h3 className="text-[15px] font-semibold">Your chats are your own</h3>
            <p className="mt-1.5 text-[13px] text-text-2">
              Only you see your chats here. HandsFreeOS keeps each one’s latest 20 messages for the
              AI to read, and never sends anything on Facebook. Save to their card puts a chat on
              the customer’s card, where the business sees it. Newer messages come in when you press
              Read my chats, as you open chats with Read chats as I open them on in Settings, or
              when you bring your file in again.
            </p>
          </Card>
        </aside>
      </div>
    </div>
  );
}

function ChatRow({ workspaceId, chat: c }: { workspaceId: string; chat: Chat }) {
  const last = `Last message ${dayWords(c.lastAt)}, from ${c.lastFromMe ? 'you' : 'them'}`;
  return (
    <li className="border-t border-border px-5 py-3" data-testid="chat">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="min-w-0 text-[13.5px]">
          {c.personId ? (
            <Link
              href={`/app/w/${workspaceId}/customers/people/${c.personId}`}
              className="font-medium text-accent-text hover:underline"
            >
              {c.name}
            </Link>
          ) : (
            <span className="font-medium">{c.name}</span>
          )}
          <div className="text-[12.5px] text-text-3">
            {last} · {c.messages.toLocaleString()} {c.messages === 1 ? 'message' : 'messages'}
            {c.threadKey ? (
              <>
                {' · '}
                <a
                  href={messengerChatUrl(c.threadKey) ?? undefined}
                  target="_blank"
                  rel="noreferrer"
                  className="text-accent-text hover:underline"
                >
                  Open in Messenger
                </a>
              </>
            ) : null}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {c.prospect ? <Badge variant="ok">Likely prospect</Badge> : null}
          {c.personId ? <Badge variant="gray">{W.inContacts}</Badge> : null}
          {c.readState === 'waiting' ? <Badge variant="pending">Being read</Badge> : null}
          {c.readState === 'failed' ? <Badge variant="danger">Couldn’t read</Badge> : null}
          {c.onCard ? <Badge variant="gray">On their card</Badge> : null}
          <PersonMenu
            workspaceId={workspaceId}
            who={{ profileId: c.profileId, personId: c.personId, name: c.name }}
          />
        </div>
      </div>
      {c.summary ? (
        <p className="mt-1.5 text-[13px] text-text" data-testid="chat-summary">
          {c.summary}
        </p>
      ) : null}
      {c.nextStep ? (
        <p className="mt-1 text-[12.5px] text-text-2" data-testid="chat-next">
          Next: {c.nextStep}
        </p>
      ) : null}
      {c.tags.length ? (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {c.tags.map((t) => (
            <Badge key={t} variant="accent">
              {t}
            </Badge>
          ))}
        </div>
      ) : null}
      <div className="mt-1.5">
        <KeepChatButton
          workspaceId={workspaceId}
          chatId={c.chatId}
          name={c.name}
          onCard={c.onCard}
          withProfile={c.profileId !== null}
        />
      </div>
    </li>
  );
}
