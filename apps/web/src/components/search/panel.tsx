'use client';
import {
  addContactHref,
  groupLabel,
  searchCount,
  searchHref,
  searchPageHref,
  SEARCH_WORDS as W,
  unavailableLine,
  type Dropdown,
  type DropdownChip,
  type SearchGroup,
  type SearchHit,
} from '@hfos/core';
import { MessageSquare, Phone } from 'lucide-react';
import type { ReactNode } from 'react';
import { AssistantMark } from '@/components/assistant/mark';
import { useAssistant } from '@/components/assistant/assistant-provider';
import { useCan } from '@/components/shell/workspace-shell';
import { Button } from '@/components/ui/button';
import { useCalls } from '@/lib/calls/call-provider';
import { cn } from '@/lib/utils';
import { DropdownRowBody, rowView, type RowContext } from './rows';
import type { SearchRefusal } from './use-search';

/**
 * The dropdown under the box (design/search/Main.dc.html, board 1), drawn from core's `dropdownOf`, which has already
 * merged the device's Settings group in and decided the line at the top: the chips, the best match with Call and
 * Text, a few groups, "Also found", Archived and the Deleted bin when little else matched, and the hints. Rows are
 * the combobox's options; the box moves over them with ↑ and ↓ and opens one with ↵.
 */

/** One row the keyboard moves over, in the order they show. */
export type PanelRow =
  | {
      readonly id: string;
      readonly type: 'hit';
      readonly hit: SearchHit;
      readonly group: SearchGroup | null;
      readonly best?: boolean;
    }
  | { readonly id: string; readonly type: 'all' };

export const rowId = (base: string, scope: string, hit: SearchHit) =>
  `${base}-${scope}-${hit.kind}-${hit.id}`.replace(/[^\w-]/g, '_');

/** Every row of the dropdown in order: the best match, exact matches, each group's rows, Archived, the bin, See all. */
export function panelRows(d: Dropdown, base: string): PanelRow[] {
  const rows: PanelRow[] = [];
  if (d.best)
    rows.push({
      id: rowId(base, 'best', d.best),
      type: 'hit',
      hit: d.best,
      group: null,
      best: true,
    });
  for (const hit of d.exact ?? [])
    rows.push({ id: rowId(base, 'exact', hit), type: 'hit', hit, group: null });
  for (const g of d.groups)
    for (const hit of g.rows)
      rows.push({ id: rowId(base, g.group.kind, hit), type: 'hit', hit, group: g.group });
  for (const g of [d.archived, d.bin])
    for (const hit of g?.items ?? [])
      rows.push({ id: rowId(base, g!.kind, hit), type: 'hit', hit, group: g });
  if (d.total > 0) rows.push({ id: `${base}-all`, type: 'all' });
  return rows;
}

/** A small key cap, as the boards draw ↑ ↓ ↵ and Esc. */
export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-[18px] items-center rounded-[4px] border border-border-strong bg-card-2 px-[5px] font-mono text-[11px] text-text-2">
      {children}
    </kbd>
  );
}

/** The line at the top: close matches, or nobody active. */
export function TopLine({ line, q }: { line: Dropdown['line']; q: string }) {
  if (line !== 'close' && line !== 'none_active') return null;
  return (
    <p className="px-3.5 pb-1 pt-3 text-[13px] text-text-2" role="status" data-testid="search-line">
      {line === 'close' ? W.closeMatches(q) : W.noneActive(q)}
    </p>
  );
}

/** A refusal (busy, too slow, too fast) or a group that didn't answer, with Try again. */
export function TryAgainLine({ text, onRetry }: { text: string; onRetry: () => void }) {
  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3.5 py-2 text-[13px] text-text-2"
      role="status"
      data-testid="search-try-again"
    >
      <span className="min-w-0 flex-1">{text}</span>
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={onRetry}
        className="font-medium text-accent-text hover:underline"
      >
        {W.tryAgain}
      </button>
    </div>
  );
}

/** Each group that was slow, skipped or failed this time, and a refusal, each with Try again. */
export function NotAnswered({
  refusal,
  unavailable,
  onRetry,
}: {
  refusal: SearchRefusal | null;
  unavailable: readonly SearchGroup[];
  onRetry: () => void;
}) {
  return (
    <>
      {refusal ? <TryAgainLine text={refusal.message} onRetry={onRetry} /> : null}
      {unavailable.map((g) => {
        const text = unavailableLine(g);
        return text ? <TryAgainLine key={g.kind} text={text} onRetry={onRetry} /> : null;
      })}
    </>
  );
}

/**
 * Nothing found (board 4): what to try, Ask HandsFreeOS with the question written out (it never sends by itself),
 * and Add a contact with what was typed as the name, after `#` so it never reaches the server.
 */
