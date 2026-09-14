'use client';
import type { AssistantCard } from '@hfos/core';
import { CircleCheck, CircleSlash, TriangleAlert, Workflow } from 'lucide-react';
import { KindChip, Snippet } from '@/components/knowledge/chips';
import { ButtonLink } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useAssistant } from './assistant-provider';
import { cardHead, cardRow, cardShell, RowLink, Tile, touchButton } from './card-parts';

type CardOf<T extends AssistantCard['type']> = Extract<AssistantCard, { type: T }>;

const STATUS_WORD: Record<CardOf<'workflow'>['status'], string> = {
  proposal: 'Draft',
  draft: 'Draft',
  active: 'On',
  paused: 'Paused',
  archived: 'Archived',
};

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/**
 * A workflow the Assistant drafted or found (design/m6/Assistant.dc.html): its name, what starts it, its
 * steps (or, for a change to one that exists, what changes), its checks, and Open. A draft from the AI
 * builder is a proposal: Open shows it for review, and nothing changes until it's applied.
 */
export function WorkflowCard({ card }: { card: CardOf<'workflow'> }) {
  const { closeIfCovering } = useAssistant();
  const change = card.workflowId !== null && card.status === 'proposal';
  const detail = change
    ? `Proposed change · ${card.changes.length === 1 ? '1 change' : `${card.changes.length} changes`}`
    : `${STATUS_WORD[card.status]} · starts ${lowerFirst(card.trigger)}`;
  return (
    <div className={cardShell} data-testid="assistant-card-workflow">
      <div className={cardHead}>
        <Tile icon={Workflow} tone="accent" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[13px] font-medium" data-testid="workflow-card-name">
            {card.name}
          </span>
          <span className="truncate text-xs text-text-3">{detail}</span>
        </span>
        <ButtonLink
          href={card.href}
          onClick={() => closeIfCovering(card.href)}
          variant="secondary"
          size="sm"
          className={touchButton}
          data-testid="workflow-card-open"
        >
          Open
        </ButtonLink>
      </div>
      <ol className="m-0 list-none p-0" data-testid="workflow-card-lines">
        {(change ? card.changes : card.steps).map((line, i) => (
          <li key={i} className={cn(cardRow, 'items-start')}>
            <span className="mt-px inline-flex h-5 w-5 flex-none items-center justify-center rounded-full bg-card-2 text-[11px] font-semibold text-text-2">
              {i + 1}
            </span>
            <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{line}</span>
          </li>
        ))}
        {!change && card.more ? (
          <li className={cn(cardRow, 'text-text-3')}>
            and {card.more === 1 ? '1 more step' : `${card.more} more steps`}
          </li>
        ) : null}
      </ol>
      {card.unsupported.map((line, i) => (
        <div
          key={`u-${i}`}
          role="note"
          className="flex items-start gap-2 border-t border-border bg-card-2 px-3.5 py-2.5 text-[13px] text-text-2"
        >
          <CircleSlash className="mt-0.5 h-3.5 w-3.5 flex-none" strokeWidth={1.5} />
          <span className="min-w-0 flex-1">Can’t do yet: {line}</span>
        </div>
      ))}
      <div
        className={cn(
          'flex items-start gap-2 border-t border-border px-3.5 py-2.5 text-[13px]',
          card.issues ? 'bg-warning-soft text-warning-text' : 'text-text-2',
        )}
        data-testid="workflow-card-checks"
      >
        {card.issues ? (
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 flex-none" strokeWidth={1.5} />
        ) : (
          <CircleCheck
            className="mt-0.5 h-3.5 w-3.5 flex-none text-success-text"
            strokeWidth={1.5}
          />
        )}
        <span className="min-w-0 flex-1">
          {card.issues
            ? `${card.issues === 1 ? '1 thing' : `${card.issues} things`} to check${card.issueNote ? `: ${card.issueNote}` : ''}`
            : card.status === 'proposal'
              ? 'Checks: nothing to fix. It still needs a test before it’s published.'
              : 'Checks: nothing to fix.'}
        </span>
      </div>
    </div>
  );
}

/** "Do we offer financing?": the knowledge base items the answer drew on, and a way to Knowledge. */
export function KnowledgeCard({ card }: { card: CardOf<'knowledge'> }) {
  return (
    <div className={cardShell} data-testid="assistant-card-knowledge">
      <div className={cn(cardHead, 'pb-2')}>
        <span className="min-w-0 flex-1 text-[15px] font-semibold leading-[1.35]">
          From your knowledge base
        </span>
      </div>
      {card.items.map((item) => (
        <RowLink key={item.id} href={item.href} className="items-start">
          <KindChip kind={item.kind} className="mt-px" />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="font-medium [overflow-wrap:anywhere]">{item.title}</span>
            <Snippet text={item.snippet} className="line-clamp-2 text-xs text-text-3" />
          </span>
        </RowLink>
      ))}
      <RowLink href={card.href}>
        <span className="min-w-0 flex-1 truncate font-medium text-accent-text">Open Knowledge</span>
      </RowLink>
    </div>
  );
}
