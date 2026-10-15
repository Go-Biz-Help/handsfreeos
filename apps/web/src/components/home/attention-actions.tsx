'use client';
import {
  assignedToOf,
  assignedToast,
  assigneeShortOf,
  ATTENTION_WORDS,
  attentionReachOf,
  clockLabel,
  handleButtonOf,
  lessonKnowsOtherwise,
  letHandleAutoToast,
  letHandleOffReason,
  type HandleIcon,
} from '@hfos/core';
import {
  ArchiveX,
  ArrowUpRight,
  CalendarPlus,
  Check,
  FileText,
  ListChecks,
  Mail,
  MessageCircle,
  MoreHorizontal,
  Phone,
  Receipt,
  Send,
  UserPlus,
  UserRound,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  useMemo,
  useState,
  type Dispatch,
  type MouseEventHandler,
  type SetStateAction,
} from 'react';
import { toast } from 'sonner';
import { BrandMark } from '@/components/ui/brand';
import { Button, buttonClassName, type ButtonVariant } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { approvalsChanged } from '@/components/workflows/approvals/use-waiting-approvals';
import { teammateCommands } from '@/lib/ai-team/use-inbox';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { AttentionItem } from '@/lib/api/types';
import { useCalls } from '@/lib/calls/call-provider';
import { useMatches } from '@/lib/use-media';
import { cn } from '@/lib/utils';
import { AssignList, AssignSubmenu } from './assign-menu';
import { KindTile, SheetRow } from './attention-bits';
import { useAttentionEnv, type ItemActions, type MemberOption } from './attention-context';
import {
  customerOf,
  firstNameOf,
  isDraft,
  KIND_LABEL,
  snoozedUntil,
  targetOf,
} from './attention-words';
import { SnoozeMenuItems, SnoozeRows } from './snooze-menu';
import { attentionCommands, type AttentionListState } from './use-attention';

/** Which dialog or sheet the Action Center has open, and for which item. */
export interface AttentionDialog {
  readonly type:
    'let_handle' | 'dismiss' | 'pick_time' | 'next_action' | 'task' | 'menu' | 'message';
  readonly item: AttentionItem;
  /** For 'message': the composer, already filled in with the follow-up about their document. */
  readonly message?: {
    readonly channel: 'sms' | 'email';
    readonly person: {
      readonly id: string;
      readonly fullName: string;
      readonly phone: string | null;
      readonly phoneE164: string | null;
      readonly email: string | null;
    };
    readonly body: string;
    readonly subject: string | null;
  };
}

const UNDO_MS = 6000;

/**
 * What each card's buttons do, with their toasts, Undo and reloads (this tab's own changes don't come back over
 * Realtime, so the list and the badge are read again after each one).
 */
