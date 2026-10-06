'use client';
import { isSocialChannel, SOCIAL_CHANNEL_NAMES, type AssistantCard } from '@hfos/core';
import {
  Activity,
  ArrowRight,
  Building2,
  CalendarDays,
  Check,
  KanbanSquare,
  LoaderCircle,
  MessageCircle,
  UserRound,
  Workflow,
  X,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { apiBrowser, unwrap } from '@/lib/api/client';
import type { PageRecord, PageRecordType } from '@/lib/assistant/page-record';
import { cn } from '@/lib/utils';
import { useAssistant, type AnswerMessage, type Step } from './assistant-provider';
import { AppointmentCard, SlotsCard } from './calendar-cards';
import {
  AttentionCard,
  CallCard,
  ChoicesCard,
  CustomerCard,
  DoneCard,
  LeadCard,
  ListCard,
  NumbersCard,
} from './cards';
import { ConfirmCard, type ConfirmCardData } from './confirm-card';
import { AssistantMark } from './mark';
import { NoticeCard } from './notices';
import { RichText } from './rich-text';
import { MoneyCard } from './money-cards';
import { KnowledgeCard, WorkflowCard } from './workflow-cards';

/** The name of the record on screen ("Mike Johnson", "Texts with Mike Johnson"). */
async function labelFor(workspaceId: string, page: PageRecord): Promise<string> {
  const api = apiBrowser();
  switch (page.type) {
    case 'person':
      return unwrap(
        await api.POST('/v1/queries/person.get', { body: { workspaceId, personId: page.id } }),
      ).person.fullName;
    case 'company':
      return unwrap(
        await api.POST('/v1/queries/company.get', { body: { workspaceId, companyId: page.id } }),
      ).company.name;
    case 'lead':
      return unwrap(
        await api.POST('/v1/queries/lead.get', { body: { workspaceId, leadId: page.id } }),
      ).lead.title;
    case 'conversation': {
      const { conversation } = unwrap(
        await api.POST('/v1/queries/conversation.get', {
          body: { workspaceId, conversationId: page.id },
        }),
      );
      const who = conversation.person?.fullName ?? conversation.counterpartDisplay;
      const where = isSocialChannel(conversation.channel)
        ? SOCIAL_CHANNEL_NAMES[conversation.channel]
        : conversation.channel === 'email'
          ? 'Email'
          : 'Texts';
      return `${where} with ${who}`;
    }
    case 'appointment': {
      const { appointment } = unwrap(
        await api.POST('/v1/queries/appointment.get', {
          body: { workspaceId, appointmentId: page.id },
        }),
      );
      const who = appointment.attendees
        .filter((p) => p.status !== 'cancelled')
        .map((p) => p.fullName);
      const what = appointment.service?.name ?? appointment.title;
      return who.length ? `${what} with ${who.join(', ')}` : what;
    }
    case 'workflow':
      return unwrap(
        await api.POST('/v1/queries/workflow.get', { body: { workspaceId, workflowId: page.id } }),
      ).workflow.name;
    case 'workflow_run': {
      const { run } = unwrap(
        await api.POST('/v1/queries/workflow.run_get', { body: { workspaceId, runId: page.id } }),
      );
      return run.person ? `${run.workflow.name} · ${run.person.fullName}` : run.workflow.name;
    }
  }
}

function usePageLabel(workspaceId: string, page: PageRecord | null): string | null {
  const [label, setLabel] = useState<{ key: string; text: string | null } | null>(null);
  const key = page ? `${page.type}:${page.id}` : null;
  useEffect(() => {
    if (!page || !key) return;
    let cancelled = false;
    labelFor(workspaceId, page)
      .then((text) => !cancelled && setLabel({ key, text }))
      .catch(() => !cancelled && setLabel({ key, text: null }));
    return () => {
      cancelled = true;
    };
    // The key stands for the page.
  }, [workspaceId, key]);
  return label && label.key === key ? label.text : null;
}

const PAGE_ICON: Record<PageRecordType, typeof UserRound> = {
  person: UserRound,
  company: Building2,
  lead: KanbanSquare,
  conversation: MessageCircle,
  appointment: CalendarDays,
  workflow: Workflow,
  workflow_run: Activity,
};

interface Suggestion {
  readonly label: string;
  readonly text: string;
  /** Put in the box to finish, rather than asked at once. */
  readonly fill?: boolean;
}

/** The four starters, about the customer on screen when there is one. */
function suggestions(page: PageRecord | null, label: string | null): Suggestion[] {
  const first = page?.type === 'person' && label ? label.split(/\s+/)[0] : null;
  return [
    { label: 'What needs attention?', text: 'What needs attention?' },
    { label: 'How many leads came in this week?', text: 'How many leads came in this week?' },
    first
      ? { label: `Text ${first} that …`, text: `Text ${first} that `, fill: true }
      : { label: 'What’s on my calendar?', text: 'What’s on my calendar?' },
    first
      ? {
          label: `Create a task to call ${first} back tomorrow`,
          text: `Create a task to call ${first} back tomorrow`,
        }
      : { label: 'Create a task to …', text: 'Create a task to ', fill: true },
  ];
}

function Welcome({ label }: { label: string | null }) {
  const a = useAssistant();
  function pick(s: Suggestion) {
    if (!s.fill) {
      a.ask(s.text);
      return;
    }
    a.setDraft(s.text);
    requestAnimationFrame(() => {
      const box = a.composerRef.current;
      if (!box) return;
      box.focus();
      box.setSelectionRange(box.value.length, box.value.length);
    });
  }
  return (
    <div className="flex flex-col gap-3.5 px-0.5 pt-1.5" data-testid="assistant-empty">
      <AssistantMark size={40} />
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold leading-[1.3] tracking-[-0.005em]">
          What can I help with?
        </h2>
        <p className="text-[13px] text-text-2">
          Ask about customers, leads, tasks and the calendar, or tell me what to do. I ask before I
          text or email a customer, or change a lead, a customer or an appointment.
        </p>
      </div>
      <div className="flex flex-col gap-2">
        {suggestions(a.page, label).map((s) => (
          <button
            key={s.label}
            type="button"
            onClick={() => pick(s)}
            className="flex min-h-10 w-full items-center gap-2.5 rounded-[10px] border border-border bg-card px-3 py-2 text-left text-[13.5px] text-text transition-colors hover:bg-card-2 max-md:min-h-12 max-md:text-[15px]"
          >
            <ArrowRight className="h-3.5 w-3.5 flex-none text-text-3" strokeWidth={1.5} />
            <span>{s.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function Steps({ steps }: { steps: readonly Step[] }) {
  return (
    <ul className="flex flex-col gap-[3px]" data-testid="assistant-steps">
      {steps.map((s) => (
        <li
          key={s.id}
          className="flex items-center gap-1.5 text-[12.5px] leading-[1.4] text-text-3"
          data-status={s.status}
        >
          {s.status === 'done' ? (
            <Check className="h-3.5 w-3.5 flex-none text-success-text" strokeWidth={1.5} />
          ) : s.status === 'failed' ? (
            <X className="h-3.5 w-3.5 flex-none text-danger-text" strokeWidth={1.5} />
          ) : (
            <LoaderCircle className="h-3.5 w-3.5 flex-none animate-spin" strokeWidth={1.5} />
          )}
          <span>{s.label}</span>
        </li>
      ))}
    </ul>
  );
}

function AnswerCardView({
  card,
  at,
  onEdit,
}: {
  card: AssistantCard;
  at: string;
  onEdit: (card: ConfirmCardData) => void;
}) {
  switch (card.type) {
    case 'customer':
      return <CustomerCard card={card} />;
    case 'lead':
      return <LeadCard card={card} />;
    case 'choices':
      return <ChoicesCard card={card} />;
    case 'attention':
      return <AttentionCard card={card} at={at} />;
    case 'numbers':
      return <NumbersCard card={card} />;
    case 'list':
      return <ListCard card={card} />;
    case 'done':
      return <DoneCard card={card} />;
    case 'confirm':
      return <ConfirmCard card={card} onEdit={onEdit} />;
    case 'call':
      return <CallCard card={card} />;
    case 'money':
      return <MoneyCard card={card} />;
    case 'slots':
      return <SlotsCard card={card} />;
    case 'appointment':
      return <AppointmentCard card={card} />;
    case 'workflow':
      return <WorkflowCard card={card} />;
    case 'knowledge':
      return <KnowledgeCard card={card} />;
  }
}

const cardKey = (card: AssistantCard, i: number) =>
  card.type === 'confirm' || card.type === 'done' ? card.toolCallId : `${card.type}-${i}`;

function Answer({
  message: m,
  phone,
  onEdit,
}: {
  message: AnswerMessage;
  phone: boolean;
  onEdit: (card: ConfirmCardData) => void;
}) {
  const a = useAssistant();
  const working = m.live && !m.text && m.steps.length === 0 && m.cards.length === 0;
  const stopped = m.notice?.code === 'stopped';
  return (
    <div
      className="flex items-start gap-2.5"
      data-testid="assistant-message"
      data-state={m.live ? 'live' : 'done'}
    >
      <AssistantMark size={24} className="mt-px" />
      <div
        className={cn(
          'flex min-w-0 flex-1 flex-col gap-2.5 leading-normal',
          phone ? 'text-[15px]' : 'text-sm',
        )}
      >
        {m.steps.length ? <Steps steps={m.steps} /> : null}
        {working ? (
          <Steps steps={[{ id: 'working', label: 'Working on it', status: 'running' }]} />
        ) : null}
        {m.text ? <RichText text={m.text} caret={m.live} onNavigate={a.closeIfCovering} /> : null}
        {m.cards.map((card, i) => (
          <AnswerCardView key={cardKey(card, i)} card={card} at={m.createdAt} onEdit={onEdit} />
        ))}
        {stopped ? (
          <p>{m.cards.length ? m.notice!.message : 'Stopped. Nothing was changed.'}</p>
        ) : m.notice ? (
          <NoticeCard
            notice={m.notice}
            workspaceName={a.workspaceName}
            onRetry={m.question && !a.running ? () => a.retry(m.key) : undefined}
            onReload={a.threadId ? () => void a.openThread(a.threadId!) : undefined}
          />
        ) : null}
      </div>
    </div>
  );
}

/**
 * The chat: the record on screen, the welcome with its starters, then each question and answer. It stays
 * pinned to the newest line as answers stream in (a column-reverse scroller).
 */
export function MessageList({
  phone,
  onEdit,
}: {
  phone: boolean;
  onEdit: (card: ConfirmCardData) => void;
}) {
  const a = useAssistant();
  const label = usePageLabel(a.workspaceId, a.page);
  const PageIcon = a.page ? PAGE_ICON[a.page.type] : null;
  return (
    <div
      role="log"
      aria-label="Chat with the Assistant"
      aria-busy={a.running || undefined}
      data-testid="assistant-log"
      className={cn(
        'flex min-h-0 flex-1 flex-col-reverse overflow-y-auto overscroll-contain',
        phone ? 'bg-bg px-3.5 pb-3 pt-3.5' : 'px-4 pb-3.5 pt-4',
      )}
    >
      <div className="flex flex-col gap-4">
        {PageIcon && label ? (
          <span
            className="inline-flex h-[26px] max-w-full items-center gap-1.5 self-start rounded-[6px] bg-card-2 px-[9px] text-xs font-medium text-text-2"
            data-testid="assistant-page"
          >
            <PageIcon className="h-3.5 w-3.5 flex-none" strokeWidth={1.5} />
            <span className="truncate">On this page: {label}</span>
          </span>
        ) : null}
        {a.messages.length === 0 ? (
          a.loading ? (
            <p role="status" className="text-[13px] text-text-3">
              Opening the chat…
            </p>
          ) : (
            <Welcome label={label} />
          )
        ) : null}
        {a.messages.map((m) =>
          m.role === 'user' ? (
            <div
              key={m.key}
              data-testid="assistant-question"
              className={cn(
                'max-w-[86%] self-end whitespace-pre-wrap rounded-2xl rounded-br-[5px] bg-accent-soft px-[13px] py-[9px] leading-[1.45] text-text [overflow-wrap:anywhere]',
                phone ? 'text-[15px]' : 'text-sm',
              )}
            >
              {m.text}
            </div>
          ) : (
            <Answer key={m.key} message={m} phone={phone} onEdit={onEdit} />
          ),
        )}
      </div>
    </div>
  );
}
