'use client';
import * as Popover from '@radix-ui/react-popover';
import {
  dropdownOf,
  searchPageHref,
  searchProbes,
  SEARCH_MIN_CHARS,
  SEARCH_WORDS as W,
  type DropdownChip,
} from '@hfos/core';
import { Clock, Search } from 'lucide-react';
import { useRouter } from 'next/navigation';
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import { ShortcutKey } from '@/components/assistant/ask-button';
import { cn } from '@/lib/utils';
import { NotAnswered, panelRows, SearchPanel, type PanelRow } from './panel';
import { useSearchContext } from './search-provider';
import { useSearch, useSettingsGroup } from './use-search';

/**
 * Search everything's box in the side menu (design/search/Main.dc.html, board 1), and its dropdown: an ARIA combobox
 * after the industry picker's (`role="combobox"`, the rows as options, `aria-activedescendant`, rows pressed on mouse
 * down so focus stays in the box), with the results in a Radix Popover anchored to it, opening to the right of the
 * side menu. Focused and empty, it lists the person's recent searches.
 *
 * Keys: ↑ ↓ move over the rows; ← → over the chips once a row is picked; ↵ opens the row picked, or the Search page
 * with none; ⌘↵ or Ctrl↵ always opens the page; Esc closes and keeps the text, a second Esc clears it; Tab leaves.
 *
 * It sits at the top of the side menu, inside the layout's `SearchProvider`; outside one it draws nothing.
 */
