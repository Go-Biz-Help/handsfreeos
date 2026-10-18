'use client';
/**
 * The portal's own pages (boards 27 and 31, design/realestate/PortalHome.dc.html and PortalMessages.dc.html): Home,
 * with each add-on's part of it and the newest message; Messages, the customer's thread with the business; Files,
 * what's been shared with them and what they added; and the door to an add-on's pages.
 */
import { ADDON_CATALOG, dayTime, PARTNER_PAGE_WORDS } from '@hfos/core';
import { Paperclip } from 'lucide-react';
import Link from 'next/link';
import { Suspense, useEffect, useRef, useState, type ComponentType } from 'react';
import { ADDON_UI } from '@/addons/registry';
import { AddonBoundary } from '@/components/addons/boundary';
import { lazyOnce } from '@/components/addons/lazy';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { cn, initials } from '@/lib/utils';
import { usePortal, usePortalAct, usePortalQuery } from './context';
import { PortalCardHead } from './ui';

interface PortalMessage {
  readonly id: string;
  readonly fromYou: boolean;
  readonly body: string;
  readonly at: string;
  readonly from: string | null;
  readonly seen: boolean;
}
interface PortalMessages {
  readonly conversationId: string | null;
  readonly messages: readonly PortalMessage[];
  readonly unread: number;
  readonly hasMore: boolean;
}
interface PortalFile {
  readonly id: string;
  readonly name: string;
  readonly recordId: string | null;
  readonly fromYou: boolean;
  readonly addedAt: string;
}

/** The customer's own zone, for times in their portal. */
const zone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

export function PortalHomePage() {
  const { home, href } = usePortal();
  const messages = usePortalQuery<PortalMessages>('portal.messages', {}, { every: 30_000 });
  const files = usePortalQuery<{ files: readonly PortalFile[] }>('portal.files');
  const last = [...(messages.data?.messages ?? [])].reverse().find((m) => !m.fromYou);
  const shared = (files.data?.files ?? []).filter((f) => !f.fromYou);
  return (
    <div className="space-y-4" data-testid="portal-home">
      <h1 className="text-[24px] font-semibold">Hi {home.person.firstName}</h1>
      {home.addons.map((a) => {
        const load = ADDON_UI[a.id]?.portal?.home;
        if (!load) return null;
        const Part = lazyOnce(load) as ComponentType;
        return (
          <AddonBoundary key={a.id} addonName={a.name}>
            <Suspense fallback={null}>
              <Part />
            </Suspense>
          </AddonBoundary>
        );
      })}
      {home.partner ? (
        <Link href={href('partner')} className="block" data-testid="portal-home-partner">
          <Card className="p-4 hover:bg-card-2">
            <PortalCardHead>{PARTNER_PAGE_WORDS.title}</PortalCardHead>
            <p className="text-[14px]">{PARTNER_PAGE_WORDS.homeCard(home.business.name)}</p>
          </Card>
        </Link>
      ) : null}
      <Link href={href('messages')} className="block" data-testid="portal-home-messages">
        <Card className="p-4 hover:bg-card-2">
          <PortalCardHead
            action={
              messages.data?.unread ? (
                <Badge variant="accent">{messages.data.unread} new</Badge>
              ) : null
            }
          >
            Messages
          </PortalCardHead>
          <p className="line-clamp-2 text-[14px]">
            {last ? (
              <>
                <span className="font-semibold">
                  {(last.from ?? home.business.name).split(' ')[0]}:
                </span>{' '}
                {last.body}
              </>
            ) : (
              <span className="text-text-2">Write to {home.business.name} any time.</span>
            )}
          </p>
        </Card>
      </Link>
      {shared.length ? (
        <Link href={href('files')} className="block">
          <Card className="p-4 hover:bg-card-2">
            <PortalCardHead>Shared with you</PortalCardHead>
            <p className="truncate text-[14px]">{shared.map((f) => f.name).join(' · ')}</p>
          </Card>
        </Link>
      ) : null}
    </div>
  );
}

