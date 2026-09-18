'use client';
import {
  assigneeShort,
  closedBanner,
  CONVERSATION_ACTIONS,
  CONVERSATION_DONE,
  customerFirstName,
  customerSinceLine,
  DRAFT_AFTER,
  handlingView,
  handoverNote,
  memberLabel,
  NO_NUMBER_WORDS,
  notCustomerBanner,
  quietStrip,
  rowName,
  SENT_WORDS,
  snoozedBanner,
  snoozeOptions,
  threadChannelLine,
  whoOf,
  zonedClock,
  zonedWhen,
} from '@hfos/core';
import {
  AlarmClock,
  ArrowLeft,
  Check,
  ChevronDown,
  CircleCheck,
  Copy,
  Info,
  Loader2,
  Mail,
  MoreHorizontal,
  Phone,
  Sparkles,
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
import { AttentionWaitingChip, useRecordAttention } from '@/components/attention/bits';
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
import { handlingOf, type TeammateDraft } from '@/lib/ai-team/inbox-types';
import { teammateCommands, useConversationDrafts } from '@/lib/ai-team/use-inbox';
import type {
  ConversationGet,
  ConversationThread,
  PersonDetail,
  Pipeline,
  Tag,
  ThreadItem,
} from '@/lib/api/types';
import { dropDraft, useComposerDraft } from '@/lib/assistant/drafts';
import { useCalls } from '@/lib/calls/call-provider';
import { formatMoney } from '@/lib/format';
import { useLiveRefresh } from '@/lib/realtime/live-provider';
import { useMediaQuery } from '@/lib/use-media';
import { SiteTag, WebsiteIcon } from './ai-bits';
import {
  ChatVisitorStrip,
  HandBackDialog,
  HandlingBanner,
  TeammateContext,
  useHandlingActions,
} from './ai-handling';
import { ChannelIcon, ContactAvatar, QuietStrip, Words } from './bits';
import { Composer, type ComposerTarget } from './composer';
import { ContextPanel } from './context-panel';
import {
  DraftCard,
  PhoneDraftBar,
  RejectedNext,
  SendingDraft,
  TeammateLine,
  useDraftDecision,
} from './draft-card';
import { useConversationActions, useCustomerNotes, useThread } from './hooks';
import { useInbox } from './inbox-shell';
import { LinkPersonDialog } from './link-person-dialog';
import { MessageLog } from './message-log';

/** How long an approved draft's message may take to arrive before the thread stops saying "Sending…". */
const SENDING_FOR_MS = 10 * 60_000;
/** How long "writing a new draft" shows after Try again before it settles on "answers their next message". */
const RETRY_FOR_MS = 2 * 60_000;

/** The approved draft's message is in the thread. */
const sentFor = (d: TeammateDraft, items: readonly ThreadItem[]): boolean =>
  items.some((i) => i.type === 'message' && i.aiDraftId === d.id);

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
  const {
    workspaceId,
    myUserId,
    role,
    members,
    timezone,
    reloadList,
    patchRow,
    listQuery,
    teammate,
  } = useInbox();
  const c = data.conversation;
  const person = data.person;
  const chat = c.channel === 'chat';
  const first = customerFirstName(person, chat ? data.chat?.name : null);
  const who = whoOf(first, c.channel);
  const name = rowName({ person, counterpartDisplay: c.counterpartDisplay });
  const listHref = `/app/w/${workspaceId}/inbox${listQuery}`;
  const customerHref = person ? `/app/w/${workspaceId}/customers/people/${person.id}` : null;
  const canManage = role === 'owner' || role === 'admin';
  const phone = useMediaQuery('(max-width: 767px)') === true;
  // With the Assistant docked beside the inbox, the customer pane folds away (Customer details opens it).
  const assistantDocked = useAssistant().docked;
  // Edit on an Assistant text or email card for a number that isn't in Customers lands here.
  const handedDraft = useComposerDraft(c.id);
  const t = useThread(workspaceId, c.id, thread);
  // The customer's own notes, shown in the thread as the phone shows them (M10 step 15).
  const notes = useCustomerNotes(workspaceId, person?.id ?? null);
  useLiveRefresh(['conversation', 'person', 'lead', 'task']);
  const after = () => {
    reloadList();
    router.refresh();
  };
  const actions = useConversationActions(workspaceId, c.id, after);
  // On Home: this conversation has an open Action Center item (a customer waiting, or a hot or unanswered lead).
  const onHome = useRecordAttention(workspaceId, 'conversation', c.id).items[0] ?? null;

  // The AI teammate here: who handles the conversation, its draft, and what became of the last one.
  const handling = handlingOf(c);
  const drafts = useConversationDrafts(workspaceId, c.id);
  const waiting = drafts.pending ?? drafts.approval;
  const view = handlingView(handling);
  const tm = teammate ?? null;
  const tmName = handling.teammate?.name ?? tm?.name ?? null;
  const aiName = tmName ?? 'The AI teammate';
  const handlingActions = useHandlingActions({
    workspaceId,
    conversationId: c.id,
    name: aiName,
    who: first ?? 'them',
    after: () => {
      drafts.refresh();
      after();
    },
  });
  const [handBackOpen, setHandBackOpen] = useState(false);
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());
  const [retry, setRetry] = useState<{ id: string; at: number } | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);
  const me = members.find((m) => m.id === myUserId);
  const decision = useDraftDecision({
    workspaceId,
    draft: waiting,
    who: first ?? 'them',
    onDecided: (d, out, edits) => {
      drafts.patch(d.id, {
        status: out.status,
        decidedAt: new Date().toISOString(),
        decidedBy: { id: myUserId, fullName: me?.fullName ?? 'You' },
        edits,
        canDecide: false,
      });
      drafts.refresh();
      t.refresh();
      reloadList();
    },
    onRefused: () => {
      drafts.refresh();
      router.refresh();
    },
  });
  const calls = useCalls();
  const email = c.channel === 'email';
  // Calls go to a text conversation's number, known customer or not. An email thread or a website chat uses
  // the customer's phone, so a chat visitor not in Customers has no Call (the chat's counterpart isn't a
  // number). Customers see the business number.
  const byNumber = !email && !chat;
  const callPhone = byNumber ? c.counterpart : (person?.phoneE164 ?? null);
  const canCall = calls.available && !!callPhone;
  const callTarget = {
    name,
    phone: callPhone ?? '',
    personId: person?.id ?? null,
    conversationId: byNumber ? c.id : undefined,
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

  const assigneeName = assigneeShort(c.assignee, myUserId);
  const assign = (userId: string | null, fullName?: string) =>
    actions.assign(userId, CONVERSATION_DONE.assigned(userId, myUserId, fullName));
  const close = () => actions.close(CONVERSATION_DONE.closed(who));
  const tomorrow = snoozeOptions(timezone).find((o) => o.key === 'tomorrow')!;
  const tomorrowTime = zonedClock(tomorrow.until, timezone);

  async function copyCounterpart() {
    const value = email ? c.counterpart : c.counterpartDisplay;
    try {
      await navigator.clipboard.writeText(value);
      toast.success(`Copied ${value}`);
    } catch {
      toast.error('Your browser didn’t allow copying.');
    }
  }

  async function retryMessage(messageId: string) {
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/message.retry', { body: { workspaceId, messageId } }),
      );
      toast.success(CONVERSATION_DONE.retrying);
      t.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  /** Cancel on a text held for quiet hours: it never goes. */
  async function cancelHeld(messageId: string) {
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/message.cancel_scheduled', {
          body: { workspaceId, messageId },
        }),
      );
      t.forget(messageId);
      toast.success(CONVERSATION_DONE.heldCancelled);
    } catch (e) {
      toast.error(errorMessage(e));
      t.refresh();
    }
  }

  /** Try again: the teammate writes a new draft for the same messages, with the reason. */
  async function tryAgain(draftId: string) {
    setRetrying(true);
    try {
      await teammateCommands(workspaceId).retry(draftId);
      setRetry({ id: draftId, at: Date.now() });
    } catch (e) {
      toast.error(errorMessage(e));
      drafts.refresh();
    } finally {
      setRetrying(false);
    }
  }

  async function linkNewPerson(personId: string) {
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/conversation.link_person', {
          body: { workspaceId, conversationId: c.id, personId },
        }),
      );
      toast.success(CONVERSATION_DONE.linked);
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
    // A website chat replies in the chat; texts and email switch between each other.
    channel: c.channel,
    phoneDisplay: email
      ? (person?.phone ?? '')
      : chat
        ? (person?.phone ?? data.chat?.phone ?? '')
        : c.counterpartDisplay,
    email: email ? c.counterpart : (person?.email ?? null),
    canText: data.canText,
    quiet: data.quiet,
    fromNumber: data.fromNumber,
    businessName,
    // A person's message takes the conversation from the teammate (the phone's draft bar says so itself).
    handoverNote: phone && waiting ? null : handoverNote(view, aiName),
    chatBlocked: data.chat?.blocked ?? false,
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
        if (!out.crossChannel && c.status !== 'open') toast.success(SENT_WORDS.reopened);
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
      extra={
        tm && (view || drafts.items.length) ? (
          <TeammateContext
            workspaceId={workspaceId}
            view={view}
            handling={handling}
            teammate={tm}
            assignee={c.assignee}
            myUserId={myUserId}
            timezone={timezone}
          />
        ) : null
      }
    />
  );
  const bannerClass = 'mx-3 mt-2.5 items-center md:mx-5 md:mt-3';
  const notCustomer = notCustomerBanner(c.counterpartDisplay, c.channel);
  // Handing a conversation to the teammate: back from a person, or one nobody is handling yet.
  const canHandToAi =
    !!tm && tm.status !== 'off' && view !== 'ai' && view !== 'needs_person' && view !== 'person';

  // After the newest message: the draft waiting for an OK, or what became of the last one.
  const latest = drafts.latest;
  const lastAt = t.items.at(-1)?.occurredAt ?? null;
  const since = (iso: string | null) =>
    !!iso && (!lastAt || Date.parse(iso) >= Date.parse(lastAt) - 1000);
  let tail: ReactNode = null;
  if (waiting) {
    tail = (
      <DraftCard
        d={decision}
        timezone={timezone}
        progress={tm?.progress ?? null}
        phone={phone}
        now={now}
      />
    );
  } else if (latest && !dismissed.has(latest.id)) {
    const recent = !!latest.decidedAt && now - Date.parse(latest.decidedAt) < SENDING_FOR_MS;
    if (
      latest.status === 'approved' &&
      latest.preview.message &&
      recent &&
      !sentFor(latest, t.items)
    )
      tail = <SendingDraft draft={latest} />;
    else if (latest.status === 'rejected' && since(latest.decidedAt))
      tail =
        retry?.id === latest.id ? (
          now - retry.at < RETRY_FOR_MS ? (
            <TeammateLine icon={Loader2} testId="draft-retrying">
              {DRAFT_AFTER.retrying(latest.teammate.name)}
            </TeammateLine>
          ) : (
            <TeammateLine testId="draft-retry-later">
              {DRAFT_AFTER.retryLater(latest.teammate.name, first)}
            </TeammateLine>
          )
        ) : (
          <RejectedNext
            draft={latest}
            who={first ?? 'them'}
            mine={latest.decidedBy?.id === myUserId}
            taking={handlingActions.busy === 'take'}
            retrying={retrying}
            onReply={() =>
              void handlingActions.takeOver().then((ok) => {
                if (ok) setDismissed((s) => new Set(s).add(latest.id));
              })
            }
            onTryAgain={() => void tryAgain(latest.id)}
          />
        );
    else if (latest.status === 'expired' && since(latest.decidedAt))
      tail = (
        <TeammateLine testId="draft-expired">
          {DRAFT_AFTER.expired(
            latest.teammate.name,
            latest.decidedAt ? zonedWhen(new Date(latest.decidedAt), timezone) : null,
          )}
        </TeammateLine>
      );
    else if (
      latest.status === 'cancelled' &&
      latest.reason === 'The customer wrote again.' &&
      since(latest.decidedAt)
    )
      tail = (
        <TeammateLine testId="draft-dropped">
          {DRAFT_AFTER.dropped(latest.teammate.name, first)}
        </TeammateLine>
      );
  }

  return (
    <div className="flex min-h-0 flex-1" data-testid="conversation" data-status={c.status}>
      <div className="relative flex min-w-0 flex-1 flex-col">
        {/* Wide screens: name, assign, snooze, close, more. */}
        <header className="hidden h-16 flex-none items-center gap-2 border-b border-border bg-card pl-5 pr-4 md:flex">
          <ContactAvatar person={person} chat={chat} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[15px] font-semibold" data-testid="thread-name">
              {name}
            </div>
            <div className="flex items-center gap-1.5 truncate text-xs text-text-3">
              {chat ? <WebsiteIcon className="h-3 w-3" /> : null}
              <span className="truncate" data-testid="thread-channel">
                {threadChannelLine(c, person, { chat: data.chat })}
              </span>
            </div>
          </div>
          {onHome ? (
            <AttentionWaitingChip item={onHome} now={now} href={`/app/w/${workspaceId}`} />
          ) : null}
          {chat && data.chat?.onSiteNow ? <SiteTag /> : null}
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
                {assigneeName ?? CONVERSATION_ACTIONS.assign}
                <ChevronDown className="h-3.5 w-3.5" strokeWidth={1.5} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="min-w-[220px]">
              <DropdownMenuLabel>{CONVERSATION_ACTIONS.assignTo}</DropdownMenuLabel>
              {members.map((m) => (
                <DropdownMenuItem
                  key={m.id}
                  onSelect={() => void assign(m.id, m.fullName)}
                  data-testid={`assign-to-${m.id}`}
                >
                  <Avatar name={m.fullName} seed={m.id} size="sm" />
                  <span className="flex-1 truncate">{memberLabel(m, myUserId)}</span>
                  {c.assignee?.id === m.id ? (
                    <Check className="h-3.5 w-3.5 text-accent-text" strokeWidth={2} />
                  ) : null}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator className="my-1.5" />
              <DropdownMenuItem onSelect={() => void assign(null)} data-testid="assign-nobody">
                <X className="h-3.5 w-3.5" strokeWidth={1.5} />
                {CONVERSATION_ACTIONS.nobody}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {c.status === 'open' ? (
            <>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="sm" data-testid="snooze-menu">
                    <AlarmClock className="h-3.5 w-3.5" strokeWidth={1.5} />
                    {CONVERSATION_ACTIONS.snooze}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent className="min-w-[250px]">
                  {snoozeOptions(timezone).map((o) => (
                    <DropdownMenuItem
                      key={o.key}
                      onSelect={() =>
                        void actions.snooze(o.until, CONVERSATION_DONE.snoozed(o.when))
                      }
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
                {CONVERSATION_ACTIONS.close}
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
              {CONVERSATION_ACTIONS.reopen}
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className={assistantDocked ? undefined : 'min-[1440px]:hidden'}
            title={CONVERSATION_ACTIONS.customerDetails}
            aria-label={CONVERSATION_ACTIONS.customerDetails}
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
                  {CONVERSATION_ACTIONS.call}
                </DropdownMenuItem>
              ) : null}
              {customerHref ? (
                <DropdownMenuItem onSelect={() => router.push(customerHref)}>
                  <UserRound className="h-3.5 w-3.5" strokeWidth={1.5} />
                  {CONVERSATION_ACTIONS.openCustomer}
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem onSelect={() => setAddPerson(true)}>
                  <UserPlus className="h-3.5 w-3.5" strokeWidth={1.5} />
                  {CONVERSATION_ACTIONS.addPerson}
                </DropdownMenuItem>
              )}
              {canHandToAi ? (
                <DropdownMenuItem onSelect={() => setHandBackOpen(true)} data-testid="hand-to-ai">
                  <Sparkles className="h-3.5 w-3.5" strokeWidth={1.5} />
                  {CONVERSATION_ACTIONS.handTo(aiName)}
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuItem
                onSelect={() => void actions.markUnread()}
                data-testid="mark-unread"
              >
                <Mail className="h-3.5 w-3.5" strokeWidth={1.5} />
                {CONVERSATION_ACTIONS.markUnread}
              </DropdownMenuItem>
              {chat ? null : (
                <DropdownMenuItem onSelect={() => void copyCounterpart()} data-testid="thread-copy">
                  <Copy className="h-3.5 w-3.5" strokeWidth={1.5} />
                  {email ? CONVERSATION_ACTIONS.copyEmail : CONVERSATION_ACTIONS.copyPhone}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </header>

        {/* Phones: back, who, details. */}
        <header className="flex h-14 flex-none items-center gap-1 border-b border-border bg-card px-1 md:hidden">
          <Link
            href={listHref}
            aria-label={CONVERSATION_ACTIONS.back}
            title={CONVERSATION_ACTIONS.back}
            className="flex h-11 w-11 flex-none items-center justify-center rounded-full text-text-2"
          >
            <ArrowLeft className="h-[18px] w-[18px]" strokeWidth={1.5} />
          </Link>
          <ContactAvatar person={person} chat={chat} />
          <div className="ml-1.5 min-w-0 flex-1">
            <div className="truncate text-[15px] font-semibold">{name}</div>
            <div className="truncate text-xs text-text-3">
              {threadChannelLine(c, person, { chat: data.chat, short: true })}
            </div>
          </div>
          {onHome ? (
            <AttentionWaitingChip
              item={onHome}
              now={now}
              href={`/app/w/${workspaceId}`}
              className="mx-1"
            />
          ) : null}
          {canCall ? (
            <button
              type="button"
              aria-label={CONVERSATION_ACTIONS.call}
              title={CONVERSATION_ACTIONS.call}
              data-testid="thread-call-phone"
              onClick={() => calls.openDialer(callTarget)}
              className="flex h-11 w-11 flex-none items-center justify-center rounded-full text-text-2"
            >
              <Phone className="h-[18px] w-[18px]" strokeWidth={1.5} />
            </button>
          ) : null}
          <button
            type="button"
            aria-label={CONVERSATION_ACTIONS.details}
            title={CONVERSATION_ACTIONS.details}
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
                {notCustomer.action}
              </Button>
            }
          >
            <span className="hidden md:inline">
              <Words parts={notCustomer.parts} />
            </span>
            <span className="md:hidden">{notCustomer.short}</span>
          </Callout>
        )}
        <HandlingBanner
          view={view}
          handling={handling}
          teammate={tm}
          myUserId={myUserId}
          assignee={c.assignee}
          timezone={timezone}
          compact={phone}
          busy={handlingActions.busy}
          onTakeOver={() => void handlingActions.takeOver()}
          onHandBack={() => setHandBackOpen(true)}
          className={bannerClass}
        />
        {chat && data.chat ? (
          <ChatVisitorStrip
            chat={data.chat}
            person={person}
            name={tmName}
            className="mx-3 mt-2.5 md:mx-5 md:mt-3"
          />
        ) : null}
        {c.status === 'snoozed' && c.snoozedUntil ? (
          <Callout
            tone="warning"
            icon={AlarmClock}
            className={bannerClass}
            data-testid="snoozed-banner"
            action={
              <Button variant="secondary" size="sm" onClick={() => void actions.reopen()}>
                {snoozedBanner(c.snoozedUntil, who, timezone).action}
              </Button>
            }
          >
            <Words parts={snoozedBanner(c.snoozedUntil, who, timezone).parts} />
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
                {closedBanner(who).action}
              </Button>
            }
          >
            {closedBanner(who).text}
          </Callout>
        ) : null}
        {phone && data.quiet.quiet && data.canText.ok ? (
          <QuietStrip className="mx-3 mt-2.5">{quietStrip(data.quiet)}</QuietStrip>
        ) : null}

        {data.canText.reason === 'no_number' ? (
          <div
            className="flex flex-1 flex-col items-center justify-center gap-2.5 px-7 py-6 text-center"
            data-testid="no-number"
          >
            <ChannelIcon icon={Phone} size={44} />
            <h3 className="text-[15px] font-semibold">{NO_NUMBER_WORDS.title}</h3>
            <p className="max-w-[360px] text-[13px] text-text-2">{NO_NUMBER_WORDS.body}</p>
            {canManage ? (
              <ButtonLink
                href={`/app/w/${workspaceId}/settings/texting`}
                variant="primary"
                size="sm"
                className="mt-1"
              >
                {NO_NUMBER_WORDS.setUp}
              </ButtonLink>
            ) : (
              <p className="text-xs text-text-3">{NO_NUMBER_WORDS.askAdmin}</p>
            )}
          </div>
        ) : (
          <>
            <MessageLog
              items={t.items}
              notes={notes}
              pending={t.pending}
              customerFirstName={first}
              customerName={person?.fullName ?? null}
              hasEarlier={t.hasEarlier}
              loadingEarlier={t.loadingEarlier}
              onLoadEarlier={() => void t.loadEarlier()}
              onRetry={(id) => void retryMessage(id)}
              onCancelScheduled={(id) => void cancelHeld(id)}
              tail={tail}
            />
            {phone && waiting ? (
              <PhoneDraftBar d={decision} progress={tm?.progress ?? null} />
            ) : null}
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
        <SheetContent title={CONVERSATION_ACTIONS.customerDetails}>{context}</SheetContent>
      </Sheet>

      <Sheet open={details} onOpenChange={setDetails}>
        <SheetContent title={CONVERSATION_ACTIONS.details} hideHeader>
          <div className="flex items-center gap-3">
            <ContactAvatar person={person} size="panel" />
            <div className="min-w-0">
              <h2 className="truncate text-lg font-semibold tracking-tight">{name}</h2>
              <div className="text-[13px] text-text-3">{customerSinceLine(person, c)}</div>
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
                {CONVERSATION_ACTIONS.call}
              </SheetAction>
            ) : null}
            {customerHref ? (
              <SheetAction icon={UserRound} onClick={() => router.push(customerHref)}>
                {CONVERSATION_ACTIONS.openCustomer}
              </SheetAction>
            ) : (
              <SheetAction
                icon={UserPlus}
                onClick={() => {
                  setDetails(false);
                  setAddPerson(true);
                }}
              >
                {CONVERSATION_ACTIONS.addPerson}
              </SheetAction>
            )}
            <SheetAction
              icon={Users}
              detail={assigneeName ?? CONVERSATION_ACTIONS.nobody}
              testId="sheet-assign"
              onClick={() => {
                setDetails(false);
                setAssignSheet(true);
              }}
            >
              {CONVERSATION_ACTIONS.assign}
            </SheetAction>
            {canHandToAi ? (
              <SheetAction
                icon={Sparkles}
                testId="sheet-hand-to-ai"
                onClick={() => {
                  setDetails(false);
                  setHandBackOpen(true);
                }}
              >
                {CONVERSATION_ACTIONS.handTo(aiName)}
              </SheetAction>
            ) : null}
            {c.status === 'open' ? (
              <>
                <SheetAction
                  icon={AlarmClock}
                  detail={`Tomorrow ${tomorrowTime}`}
                  testId="sheet-snooze"
                  onClick={() =>
                    void actions
                      .snooze(tomorrow.until, CONVERSATION_DONE.snoozedTomorrow(tomorrowTime))
                      .then((ok) => ok && router.push(listHref))
                  }
                >
                  {CONVERSATION_ACTIONS.snooze}
                </SheetAction>
                <SheetAction
                  icon={CircleCheck}
                  testId="sheet-close"
                  onClick={() =>
                    void actions
                      .close(CONVERSATION_DONE.closedShort)
                      .then((ok) => ok && router.push(listHref))
                  }
                >
                  {CONVERSATION_ACTIONS.closeConversation}
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
                {CONVERSATION_ACTIONS.reopen}
              </SheetAction>
            )}
          </div>
        </SheetContent>
      </Sheet>

      <Sheet open={assignSheet} onOpenChange={setAssignSheet}>
        <SheetContent title={CONVERSATION_ACTIONS.assignTo} hideHeader>
          <h3 className="mb-2 text-[15px] font-semibold">{CONVERSATION_ACTIONS.assignTo}</h3>
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
              <span className="flex-1 truncate">{memberLabel(m, myUserId)}</span>
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
            {CONVERSATION_ACTIONS.nobody}
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
      <HandBackDialog
        open={handBackOpen}
        onOpenChange={setHandBackOpen}
        name={aiName}
        who={first ?? 'them'}
        busy={handlingActions.busy === 'back'}
        onConfirm={() =>
          void handlingActions.handBack().then((ok) => {
            if (ok) setHandBackOpen(false);
          })
        }
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