export function useItemActions(o: {
  readonly workspaceId: string;
  readonly timeZone: string;
  readonly myUserId: string;
  readonly members: readonly MemberOption[];
  readonly teammateName: string | null;
  readonly hide: AttentionListState['hide'];
  readonly unhide: AttentionListState['unhide'];
  readonly reload: AttentionListState['reload'];
  readonly refreshSummary: () => void;
  readonly open: (dialog: AttentionDialog) => void;
  readonly setBusy: Dispatch<SetStateAction<ReadonlySet<string>>>;
  /** Whether the open task behind an overdue-task item is on the page (the dialog edits it). */
  readonly hasTask: (taskId: string) => boolean;
}): ItemActions {
  const router = useRouter();
  const calls = useCalls();
  const {
    workspaceId,
    timeZone,
    myUserId,
    members,
    teammateName,
    hide,
    unhide,
    reload,
    refreshSummary,
    open,
    setBusy,
    hasTask,
  } = o;
  const { available: callsAvailable, openDialer } = calls;

  return useMemo<ItemActions>(() => {
    const cmd = attentionCommands(workspaceId);
    const base = `/app/w/${workspaceId}`;
    const settle = () => {
      reload();
      refreshSummary();
    };
    const running = (id: string, on: boolean) =>
      setBusy((s) => {
        const next = new Set(s);
        if (on) next.add(id);
        else next.delete(id);
        return next;
      });
    async function withBusy(id: string, run: () => Promise<void>) {
      running(id, true);
      try {
        await run();
      } catch (e) {
        toast.error(errorMessage(e));
      } finally {
        running(id, false);
      }
    }
    const firstOf = (item: AttentionItem) => firstNameOf(customerOf(item));
    /** The conversation to answer in, or the record itself. */
    const reachOf = (item: AttentionItem) => attentionReachOf(item, workspaceId);
    const undo = (item: AttentionItem) => {
      cmd
        .restore(item.id)
        .then(() => {
          unhide([item.id]);
          settle();
        })
        .catch((e: unknown) => toast.error(errorMessage(e)));
    };

    async function call(item: AttentionItem) {
      if (!item.personId) return router.push(reachOf(item));
      const { person } = unwrap(
        await apiBrowser().POST('/v1/queries/person.get', {
          body: { workspaceId, personId: item.personId },
        }),
      );
      if (!person.phoneE164) {
        toast.error(ATTENTION_WORDS.noPhoneToast(firstNameOf(person.fullName)));
        return router.push(reachOf(item));
      }
      openDialer({ name: person.fullName, phone: person.phoneE164, personId: person.id });
    }

    /** "Confirm by text": the confirmation request, through Let HandsFreeOS Handle (its sheet says why not). */
    async function askToConfirm(item: AttentionItem) {
      const first = firstOf(item);
      const { auto: plan } = await cmd.preview(item.id);
      if (!plan || plan.blocked || !item.actions.letHandle)
        return open({ type: 'let_handle', item });
      if (plan.scheduledFor) {
        toast(
          ATTENTION_WORDS.asksAtToast(first, clockLabel(Date.parse(plan.scheduledFor), timeZone)),
        );
        return;
      }
      const out = await cmd.letHandle({ itemId: item.id });
      const at = out.scheduledFor ?? plan.sendAt;
      toast.success(
        letHandleAutoToast({
          confirm: true,
          channel: plan.channel,
          first,
          at: at ? clockLabel(Date.parse(at), timeZone) : null,
        }),
      );
      settle();
    }

    /**
     * A money card handled in one press: ring them when there's a number and the business is open, otherwise
     * open the composer with the follow-up already written from the document's own figures. When it can't go —
     * no way to reach them, or the business's own reminder went out today — the Let HandsFreeOS Handle sheet
     * says so instead of opening a composer that shouldn't be used.
     */
    async function followUp(item: AttentionItem) {
      if (!item.personId) return router.push(targetOf(item, workspaceId).href);
      if (callsAvailable && item.callable) return call(item);
      const { options } = await cmd.preview(item.id);
      const reply = options.find((o) => o.action === 'reply');
      const channel = reply?.channel;
      if (!reply?.available || !reply.draft || (channel !== 'sms' && channel !== 'email'))
        return open({ type: 'let_handle', item });
      const { person } = unwrap(
        await apiBrowser().POST('/v1/queries/person.get', {
          body: { workspaceId, personId: item.personId },
        }),
      );
      open({
        type: 'message',
        item,
        message: {
          channel,
          person: {
            id: person.id,
            fullName: person.fullName,
            phone: person.phone,
            phoneE164: person.phoneE164,
            email: person.email,
          },
          body: reply.draft.body,
          subject: reply.draft.subject,
        },
      });
    }

    /** A referral's one press: the person and the lead, then the lead itself. */
    async function createReferralLead(item: AttentionItem) {
      hide([item.id]);
      try {
        const out = unwrap(
          await apiBrowser().POST('/v1/commands/referral.create_lead', {
            body: { workspaceId, referralId: item.subject.id },
          }),
        );
        toast.success(
          out.existingPerson
            ? 'They were already a customer: added a lead for them.'
            : 'Added them as a customer, with a lead.',
          {
            action: {
              label: 'Open the lead',
              onClick: () => router.push(`${base}/leads/${out.leadId}`),
            },
          },
        );
      } catch (e) {
        unhide([item.id]);
        throw e;
      }
      settle();
    }

    /** A deal behind what happened: onto the stage that says so. */
    async function catchUp(item: AttentionItem) {
      hide([item.id]);
      try {
        const out = unwrap(
          await apiBrowser().POST('/v1/commands/lead.catch_up', {
            body: { workspaceId, leadId: item.subject.id },
          }),
        );
        toast.success(`Moved to ${out.stageName}.`);
      } catch (e) {
        unhide([item.id]);
        throw e;
      }
      settle();
    }

    /**
     * The line made of a correction goes on the AI teammate's instructions. When what it knows said otherwise, the card asked
     * which is right and this is "Use the new one": the new words take the old ones' place (dismissing keeps them).
     */
    async function addLesson(item: AttentionItem) {
      const replace = lessonKnowsOtherwise(item);
      hide([item.id]);
      try {
        const out = unwrap(
          await apiBrowser().POST('/v1/commands/teammate_lesson.apply', {
            body: { workspaceId, lessonId: item.subject.id, ...(replace ? { replace } : {}) },
          }),
        );
        toast.success(
          out.replaced
            ? `Added to its instructions, and changed ${out.replaced.where} to match.`
            : 'Added to its instructions.',
          {
            action: {
              label: 'See it',
              onClick: () => router.push(`${base}/ai-team/instructions`),
            },
          },
        );
      } catch (e) {
        unhide([item.id]);
        throw e;
      }
      settle();
    }

    /** A visit whose time passed: it happened. The toast offers the other answer. */
    async function markDone(item: AttentionItem) {
      const setStatus = (status: 'completed' | 'no_show') =>
        apiBrowser().POST('/v1/commands/appointment.set_status', {
          body: { workspaceId, appointmentId: item.subject.id, status },
        });
      hide([item.id]);
      try {
        unwrap(await setStatus('completed'));
      } catch (e) {
        unhide([item.id]);
        throw e;
      }
      toast.success('Marked done.', {
        action: {
          label: 'It didn’t happen',
          onClick: () =>
            void setStatus('no_show').then((r) => {
              unwrap(r);
              toast('Marked as didn’t happen.');
            }),
        },
      });
      settle();
    }

    async function approve(item: AttentionItem) {
      hide([item.id]);
      try {
        await teammateCommands(workspaceId).decide({
          draftId: item.subject.id,
          decision: 'approve',
        });
      } catch (e) {
        unhide([item.id]);
        throw e;
      }
      approvalsChanged();
      toast.success(ATTENTION_WORDS.approvedToast(teammateName, firstOf(item)));
      settle();
    }

    return {
      handle(item) {
        // The wait comes first: a card carrying a customer's waiting chip opens that conversation, whatever
        // kind the card is (see handleButtonOf, which words the button the same way).
        if (item.conversationId && item.reasons.some((r) => r.code === 'waiting'))
          return router.push(reachOf(item));
        switch (item.kind) {
          case 'hot_lead':
            if (callsAvailable && item.personId) return void withBusy(item.id, () => call(item));
            return router.push(reachOf(item));
          case 'unanswered_lead':
          case 'customer_waiting':
          case 'stale_opportunity':
            return router.push(reachOf(item));
          case 'missing_next_action':
            if (item.leadId) return open({ type: 'next_action', item });
            return router.push(reachOf(item));
          case 'unconfirmed_appointment':
            return void withBusy(item.id, () => askToConfirm(item));
          case 'ai_approval':
            if (isDraft(item)) return void withBusy(item.id, () => approve(item));
            return router.push(targetOf(item, workspaceId).href);
          case 'overdue_task':
            if (hasTask(item.subject.id)) return open({ type: 'task', item });
            return router.push(`${base}/tasks`);
          // Money is handled like the rest: reach the customer, with the follow-up already written. The
          // document itself is one press away in the ⋯ menu.
          case 'estimate_waiting':
          case 'invoice_overdue':
            return void withBusy(item.id, () => followUp(item));
          // After the job: thanking them is a reply; a referral becomes a customer and a lead in one press.
          case 'job_not_thanked':
            return router.push(reachOf(item));
          case 'referral_mentioned':
            return void withBusy(item.id, () => createReferralLead(item));
          // Two texts went already: a call when this browser can, else the conversation.
          case 'maintenance_due':
          case 'quiet_after_price':
          case 'client_quiet':
          case 'promise_due':
            if (callsAvailable && item.personId) return void withBusy(item.id, () => call(item));
            return router.push(reachOf(item));
          case 'revenue_moved':
            return router.push(targetOf(item, workspaceId).href);
          // Health and quality: the page that checks or fixes it; a lesson is added in one press. An add-on's
          // alert opens the add-on's own page.
          case 'channel_quiet':
          case 'connection_error':
          case 'connection_silent':
          case 'ai_unreviewed':
          case 'website_changed':
          case 'faq_suggestions':
          case 'offer_lapsing':
          case 'texting_rejected':
          case 'addon_alert':
            return router.push(targetOf(item, workspaceId).href);
          case 'ai_corrections':
            return void withBusy(item.id, () => addLesson(item));
          // Pipeline and jobs: the deal moves in one press; a visit is marked done in one; an address is
          // added on the customer (where every visit at their place reads it).
          case 'pipeline_mismatch':
            return void withBusy(item.id, () => catchUp(item));
          case 'job_unconfirmed':
          case 'job_never_completed':
            return void withBusy(item.id, () => markDone(item));
          case 'job_no_address':
            if (item.personId) return router.push(`${base}/customers/people/${item.personId}`);
            return router.push(targetOf(item, workspaceId).href);
        }
      },
      call(item) {
        void withBusy(item.id, () => call(item));
      },
      letHandle(item) {
        open({ type: 'let_handle', item });
      },
      snooze(item, until) {
        void withBusy(item.id, async () => {
          hide([item.id]);
          try {
            await cmd.snooze(item.id, new Date(until).toISOString());
          } catch (e) {
            unhide([item.id]);
            throw e;
          }
          toast(ATTENTION_WORDS.snoozedToast(snoozedUntil(until, timeZone, Date.now())), {
            action: { label: ATTENTION_WORDS.undo, onClick: () => undo(item) },
            duration: UNDO_MS,
          });
          settle();
        });
      },
      pickTime(item) {
        open({ type: 'pick_time', item });
      },
      dismiss(item) {
        open({ type: 'dismiss', item });
      },
      dismissNow(item, reason) {
        void withBusy(item.id, async () => {
          hide([item.id]);
          try {
            await cmd.dismiss(item.id, reason);
          } catch (e) {
            unhide([item.id]);
            throw e;
          }
          toast(ATTENTION_WORDS.dismissedToast, {
            action: { label: ATTENTION_WORDS.undo, onClick: () => undo(item) },
            duration: UNDO_MS,
          });
          settle();
        });
      },
      assign(item, userId) {
        if ((item.assignee?.id ?? null) === userId) return;
        void withBusy(item.id, async () => {
          const out = await cmd.assign(item.id, userId);
          const who = members.find((m) => m.id === userId);
          toast(
            assignedToast(
              out.passedTo,
              userId === myUserId,
              who ? firstNameOf(who.fullName) : null,
            ),
            {
              action: {
                label: ATTENTION_WORDS.undo,
                onClick: () => {
                  cmd
                    .assign(item.id, out.previousAssigneeUserId)
                    .then(settle)
                    .catch((e: unknown) => toast.error(errorMessage(e)));
                },
              },
              duration: UNDO_MS,
            },
          );
          settle();
        });
      },
      cancelAuto(ref) {
        void withBusy(ref.itemId, async () => {
          await cmd.cancelAuto(ref.itemId);
          const first = firstNameOf(ref.name);
          toast(ATTENTION_WORDS.cancelledAutoToast(ref.action === 'confirm_request', first));
          settle();
        });
      },
      acknowledge(item) {
        const alertId = item.addonAlert?.alertId;
        if (!alertId) return;
        void withBusy(item.id, async () => {
          await cmd.acknowledge(alertId);
          toast.success(ATTENTION_WORDS.acknowledgedToast);
          settle();
        });
      },
      more(item) {
        open({ type: 'menu', item });
      },
    };
  }, [
    workspaceId,
    timeZone,
    myUserId,
    members,
    teammateName,
    hide,
    unhide,
    reload,
    refreshSummary,
    open,
    setBusy,
    hasTask,
    callsAvailable,
    openDialer,
    router,
  ]);
}

