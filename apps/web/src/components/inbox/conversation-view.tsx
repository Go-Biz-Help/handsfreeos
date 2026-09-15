'use client';
import { formatClock } from '@hfos/core';
import {
  AlarmClock,
  ArrowLeft,
  Check,
  ChevronDown,
  CircleCheck,
  Copy,
  Info,
  Mail,
  MoreHorizontal,
  Phone,
  Undo2,
  UserPlus,
  UserRound,
  Users,
  X,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { useAssistant } from '@/components/assistant/assistant-provider';
import { Callout, StageBadge } from '@/components/crm/chips';
import { PersonDialog } from '@/components/crm/person-dialog';
import { Avatar } from '@/components/ui/avatar';
import { Button, ButtonLink } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type {
  ConversationGet,
  ConversationThread,
  PersonDetail,
  Pipeline,
  Tag,
} from '@/lib/api/types';
import { dropDraft, useComposerDraft } from '@/lib/assistant/drafts';
import { useCalls } from '@/lib/calls/call-provider';
import { formatMoney } from '@/lib/format';
import { snoozeOptions, zonedWhen } from '@/lib/inbox';
import { useLiveRefresh } from '@/lib/realtime/live-provider';
import { useMediaQuery } from '@/lib/use-media';
import { ChannelIcon, ContactAvatar, QuietStrip } from './bits';
import { Composer, type ComposerTarget } from './composer';
import { ContextPanel } from './context-panel';
import { firstName } from './conversation-row';
import { useConversationActions, useThread } from './hooks';
import { useInbox } from './inbox-shell';
import { LinkPersonDialog } from './link-person-dialog';
import { MessageLog } from './message-log';

function SheetAction({
  icon: Icon,
  detail,
  onClick,
  children,
  testId,
}: {
  icon: LucideIcon;
  detail?: string;
  onClick: () => void;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      className="flex min-h-11 w-full items-center gap-2.5 rounded-[6px] px-2.5 text-left text-sm hover:bg-card-2"
    >
      <Icon className="h-[18px] w-[18px] flex-none" strokeWidth={1.5} />
      <span className="flex-1">{children}</span>
      {detail ? <span className="text-[13px] text-text-3">{detail}</span> : null}
    </button>
  );
}

/**
 * One conversation: the header with assign, snooze and close; the thread; the composer; and the customer
 * beside it (a sheet below 1440px, where the three panes get too narrow for the header). On a phone it fills the screen with its own top bar and a details sheet.
 */
export function ConversationView({
  data,
  thread,
  tags,
  pipelines,
  businessName,
}: {
  data: ConversationGet;
  thread: ConversationThread;
  tags: Tag[];
  pipelines: Pipeline[];
  businessName: string;
}) {
  const router = useRouter();
  const { workspaceId, myUserId, role, members, timezone, reloadList, patchRow, listQuery } =
    useInbox();
  const c = data.conversation;
  const person = data.person;
  const first = person ? firstName(person.fullName) : null;
  const who = first ?? 'this number';
  const name = person?.fullName ?? c.counterpartDisplay;
  const listHref = `/app/w/${workspaceId}/inbox${listQuery}`;
  const customerHref = person ? `/app/w/${workspaceId}/customers/people/${person.id}` : null;
  const canManage = role === 'owner' || role === 'admin';
  const phone = useMediaQuery('(max-width: 767px)') === true;
  // With the Assistant docked beside the inbox, the customer pane folds away (Customer details opens it).
  const assistantDocked = useAssistant().docked;
  // Edit on an Assistant text or email card for a number that isn't in Customers lands here.
  const handedDraft = useComposerDraft(c.id);
  const t = useThread(workspaceId, c.id, thread);
  useLiveRefresh(['conversation', 'person', 'lead', 'task']);
  const after = () => {
    reloadList();
    router.refresh();
  };
  const actions = useConversationActions(workspaceId, c.id, after);
  const calls = useCalls();
  const email = c.channel === 'email';
  // Calls go to the conversation's number, known customer or not (an email thread uses the customer's
  // phone); customers see the business number.
  const callPhone = email ? (person?.phoneE164 ?? null) : c.counterpart;
  const canCall = calls.available && !!callPhone;
  const callTarget = {
    name,
    phone: callPhone ?? '',
    personId: person?.id ?? null,
    conversationId: email ? undefined : c.id,
  };
  const [addPerson, setAddPerson] = useState(false);
  const [linkPerson, setLinkPerson] = useState(false);
  const [details, setDetails] = useState(false);
  const [assignSheet, setAssignSheet] = useState(false);
  const [contextSheet, setContextSheet] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editing, setEditing] = useState<PersonDetail | null>(null);

  // Reading the conversation clears its unread count, again whenever a new message comes in while it's open.
  const markedFor = useRef('');
  useEffect(() => {
    const key = `${c.id}:${c.lastMessageAt ?? ''}`;
    if (c.unreadCount === 0 || markedFor.current === key) return;
    markedFor.current = key;
    patchRow(c.id, { unreadCount: 0 });
    void actions.markRead();
  }, [c.id, c.unreadCount, c.lastMessageAt, patchRow, actions]);

  const assigneeName = c.assignee
    ? c.assignee.id === myUserId
      ? 'You'
      : firstName(c.assignee.fullName)
    : null;
  const assign = (userId: string | null, fullName?: string) =>
    actions.assign(
      userId,
      userId === null
        ? 'Unassigned'
        : userId === myUserId
          ? 'Assigned to you'
          : `Assigned to ${firstName(fullName ?? '')}`,
    );
  const close = () => actions.close(`Closed. A new message from ${who} opens it again.`);
  const tomorrow = snoozeOptions(timezone).find((o) => o.key === 'tomorrow')!;
  const tomorrowTime = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    minute: '2-digit',
  }).format(tomorrow.until);

  async function copyCounterpart() {
    const value = email ? c.counterpart : c.counterpartDisplay;
    try {
      await navigator.clipboard.writeText(value);
      toast.success(`Copied ${value}`);
    } catch {
      toast.error('Your browser didn’t allow copying.');
    }
  }

  async function retry(messageId: string) {
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/message.retry', { body: { workspaceId, messageId } }),
      );
      toast.success('Sending it again');
      t.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  async function linkNewPerson(personId: string) {
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/conversation.link_person', {
          body: { workspaceId, conversationId: c.id, personId },
        }),
      );
      toast.success('Added to Customers and linked');
      after();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  // The bounced-email note offers to fix the customer's address without leaving the thread.
  async function editPerson() {
    if (!person) return;
    try {
      const got = unwrap(
        await apiBrowser().POST('/v1/queries/person.get', {
          body: { workspaceId, personId: person.id },
        }),
      );
      setEditing(got.person);
      setEditOpen(true);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  const target: ComposerTarget = {
    workspaceId,
    conversationId: c.id,
    personId: person?.id ?? null,
    firstName: first,
    // A website chat has no composer mode yet: it starts on texts, which canText (chat_channel) keeps shut.
    channel: c.channel === 'chat' ? undefined : c.channel,
    phoneDisplay: email ? (person?.phone ?? '') : c.counterpartDisplay,
    email: email ? c.counterpart : (person?.email ?? null),
    canText: data.canText,
    quiet: data.quiet,
    fromNumber: data.fromNumber,
    businessName,
  };
  const composer = (
    <Composer
      key={handedDraft ? `${c.id}:${handedDraft.id}` : c.id}
      target={target}
      variant={phone ? 'phone' : 'desktop'}
      onPending={t.addPending}
      onSettled={t.settlePending}
      onDropPending={t.dropPending}
      onEditPerson={person ? () => void editPerson() : undefined}
      initialText={handedDraft?.text}
      initialSubject={handedDraft?.subject}
      onSent={(out) => {
        if (!out.crossChannel && c.status !== 'open')
          toast.success('Sent. The conversation is open again.');
        if (handedDraft) {
          handedDraft.onSent?.();
          dropDraft(c.id);
        }
        t.refresh();
        after();
      }}
    />
  );
  const context = (
    <ContextPanel
      data={data}
      workspaceId={workspaceId}
      myUserId={myUserId}
      members={members}
      pipelines={pipelines}
      onAddPerson={() => setAddPerson(true)}
      onLinkPerson={() => setLinkPerson(true)}
    />
  );
  const bannerClass = 'mx-3 mt-2.5 items-center md:mx-5 md:mt-3';

  return (
    <div className="flex min-h-0 flex-1" data-testid="conversation" data-status={c.status}>
      <div className="relative flex min-w-0 flex-1 flex-col">
        {/* Wide screens: name, assign, snooze, close, more. */}
        <header className="hidden h-16 flex-none items-center gap-2 border-b border-border bg-card pl-5 pr-4 md:flex">
          <ContactAvatar person={person} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[15px] font-semibold" data-testid="thread-name">
              {name}
            </div>
            <div className="truncate text-xs text-text-3">
              {email
                ? `${c.counterpart} · Email`
                : person
                  ? `${person.phone ?? c.counterpartDisplay} · Texts`
                  : 'Texts · not in Customers yet'}
            </div>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="secondary"
                size="sm"
                title="Assign this conversation"
                data-testid="assign-menu"
              >
                {c.assignee ? (
                  <Avatar
                    name={c.assignee.fullName}
                    seed={c.assignee.id}
                    size="sm"
                    className="h-5 w-5 text-[9px]"
                  />
                ) : (
                  <UserPlus className="h-3.5 w-3.5" strokeWidth={1.5} />
                )}
                {assigneeName ?? 'Assign'}
                <ChevronDown className="h-3.5 w-3.5" strokeWidth={1.5} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="min-w-[220px]">
              <DropdownMenuLabel>Assign to</DropdownMenuLabel>
              {members.map((m) => (
                <DropdownMenuItem
                  key={m.id}
                  onSelect={() => void assign(m.id, m.fullName)}
                  data-testid={`assign-to-${m.id}`}
                >
                  <Avatar name={m.fullName} seed={m.id} size="sm" />
                  <span className="flex-1 truncate">
                    {m.id === myUserId ? `${m.fullName} (you)` : m.fullName}
                  </span>
                  {c.assignee?.id === m.id ? (
                    <Check className="h-3.5 w-3.5 text-accent-text" strokeWidth={2} />
                  ) : null}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator className="my-1.5" />
              <DropdownMenuItem onSelect={() => void assign(null)} data-testid="assign-nobody">
                <X className="h-3.5 w-3.5" strokeWidth={1.5} />
                Nobody
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {c.status === 'open' ? (
            <>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="sm" data-testid="snooze-menu">
                    <AlarmClock className="h-3.5 w-3.5" strokeWidth={1.5} />
                    Snooze
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent className="min-w-[250px]">
                  {snoozeOptions(timezone).map((o) => (
                    <DropdownMenuItem
                      key={o.key}
                      onSelect={() => void actions.snooze(o.until, `Snoozed until ${o.when}`)}
                      data-testid={`snooze-${o.key}`}
                    >
                      <span className="flex-1">{o.label}</span>
                      <span className="text-xs text-text-3">{o.when}</span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void close()}
                data-testid="close-conversation"
              >
                <CircleCheck className="h-3.5 w-3.5" strokeWidth={1.5} />
                Close
              </Button>
            </>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void actions.reopen()}
              data-testid="reopen-conversation"
            >
              <Undo2 className="h-3.5 w-3.5" strokeWidth={1.5} />
              Reopen
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className={assistantDocked ? undefined : 'min-[1440px]:hidden'}
            title="Customer details"
            aria-label="Customer details"
            onClick={() => setContextSheet(true)}
          >
            <Info className="h-[18px] w-[18px]" strokeWidth={1.5} />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" title="More" aria-label="More">
                <MoreHorizontal className="h-[18px] w-[18px]" strokeWidth={1.5} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="min-w-[220px]">
              {canCall ? (
                <DropdownMenuItem
                  onSelect={() => calls.openDialer(callTarget)}
                  data-testid="thread-call"
                >
                  <Phone className="h-3.5 w-3.5" strokeWidth={1.5} />
                  Call
                </DropdownMenuItem>
              ) : null}
              {customerHref ? (
                <DropdownMenuItem onSelect={() => router.push(customerHref)}>
                  <UserRound className="h-3.5 w-3.5" strokeWidth={1.5} />
                  Open customer
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem onSelect={() => setAddPerson(true)}>
                  <UserPlus className="h-3.5 w-3.5" strokeWidth={1.5} />
                  Add as a new person
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                onSelect={() => void actions.markUnread()}
                data-testid="mark-unread"
              >
                <Mail className="h-3.5 w-3.5" strokeWidth={1.5} />
                Mark as unread
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void copyCounterpart()} data-testid="thread-copy">
                <Copy className="h-3.5 w-3.5" strokeWidth={1.5} />
                {email ? 'Copy email address' : 'Copy phone number'}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </header>

        {/* Phones: back, who, details. */}
        <header className="flex h-14 flex-none items-center gap-1 border-b border-border bg-card px-1 md:hidden">
          <Link
            href={listHref}
            aria-label="Back to the inbox"
            title="Back to the inbox"
            className="flex h-11 w-11 flex-none items-center justify-center rounded-full text-text-2"
          >
            <ArrowLeft className="h-[18px] w-[18px]" strokeWidth={1.5} />
          </Link>
          <ContactAvatar person={person} />
          <div className="ml-1.5 min-w-0 flex-1">
            <div className="truncate text-[15px] font-semibold">{name}</div>
            <div className="truncate text-xs text-text-3">
              {email
                ? `${c.counterpart} · Email`
                : person
                  ? `${person.phone ?? c.counterpartDisplay} · Texts`
                  : 'Texts'}
            </div>
          </div>
          {canCall ? (
            <button
              type="button"
              aria-label="Call"
              title="Call"
              data-testid="thread-call-phone"
              onClick={() => calls.openDialer(callTarget)}
              className="flex h-11 w-11 flex-none items-center justify-center rounded-full text-text-2"
            >
              <Phone className="h-[18px] w-[18px]" strokeWidth={1.5} />
            </button>
          ) : null}
          <button
            type="button"
            aria-label="Details and actions"
            title="Details and actions"
            data-testid="thread-details"
            onClick={() => setDetails(true)}
            className="flex h-11 w-11 flex-none items-center justify-center rounded-full text-text-2"
          >
            <Info className="h-[18px] w-[18px]" strokeWidth={1.5} />
          </button>
        </header>

        {person ? null : (
          <Callout
            tone="info"
            icon={UserPlus}
            className={bannerClass}
            action={
              <Button
                variant="secondary"
                size="sm"
                className="max-md:min-h-11"
                onClick={() => setAddPerson(true)}
                data-testid="banner-add-person"
              >
                Add person
              </Button>
            }
          >
            <span className="hidden md:inline">
              <strong>{c.counterpartDisplay} isn’t a customer yet.</strong> Add them, or link the
              number to someone you already have.
            </span>
            <span className="md:hidden">Not in Customers yet.</span>
          </Callout>
        )}
        {c.status === 'snoozed' && c.snoozedUntil ? (
          <Callout
            tone="warning"
            icon={AlarmClock}
            className={bannerClass}
            data-testid="snoozed-banner"
            action={
              <Button variant="secondary" size="sm" onClick={() => void actions.reopen()}>
                Unsnooze
              </Button>
            }
          >
            Snoozed until <strong>{zonedWhen(new Date(c.snoozedUntil), timezone)}</strong>. It comes
            back sooner if {who} writes again.
          </Callout>
        ) : null}
        {c.status === 'closed' ? (
          <Callout
            tone="neutral"
            icon={CircleCheck}
            className={bannerClass}
            data-testid="closed-banner"
            action={
              <Button variant="secondary" size="sm" onClick={() => void actions.reopen()}>
                Reopen
              </Button>
            }
          >
            Closed. A new message from {who} opens it again.
          </Callout>
        ) : null}
        {phone && data.quiet.quiet && data.canText.ok ? (
          <QuietStrip className="mx-3 mt-2.5">
            Quiet hours{data.quiet.endsAt ? ` until ${formatClock(data.quiet.endsAt)}` : ' are on'}
          </QuietStrip>
        ) : null}

        {data.canText.reason === 'no_number' ? (
          <div
            className="flex flex-1 flex-col items-center justify-center gap-2.5 px-7 py-6 text-center"
            data-testid="no-number"
          >
            <ChannelIcon icon={Phone} size={44} />
            <h3 className="text-[15px] font-semibold">Text customers from HandsFreeOS</h3>
            <p className="max-w-[360px] text-[13px] text-text-2">
              Get a business number first. It takes about two minutes, and calls work right away.
            </p>
            {canManage ? (
              <ButtonLink
                href={`/app/w/${workspaceId}/settings/texting`}
                variant="primary"
                size="sm"
                className="mt-1"
              >
                Set up texting
              </ButtonLink>
            ) : (
              <p className="text-xs text-text-3">Ask an owner or admin to set up texting.</p>
            )}
          </div>
        ) : (
          <>
            <MessageLog
              items={t.items}
              pending={t.pending}
              customerFirstName={first}
              customerName={person?.fullName ?? null}
              hasEarlier={t.hasEarlier}
              loadingEarlier={t.loadingEarlier}
              onLoadEarlier={() => void t.loadEarlier()}
              onRetry={(id) => void retry(id)}
            />
            {composer}
          </>
        )}
      </div>

      <aside
        aria-label="Customer"
        className={
          assistantDocked
            ? 'hidden'
            : 'hidden w-[300px] flex-none overflow-y-auto border-l border-border bg-card px-[18px] py-5 min-[1440px]:block'
        }
      >
        {context}
      </aside>

      <Sheet open={contextSheet} onOpenChange={setContextSheet}>
        <SheetContent title="Customer details">{context}</SheetContent>
      </Sheet>

      <Sheet open={details} onOpenChange={setDetails}>
        <SheetContent title="Details and actions" hideHeader>
          <div className="flex items-center gap-3">
            <ContactAvatar person={person} size="panel" />
            <div className="min-w-0">
              <h2 className="truncate text-lg font-semibold tracking-tight">{name}</h2>
              <div className="text-[13px] text-text-3">
                {person
                  ? `${email ? c.counterpart : (person.phone ?? c.counterpartDisplay)} · Customer since ${new Date(person.customerSince).getFullYear()}`
                  : 'Not in Customers yet'}
              </div>
            </div>
          </div>
          {c.openLead ? (
            <div className="mt-3.5 rounded-[10px] border border-border bg-card p-3">
              <div className="flex items-start justify-between gap-2">
                <span className="text-[13px] font-medium">{c.openLead.title}</span>
                <StageBadge name={c.openLead.stageName} kind="open" className="h-5 text-[11.5px]" />
              </div>
              <div className="mt-0.5 text-xs text-text-2">{formatMoney(c.openLead.valueCents)}</div>
            </div>
          ) : null}
          <div className="mt-3.5 flex flex-col gap-0.5">
            {canCall ? (
              <SheetAction
                icon={Phone}
                testId="sheet-call"
                onClick={() => {
                  setDetails(false);
                  calls.openDialer(callTarget);
                }}
              >
                Call
              </SheetAction>
            ) : null}
            {customerHref ? (
              <SheetAction icon={UserRound} onClick={() => router.push(customerHref)}>
                Open customer
              </SheetAction>
            ) : (
              <SheetAction
                icon={UserPlus}
                onClick={() => {
                  setDetails(false);
                  setAddPerson(true);
                }}
              >
                Add as a new person
              </SheetAction>
            )}
            <SheetAction
              icon={Users}
              detail={assigneeName ?? 'Nobody'}
              testId="sheet-assign"
              onClick={() => {
                setDetails(false);
                setAssignSheet(true);
              }}
            >
              Assign
            </SheetAction>
            {c.status === 'open' ? (
              <>
                <SheetAction
                  icon={AlarmClock}
                  detail={`Tomorrow ${tomorrowTime}`}
                  testId="sheet-snooze"
                  onClick={() =>
                    void actions
                      .snooze(tomorrow.until, `Snoozed until tomorrow ${tomorrowTime}`)
                      .then((ok) => ok && router.push(listHref))
                  }
                >
                  Snooze
                </SheetAction>
                <SheetAction
                  icon={CircleCheck}
                  testId="sheet-close"
                  onClick={() =>
                    void actions
                      .close('Closed. A new message opens it again.')
                      .then((ok) => ok && router.push(listHref))
                  }
                >
                  Close conversation
                </SheetAction>
              </>
            ) : (
              <SheetAction
                icon={Undo2}
                onClick={() => {
                  setDetails(false);
                  void actions.reopen();
                }}
              >
                Reopen
              </SheetAction>
            )}
          </div>
        </SheetContent>
      </Sheet>

      <Sheet open={assignSheet} onOpenChange={setAssignSheet}>
        <SheetContent title="Assign to" hideHeader>
          <h3 className="mb-2 text-[15px] font-semibold">Assign to</h3>
          {members.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => {
                setAssignSheet(false);
                void assign(m.id, m.fullName);
              }}
              className="flex min-h-11 w-full items-center gap-2.5 rounded-[6px] px-2.5 text-left text-sm hover:bg-card-2"
            >
              <Avatar name={m.fullName} seed={m.id} size="sm" />
              <span className="flex-1 truncate">
                {m.id === myUserId ? `${m.fullName} (you)` : m.fullName}
              </span>
              {c.assignee?.id === m.id ? (
                <Check className="h-[18px] w-[18px] text-accent-text" strokeWidth={2} />
              ) : null}
            </button>
          ))}
          <button
            type="button"
            onClick={() => {
              setAssignSheet(false);
              void assign(null);
            }}
            className="flex min-h-11 w-full items-center gap-2.5 rounded-[6px] px-2.5 text-left text-sm hover:bg-card-2"
          >
            <X className="h-[18px] w-[18px]" strokeWidth={1.5} />
            Nobody
          </button>
        </SheetContent>
      </Sheet>

      <PersonDialog
        workspaceId={workspaceId}
        tags={tags}
        open={addPerson}
        onOpenChange={setAddPerson}
        defaultPhone={c.counterpartDisplay}
        onSaved={(personId) => void linkNewPerson(personId)}
      />
      <LinkPersonDialog
        workspaceId={workspaceId}
        conversationId={c.id}
        number={c.counterpartDisplay}
        open={linkPerson}
        onOpenChange={setLinkPerson}
        onLinked={after}
      />
      {editing ? (
        <PersonDialog
          workspaceId={workspaceId}
          tags={tags}
          open={editOpen}
          onOpenChange={setEditOpen}
          initial={editing}
          onSaved={() => after()}
        />
      ) : null}
    </div>
  );
}
