'use client';
import type { SearchHit } from '@hfos/core';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { addonRow } from './addon';
import { archivedRow } from './archived';
import { binRow } from './bin';
import { calendarRow } from './calendar';
import { companyRow } from './company';
import { contactRow } from './contact';
import { fileRow } from './file';
import { formRow } from './form';
import { knowledgeRow } from './knowledge';
import { leadRow } from './lead';
import { messageRow } from './message';
import { moneyRow } from './money';
import { noteRow } from './note';
import type { RowContext, RowView } from './parts';
import { recordRow } from './record';
import { settingRow } from './setting';
import { taskRow } from './task';

export type { RowContext, RowView } from './parts';

const ROWS: Readonly<Record<string, (hit: SearchHit, ctx: RowContext) => RowView>> = {
  contacts: contactRow,
  companies: companyRow,
  leads: leadRow,
  money: moneyRow,
  messages: messageRow,
  spam: messageRow,
  calendar: calendarRow,
  tasks: taskRow,
  notes: noteRow,
  files: fileRow,
  forms: formRow,
  knowledge: knowledgeRow,
  settings: settingRow,
  bin: binRow,
};

/**
 * How a hit is drawn, by its kind: core's kinds each their own, a business's own kinds (`record.pets`) the record
 * row, and any other kind with a dot an add-on's (`realestate.listings`), from the add-on's own title and line. Under
 * Archived every hit is drawn greyed, whatever its kind.
 */
export function rowView(hit: SearchHit, ctx: RowContext, groupKind?: string): RowView {
  if (groupKind === 'archived' || hit.badges.includes('archived')) return archivedRow(hit, ctx);
  const own = ROWS[hit.kind];
  if (own) return own(hit, ctx);
  if (hit.kind.startsWith('record.')) return recordRow(hit, ctx);
  return addonRow(hit, ctx);
}

/** A row's insides as the dropdown draws them: the picture, the title over its line, and the chips. */
export function DropdownRowBody({ view, trailing }: { view: RowView; trailing?: ReactNode }) {
  return (
    <>
      {view.leading}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-[14px] font-medium text-text">{view.title}</span>
        {view.line ? <span className="truncate text-[12.5px] text-text-3">{view.line}</span> : null}
      </span>
      {view.chips ? (
        <span className="flex flex-none items-center gap-1.5">{view.chips}</span>
      ) : null}
      {trailing}
    </>
  );
}

/**
 * A row's insides as the Search page's cards draw them: the title over its line (and, for a contact, what's under
 * the name), then a contact's columns or the chips. Wraps under the title on a narrow screen.
 */
export function PageRowBody({ view }: { view: RowView }) {
  return (
    <>
      <span className="flex min-w-0 flex-[1_1_240px] items-center gap-3">
        {view.leading}
        <span className="flex min-w-0 flex-col">
          <span className="text-[14px] font-medium text-text">{view.title}</span>
          {/* A contact's line is its columns here, so only what's under the name shows. */}
          {(view.columns ? view.under : view.line) ? (
            <span className="truncate text-[12.5px] text-text-3">
              {view.columns ? view.under : view.line}
            </span>
          ) : null}
        </span>
      </span>
      {view.columns
        ? view.columns.map((c, i) => (
            <span
              key={i}
              className={cn(
                'min-w-0 flex-[0_1_170px] truncate text-[13px]',
                // On a phone the columns wrap under the name, where an empty one is only a dash.
                c ? 'text-text-2' : 'hidden text-text-3 md:block',
              )}
            >
              {c ?? '—'}
            </span>
          ))
        : null}
      {view.chips ? (
        <span className="flex flex-none items-center gap-1.5">{view.chips}</span>
      ) : null}
    </>
  );
}

/**
 * One result on the Search page: a link to where it opens, drawn as `PageRowBody`, that the page's ↑ and ↓ move over
 * (`data-search-nav`). `onOpen` keeps the search among the person's recent ones.
 */
export function PageRow({
  hit,
  ctx,
  groupKind,
  onOpen,
  first,
}: {
  hit: SearchHit;
  ctx: RowContext;
  groupKind?: string;
  onOpen?: () => void;
  first?: boolean;
}) {
  return (
    <Link
      href={hit.href}
      onClick={onOpen}
      data-search-nav
      data-testid={`search-row-${hit.kind}`}
      data-hit={hit.id}
      className={cn(
        'flex min-h-12 flex-wrap items-center gap-x-4 gap-y-1.5 px-4 py-[7px] text-text transition-colors hover:bg-card-2 focus-visible:bg-card-2 focus-visible:outline-none',
        !first && 'border-t border-border',
      )}
    >
      <PageRowBody view={rowView(hit, ctx, groupKind)} />
    </Link>
  );
}