const HANDLE_ICONS: Readonly<Record<HandleIcon, LucideIcon>> = {
  phone: Phone,
  mail: Mail,
  send: Send,
  message: MessageCircle,
  'calendar-plus': CalendarPlus,
  check: Check,
  'list-checks': ListChecks,
  receipt: Receipt,
  'file-text': FileText,
  'user-plus': UserPlus,
};

/** The main button's words and icon for an item (core's words); `reach` says the channel it would really use. */
export function handleLook(
  item: AttentionItem,
  callsAvailable: boolean,
): { label: string; icon: LucideIcon } {
  const look = handleButtonOf(item, callsAvailable);
  return { label: look.label, icon: HANDLE_ICONS[look.icon] };
}

/** The main button: it fits the item (Call Maria, Reply, Set next action, Confirm by text, Approve, Open task). */
export function HandleButton({
  item,
  variant = 'primary',
  className,
}: {
  item: AttentionItem;
  variant?: ButtonVariant;
  className?: string;
}) {
  const env = useAttentionEnv();
  if (!item.actions.handle) return null;
  const look = handleLook(item, env.callsAvailable);
  const Icon = look.icon;
  return (
    <Button
      size="sm"
      variant={variant}
      loading={env.busy.has(item.id)}
      onClick={() => env.act.handle(item)}
      data-testid="attention-handle"
      className={className}
    >
      {env.busy.has(item.id) ? null : <Icon className="h-4 w-4" strokeWidth={1.75} />}
      {look.label}
    </Button>
  );
}

