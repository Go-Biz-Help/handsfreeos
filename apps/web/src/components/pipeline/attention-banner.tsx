'use client';
/**
 * The lead page's Action Center banner (M8): the top open item about this lead ("Hot lead · waiting 11 min"), its
 * reasons, and the main Handle action for its kind, with Snooze and Dismiss in the ⋯ menu (each with Undo). Letting
 * HandsFreeOS handle it is on Home, which the menu opens. Styled like Home's card (design/m8 Cards).
 */
import { addDays, chipText, localInstant } from '@hfos/core';
import {
  AlarmClock,
  CalendarClock,
  EyeOff,
  House,
  ListChecks,
  Mail,
  MessageCircle,
  MoreHorizontal,
  Phone,
  Signpost,
  Sparkles,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import {
  KIND_WORD,
  KindTile,
  ReasonChip,
  timeChipOf,
  useRecordAttention,
  useTick,
} from '@/components/attention/bits';
import { MessageSheet } from '@/components/inbox/message-sheet';
import { Avatar } from '@/components/ui/avatar';
import { Button, ButtonLink } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import { fmtTime, todayIn } from '@/lib/calendar/time';
import { useCalls } from '@/lib/calls/call-provider';
import { telHref } from '@/lib/format';
import { cn } from '@/lib/utils';

const firstOf = (name: string) => name.trim().split(/\s+/)[0] ?? name;

interface Contact {
  readonly phone: string | null;
  readonly phoneE164: string | null;
  readonly email: string | null;
}

export function AttentionBanner({
  workspaceId,
  leadId,
  person,
  timeZone,
  onSetNextAction,
  onOpenAppointment,
  className,
}: {
  workspaceId: string;
  leadId: string;
  person: { readonly id: string; readonly fullName: string } | null;
  /** The workspace's zone, for "tomorrow morning"; the browser's when not given. */
  timeZone?: string;
  /** No next action: the lead page's own dialog. */
  onSetNextAction?: () => void;
  /** Not confirmed: the lead page's appointment sheet, where it can be marked confirmed. */
  onOpenAppointment?: (appointmentId: string) => void;
  className?: string;
}) {
  const router = useRouter();
  const calls = useCalls();
  const now = useTick(30_000);
  const { items, reload } = useRecordAttention(workspaceId, 'lead', leadId);
  const [contact, setContact] = useState<Contact | null>(null);
  const [message, setMessage] = useState<'sms' | 'email' | null>(null);
  const item = items[0] ?? null;
  const personId = person?.id ?? null;
  // The item says which channel it would use; the customer's number or address comes from their record.
  const reaches = item?.reach === 'sms' || item?.reach === 'email';

  useEffect(() => {
    if (!reaches || !personId) return;
    let live = true;
    apiBrowser()
      .POST('/v1/queries/person.get', { body: { workspaceId, personId } })
      .then((r) => {
        const p = r.data?.person;
        if (live && p) setContact({ phone: p.phone, phoneE164: p.phoneE164, email: p.email });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [reaches, workspaceId, personId]);

  if (!item) return null;

  const tz = timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const home = `/app/w/${workspaceId}`;
  const inbox = item.conversationId ? `/app/w/${workspaceId}/inbox/${item.conversationId}` : null;
  const name = person ? firstOf(person.fullName) : 'them';
  const phone = contact?.phoneE164 ?? contact?.phone ?? null;
  const time = timeChipOf(item);
  const chips = item.reasons.filter((r) => r !== time).slice(0, 3);

  async function restore() {
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/attention.restore', {
          body: { workspaceId, itemId: item!.id },
        }),
      );
      toast.success('It’s back on Home.');
      reload();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  async function snooze(until: number, words: string) {
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/attention.snooze', {
          body: { workspaceId, itemId: item!.id, until: new Date(until).toISOString() },
        }),
      );
      toast.success(`Snoozed ${words}.`, {
        action: { label: 'Undo', onClick: () => void restore() },
      });
      reload();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  async function dismiss() {
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/attention.dismiss', {
          body: { workspaceId, itemId: item!.id, reason: null },
        }),
      );
      toast.success('Dismissed. It comes back only if something changes.', {
        action: { label: 'Undo', onClick: () => void restore() },
      });
      reload();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  const call = () => {
    if (!phone || !person) return;
    if (calls.available) calls.openDialer({ name: person.fullName, phone, personId: person.id });
    else window.location.href = telHref(phone) ?? '#';
  };
  const tall = 'max-sm:h-11 max-sm:text-[14.5px]';
  const testId = 'attention-banner-handle';
  /** A new message on the channel the item would use. */
  const write = () => {
    const email = item.reach === 'email' || (!phone && !!contact?.email);
    if (email && contact?.email)
      return (
        <Button size="sm" className={tall} onClick={() => setMessage('email')} data-testid={testId}>
          <Mail className="h-3.5 w-3.5" strokeWidth={1.5} />
          Email {name}
        </Button>
      );
    return phone ? (
      <Button size="sm" className={tall} onClick={() => setMessage('sms')} data-testid={testId}>
        <MessageCircle className="h-3.5 w-3.5" strokeWidth={1.5} />
        Text {name}
      </Button>
    ) : null;
  };
  /** The conversation, when the item would answer where they wrote; otherwise a new message. */
  const reply = (label: string) =>
    inbox && item.reach !== 'email' ? (
      <ButtonLink href={inbox} variant="primary" size="sm" className={tall} data-testid={testId}>
        <MessageCircle className="h-3.5 w-3.5" strokeWidth={1.5} />
        {label}
      </ButtonLink>
    ) : (
      write()
    );

  let handle: ReactNode = null;
  if (item.actions.handle)
    switch (item.kind) {
      case 'hot_lead':
        handle = phone ? (
          <Button size="sm" className={tall} onClick={call} data-testid={testId}>
            <Phone className="h-3.5 w-3.5" strokeWidth={1.5} />
            Call {name}
          </Button>
        ) : (
          reply('Reply')
        );
        break;
      case 'unanswered_lead':
      case 'customer_waiting':
        handle = reply('Reply');
        break;
      case 'stale_opportunity':
        handle = reply('Follow up');
        break;
      case 'missing_next_action':
        handle = onSetNextAction ? (
          <Button size="sm" className={tall} onClick={onSetNextAction} data-testid={testId}>
            <Signpost className="h-3.5 w-3.5" strokeWidth={1.5} />
            Set next action
          </Button>
        ) : null;
        break;
      case 'unconfirmed_appointment':
        handle =
          item.appointmentId && onOpenAppointment ? (
            <Button
              size="sm"
              className={tall}
              onClick={() => onOpenAppointment(item.appointmentId!)}
              data-testid={testId}
            >
              <CalendarClock className="h-3.5 w-3.5" strokeWidth={1.5} />
              Open the visit
            </Button>
          ) : null;
        break;
      case 'overdue_task':
        handle = (
          <Button
            size="sm"
            className={tall}
            data-testid={testId}
            onClick={() =>
              document.getElementById('lead-tasks')?.scrollIntoView({ behavior: 'smooth' })
            }
          >
            <ListChecks className="h-3.5 w-3.5" strokeWidth={1.5} />
            Open task
          </Button>
        );
        break;
      case 'ai_approval':
        handle = (
          <ButtonLink
            href={`/app/w/${workspaceId}/workflows/approvals`}
            variant="primary"
            size="sm"
            className={tall}
            data-testid={testId}
          >
            <Sparkles className="h-3.5 w-3.5" strokeWidth={1.5} />
            Review
          </ButtonLink>
        );
        break;
      default:
        handle = (
          <ButtonLink href={home} variant="primary" size="sm" className={tall} data-testid={testId}>
            {item.handleLabel} on Home
          </ButtonLink>
        );
    }

  const tomorrowMorning = localInstant(addDays(todayIn(tz), 1), '08:00', tz);

  return (
    <>
      <div
        className={cn(
          'flex flex-col gap-[3px] rounded-card border bg-card px-3.5 py-3 shadow-1',
          item.urgent
            ? 'border-[color-mix(in_oklab,var(--danger)_42%,var(--border))] shadow-[0_0_0_3px_color-mix(in_oklab,var(--danger-soft)_70%,transparent),var(--shadow-1)]'
            : 'border-border',
          className,
        )}
        role="status"
        data-testid="attention-banner"
        data-kind={item.kind}
        data-urgent={item.urgent || undefined}
      >
        <div className="flex min-w-0 items-center gap-3">
          <KindTile kind={item.kind} />
          <span
            className="min-w-0 flex-1 truncate text-[14.5px] font-semibold leading-[1.3]"
            data-testid="attention-banner-title"
          >
            {KIND_WORD[item.kind]}
            {time ? (
              <span className="font-normal text-text-2"> · {chipText(time, now)}</span>
            ) : null}
          </span>
          {item.assignee ? (
            <span title={item.assignee.fullName} className="flex-none">
              <Avatar name={item.assignee.fullName} seed={item.assignee.id} size="sm" />
            </span>
          ) : null}
        </div>
        {item.detail ? (
          <div className="truncate text-[13px] leading-[1.45] text-text-2 sm:pl-[42px] max-sm:whitespace-normal">
            {item.detail}
          </div>
        ) : null}
        <div className="mt-[7px] flex min-w-0 flex-wrap items-center gap-2 sm:pl-[42px]">
          {chips.length ? (
            <span className="flex min-w-0 flex-wrap items-center gap-[5px]">
              {chips.map((c) => (
                <ReasonChip key={`${c.code}-${c.label}`} chip={c} now={now} urgent={item.urgent} />
              ))}
            </span>
          ) : null}
          <span className="min-w-2 flex-1" />
          {handle}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label="More"
                title="More"
                className="max-sm:h-11 max-sm:w-11 max-sm:border max-sm:border-border-strong max-sm:bg-card"
                data-testid="attention-banner-more"
              >
                <MoreHorizontal className="h-[18px] w-[18px]" strokeWidth={1.5} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="min-w-[240px]">
              {item.actions.snooze ? (
                <>
                  <DropdownMenuItem
                    onSelect={() => void snooze(Date.now() + 60 * 60_000, 'for an hour')}
                    data-testid="attention-snooze-hour"
                  >
                    <AlarmClock className="h-3.5 w-3.5" strokeWidth={1.5} />
                    <span className="flex-1">Snooze 1 hour</span>
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() =>
                      void snooze(tomorrowMorning, `until tomorrow ${fmtTime(tomorrowMorning, tz)}`)
                    }
                    data-testid="attention-snooze-morning"
                  >
                    <AlarmClock className="h-3.5 w-3.5" strokeWidth={1.5} />
                    <span className="flex-1">Snooze until tomorrow</span>
                    <span className="text-xs text-text-3">{fmtTime(tomorrowMorning, tz)}</span>
                  </DropdownMenuItem>
                </>
              ) : null}
              {item.actions.dismiss ? (
                <DropdownMenuItem onSelect={() => void dismiss()} data-testid="attention-dismiss">
                  <EyeOff className="h-3.5 w-3.5" strokeWidth={1.5} />
                  Dismiss
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuSeparator className="my-1.5" />
              <DropdownMenuItem onSelect={() => router.push(home)}>
                <House className="h-3.5 w-3.5" strokeWidth={1.5} />
                Open on Home
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      {person && message ? (
        <MessageSheet
          workspaceId={workspaceId}
          person={{
            id: person.id,
            fullName: person.fullName,
            phone: contact?.phone ?? null,
            phoneE164: contact?.phoneE164 ?? null,
            email: contact?.email ?? null,
          }}
          channel={message}
          open
          onOpenChange={(o) => {
            if (!o) {
              setMessage(null);
              reload();
            }
          }}
        />
      ) : null}
    </>
  );
}
