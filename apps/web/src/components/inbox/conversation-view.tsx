'use client';
import {
  aiWroteIt,
  ALL_LINES_WORDS,
  assigneeShort,
  BIN_WORDS,
  can,
  closedBanner,
  CONVERSATION_ACTIONS,
  CONVERSATION_DONE,
  customerFirstName,
  customerSinceLine,
  DRAFT_AFTER,
  handlingView,
  handoverNote,
  isSocialChannel,
  mailMoves,
  memberLabel,
  NO_NUMBER_WORDS,
  notCustomerBanner,
  PRIVATE_THREAD_WORDS,
  quietStrip,
  rowName,
  SENDER_WORDS,
  SENT_WORDS,
  snoozedBanner,
  snoozeOptions,
  SOCIAL_CONTACT_NAMES,
  threadChannelLine,
  VIDEO_CALL_WORDS,
  whoOf,
  zonedClock,
  zonedWhen,
} from '@hfos/core';
import {
  AlarmClock,
  Archive,
  ArchiveRestore,
  ArrowLeft,
  Check,
  ChevronDown,
  CircleCheck,
  Copy,
  Inbox,
  Info,
  Link as LinkIcon,
  Loader2,
  Lock,
  Mail,
  MoreHorizontal,
  Phone,
  Share2,
  ShieldAlert,
  Sparkles,
  Trash2,
  Undo2,
  UserPlus,
  UserRound,
  Users,
  Video,
  X,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { useAssistant } from '@/components/assistant/assistant-provider';
import { AttentionWaitingChip, useRecordAttention } from '@/components/attention/bits';
import { DeleteDialog } from '@/components/bin/delete-dialog';
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
import { useCanStartVideoCall, useStartVideoCall } from '@/components/video-call/start-call';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import { feedbackActions, feedbackOn, myFeedback, useReplyFeedback } from '@/lib/ai-team/feedback';
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
import { LaneSwitcher } from './lane-switcher';
import { ContextPanel } from './context-panel';
import {
  DraftCard,
  PhoneDraftBar,
  RejectedNext,
  SendingDraft,
  TeammateLine,
  useDraftDecision,
} from './draft-card';
import { useConversationActions, useCustomerNotes, useOpenedMessage, useThread } from './hooks';
import { useInbox } from './inbox-shell';
import { LinkPersonDialog } from './link-person-dialog';
import { MessageLog } from './message-log';
import { ReplyFeedback } from '@/components/ai-team/reply-feedback';
import { SocialMark } from './social-bits';

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
  allLanes = false,
}: {
  data: ConversationGet;
  thread: ConversationThread;
  tags: Tag[];
  pipelines: Pipeline[];
  businessName: string;
  /** "All lines": every lane of this customer at once, which reads and never sends (0089). */
  allLanes?: boolean;
}) {
  const router = useRouter();
  const {
    workspaceId,
    myUserId,
    permissions,
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
  // Messenger or Instagram (20261025000200): the name they go by there, until they're a customer.
  const social = isSocialChannel(c.channel) ? c.channel : null;
  const socialName =
    social && data.social && data.social.contact.name !== SOCIAL_CONTACT_NAMES[social]
      ? data.social.contact.name
      : null;
  const first = customerFirstName(person, chat ? data.chat?.name : socialName);
  const who = whoOf(first, c.channel);
  const name = rowName({ person, counterpartDisplay: c.counterpartDisplay });
  const listHref = `/app/w/${workspaceId}/inbox${listQuery}`;
  const customerHref = person ? `/app/w/${workspaceId}/customers/people/${person.id}` : null;
  // What the business lets them do (0106). Archiving matches every other record in HandsFreeOS
  // (records.archive), not everyone with the inbox; setting up a number is channels.manage.
  const canArchive = can(permissions, 'records.archive');
  // Deleting for good, with every lane the inbox shows as this one conversation (records.delete).
  const canDelete = can(permissions, 'records.delete');
  const [deleting, setDeleting] = useState(false);
  const laneIds = c.lanes.length > 0 ? c.lanes.map((l) => l.id) : [c.id];
  const canSetUp = can(permissions, 'channels.manage');
  const phone = useMediaQuery('(max-width: 767px)') === true;
  // With the Assistant docked beside the inbox, the customer pane folds away (Customer details opens it).
  const assistantDocked = useAssistant().docked;
  // Edit on an Assistant text or email card for a number that isn't in Contacts lands here.
  const handedDraft = useComposerDraft(c.id);
  const t = useThread(workspaceId, c.id, thread, allLanes);
  // A search result's message (`?message=…&at=…`): the thread opens at it and rings it.
  useOpenedMessage(t);
  // Thumbs on what the AI teammate wrote here, and what came of them.
  const aiMessageIds = t.items
    .filter(aiWroteIt)
    .map((i) => i.id)
    .slice(-100);
  const feedback = useReplyFeedback(workspaceId, { messageIds: aiMessageIds });
  const feedbackApi = useMemo(() => feedbackActions(workspaceId), [workspaceId]);
  // The customer's own notes, shown in the thread as the phone shows them (M10 step 15).
  const notes = useCustomerNotes(workspaceId, person?.id ?? null);
  // Only this customer's lanes and this customer: another conversation's news is the list's, not this page's.
  useLiveRefresh(['conversation', 'person', 'lead', 'task'], 300, {
    only: {
      conversation: [c.id, ...c.lanes.map((l) => l.id)],
      ...(person ? { person: [person.id] } : {}),
    },
  });
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
  const waiting = drafts.pending ?? drafts.approval ?? drafts.ask;
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
  // Someone's own mail (M19): theirs alone, so nobody to assign it to and no customer to make of it.
  const priv = c.private;
  const moves = (email && !allLanes ? mailMoves(c.folder, priv) : []).map((m) => ({
    ...m,
    icon: FOLDER_ICON[m.folder],
    testId: `thread-${m.remember ? 'always' : 'move'}-${m.folder}`,
  }));
  // Calls go to a text conversation's number, known customer or not. An email thread or a website chat uses
  // the customer's phone, so a chat visitor not in Contacts has no Call (the chat's counterpart isn't a
  // number). Customers see the business number.
  // A client's portal thread is neither: its client's phone, like an email thread's.
  const portal = c.channel === 'portal';
  // Messenger and Instagram the same: the customer's phone, when they're a customer with one.
  const byNumber = !email && !chat && !portal && !social;
  const callPhone = byNumber ? c.counterpart : (person?.phoneE164 ?? null);
  const canCall = calls.available && !!callPhone;
  const callTarget = {
    name,
    phone: callPhone ?? '',
    personId: person?.id ?? null,
    conversationId: byNumber ? c.id : undefined,
  };
  // A video call (docs/video-calls.md, part 5) with the customer this conversation is with, its link sent here.
  const canVideo = useCanStartVideoCall() && !!person && !priv;
  const video = useStartVideoCall(workspaceId);
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
      const out = unwrap(
        await apiBrowser().POST('/v1/commands/message.retry', { body: { workspaceId, messageId } }),
      );
      // In quiet hours a text tried again waits for them to end, like any held text.
      toast.success(
        out.scheduledFor
          ? SENT_WORDS.held(first ?? c.counterpartDisplay, out.scheduledFor, timezone)
          : CONVERSATION_DONE.retrying,
      );
      t.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  /** Cancel on a text held for quiet hours: it never goes. A failed text sent again goes back as it was. */
  async function cancelHeld(messageId: string) {
    try {
      const out = unwrap(
        await apiBrowser().POST('/v1/commands/message.cancel_scheduled', {
          body: { workspaceId, messageId },
        }),
      );
      // A failed text tried again goes back to its old place, which may be further back than the newest page.
      if (out.stays) void t.bringBack(messageId);
      else t.forget(messageId);
      toast.success(out.stays ? CONVERSATION_DONE.retryCancelled : CONVERSATION_DONE.heldCancelled);
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

  const notCustomer = notCustomerBanner(c.counterpartDisplay, c.channel);
  /**
   * The conversation onto a customer: one just added from it, or one picked to link it to. Someone's own mail is
   * never a customer's while it's theirs (M19), so it is shared with the team in the same step, as its buttons say.
   */
  async function linkTo(personId: string, done: string, sharedDone: string) {
    if (priv) {
      await actions.share(personId, sharedDone);
      return;
    }
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/conversation.link_person', {
          body: { workspaceId, conversationId: c.id, personId },
        }),
      );
      toast.success(done);
      after();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }
  const linkNewPerson = (personId: string) =>
    linkTo(personId, CONVERSATION_DONE.linked, CONVERSATION_DONE.shared);
  // Email from an address somebody in Contacts already has: one tap links them (and shares one's own mail).
  const known = data.sender?.customer ?? null;
  const linkKnown = (id: string, name: string) =>
    linkTo(id, SENDER_WORDS.linked(name), SENDER_WORDS.linkedShared(name));
  const senderButtons = known ? (
    <Button
      variant="secondary"
      size="sm"
      className="max-md:min-h-11"
      onClick={() => void linkKnown(known.id, known.fullName)}
      data-testid="banner-link-known"
    >
      <LinkIcon className="h-3.5 w-3.5" strokeWidth={1.5} />
      {SENDER_WORDS.linkTo(known.fullName)}
    </Button>
  ) : (
    <>
      <Button
        variant="secondary"
        size="sm"
        className="max-md:min-h-11"
        onClick={() => setAddPerson(true)}
        data-testid="banner-add-person"
      >
        {priv ? SENDER_WORDS.add : notCustomer.action}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="max-md:min-h-11"
        onClick={() => setLinkPerson(true)}
        data-testid="banner-link-person"
      >
        <LinkIcon className="h-3.5 w-3.5" strokeWidth={1.5} />
        {SENDER_WORDS.link}
      </Button>
    </>
  );

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
    phoneDisplay:
      email || social
        ? (person?.phone ?? '')
        : chat
          ? (person?.phone ?? data.chat?.phone ?? '')
          : c.counterpartDisplay,
    email: email ? c.counterpart : (person?.email ?? null),
    canText: data.canText,
    quiet: data.quiet,
    timeZone: timezone,
    fromNumber: data.fromNumber,
    businessName,
    // A person's message takes the conversation from the teammate (the phone's draft bar says so itself).
    handoverNote: phone && waiting ? null : handoverNote(view, aiName),
    chatBlocked: data.chat?.blocked ?? false,
    rcs: data.rcs,
    social: data.social,
  };
  // "@jane.doe · Instagram · to @brightplumbing": who they are there, and which of the business's accounts.
  const socialLine = data.social
    ? { handle: data.social.contact.username, account: data.social.account?.label ?? null }
    : null;
  /**
   * "All lines" reads and never writes (0089).
   *
   * Not a disabled Send but no composer at all, with the reason and the way out in its place: the customer
   * has more than one line here and the app cannot pick which one an answer leaves from — only the person
   * can, and the switcher above is where. A greyed-out box would leave somebody typing into something that
   * was never going to send.
   */
  const composer = allLanes ? (
    <div
      className="flex-none border-t border-border bg-card px-4 py-3 text-center text-[13px] text-text-2"
      data-testid="composer-all-lines"
    >
      {ALL_LINES_WORDS.note}
    </div>
  ) : (
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
      tags={tags}
      canMoney={can(permissions, 'money.bill')}
      onAddPerson={() => setAddPerson(true)}
      onLinkPerson={() => setLinkPerson(true)}
      onLinkTo={(id, name) => void linkKnown(id, name)}
      onEditPerson={() => void editPerson()}
      onPersonCreated={(personId) => void linkNewPerson(personId)}
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
  // Handing a conversation to the teammate: back from a person, or one nobody is handling yet. Not on Messenger or
  // Instagram, which it doesn't answer yet.
  const canHandToAi =
    !priv &&
    !social &&
    !!tm &&
    tm.status !== 'off' &&
    view !== 'ai' &&
    view !== 'needs_person' &&
    view !== 'person';

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
          <ContactAvatar person={person} chat={chat} social={social} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[15px] font-semibold" data-testid="thread-name">
              {name}
            </div>
            <div className="flex items-center gap-1.5 truncate text-xs text-text-3">
              {/* Which of the business's lines this customer is on, and a way to change it (0089). The
                  channel line stays beside it: one says what the customer's end is, the other ours. */}
              <LaneSwitcher
                workspaceId={workspaceId}
                lanes={data.conversation.lanes}
                currentId={c.id}
                all={allLanes}
                listQuery={listQuery}
              />
              {chat ? <WebsiteIcon className="h-3 w-3" /> : null}
              {social ? <SocialMark channel={social} className="h-3 w-3" /> : null}
              <span className="truncate" data-testid="thread-channel">
                {threadChannelLine(c, person, { chat: data.chat, social: socialLine })}
              </span>
            </div>
          </div>
          {onHome ? (
            <AttentionWaitingChip item={onHome} now={now} href={`/app/w/${workspaceId}`} />
          ) : null}
          {chat && data.chat?.onSiteNow ? <SiteTag /> : null}
          {priv ? (
            <span
              className="inline-flex h-7 items-center gap-1 rounded-full bg-card-2 px-2.5 text-xs font-medium text-text-2"
              data-testid="thread-private"
            >
              <Lock className="h-3 w-3" strokeWidth={1.5} />
              {PRIVATE_THREAD_WORDS.badge}
            </span>
          ) : null}
          {priv ? null : (
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
          )}
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
              <Button
                variant="ghost"
                size="icon"
                title="More"
                aria-label="More"
                data-testid="thread-menu"
              >
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
              {canVideo ? (
                <DropdownMenuItem
                  disabled={video.busy}
                  onSelect={() => void video.start({ conversationId: c.id })}
                  data-testid="thread-video-call"
                >
                  <Video className="h-3.5 w-3.5" strokeWidth={1.5} />
                  {VIDEO_CALL_WORDS.start}
                </DropdownMenuItem>
              ) : null}
              {customerHref ? (
                <DropdownMenuItem onSelect={() => router.push(customerHref)}>
                  <UserRound className="h-3.5 w-3.5" strokeWidth={1.5} />
                  {CONVERSATION_ACTIONS.openCustomer}
                </DropdownMenuItem>
              ) : (
                <>
                  {priv ? (
                    <DropdownMenuItem
                      onSelect={() => void actions.share()}
                      data-testid="thread-share"
                    >
                      <Share2 className="h-3.5 w-3.5" strokeWidth={1.5} />
                      {CONVERSATION_ACTIONS.share}
                    </DropdownMenuItem>
                  ) : null}
                  {/* Someone's own mail only ever comes by email; adding or linking its sender shares it (M19). */}
                  {!priv || email ? (
                    <>
                      <DropdownMenuItem
                        onSelect={() => setAddPerson(true)}
                        data-testid="thread-add-person"
                      >
                        <UserPlus className="h-3.5 w-3.5" strokeWidth={1.5} />
                        {priv ? SENDER_WORDS.add : CONVERSATION_ACTIONS.addPerson}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onSelect={() => setLinkPerson(true)}
                        data-testid="thread-link-person"
                      >
                        <LinkIcon className="h-3.5 w-3.5" strokeWidth={1.5} />
                        {SENDER_WORDS.link}
                      </DropdownMenuItem>
                    </>
                  ) : null}
                </>
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
              {/* Closing is per lane, because finishing a text says nothing about a mail thread still
                  waiting. This is the other half: done with the customer, everywhere (0089). Only offered
                  when there is more than one, or it is the Close button under a longer name. */}
              {data.conversation.lanes.length > 1 ? (
                <DropdownMenuItem
                  onSelect={() => void actions.closeAll()}
                  data-testid="close-all-lanes"
                >
                  <CircleCheck className="h-3.5 w-3.5" strokeWidth={1.5} />
                  {CONVERSATION_ACTIONS.closeAll}
                </DropdownMenuItem>
              ) : null}
              {chat || portal ? null : (
                <DropdownMenuItem onSelect={() => void copyCounterpart()} data-testid="thread-copy">
                  <Copy className="h-3.5 w-3.5" strokeWidth={1.5} />
                  {email ? CONVERSATION_ACTIONS.copyEmail : CONVERSATION_ACTIONS.copyPhone}
                </DropdownMenuItem>
              )}
              {moves.length ? (
                <>
                  <DropdownMenuSeparator />
                  {moves.map((m) => (
                    <DropdownMenuItem
                      key={m.testId}
                      onSelect={() => void actions.move(m.folder, m.remember)}
                      data-testid={m.testId}
                    >
                      <m.icon className="h-3.5 w-3.5" strokeWidth={1.5} />
                      {m.label}
                    </DropdownMenuItem>
                  ))}
                </>
              ) : null}
              {canArchive ? (
                <>
                  <DropdownMenuSeparator />
                  {c.archived ? (
                    <DropdownMenuItem
                      onSelect={() => void actions.restore()}
                      data-testid="thread-restore"
                    >
                      <ArchiveRestore className="h-3.5 w-3.5" strokeWidth={1.5} />
                      {CONVERSATION_ACTIONS.restore}
                    </DropdownMenuItem>
                  ) : (
                    <DropdownMenuItem
                      danger
                      onSelect={() => void actions.archive()}
                      data-testid="thread-archive"
                    >
                      <Archive className="h-3.5 w-3.5" strokeWidth={1.5} />
                      {CONVERSATION_ACTIONS.archive}
                    </DropdownMenuItem>
                  )}
                  {canDelete ? (
                    <DropdownMenuItem
                      danger
                      onSelect={() => setDeleting(true)}
                      data-testid="thread-delete"
                    >
                      <Trash2 className="h-3.5 w-3.5" strokeWidth={1.5} />
                      {BIN_WORDS.menu}
                    </DropdownMenuItem>
                  ) : null}
                </>
              ) : null}
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
          <ContactAvatar person={person} chat={chat} social={social} />
          <div className="ml-1.5 min-w-0 flex-1">
            <div className="truncate text-[15px] font-semibold">{name}</div>
            {/* A phone has less room, so the line it is on replaces the channel line rather than joining it:
                which of the business's numbers answers is the more useful of the two here (0089). */}
            {data.conversation.lanes.length > 1 ? (
              <LaneSwitcher
                workspaceId={workspaceId}
                lanes={data.conversation.lanes}
                currentId={c.id}
                all={allLanes}
                listQuery={listQuery}
              />
            ) : (
              <div className="truncate text-xs text-text-3">
                {threadChannelLine(c, person, { chat: data.chat, social: socialLine, short: true })}
              </div>
            )}
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

        {person ? null : priv ? (
          // Someone's own mail (M19): shared as it is, or with its sender added or linked on the way.
          <Callout tone="info" icon={Lock} className={bannerClass}>
            <p>
              {PRIVATE_THREAD_WORDS.banner}
              {email
                ? ` ${known ? SENDER_WORDS.known(known.fullName) : SENDER_WORDS.sharesToo}`
                : ''}
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button
                variant="secondary"
                size="sm"
                className="max-md:min-h-11"
                onClick={() => void actions.share()}
                data-testid="banner-share"
              >
                {CONVERSATION_ACTIONS.share}
              </Button>
              {email ? senderButtons : null}
            </div>
          </Callout>
        ) : (
          <Callout
            tone="info"
            icon={UserPlus}
            className={bannerClass}
            action={<div className="flex gap-2">{senderButtons}</div>}
          >
            {known ? (
              SENDER_WORDS.known(known.fullName)
            ) : (
              <>
                <span className="hidden md:inline">
                  <Words parts={notCustomer.parts} />
                </span>
                <span className="md:hidden">{notCustomer.short}</span>
              </>
            )}
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
            {canSetUp ? (
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
              timeZone={timezone}
              aiFeedback={(item) => (
                <ReplyFeedback
                  workspaceId={workspaceId}
                  actions={feedbackApi}
                  reply={item.body ?? ''}
                  messageId={item.id}
                  mine={myFeedback(feedback, { messageId: item.id })}
                  all={feedbackOn(feedback, { messageId: item.id })}
                  canSaveRules={feedback.canSaveRules}
                  slow={feedback.slow}
                  onChange={feedback.put}
                  align="end"
                />
              )}
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
            <ContactAvatar person={person} size="panel" social={social} />
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
            {canVideo ? (
              <SheetAction
                icon={Video}
                testId="sheet-video-call"
                onClick={() => {
                  setDetails(false);
                  void video.start({ conversationId: c.id });
                }}
              >
                {VIDEO_CALL_WORDS.start}
              </SheetAction>
            ) : null}
            {customerHref ? (
              <SheetAction icon={UserRound} onClick={() => router.push(customerHref)}>
                {CONVERSATION_ACTIONS.openCustomer}
              </SheetAction>
            ) : (
              <>
                {priv ? (
                  <SheetAction
                    icon={Share2}
                    testId="sheet-share"
                    onClick={() => {
                      setDetails(false);
                      void actions.share();
                    }}
                  >
                    {CONVERSATION_ACTIONS.share}
                  </SheetAction>
                ) : null}
                {!priv || email ? (
                  <>
                    <SheetAction
                      icon={UserPlus}
                      testId="sheet-add-person"
                      onClick={() => {
                        setDetails(false);
                        setAddPerson(true);
                      }}
                    >
                      {priv ? SENDER_WORDS.add : CONVERSATION_ACTIONS.addPerson}
                    </SheetAction>
                    <SheetAction
                      icon={LinkIcon}
                      testId="sheet-link-person"
                      onClick={() => {
                        setDetails(false);
                        setLinkPerson(true);
                      }}
                    >
                      {SENDER_WORDS.link}
                    </SheetAction>
                  </>
                ) : null}
              </>
            )}
            {priv ? null : (
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
            )}
            {moves.map((m) => (
              <SheetAction
                key={m.testId}
                icon={m.icon}
                testId={`sheet-${m.testId.slice('thread-'.length)}`}
                onClick={() => {
                  setDetails(false);
                  void actions.move(m.folder, m.remember).then((ok) => ok && router.push(listHref));
                }}
              >
                {m.label}
              </SheetAction>
            ))}
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
        defaultPhone={email ? undefined : c.counterpartDisplay}
        defaultEmail={email ? c.counterpart : undefined}
        defaultName={data.sender?.name ?? undefined}
        onSaved={(personId) => void linkNewPerson(personId)}
        // Somebody already has the number or address: choosing them links the conversation to them instead.
        onChooseMatch={(m) => void linkKnown(m.id, m.name)}
      />
      <LinkPersonDialog
        workspaceId={workspaceId}
        conversationId={c.id}
        number={c.counterpartDisplay}
        privateMail={priv}
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
      {canDelete ? (
        <DeleteDialog
          workspaceId={workspaceId}
          kind="conversation"
          ids={laneIds}
          names={laneIds.map(() => name)}
          open={deleting}
          onOpenChange={setDeleting}
          onDeleted={() => {
            reloadList();
            router.push(listHref);
          }}
        />
      ) : null}
    </div>
  );
}

/** How each email folder looks in a thread's menu (M19). */
const FOLDER_ICON: Record<'inbox' | 'other' | 'spam', LucideIcon> = {
  inbox: Undo2,
  other: Inbox,
  spam: ShieldAlert,
};