export function NothingFound({
  workspaceId,
  q,
  onGo,
}: {
  workspaceId: string;
  q: string;
  onGo: (href: string) => void;
}) {
  const assistant = useAssistant();
  const canAdd = useCan('records.write');
  return (
    <div className="px-6 py-7 text-center" role="status" data-testid="search-empty">
      <p className="text-[15px] font-semibold text-text">{W.noMatches(q)}</p>
      <p className="mt-1 text-[13px] text-text-2">{W.noMatchesHelp}</p>
      <div className="mt-3.5 flex flex-wrap justify-center gap-2">
        {assistant.enabled ? (
          <Button
            variant="secondary"
            size="sm"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              assistant.setDraft(W.askDraft(q));
              assistant.setOpen(true);
            }}
            data-testid="search-ask"
          >
            <AssistantMark size={16} />
            {W.ask}
          </Button>
        ) : null}
        {canAdd ? (
          <Button
            variant="ghost"
            size="sm"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onGo(addContactHref(workspaceId, q))}
            data-testid="search-add-contact"
          >
            {W.addContact}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/** Call and Text on the best match, for someone with the inbox and a contact with a phone. */
function ContactActions({
  workspaceId,
  hit,
  onGo,
}: {
  workspaceId: string;
  hit: SearchHit;
  onGo: (href: string) => void;
}) {
  const calls = useCalls();
  const inbox = useCan('inbox.use');
  const phone = hit.contact?.phoneE164 ?? null;
  const personId = hit.contact?.personId ?? null;
  if (!inbox || !phone) return null;
  const button =
    'inline-flex h-[30px] w-[30px] items-center justify-center rounded-control border border-border-strong bg-card text-text-2 hover:bg-card-2 hover:text-text';
  return (
    <span className="flex flex-none items-center gap-1.5">
      {calls.available ? (
        <button
          type="button"
          aria-label={W.call(hit.title)}
          title={W.call(hit.title)}
          className={button}
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => {
            e.stopPropagation();
            calls.openDialer({ name: hit.title, phone, personId });
          }}
          data-testid="search-best-call"
        >
          <Phone className="h-4 w-4" strokeWidth={1.5} />
        </button>
      ) : (
        <a
          href={`tel:${phone}`}
          aria-label={W.call(hit.title)}
          title={W.call(hit.title)}
          className={button}
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => e.stopPropagation()}
          data-testid="search-best-call"
        >
          <Phone className="h-4 w-4" strokeWidth={1.5} />
        </a>
      )}
      {personId ? (
        <button
          type="button"
          aria-label={W.text(hit.title)}
          title={W.text(hit.title)}
          className={button}
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => {
            e.stopPropagation();
            onGo(searchHref(workspaceId, { type: 'compose_text', personId }));
          }}
          data-testid="search-best-text"
        >
          <MessageSquare className="h-4 w-4" strokeWidth={1.5} />
        </button>
      ) : null}
    </span>
  );
}

function Heading({
  label,
  count,
  capped,
  seeAll,
  onGo,
}: {
  label: string;
  count?: number;
  capped?: boolean;
  seeAll?: string | null;
  onGo?: (href: string) => void;
}) {
  return (
    <div
      role="presentation"
      className="flex items-center gap-2 px-3.5 pb-1 pt-2.5 text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3"
    >
      {label}
      {count !== undefined ? (
        <span className="font-medium normal-case tracking-normal">
          {searchCount(count, capped)}
        </span>
      ) : null}
      {seeAll && onGo && count !== undefined ? (
        <a
          href={seeAll}
          className="ml-auto text-[12.5px] font-medium normal-case tracking-normal text-accent-text hover:underline"
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => {
            e.preventDefault();
            onGo(seeAll);
          }}
        >
          {W.seeAll(count, capped)}
        </a>
      ) : null}
    </div>
  );
}

