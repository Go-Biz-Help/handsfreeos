import type { Step, Trigger } from '@hfos/core';
import {
  ArrowRightLeft,
  Bell,
  BookOpen,
  Building2,
  CalendarCheck,
  CalendarClock,
  CalendarX,
  CircleCheck,
  CircleStop,
  Clock,
  CornerUpLeft,
  DollarSign,
  FileText,
  Hand,
  Hourglass,
  KanbanSquare,
  ListChecks,
  Mail,
  MessageSquare,
  MessageSquareOff,
  PhoneCall,
  PhoneMissed,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Split,
  Star,
  StickyNote,
  Tag,
  UserCheck,
  UserPen,
  UserPlus,
  UserX,
  Webhook,
  Workflow,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import type { WorkflowStatus, WorkflowSummary } from '@/lib/api/types';
import type { StepTone } from '@/lib/workflows/steps';
import { cn } from '@/lib/utils';

/**
 * AI and branch tints. The app has no tokens for them yet, so they mix a fixed hue into the card and text
 * colours, which follow light and dark.
 */
export const AI_SOFT = 'bg-[color-mix(in_oklab,#7c3aed_13%,var(--card))]';
export const AI_TEXT = 'text-[color-mix(in_oklab,#7c3aed_72%,var(--text))]';
export const BR_SOFT = 'bg-[color-mix(in_oklab,#0e7490_13%,var(--card))]';
export const BR_TEXT = 'text-[color-mix(in_oklab,#0e7490_70%,var(--text))]';

const TONES: Record<StepTone, string> = {
  trig: 'bg-success-soft text-success-text',
  act: 'bg-accent-soft text-accent-text',
  wait: 'bg-card-2 text-text-2',
  ai: cn(AI_SOFT, AI_TEXT),
  appr: 'bg-warning-soft text-warning-text',
  br: cn(BR_SOFT, BR_TEXT),
  end: 'bg-card-2 text-text-3',
};

/** A step's icon on its colour tile (30px; `sm` 24px; `xs` 22px in menus). */
export function KindTile({
  tone,
  icon: Icon,
  size = 'md',
  className,
}: {
  tone: StepTone;
  icon: LucideIcon;
  size?: 'md' | 'sm' | 'xs';
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex flex-none items-center justify-center',
        size === 'md'
          ? 'h-[30px] w-[30px] rounded-control'
          : size === 'sm'
            ? 'h-6 w-6 rounded-[7px]'
            : 'h-[22px] w-[22px] rounded-[6px]',
        TONES[tone],
        className,
      )}
    >
      <Icon
        className={size === 'md' ? 'h-[15px] w-[15px]' : 'h-[13px] w-[13px]'}
        strokeWidth={1.75}
      />
    </span>
  );
}

const ACTION_ICONS: Record<string, LucideIcon> = {
  send_text: MessageSquare,
  send_email: Mail,
  update_person: UserPen,
  add_tag: Tag,
  remove_tag: Tag,
  create_lead: KanbanSquare,
  move_lead_stage: ArrowRightLeft,
  assign_lead: UserCheck,
  set_next_action: CalendarClock,
  create_task: ListChecks,
  complete_task: CircleCheck,
  add_note: StickyNote,
  assign_conversation: UserCheck,
  close_conversation: MessageSquareOff,
  notify_team: Bell,
  webhook_out: Webhook,
  enrol_workflow: Workflow,
  remove_from_workflow: UserX,
  hand_to_ai_teammate: Sparkles,
  call_with_ai: PhoneCall,
};

export function actionIcon(action: string): LucideIcon {
  return ACTION_ICONS[action] ?? Zap;
}

export function stepIcon(step: Step): LucideIcon {
  switch (step.type) {
    case 'action':
      return actionIcon(step.action);
    case 'wait':
      return Hourglass;
    case 'branch':
      return step.mode === 'ai' ? Sparkles : Split;
    case 'ai':
      return Sparkles;
    case 'approval':
      return ShieldCheck;
    case 'goto':
      return CornerUpLeft;
    case 'end':
      return CircleStop;
  }
}

