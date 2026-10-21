'use client';
import {
  badgeLabel,
  badgeTone,
  hitLines,
  money,
  whyLabel,
  type SearchHit,
  type SearchProbes,
} from '@hfos/core';
import {
  BookOpen,
  Building2,
  CalendarDays,
  CircleDollarSign,
  ClipboardList,
  FileText,
  KanbanSquare,
  ListChecks,
  MessageCircle,
  Settings,
  StickyNote,
  Trash2,
  type LucideIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { RecordIcon } from '@/components/relationships/record-icon';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { Highlight, Marked } from '../highlight';

/**
 * What every search result row is made of, shared by each kind's row (`rows/<kind>.tsx`): the picture on the left,
 * the marked title and its badges, the grey line core's `hitLines` prints, and the chips on the right. The dropdown
 * draws a row in one line under its title; the Search page draws the same view in its cards, with columns for a
 * contact.
 */

/** What a row needs beyond its hit: what was typed (for the marks), now, and the business's clock. */
export interface RowContext {
  readonly probes: SearchProbes;
  readonly now: number;
  readonly timeZone: string;
  /** The group's own icon: a business's kind of record, or an add-on's kind. */
  readonly icon?: string | null;
}

export interface RowView {
  readonly leading: ReactNode;
  readonly title: ReactNode;
  /** The grey line under the title. */
  readonly line: ReactNode | null;
  /** The Search page's second line under a contact's name: the open lead, or where they work. */
  readonly under?: ReactNode | null;
  /** On the right: why it matched, money, a time. */
  readonly chips?: ReactNode;
  /** The Search page's columns for a contact: phone, email, last contact. */
  readonly columns?: readonly (string | null)[];
}

type Tone = 'accent' | 'success' | 'warning' | 'gray';
const TONES: Record<Tone, string> = {
  accent: 'bg-accent-soft text-accent-text',
  success: 'bg-success-soft text-success-text',
  warning: 'bg-warning-soft text-warning-text',
  gray: 'bg-card-2 text-text-2',
};

/** A kind's picture on its tinted tile, as the boards draw each group's rows. */
export function KindTile({ icon: Icon, tone = 'gray' }: { icon: LucideIcon; tone?: Tone }) {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex h-8 w-8 flex-none items-center justify-center rounded-[8px]',
        TONES[tone],
      )}
    >
      <Icon className="h-4 w-4" strokeWidth={1.75} />
    </span>
  );
}

/** Each of core's kinds' tile. */
export const KIND_TILES: Readonly<Record<string, { icon: LucideIcon; tone: Tone }>> = {
  companies: { icon: Building2, tone: 'gray' },
  leads: { icon: KanbanSquare, tone: 'accent' },
  money: { icon: CircleDollarSign, tone: 'success' },
  messages: { icon: MessageCircle, tone: 'gray' },
  spam: { icon: MessageCircle, tone: 'gray' },
  calendar: { icon: CalendarDays, tone: 'accent' },
  tasks: { icon: ListChecks, tone: 'gray' },
  notes: { icon: StickyNote, tone: 'gray' },
  files: { icon: FileText, tone: 'gray' },
  forms: { icon: ClipboardList, tone: 'gray' },
  knowledge: { icon: BookOpen, tone: 'gray' },
  settings: { icon: Settings, tone: 'gray' },
  bin: { icon: Trash2, tone: 'gray' },
};

/** The picture for a hit of a kind core names, a business's kind of record, or an add-on's kind. */
export function tileOf(kind: string, icon?: string | null): ReactNode {
  const own = KIND_TILES[kind];
  if (own) return <KindTile icon={own.icon} tone={own.tone} />;
  return <RecordIcon icon={icon} size="md" />;
}

/** A person's avatar, greyed when they're archived. */
export function PersonMark({ hit }: { hit: SearchHit }) {
  const archived = hit.badges.includes('archived');
  return (
    <Avatar
      name={hit.title}
      seed={hit.id}
      className={archived ? 'bg-card-3 text-text-2' : undefined}
    />
  );
}