/** An add-on's alert that waits for someone to say they've seen it: in Let HandsFreeOS Handle's place. */
export function AcknowledgeButton({
  item,
  className,
}: {
  item: AttentionItem;
  className?: string;
}) {
  const env = useAttentionEnv();
  const alert = item.addonAlert;
  if (!alert?.needsAck || alert.acknowledgedAt) return null;
  return (
    <Button
      size="sm"
      variant="secondary"
      loading={env.busy.has(item.id)}
      onClick={() => env.act.acknowledge(item)}
      data-testid="attention-acknowledge"
      className={className}
    >
      {env.busy.has(item.id) ? null : <Check className="h-4 w-4" strokeWidth={1.75} />}
      {ATTENTION_WORDS.acknowledge}
    </Button>
  );
}

export function LetHandleButton({ item, className }: { item: AttentionItem; className?: string }) {
  const env = useAttentionEnv();
  const off = letHandleOffReason(item);
  return (
    <button
      type="button"
      aria-disabled={off ? true : undefined}
      title={off ?? undefined}
      data-testid="attention-let-handle"
      onClick={off ? undefined : () => env.act.letHandle(item)}
      className={cn(
        buttonClassName({ variant: 'secondary', size: 'sm' }),
        off && 'cursor-not-allowed opacity-50 shadow-none hover:bg-card',
        className,
      )}
    >
      <BrandMark size={16} />
      {ATTENTION_WORDS.letHandle}
    </button>
  );
}