/** The icon for what starts a workflow. */
export function triggerIcon(kind: string, event: string | null): LucideIcon {
  if (kind === 'schedule') return Clock;
  if (kind === 'date') return CalendarClock;
  if (kind === 'webhook') return Webhook;
  if (kind === 'manual') return Hand;
  if (!event) return Zap;
  if (event === 'call.missed' || event === 'call.voicemail_left') return PhoneMissed;
  if (event.startsWith('call.') || event === 'message.received') return MessageSquare;
  if (event === 'appointment.no_show') return CalendarX;
  if (event.startsWith('appointment.')) return CalendarCheck;
  if (event.startsWith('lead.')) return KanbanSquare;
  if (event === 'person.created') return UserPlus;
  if (event === 'task.completed') return ListChecks;
  if (event === 'record.tags_changed') return Tag;
  return Zap;
}

export function triggerIconOf(t: Trigger): LucideIcon {
  return triggerIcon(t.kind, t.kind === 'event' ? t.event : null);
}

const RECIPE_ICONS: Record<string, LucideIcon> = {
  speed_to_lead: Zap,
  missed_call_text_back: PhoneMissed,
  appointment_follow_up_review: Star,
  estimate_follow_up: DollarSign,
  no_show_rebook: CalendarX,
};

/** A workflow's icon: its recipe's, else its trigger's. */
export function workflowIcon(w: Pick<WorkflowSummary, 'source' | 'trigger'>): LucideIcon {
  if (w.source.recipeKey && RECIPE_ICONS[w.source.recipeKey])
    return RECIPE_ICONS[w.source.recipeKey]!;
  if (w.source.kind === 'template') return Building2;
  return triggerIcon(w.trigger.kind, w.trigger.event);
}

export function recipeIcon(key: string): LucideIcon {
  return RECIPE_ICONS[key] ?? FileText;
}

const STATUS: Record<
  WorkflowStatus,
  { variant: 'ok' | 'gray' | 'pending' | 'danger'; label: string }
> = {
  active: { variant: 'ok', label: 'Active' },
  draft: { variant: 'gray', label: 'Draft' },
  paused: { variant: 'pending', label: 'Paused' },
  archived: { variant: 'danger', label: 'Archived' },
};

export function WorkflowStatusBadge({ status }: { status: WorkflowStatus }) {
  const s = STATUS[status];
  return (
    <Badge variant={s.variant} data-testid="workflow-status">
      {s.label}
    </Badge>
  );
}

/** A small source chip (the design's `.src`). */
export function SourceChip({
  tone = 'gray',
  icon: Icon,
  children,
  title,
  testId,
}: {
  tone?: 'gray' | 'accent' | 'warning';
  icon?: LucideIcon;
  children: ReactNode;
  title?: string;
  testId?: string;
}) {
  return (
    <span
      title={title}
      data-testid={testId}
      className={cn(
        'inline-flex h-5 items-center gap-1 whitespace-nowrap rounded-[6px] px-[7px] text-[11.5px] font-medium',
        tone === 'accent'
          ? 'bg-accent-soft text-accent-text'
          : tone === 'warning'
            ? 'bg-warning-soft text-warning-text'
            : 'bg-card-2 text-text-2',
      )}
    >
      {Icon ? <Icon className="h-3 w-3" strokeWidth={1.75} /> : null}
      {children}
    </span>
  );
}

/** Where a workflow came from: a recipe, a Go Biz Help template (and whether it has an update), or blank. */
export function SourceChips({ source }: { source: WorkflowSummary['source'] }) {
  if (source.kind === 'template' && source.template)
    return (
      <>
        <SourceChip tone="accent" icon={Building2} testId="source-chip">
          {`Go Biz Help${source.template.installedVersion ? ` v${source.template.installedVersion}` : ''}`}
        </SourceChip>
        {source.template.updateAvailable ? (
          <SourceChip tone="warning" icon={RefreshCw} testId="update-available">
            Update available
          </SourceChip>
        ) : null}
      </>
    );
  if (source.kind === 'recipe')
    return (
      <SourceChip icon={BookOpen} title={source.recipeName ?? undefined} testId="source-chip">
        Recipe
      </SourceChip>
    );
  return <SourceChip testId="source-chip">Blank</SourceChip>;
}

/** Path colours for lane dots; "Otherwise" is grey. */
const LANE_COLORS = ['var(--accent)', '#0e7490', '#7c3aed', '#c2410c', '#008743', '#be185d'];

export function laneColor(index: number, otherwise: boolean): string {
  return otherwise ? 'var(--text-3)' : LANE_COLORS[index % LANE_COLORS.length]!;
}