/** The badges core's words name ("Lead", "Client", "Archived", "Other mail"), in the order the hit has them. */
export function HitBadges({ hit }: { hit: SearchHit }) {
  const shown = hit.badges
    .map((b) => ({ b, label: badgeLabel(b) }))
    .filter((x): x is { b: string; label: string } => !!x.label);
  if (!shown.length) return null;
  return (
    <>
      {shown.map(({ b, label }) => (
        <Badge key={b} variant={badgeTone(b)} className="h-5 px-1.5 text-[11.5px]" data-badge={b}>
          {label}
        </Badge>
      ))}
    </>
  );
}

/** The title, marked where it matched, with its badges. */
export function HitTitle({ hit, ctx }: { hit: SearchHit; ctx: RowContext }) {
  const archived = hit.badges.includes('archived');
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className={cn('min-w-0 truncate', archived && 'text-text-2')}>
        <Marked text={hit.title} probes={ctx.probes} />
      </span>
      <HitBadges hit={hit} />
    </span>
  );
}

/** Why it matched, as a small chip ("Phone", "In the file", a custom field's name); none for a plain name. */
export function WhyChip({ hit }: { hit: SearchHit }) {
  if (hit.why.field === 'name' || hit.why.field === 'title' || hit.why.field === 'setting')
    return null;
  const label = whyLabel(hit.why, hit.kind);
  if (!label) return null;
  return (
    <span
      className="inline-flex h-5 flex-none items-center whitespace-nowrap rounded-[6px] bg-card-2 px-1.5 text-[11.5px] font-medium text-text-2"
      data-testid="search-why"
    >
      {label}
    </span>
  );
}

/** An amount, as the boards' money chip draws it. */
export function AmountChip({ hit }: { hit: SearchHit }) {
  if (!hit.amount) return null;
  return (
    <span className="inline-flex h-5 flex-none items-center whitespace-nowrap rounded-[6px] bg-success-soft px-1.5 text-[12px] font-medium tabular-nums text-success-text">
      {money(hit.amount.cents)}
    </span>
  );
}

/** A chip beside the line: "Paid Sep 30". */
export function LineChip({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <span className="inline-flex h-5 flex-none items-center whitespace-nowrap rounded-[6px] bg-success-soft px-1.5 text-[11.5px] font-medium text-success-text">
      {text}
    </span>
  );
}

/** The snippet the server cut, quoted and marked: “…the water heater’s leaking again”. */
export function SnippetLine({ hit }: { hit: SearchHit }) {
  const s = hit.why.snippet;
  if (!s?.text) return null;
  return (
    <>
      “<Highlight text={s.text} marks={s.marks} />”
    </>
  );
}

/** The grey line core works out from a hit's facts, marked; a snippet stands in where the facts say nothing. */
export function linesOf(hit: SearchHit, ctx: RowContext) {
  return hitLines(hit, { now: ctx.now, timeZone: ctx.timeZone });
}

/** A grey line, marked where it matched. */
export function GreyLine({ text, ctx }: { text: string | null; ctx: RowContext }) {
  return text ? <Marked text={text} probes={ctx.probes} /> : null;
}

/** "On Kim Le · page 3: “valve leaking at the boiler”": the line, then the snippet after a colon. */
export function LineWithSnippet({ hit, ctx }: { hit: SearchHit; ctx: RowContext }) {
  const { line } = linesOf(hit, ctx);
  const snippet = hit.why.snippet?.text ? <SnippetLine hit={hit} /> : null;
  if (line && snippet)
    return (
      <>
        <GreyLine text={line} ctx={ctx} />: {snippet}
      </>
    );
  return snippet ?? <GreyLine text={line} ctx={ctx} />;
}

/** The plain view most kinds share: their tile, the marked title, the line, and why it matched. */
export function plainRow(
  hit: SearchHit,
  ctx: RowContext,
  more: Partial<Pick<RowView, 'leading' | 'line' | 'chips'>> = {},
): RowView {
  return {
    leading: more.leading ?? tileOf(hit.kind, ctx.icon),
    title: <HitTitle hit={hit} ctx={ctx} />,
    line: more.line ?? <GreyLine text={linesOf(hit, ctx).line} ctx={ctx} />,
    chips: more.chips ?? <WhyChip hit={hit} />,
  };
}
