'use client';
import { ATTENTION_WORDS } from '@hfos/core';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { NextActionDialog } from '@/components/crm/next-action-dialog';
import { MessageSheet } from '@/components/inbox/message-sheet';
import { TaskDialog } from '@/components/tasks/task-dialog';
import { Card } from '@/components/ui/card';
import type { Appointment, AttentionList, Task } from '@/lib/api/types';
import { useCalls } from '@/lib/calls/call-provider';
import { useAttentionSummary } from '@/lib/realtime/attention-summary';
import { useLiveRefresh } from '@/lib/realtime/live-provider';
import { useMatches } from '@/lib/use-media';
import { cn } from '@/lib/utils';
import { ItemSheet, useItemActions, type AttentionDialog } from './attention-actions';
import { SectionHead } from './attention-bits';
import { AttentionCard } from './attention-card';
import { AttentionEnvProvider, type AttentionEnv, type MemberOption } from './attention-context';
import { AttentionGroup } from './attention-group';
import { AttentionHeader } from './attention-header';
import { foldRows, splitTitle } from './attention-words';
import { ComingUp, ComingUpFold } from './coming-up';
import { DismissDialog } from './dismiss-dialog';
import { CaughtUp, HandledByHandsFree } from './handled-today';
import { LetHandleSheet } from './let-handle-sheet';
import { PickTimeDialog } from './snooze-menu';
import { TodayCard, TodayFold, type TodayProps } from './today-card';
import { useAttentionList } from './use-attention';

/**
 * Home as the Action Center (M8): one ranked list of what needs attention.
 * - The header: "$X affected", the counts, and Mine / Everyone (members start on Mine, owners and admins on
 *   Everyone).
 * - The list: Urgent, then Up next, with three or more lower items of one kind folded into a group; then a
 *   collapsed "Handled by HandsFreeOS".
 * - The side rail (1024 px and up): Today, then "Coming up from HandsFreeOS", then now and then an add-on that
 *   fits the business (for owners and admins). Narrower, they fold below the list.
 * It follows item changes live and re-reads every 30 seconds, so the ranking and the waiting chips stay current.
 */