export function PortalMessagesPage() {
  const { home, op } = usePortal();
  const { data, reload } = usePortalQuery<PortalMessages>('portal.messages', {}, { every: 10_000 });
  const [body, setBody] = useState('');
  const { busy, act } = usePortalAct(reload);
  const end = useRef<HTMLDivElement>(null);
  const list = data?.messages ?? [];
  const agent = [...list].reverse().find((m) => !m.fromYou && m.from)?.from ?? null;
  const newest = [...list].reverse().find((m) => !m.fromYou);
  // What they've now seen of the business's messages.
  useEffect(() => {
    if (data?.conversationId && data.unread > 0 && newest)
      void op('portal.mark_read', {
        conversationId: data.conversationId,
        throughMessageId: newest.id,
      }).catch(() => null);
  }, [data?.conversationId, data?.unread, newest, op]);
  // A block, so the effect returns nothing: newer browsers' scrollIntoView returns a promise, which React refuses.
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [list.length]);
  const send = () =>
    act('send', async () => {
      await op('portal.message_send', { body, clientId: crypto.randomUUID() });
      setBody('');
    });
  return (
    <div className="flex min-h-[calc(100dvh-14rem)] flex-col" data-testid="portal-messages">
      <div className="mb-4 flex items-center gap-3">
        <span className="inline-flex h-10 w-10 flex-none items-center justify-center rounded-full bg-accent text-[13px] font-semibold text-white">
          {initials(agent ?? home.business.name)}
        </span>
        <div className="min-w-0">
          <div className="truncate text-[15px] font-semibold">{agent ?? home.business.name}</div>
          <div className="truncate text-[12.5px] text-text-2">
            {agent ? `${home.business.name} · ` : ''}seen only by the people on your deals
          </div>
        </div>
      </div>
      <ol className="flex-1 space-y-2.5">
        {list.length === 0 ? (
          <li className="text-[14px] text-text-2">
            No messages yet. Write to {home.business.name} below; you’ll get an email when they
            answer.
          </li>
        ) : null}
        {list.map((m) => (
          <li key={m.id} className={cn('flex', m.fromYou ? 'justify-end' : 'justify-start')}>
            <div
              className={cn(
                'max-w-[82%] whitespace-pre-wrap rounded-[14px] px-3.5 py-2.5 text-[14px]',
                m.fromYou ? 'bg-accent text-white' : 'bg-card-2 text-text',
              )}
              title={dayTime(m.at, zone())}
            >
              {m.body}
            </div>
          </li>
        ))}
        <div ref={end} />
      </ol>
      <form
        className="sticky bottom-20 mt-4 flex gap-2 bg-bg py-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (body.trim()) void send();
        }}
      >
        <Input
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder={`Write to ${agent?.split(' ')[0] ?? home.business.name}…`}
          aria-label="Your message"
          maxLength={4000}
          data-testid="portal-message-input"
        />
        <Button
          type="submit"
          loading={busy === 'send'}
          disabled={!body.trim()}
          data-testid="portal-message-send"
        >
          Send
        </Button>
      </form>
    </div>
  );
}

export function PortalFilesPage() {
  const { openFile } = usePortal();
  const { data } = usePortalQuery<{ files: readonly PortalFile[] }>('portal.files');
  const { busy, act } = usePortalAct();
  const files = data?.files ?? [];
  return (
    <div className="space-y-4" data-testid="portal-files">
      <h1 className="text-[22px] font-semibold">Files</h1>
      <Card className="p-0">
        {files.length === 0 ? (
          <p className="p-4 text-[14px] text-text-2">Nothing shared with you yet.</p>
        ) : (
          <ul>
            {files.map((f) => (
              <li key={f.id} className="border-b border-border last:border-b-0">
                <button
                  type="button"
                  className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-card-2"
                  disabled={busy === f.id}
                  onClick={() => void act(f.id, () => openFile(f.id))}
                >
                  <Paperclip className="h-4 w-4 flex-none text-text-3" strokeWidth={1.75} />
                  <span className="min-w-0 flex-1 truncate text-[14px]">{f.name}</span>
                  <span className="text-[12.5px] text-text-3">
                    {f.fromYou ? 'From you' : 'Shared with you'}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

/** Whether a path is one of the add-on's declared portal pages ("deals/:dealId" matches "deals/<id>"). */
function declared(addonId: string, path: readonly string[]): boolean {
  const pages = ADDON_CATALOG.find((a) => a.id === addonId)?.ui?.portal ?? [];
  return pages.some((p) => {
    const want = p.path ? p.path.split('/') : [];
    return (
      want.length === path.length &&
      want.every((w, i) => (w.startsWith(':') ? /^[0-9a-f-]{36}$/i.test(path[i]!) : w === path[i]))
    );
  });
}

/** An add-on's portal page (`a/<id>/<path>`): one it declares, for a customer it has records for. */
export function PortalAddonPage({ addonId, path }: { addonId: string; path: readonly string[] }) {
  const { home, href } = usePortal();
  const addon = home.addons.find((a) => a.id === addonId);
  const load = ADDON_UI[addonId]?.portal?.pages;
  if (!addon || !load || !declared(addonId, path))
    return (
      <Card className="p-5 text-[14px]" data-testid="portal-not-found">
        This page isn’t in your portal.{' '}
        <Link href={href()} className="text-accent-text hover:underline">
          Go to your portal’s home
        </Link>
        .
      </Card>
    );
  const Pages = lazyOnce(load);
  return (
    <AddonBoundary addonName={addon.name}>
      <Suspense fallback={<p className="text-[14px] text-text-2">Opening…</p>}>
        <Pages path={path} />
      </Suspense>
    </AddonBoundary>
  );
}
