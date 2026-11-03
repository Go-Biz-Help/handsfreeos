/**
 * Forms → Website chats: every chat button the business has, the texting registration's one included, each opening
 * the same editor (its sites, who answers, look, where its button sits on phones and computers, what it asks for).
 * Shown to people who may change chats (channels.manage); a business without one is offered to set one up.
 */
import { Check, MessageCircle, Plus } from 'lucide-react';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { buttonClassName } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import type { ChatWidget } from '@/lib/api/types';

const shown = (origin: string) => origin.replace(/^https:\/\//, '');

/** The sites a chat shows on, as people typed them: www twins left out, at most two and a count. */
function sitesLine(origins: readonly string[]): string {
  const bare = origins.filter(
    (o) =>
      !(o.startsWith('https://www.') && origins.includes(o.replace('https://www.', 'https://'))),
  );
  const first = bare.slice(0, 2).map(shown).join(', ');
  return bare.length > 2 ? `${first} and ${bare.length - 2} more` : first;
}

function placeLine(w: ChatWidget): string {
  const corner = (p: 'left' | 'right') => (p === 'left' ? 'bottom left' : 'bottom right');
  const { desktop, mobile } = w.placement;
  const phone =
    mobile.button === 'hidden'
      ? 'hidden on phones'
      : mobile.position === desktop.position && mobile.lift === desktop.lift
        ? null
        : `${corner(mobile.position)}${mobile.lift ? `, ${mobile.lift} px up` : ''} on phones`;
  const computer = `${corner(desktop.position)}${desktop.lift ? `, ${desktop.lift} px up` : ''}`;
  return phone ? `${computer} on computers, ${phone}` : computer;
}

export function WebsiteChats({
  workspaceId,
  items,
}: {
  workspaceId: string;
  items: readonly ChatWidget[];
}) {
  const base = `/app/w/${workspaceId}/forms/chats`;
  return (
    <section id="website-chats" className="mb-6 scroll-mt-20" data-testid="website-chats">
      <div className="mb-2.5 flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold tracking-tight">Website chats</h2>
          <p className="text-[13px] text-text-2">
            The chat buttons on your websites. Each one’s look, where it sits on phones and
            computers, and what it asks visitors for.
          </p>
        </div>
        <Link
          href={`${base}/new`}
          className={buttonClassName({ variant: 'secondary', size: 'sm' })}
          data-testid="website-chat-new"
        >
          <Plus className="h-4 w-4" aria-hidden />
          New website chat
        </Link>
      </div>
      {items.length ? (
        <Card className="divide-y divide-border">
          {items.map((w) => (
            <Link
              key={w.id}
              href={`${base}/${w.id}`}
              className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-card-2 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-ring"
              data-testid="website-chat-row"
            >
              <span
                aria-hidden
                className="inline-flex h-9 w-9 flex-none items-center justify-center rounded-full"
                style={{ background: w.accentColor, color: w.textColor }}
              >
                <MessageCircle className="h-[18px] w-[18px]" />
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-[14px] font-medium">{w.name}</span>
                <span className="truncate text-xs text-text-3">
                  {sitesLine(w.allowedOrigins)} · {placeLine(w)}
                </span>
              </span>
              <span className="hidden flex-none flex-wrap items-center justify-end gap-1.5 sm:flex">
                {w.smsConsent ? <Badge variant="gray">Texts box</Badge> : null}
                {w.install.seen ? (
                  <Badge variant="ok">
                    <Check className="h-3.5 w-3.5" aria-hidden />
                    On your site
                  </Badge>
                ) : (
                  <Badge variant="gray">Not seen yet</Badge>
                )}
                {w.paused ? <Badge variant="pending">Paused</Badge> : null}
              </span>
            </Link>
          ))}
        </Card>
      ) : (
        <Card className="flex items-center gap-3 px-4 py-4 text-[13.5px] text-text-2">
          <MessageCircle className="h-5 w-5 flex-none text-text-3" aria-hidden />
          No website chat yet. Set one up, then paste its snippet on your site.
        </Card>
      )}
    </section>
  );
}