const MORE =
  'inline-flex h-11 w-11 flex-none items-center justify-center rounded-control border border-border-strong bg-card text-text-2 transition-colors hover:bg-card-2 hover:text-text data-[state=open]:bg-card-2 data-[state=open]:text-text md:h-8 md:w-8 md:border-transparent md:bg-transparent';
const MENU_HEAD = 'pb-1 pt-[7px] text-[11px] font-semibold uppercase tracking-[0.04em] text-text-3';

function MoreButton({ onClick }: { onClick?: MouseEventHandler<HTMLButtonElement> }) {
  return (
    <button
      type="button"
      aria-label="More"
      data-testid="attention-more"
      onClick={onClick}
      className={MORE}
    >
      <MoreHorizontal className="h-[18px] w-[18px]" strokeWidth={1.75} />
    </button>
  );
}

/** ⋯ on a card: Assign, Snooze and Dismiss, and the record itself. A phone gets a bottom sheet instead. */
export function ItemMenu({ item }: { item: AttentionItem }) {
  const env = useAttentionEnv();
  const phone = useMatches('(max-width: 767px)');
  const a = item.actions;
  if (phone) return <MoreButton onClick={() => env.act.more(item)} />;
  const target = targetOf(item, env.workspaceId);
  return (
    <DropdownMenu modal={false}>
      {/* The trigger's own element: Radix hands it the open state and its handlers. */}
      <DropdownMenuTrigger asChild>
        <button type="button" aria-label="More" data-testid="attention-more" className={MORE}>
          <MoreHorizontal className="h-[18px] w-[18px]" strokeWidth={1.75} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="min-w-[240px]" data-testid="attention-menu">
        {a.assign ? <AssignSubmenu item={item} /> : null}
        {a.snooze ? (
          <>
            {a.assign ? <DropdownMenuSeparator /> : null}
            <DropdownMenuLabel className={MENU_HEAD}>{ATTENTION_WORDS.snooze}</DropdownMenuLabel>
            <SnoozeMenuItems item={item} />
          </>
        ) : null}
        {a.dismiss ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              danger
              data-testid="attention-dismiss"
              onSelect={() => env.act.dismiss(item)}
            >
              <ArchiveX className="h-4 w-4" strokeWidth={1.5} />
              {ATTENTION_WORDS.dismiss}
            </DropdownMenuItem>
          </>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href={target.href} data-testid="attention-open">
            <ArrowUpRight className="h-4 w-4 text-text-2" strokeWidth={1.5} />
            {target.label}
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const FL = 'px-1 pb-0.5 pt-2.5 text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3';

/** A phone's ⋯: snooze first (it's used most), then Assign, Dismiss and the record, as a bottom sheet. */
export function ItemSheet({
  item,
  open,
  onOpenChange,
}: {
  item: AttentionItem;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const env = useAttentionEnv();
  const [view, setView] = useState<'main' | 'assign'>('main');
  const a = item.actions;
  const target = targetOf(item, env.workspaceId);
  const close = () => onOpenChange(false);
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent title={item.title} hideHeader className="px-4 pb-[26px] pt-2.5 sm:p-6">
        <div data-testid="attention-sheet">
          <div className="mb-2 flex items-center gap-2.5">
            <KindTile kind={item.kind} />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-base font-medium">{item.title}</span>
              <span className="text-xs text-text-3">
                {KIND_LABEL[item.kind]} · {assignedToOf(item, env.myUserId)}
              </span>
            </span>
          </div>
          {view === 'assign' ? (
            <AssignList
              item={item}
              onPick={(userId) => {
                close();
                env.act.assign(item, userId);
              }}
              onBack={() => setView('main')}
            />
          ) : (
            <>
              {a.snooze ? (
                <>
                  <div className={FL}>{ATTENTION_WORDS.snooze}</div>
                  <SnoozeRows
                    onPick={(until) => {
                      close();
                      env.act.snooze(item, until);
                    }}
                    onPickTime={() => {
                      close();
                      env.act.pickTime(item);
                    }}
                  />
                </>
              ) : null}
              <div className={cn(FL, 'pt-3')}>{ATTENTION_WORDS.more}</div>
              {a.assign ? (
                <SheetRow
                  icon={UserRound}
                  label={ATTENTION_WORDS.assign}
                  hint={assigneeShortOf(item, env.myUserId)}
                  onClick={() => setView('assign')}
                  testId="attention-assign"
                />
              ) : null}
              {a.dismiss ? (
                <SheetRow
                  icon={ArchiveX}
                  label={ATTENTION_WORDS.dismiss}
                  danger
                  onClick={() => {
                    close();
                    env.act.dismiss(item);
                  }}
                  testId="attention-dismiss"
                />
              ) : null}
              <SheetRow icon={ArrowUpRight} label={target.label} href={target.href} />
            </>
          )}
          <Button variant="secondary" size="lg" className="mt-3 w-full" onClick={close}>
            {ATTENTION_WORDS.close}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