export function ActionCenter({
  workspaceId,
  timeZone,
  myUserId,
  greeting,
  dateLabel,
  initial,
  members,
  teammateName,
  appointments,
  tasks,
  today,
  tomorrow,
  newLeadHref,
  highlightItem,
  suggestion,
  guide,
}: {
  workspaceId: string;
  timeZone: string;
  myUserId: string;
  /** "Good morning, Dale". */
  greeting: string;
  /** "Tue, Sep 22", in the business's time zone. */
  dateLabel: string;
  /** The server's first read (the viewer's default scope, with today's handled items), or null. */
  initial: AttentionList | null;
  members: readonly MemberOption[];
  teammateName: string | null;
  /** Today's and the next two days' appointments (Today, and which appointment an attendee is on). */
  appointments: readonly Appointment[];
  /** Open tasks (those due today show in Today; the overdue ones open from their cards). */
  tasks: readonly Task[];
  today: string;
  tomorrow: string;
  newLeadHref: string;
  /** From `?item=`: the Assistant's cards link to one card. */
  highlightItem?: string | null;
  /** The add-on Home suggests to owners and admins (components/home/addon-suggestion.tsx), when there is one. */
  suggestion?: ReactNode;
  /** Getting started, while the person's guide is still showing (components/home/getting-started.tsx). */
  guide?: ReactNode;
}) {
  // Today's appointments and tasks come with the page: it's read again when they change.
  useLiveRefresh(['appointment', 'task'], 500);
  const list = useAttentionList(workspaceId, initial);
  const { refresh: refreshSummary } = useAttentionSummary();
  const calls = useCalls();
  const [dialog, setDialog] = useState<AttentionDialog | null>(null);
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());
  const [highlightId, setHighlightId] = useState<string | null>(highlightItem ?? null);
  // The suggestion sits in the side rail or the fold, whichever shows: drawn once, so setting it aside is once.
  const wide = useMatches('(min-width: 1024px)');
  const hasTask = useCallback((taskId: string) => tasks.some((t) => t.id === taskId), [tasks]);
  const act = useItemActions({
    workspaceId,
    timeZone,
    myUserId,
    members,
    teammateName,
    hide: list.hide,
    unhide: list.unhide,
    reload: list.reload,
    refreshSummary,
    open: setDialog,
    setBusy,
    hasTask,
  });

  const data = list.data;
  const items = (data?.items ?? []).filter((i) => !list.hidden.has(i.id));
  const urgent = items.filter((i) => i.urgent);
  const upNext = items.filter((i) => !i.urgent);
  const rows = foldRows(upNext, urgent.length);
  const scheduled = data?.scheduled ?? [];
  const scope = list.scope ?? data?.scope ?? 'everyone';
  const env: AttentionEnv = {
    workspaceId,
    timeZone,
    now: list.now,
    myUserId,
    members,
    teammateName,
    callsAvailable: calls.available,
    busy,
    highlightId,
    act,
  };
  const todayProps: TodayProps = {
    workspaceId,
    timeZone,
    today,
    tomorrow,
    items: appointments,
    myUserId,
    who: scope === 'mine' ? 'mine' : 'all',
    tasks,
    unconfirmed: new Set(
      items.flatMap((i) =>
        i.kind === 'unconfirmed_appointment' && i.appointmentId ? [i.appointmentId] : [],
      ),
    ),
  };

  // The Assistant's cards link to `?item=`: bring that card into view and mark it for a few seconds.
  useEffect(() => {
    if (!highlightId) return;
    document
      .querySelector(`[data-item="${highlightId}"]`)
      ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    const timer = setTimeout(() => setHighlightId(null), 4000);
    return () => clearTimeout(timer);
  }, [highlightId, data]);

  const close = (open: boolean) => {
    if (!open) setDialog(null);
  };
  let overlay: ReactNode = null;
  if (dialog) {
    const item = dialog.item;
    switch (dialog.type) {
      case 'let_handle':
        overlay = (
          <LetHandleSheet
            key={item.id}
            item={item}
            open
            onOpenChange={close}
            onDone={(how) => {
              if (how === 'ask') list.hide([item.id]);
              list.reload();
              refreshSummary();
            }}
          />
        );
        break;
      case 'dismiss':
        overlay = (
          <DismissDialog
            item={item}
            open
            onOpenChange={close}
            onDismiss={(reason) => {
              setDialog(null);
              act.dismissNow(item, reason);
            }}
          />
        );
        break;
      case 'pick_time':
        overlay = <PickTimeDialog item={item} open onOpenChange={close} />;
        break;
      case 'next_action':
        overlay = item.leadId ? (
          <NextActionDialog
            workspaceId={workspaceId}
            leadId={item.leadId}
            leadTitle={splitTitle(item.title).rest ?? item.title}
            open
            onOpenChange={close}
            onSaved={() => {
              list.hide([item.id]);
              refreshSummary();
            }}
          />
        ) : null;
        break;
      case 'task': {
        const task = tasks.find((t) => t.id === item.subject.id);
        overlay = task ? (
          <TaskDialog
            workspaceId={workspaceId}
            open
            onOpenChange={close}
            members={members.map((m) => ({ id: m.id, fullName: m.fullName }))}
            myUserId={myUserId}
            initial={task}
          />
        ) : null;
        break;
      }
      case 'message': {
        const m = dialog.message;
        // The follow-up about a money document, written and waiting for the person to read it and press send.
        // Sending it doesn't settle anything — the invoice is still owed — so the card stays until it is.
        overlay = m ? (
          <MessageSheet
            key={item.id}
            workspaceId={workspaceId}
            person={m.person}
            channel={m.channel}
            initialText={m.body}
            {...(m.subject ? { initialSubject: m.subject } : {})}
            open
            onOpenChange={close}
            onSent={() => {
              list.reload();
              refreshSummary();
            }}
          />
        ) : null;
        break;
      }
      case 'menu':
        overlay = <ItemSheet key={item.id} item={item} open onOpenChange={close} />;
        break;
    }
  }

  return (
    <AttentionEnvProvider value={env}>
      <div data-testid="action-center" data-scope={scope}>
        <AttentionHeader
          greeting={greeting}
          dateLabel={dateLabel}
          affectedCents={data?.affectedCents ?? 0}
          total={items.length}
          urgent={urgent.length}
          handledToday={data?.handledToday ?? 0}
          scope={scope}
          onScope={list.setScope}
          newLeadHref={newLeadHref}
        />
        {guide ? <div className="mb-6 empty:hidden">{guide}</div> : null}
        <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
          <div
            className={cn('min-w-0 transition-opacity', list.loading && data && 'opacity-60')}
            aria-busy={list.loading || undefined}
          >
            {!data ? (
              <Card
                className="px-5 py-8 text-center text-[13px] text-text-3"
                data-testid="attention-loading"
              >
                {list.error ?? ATTENTION_WORDS.loading}
              </Card>
            ) : items.length === 0 ? (
              <CaughtUp items={data.handled} count={data.handledToday} />
            ) : (
              <>
                {urgent.length ? (
                  <section data-testid="attention-urgent" aria-label="Urgent" className="mb-[18px]">
                    <SectionHead label={ATTENTION_WORDS.urgent} count={urgent.length} urgent />
                    <div className="flex flex-col gap-2.5">
                      {urgent.map((i) => (
                        <AttentionCard key={i.id} item={i} />
                      ))}
                    </div>
                  </section>
                ) : null}
                {upNext.length ? (
                  <section data-testid="attention-next" aria-label="Up next">
                    <SectionHead label={ATTENTION_WORDS.upNext} count={upNext.length} />
                    <div className="flex flex-col gap-2.5">
                      {rows.map((r) =>
                        r.type === 'item' ? (
                          <AttentionCard key={r.item.id} item={r.item} />
                        ) : (
                          <AttentionGroup key={`group-${r.kind}`} kind={r.kind} items={r.items} />
                        ),
                      )}
                    </div>
                  </section>
                ) : null}
                <HandledByHandsFree items={data.handled} />
              </>
            )}
            <div className="mt-5 flex flex-col gap-3 lg:hidden">
              <SectionHead label="Today" className="mb-0" />
              <TodayFold {...todayProps} />
              <ComingUpFold scheduled={scheduled} />
              {wide ? null : suggestion}
            </div>
          </div>
          <aside
            aria-label="Today and what's coming up"
            className="hidden min-w-0 flex-col gap-4 lg:flex"
          >
            <TodayCard {...todayProps} />
            <ComingUp scheduled={scheduled} />
            {wide ? suggestion : null}
          </aside>
        </div>
      </div>
      {overlay}
    </AttentionEnvProvider>
  );
}
