'use client';
import { BELL_WORDS as W, bellTime } from '@hfos/core';
import { Bell, ChevronRight } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import type { BellItem } from '@/lib/api/types';
import { useNotifications, type BellAlert } from '@/lib/realtime/notifications-provider';
import { cn } from '@/lib/utils';
import { useWorkspaceShell } from './workspace-shell';

const IN_A_BUSINESS = /^\/app\/w\/[0-9a-f-]{36}(?=[/?#]|$)/;

/**
 * Where the web opens a notification's path: the business's page, or the support desk. Null for one only the phone
 * opens (a sign-in to the extension, which the web asks about on its own).
 */
export function webHrefOf(path: string): string | null {
  return IN_A_BUSINESS.test(path) || /^\/admin(?=[/?#]|$)/.test(path) ? path : null;
}

/**
 * The bell (20261027012600, packages/core/src/bell.ts): at the top of the side menu, and beside Ask HandsFreeOS in
 * the phone-width header, for this business only. Its count is what's new here. Its sheet keeps the add-ons' alerts
 * still open at the top, under Needs you, then lists what HandsFreeOS sent to the person's phones about this business
 * in the last 30 days (and their own about no business), newest first, the unread ones marked. Opening it sees them;
 * pressing one reads it and opens its page.
 */
export function NotificationsBell({ variant }: { variant: 'sidebar' | 'header' }) {
  const n = useNotifications();
  const { workspaceId } = useWorkspaceShell();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  if (!n.enabled) return null;

  const show = (next: boolean) => {
    setOpen(next);
    n.seeAll();
    if (!next) n.reset();
  };
  const go = (href: string) => {
    show(false);
    router.push(href);
  };
  const press = (item: BellItem) => {
    n.read(item);
    const href = webHrefOf(item.path);
    if (href) go(href);
  };
  const empty = n.loaded && n.list.length === 0 && n.alerts.length === 0;
  const now = Date.now();
  const header = variant === 'header';

  return (
    <>
      <button
        type="button"
        aria-label={W.label(n.count)}
        title={W.title}
        data-testid={header ? 'mobile-bell' : 'bell-button'}
        onClick={() => show(true)}
        className={cn(
          'relative flex flex-none items-center justify-center rounded-control text-text-2 hover:bg-card-2 hover:text-text focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring',
          header ? 'h-11 w-11' : 'h-8 w-8',
        )}
      >
        <Bell className={header ? 'h-5 w-5' : 'h-[18px] w-[18px]'} strokeWidth={1.5} />
        {n.count > 0 ? (
          <span
            aria-hidden
            data-testid="bell-count"
            className={cn(
              'absolute inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[10px] font-semibold leading-none text-on-solid ring-2 ring-card',
              header ? 'right-1.5 top-1.5' : '-right-1 -top-1',
            )}
          >
            {n.count > 9 ? '9+' : n.count}
          </span>
        ) : null}
      </button>
      <Sheet open={open} onOpenChange={show}>
        <SheetContent title={W.title} description={empty || !n.loaded ? undefined : W.about}>
          {n.failed ? (
            <p role="alert" className="py-6 text-center text-sm text-text-2">
              {W.failed}
            </p>
          ) : empty ? (
            <p data-testid="bell-none" className="py-6 text-center text-sm text-text-2">
              {W.none}
            </p>
          ) : (
            <div className="-mx-2 flex flex-col" data-testid="bell-list">
              {n.alerts.length > 0 ? (
                <>
                  <h3 className="px-2 pb-2 text-xs font-semibold uppercase tracking-[0.5px] text-text-3">
                    {W.needsYou}
                  </h3>
                  <div className="flex flex-col gap-2 px-2">
                    {n.alerts.map((a) => (
                      <AlertRow
                        key={a.id}
                        alert={a}
                        onPress={() => go(`/app/w/${workspaceId}${a.href}`)}
                      />
                    ))}
                  </div>
                  {n.list.length > 0 ? (
                    <h3 className="px-2 pb-1 pt-5 text-xs font-semibold uppercase tracking-[0.5px] text-text-3">
                      {W.recent}
                    </h3>
                  ) : null}
                </>
              ) : null}
              {n.list.map((item) => (
                <NotificationRow
                  key={item.id}
                  item={item}
                  unread={!n.isRead(item)}
                  now={now}
                  onPress={() => press(item)}
                />
              ))}
              {n.more ? (
                <Button
                  variant="ghost"
                  className="mx-2 mt-1"
                  onClick={n.loadOlder}
                  data-testid="bell-older"
                >
                  {W.older}
                </Button>
              ) : null}
            </div>
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}

function AlertRow({ alert: a, onPress }: { alert: BellAlert; onPress: () => void }) {
  return (
    <button
      type="button"
      onClick={onPress}
      data-testid="bell-alert"
      className="flex w-full items-center gap-3 rounded-card border border-border bg-card px-3.5 py-3 text-left hover:bg-card-2 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring"
    >
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-[11px] font-semibold uppercase tracking-[0.4px] text-text-3">
          {a.addonName}
        </span>
        <span className="text-sm font-semibold">{a.title}</span>
        {a.detail ? <span className="text-[13px] text-text-2">{a.detail}</span> : null}
      </span>
      <ChevronRight className="h-[18px] w-[18px] flex-none text-text-3" strokeWidth={1.5} />
    </button>
  );
}

/** One notification: its words as the push said them (the subtitle names the business), and when it came. */
function NotificationRow({
  item,
  unread,
  now,
  onPress,
}: {
  item: BellItem;
  unread: boolean;
  now: number;
  onPress: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onPress}
      data-testid="bell-item"
      className={cn(
        'flex w-full gap-2.5 rounded-control px-2 py-2.5 text-left hover:bg-card-2 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring',
        unread && 'bg-accent-soft hover:bg-accent-soft-2',
      )}
    >
      <span className="flex w-2 flex-none justify-center pt-[7px]">
        {unread ? (
          <span data-testid="bell-unread" className="h-2 w-2 rounded-full bg-accent">
            <span className="sr-only">{W.unread}</span>
          </span>
        ) : null}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-baseline gap-2">
          <span
            className={cn(
              'min-w-0 flex-1 truncate text-sm',
              unread ? 'font-semibold' : 'font-medium',
            )}
          >
            {item.title}
          </span>
          <span
            className={cn(
              'flex-none text-xs',
              unread ? 'font-semibold text-accent-text' : 'text-text-3',
            )}
          >
            {bellTime(item.sentAt, now)}
          </span>
        </span>
        {item.subtitle ? (
          <span className="truncate text-xs text-text-3">{item.subtitle}</span>
        ) : null}
        <span
          className={cn('mt-0.5 line-clamp-2 text-[13px]', unread ? 'text-text' : 'text-text-2')}
        >
          {item.body}
        </span>
      </span>
    </button>
  );
}