export function SearchPanel({
  workspaceId,
  dropdown: d,
  chips = d.chips,
  q,
  ctx,
  base,
  rows,
  activeId,
  chip,
  onChip,
  onOpen,
  onGo,
  refusal,
  onRetry,
}: {
  workspaceId: string;
  dropdown: Dropdown;
  /** The chips, when not the answer's own: everything's counts while one kind is picked. */
  chips?: readonly DropdownChip[];
  /** What the answer on screen was for. */
  q: string;
  ctx: RowContext;
  /** The id the rows were made with (`panelRows`). */
  base: string;
  rows: readonly PanelRow[];
  activeId: string | null;
  /** The chip picked: 'all', or one kind. */
  chip: string;
  onChip: (kind: string) => void;
  onOpen: (row: PanelRow) => void;
  onGo: (href: string) => void;
  refusal: SearchRefusal | null;
  onRetry: () => void;
}) {
  const byHit = new Map(rows.map((r) => [r.id, r]));
  const pageHref = (kind?: string) => searchPageHref(workspaceId, { q, kind });

  const option = (row: PanelRow & { type: 'hit' }, trailing?: ReactNode) => (
    <div
      key={row.id}
      id={row.id}
      role="option"
      aria-selected={activeId === row.id}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => onOpen(row)}
      className={cn(
        'flex min-h-[44px] cursor-pointer items-center gap-3 px-3.5 py-[5px]',
        row.best && 'min-h-[52px] bg-accent-soft',
        activeId === row.id ? (row.best ? 'ring-2 ring-inset ring-accent' : 'bg-card-2') : '',
        !row.best && 'hover:bg-card-2',
      )}
      data-testid={row.best ? 'search-best' : `search-hit-${row.hit.kind}`}
      data-hit={row.hit.id}
    >
      <DropdownRowBody
        view={rowView(row.hit, { ...ctx, icon: row.group?.icon ?? null }, row.group?.kind)}
        trailing={trailing}
      />
    </div>
  );
  const hitRows = (scope: string, hits: readonly SearchHit[]) =>
    hits.map((hit) => {
      const row = byHit.get(rowId(base, scope, hit));
      return row?.type === 'hit' ? option(row) : null;
    });
  const all = rows.find((r) => r.type === 'all');

  return (
    <div className="pb-1.5">
      {chips.length > 1 ? (
        <div
          className="flex gap-1.5 overflow-x-auto border-b border-border px-3.5 py-2.5"
          role="group"
          aria-label={W.kindsOfResults}
          data-testid="search-chips"
        >
          {chips.map((c) => (
            <button
              key={c.kind}
              type="button"
              aria-pressed={chip === c.kind}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onChip(c.kind)}
              className={cn(
                'inline-flex h-7 flex-none items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 text-[13px] font-medium',
                chip === c.kind
                  ? 'border-transparent bg-accent-soft text-accent-text'
                  : 'border-border bg-card text-text-2 hover:bg-card-2',
              )}
              data-testid={`search-chip-${c.kind}`}
            >
              {c.label}
              <span className={chip === c.kind ? 'text-accent-text' : 'text-text-3'}>
                {searchCount(c.count, c.capped)}
              </span>
            </button>
          ))}
        </div>
      ) : null}

      <TopLine line={d.line} q={q} />
      <NotAnswered refusal={refusal} unavailable={d.unavailable} onRetry={onRetry} />
      {d.line === 'empty' && !refusal ? (
        <NothingFound workspaceId={workspaceId} q={q} onGo={onGo} />
      ) : null}

      {d.best ? (
        <>
          <Heading label={W.best} />
          {(() => {
            const row = rows.find((r) => r.type === 'hit' && r.best);
            return row?.type === 'hit'
              ? option(
                  row,
                  <span className="flex flex-none items-center gap-1.5">
                    {row.hit.kind === 'contacts' ? (
                      <ContactActions workspaceId={workspaceId} hit={row.hit} onGo={onGo} />
                    ) : null}
                    {activeId === row.id ? <Kbd>↵</Kbd> : null}
                  </span>,
                )
              : null;
          })()}
        </>
      ) : null}

      {d.exact ? (
        <>
          <Heading label={W.exact} />
          {hitRows('exact', d.exact)}
          {d.groups.length ? <Heading label={W.alsoHas(q)} /> : null}
        </>
      ) : null}

      {d.groups.map((g) => (
        <div key={g.group.kind} data-testid={`search-group-${g.group.kind}`}>
          {d.exact ? null : (
            <Heading
              label={g.label}
              count={g.group.total}
              capped={g.group.capped}
              seeAll={g.more > 0 ? pageHref(g.group.kind) : null}
              onGo={onGo}
            />
          )}
          {hitRows(g.group.kind, g.rows)}
        </div>
      ))}

      {[d.archived, d.bin].map((g) =>
        g ? (
          <div key={g.kind} data-testid={`search-group-${g.kind}`}>
            <Heading
              label={groupLabel(g)}
              count={g.total}
              capped={g.capped}
              seeAll={g.total > g.items.length ? pageHref(g.kind) : null}
              onGo={onGo}
            />
            {hitRows(g.kind, g.items)}
          </div>
        ) : null,
      )}

      {d.total > 0 ? (
        <div className="mt-2 flex flex-wrap items-center gap-x-3.5 gap-y-1.5 border-t border-border bg-card-2 px-3.5 py-2.5 text-[12.5px] text-text-3">
          {d.alsoFound.length ? (
            <>
              <span>{W.alsoFound}</span>
              {d.alsoFound.map((a) => (
                <a
                  key={a.kind}
                  href={pageHref(a.kind)}
                  className="text-accent-text hover:underline"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={(e) => {
                    e.preventDefault();
                    onGo(pageHref(a.kind));
                  }}
                  data-testid={`search-also-${a.kind}`}
                >
                  {a.label} {searchCount(a.total, a.capped)}
                </a>
              ))}
            </>
          ) : null}
          <span className="ml-auto hidden items-center gap-1.5 md:flex">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd> {W.hints.move} <Kbd>↵</Kbd> {W.hints.open} <Kbd>Esc</Kbd> {W.hints.close}
          </span>
          {all ? (
            <a
              id={all.id}
              role="option"
              aria-selected={activeId === all.id}
              href={pageHref()}
              className={cn(
                'rounded-[4px] font-semibold text-accent-text hover:underline',
                activeId === all.id && 'underline ring-2 ring-accent',
              )}
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => {
                e.preventDefault();
                onOpen(all);
              }}
              data-testid="search-see-all"
            >
              {W.seeAllResults(d.total, d.capped)}
            </a>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