export function SearchBox({ className }: { className?: string }) {
  const search = useSearchContext();
  const router = useRouter();
  const base = useId().replace(/:/g, '');
  const listId = `${base}-list`;
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [chip, setChip] = useState('all');
  const [active, setActive] = useState(-1);
  const anchor = useRef<HTMLFormElement>(null);
  const workspaceId = search?.workspaceId ?? '';
  const settingsOf = useSettingsGroup(
    search ?? { workspaceId, settings: null, timeZone: 'UTC', staff: false, agency: false },
  );
  const ask = {
    q,
    kinds: chip === 'all' ? undefined : [chip],
    perKind: chip === 'all' ? 3 : 5,
    depth: 'quick' as const,
  };
  // Closed, the box keeps its words from page to page but asks nothing, so a refresh never sends a search unseen.
  const s = useSearch(workspaceId, ask, settingsOf, { paused: !open });
  const typed = q.trim();
  const searching = typed.length >= SEARCH_MIN_CHARS;
  const dropdown = useMemo(
    () => (s.answer ? dropdownOf(s.answer, s.settings, { maxGroups: 5, maxRows: 10 }) : null),
    [s.answer, s.settings],
  );
  const rows: PanelRow[] = useMemo(
    () => (searching && dropdown ? panelRows(dropdown, base) : []),
    [searching, dropdown, base],
  );
  // A chip asks for its kind alone; the chips keep the counts of everything meanwhile, so another can be picked.
  const [allChips, setAllChips] = useState<readonly DropdownChip[] | null>(null);
  useEffect(() => {
    if (chip === 'all' && dropdown) setAllChips(dropdown.chips);
  }, [chip, dropdown]);
  const recent = !searching ? (search?.recent ?? []) : [];
  const showRecent = open && !typed && recent.length > 0;
  const showPanel = open && searching && (!!dropdown || !!s.refusal);
  const activeRow = rows[active] ?? null;
  const probes = useMemo(() => searchProbes(s.q), [s.q]);

  if (!search) return null;

  function close() {
    setOpen(false);
    setActive(-1);
  }

  function go(href: string) {
    search!.remember(typed);
    close();
    search!.boxRef.current?.blur();
    // Already on the page (the Search page, or Contacts for Add a contact), only what's after `#` changes: set it so
    // the page hears `hashchange`, which a router push to the same page never fires.
    const to = new URL(href, window.location.origin);
    const here = to.pathname === window.location.pathname && to.search === window.location.search;
    if (here && to.hash) window.location.hash = to.hash;
    else router.push(href);
  }

  function openRow(row: PanelRow) {
    if (row.type === 'all') go(searchPageHref(workspaceId, { q: typed }));
    else go(row.hit.href);
  }

  function change(next: string) {
    setQ(next);
    setActive(-1);
    setChip('all');
    setOpen(true);
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!searching) return;
    if (activeRow) openRow(activeRow);
    else go(searchPageHref(workspaceId, { q: typed }));
  }

  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    const chips = (chip === 'all' ? dropdown?.chips : allChips) ?? [];
    if (e.key === 'ArrowDown' && rows.length) {
      e.preventDefault();
      setOpen(true);
      setActive((a) => Math.min(a + 1, rows.length - 1));
    } else if (e.key === 'ArrowUp' && rows.length) {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && activeRow && chips.length > 1) {
      // Once a row is picked the arrows move over the chips; before that they move the caret, as in any box.
      e.preventDefault();
      const at = Math.max(
        0,
        chips.findIndex((c) => c.kind === chip),
      );
      const next = chips[(at + (e.key === 'ArrowRight' ? 1 : chips.length - 1)) % chips.length]!;
      setChip(next.kind);
      setActive(-1);
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && searching) {
      e.preventDefault();
      go(searchPageHref(workspaceId, { q: typed }));
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (open && (showPanel || showRecent)) close();
      else if (q) change('');
    } else if (e.key === 'Tab') close();
  }

  const ctx = { probes, now: Date.now(), timeZone: search.timeZone };

  return (
    <Popover.Root open={showPanel || showRecent} onOpenChange={(next) => !next && close()}>
      <Popover.Anchor asChild>
        <form
          ref={anchor}
          role="search"
          onSubmit={submit}
          className={cn('relative', className)}
          data-testid="search-box"
        >
          <Search
            className="pointer-events-none absolute left-2.5 top-[9px] h-4 w-4 text-text-3"
            strokeWidth={1.5}
            aria-hidden
          />
          <input
            ref={search.boxRef}
            type="search"
            value={q}
            placeholder={W.box}
            aria-label={W.box}
            aria-keyshortcuts={search.shortcut?.aria}
            autoComplete="off"
            spellCheck={false}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={showPanel || showRecent}
            aria-controls={listId}
            aria-activedescendant={activeRow?.id}
            onChange={(e) => change(e.target.value)}
            onFocus={() => setOpen(true)}
            onKeyDown={onKey}
            data-testid="shell-search"
            className="h-[34px] w-full rounded-control border border-border bg-card-2 pl-8 pr-14 text-[13px] text-text placeholder:text-placeholder focus:border-accent focus:bg-card focus:outline-none focus:ring-[3px] focus:ring-ring [&::-webkit-search-cancel-button]:hidden"
          />
          {search.shortcut ? (
            <ShortcutKey className="pointer-events-none absolute right-2 top-[7px]">
              {search.shortcut.label}
            </ShortcutKey>
          ) : null}
        </form>
      </Popover.Anchor>
      <Popover.Portal>
        <Popover.Content
          side="right"
          align="start"
          sideOffset={12}
          collisionPadding={12}
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}
          onInteractOutside={(e) => {
            // A press in the box itself is typing, not leaving.
            if (anchor.current?.contains(e.target as Node)) e.preventDefault();
          }}
          onEscapeKeyDown={(e) => {
            // Esc in the box is the box's own: the first closes and keeps the text, a second clears it. Left to the
            // popover too, the first did both, since the box then saw the panel already closed.
            if (anchor.current?.contains(e.target as Node)) e.preventDefault();
          }}
          className="z-40 max-h-[min(78vh,760px)] w-[min(620px,calc(100vw-24px))] overflow-y-auto rounded-card border border-border bg-card shadow-2"
          data-testid="search-panel"
        >
          <div id={listId} role="listbox" aria-label={W.box}>
            {showRecent ? (
              <div data-testid="search-recent">
                <div
                  role="presentation"
                  className="flex items-center px-3.5 pb-1 pt-2.5 text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3"
                >
                  {W.recent}
                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={search.clearRecent}
                    className="ml-auto text-[12.5px] font-medium normal-case tracking-normal text-accent-text hover:underline"
                    data-testid="search-recent-clear"
                  >
                    {W.clear}
                  </button>
                </div>
                {recent.map((r) => (
                  <div
                    key={r}
                    role="option"
                    aria-selected={false}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => change(r)}
                    className="flex h-9 cursor-pointer items-center gap-2.5 px-3.5 text-[13.5px] text-text hover:bg-card-2"
                  >
                    <Clock className="h-4 w-4 flex-none text-text-3" strokeWidth={1.5} />
                    <span className="min-w-0 truncate">{r}</span>
                  </div>
                ))}
              </div>
            ) : dropdown ? (
              <SearchPanel
                workspaceId={workspaceId}
                dropdown={dropdown}
                chips={chip === 'all' ? undefined : (allChips ?? undefined)}
                q={s.q || typed}
                ctx={ctx}
                base={base}
                rows={rows}
                activeId={activeRow?.id ?? null}
                chip={chip}
                onChip={(kind) => {
                  setChip(kind);
                  setActive(-1);
                }}
                onOpen={openRow}
                onGo={go}
                refusal={s.refusal}
                onRetry={s.retry}
              />
            ) : s.refusal ? (
              <NotAnswered refusal={s.refusal} unavailable={[]} onRetry={s.retry} />
            ) : null}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
