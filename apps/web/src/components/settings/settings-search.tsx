'use client';
/**
 * Search settings (design/search/Settings.dc.html, board 6): a box at the top of the Settings menu that finds a
 * setting on any page this person may open, worked out here from core's catalogue as they type, with nothing sent
 * anywhere. Typing replaces the menu with what matched, grouped as the menu is: the group, the page, then each
 * setting with where it sits. Choosing one opens its page at it and rings it; Show every setting brings the menu back.
 *
 * An add-on's own settings come last, under the add-on's name: Add-ons isn't a Settings page.
 */
import {
  SETTINGS_SEARCH_WORDS as W,
  searchSettings,
  settingHref,
  settingsByPage,
  settingsCount,
  settingsFound,
  type SettingHit,
  type SettingsPageKey,
} from '@hfos/core';
import { Search, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { Fragment, useId, useMemo, useState, type ComponentType, type ReactNode } from 'react';
import { useWorkspaceShell } from '@/components/shell/workspace-shell';
import { cn } from '@/lib/utils';

type Icon = ComponentType<{ className?: string; strokeWidth?: number }>;

/** One row the keyboard moves over: a page, or a setting under it. */
interface Row {
  readonly id: string;
  readonly href: string;
  /** What to ring once there; null for a page. */
  readonly anchor: string | null;
}

/** A label with the places the search matched, drawn as text inside `<mark>`, never as HTML. */
function Marked({ text, marks }: { text: string; marks: readonly (readonly [number, number])[] }) {
  if (!marks.length) return <>{text}</>;
  const parts: ReactNode[] = [];
  let at = 0;
  marks.forEach(([start, end], i) => {
    if (start > at) parts.push(text.slice(at, start));
    parts.push(
      <mark key={i} className="rounded-[3px] bg-accent-soft px-px font-semibold text-text">
        {text.slice(start, end)}
      </mark>,
    );
    at = end;
  });
  if (at < text.length) parts.push(text.slice(at));
  return <>{parts}</>;
}

/** Whether there's a search to show: two characters, as everywhere search is. */
export const hasSettingsSearch = (q: string) => q.trim().length >= 2;

export function SettingsSearch({
  workspaceId,
  staff,
  agency,
  q,
  onChange,
  icons,
  highlight,
  clearOnPick = false,
  sticky = false,
  children,
}: {
  workspaceId: string;
  /** They answer HandsFreeOS support: New support tickets is theirs to find. */
  staff: boolean;
  /** They run an agency: Daily agency digest is theirs to find. */
  agency: boolean;
  q: string;
  onChange: (q: string) => void;
  /** Each page's icon, as the menu draws it. */
  icons: Readonly<Record<SettingsPageKey, Icon>>;
  /** Rings a setting already on the page (`useSettingHighlight`). */
  highlight: (anchor: string) => void;
  /** Below `lg` the results sit over the page, so choosing one puts the picker back. */
  clearOnPick?: boolean;
  /** In the side menu, the box stays at its top while the menu scrolls under it. */
  sticky?: boolean;
  /** The menu, shown while there's no search. */
  children: ReactNode;
}) {
  const router = useRouter();
  const { permissions, addons } = useWorkspaceShell();
  const id = useId();
  const listId = `${id}-results`;
  const [active, setActive] = useState(-1);
  const searching = hasSettingsSearch(q);
  const hits = useMemo(
    () =>
      searching ? searchSettings(q, { permissions, addons, staff, agency, surface: 'web' }) : [],
    [searching, q, permissions, addons, staff, agency],
  );
  const groups = useMemo(() => settingsByPage(hits), [hits]);
  const count = settingsCount(hits);

  const rowOfHit = (hit: SettingHit): Row => ({
    id: `${id}-${hit.entry.key}`,
    href: settingHref(workspaceId, hit.entry),
    anchor: hit.entry.anchor,
  });
  const rows: Row[] = groups.flatMap((g) =>
    g.pages.flatMap((p) => [
      ...(p.key.startsWith('addon:')
        ? []
        : [{ id: `${id}-page-${p.key}`, href: `/app/w/${workspaceId}/${p.path}`, anchor: null }]),
      ...p.hits.map(rowOfHit),
    ]),
  );
  const activeRow = rows[active] ?? null;
  // ↵ with nothing picked opens the best match, a setting or a page found by its name, not the first row in menu order.
  const best = hits[0] ? rowOfHit(hits[0]) : null;

  function change(next: string) {
    onChange(next);
    setActive(-1);
  }

  function go(row: Row) {
    const here = new URL(row.href, window.location.origin).pathname === window.location.pathname;
    router.push(row.href);
    // A push to the page you're on fires no hashchange, so the ring is asked for here.
    if (here && row.anchor) highlight(row.anchor);
    if (clearOnPick) change('');
  }

  const rowClass = (row: Row, extra: string) =>
    cn(
      'flex cursor-pointer rounded-control text-left transition-colors focus-visible:outline-none',
      extra,
      activeRow?.id === row.id ? 'bg-card-2 text-text' : 'hover:bg-card-2 hover:text-text',
    );

  return (
    <div className="flex flex-col gap-1.5" data-testid="settings-search">
      <div
        // Over the padding around it too, and the gap below, so nothing shows through as the menu scrolls under it.
        className={cn(
          sticky && 'sticky top-0 z-10 -mx-2 -mb-1.5 -mt-2 rounded-t-card bg-card px-2 pb-1.5 pt-2',
        )}
        data-testid="settings-search-box"
      >
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-text-3"
            strokeWidth={1.5}
            aria-hidden
          />
          <input
            type="search"
            value={q}
            placeholder={W.box}
            aria-label={W.box}
            autoComplete="off"
            spellCheck={false}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={searching}
            aria-controls={listId}
            aria-activedescendant={activeRow?.id}
            data-testid="settings-search-input"
            className="h-9 w-full rounded-control border border-border bg-card-2 pl-8 pr-8 text-[13px] text-text placeholder:text-text-3 focus:border-accent focus:bg-card focus:outline-none focus:ring-[3px] focus:ring-ring [&::-webkit-search-cancel-button]:hidden"
            onChange={(e) => change(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown' && rows.length) {
                e.preventDefault();
                setActive((a) => Math.min(a + 1, rows.length - 1));
              } else if (e.key === 'ArrowUp' && rows.length) {
                e.preventDefault();
                setActive((a) => Math.max(a - 1, 0));
              } else if (e.key === 'Enter' && searching) {
                e.preventDefault();
                const row = activeRow ?? best;
                if (row) go(row);
              } else if (e.key === 'Escape' && q) {
                e.preventDefault();
                change('');
              }
            }}
          />
          {q ? (
            <button
              type="button"
              aria-label={W.clear}
              onClick={() => change('')}
              className="absolute right-1 top-1/2 inline-flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-[6px] text-text-3 hover:bg-card-2 hover:text-text"
              data-testid="settings-search-clear"
            >
              <X className="h-3.5 w-3.5" strokeWidth={1.75} />
            </button>
          ) : null}
        </div>
      </div>

      {!searching ? (
        children
      ) : (
        <div id={listId} role="listbox" aria-label={W.box} data-testid="settings-search-results">
          {hits.length ? (
            <p
              className="px-2.5 pb-0.5 pt-1 text-[12.5px] text-text-3"
              role="status"
              data-testid="settings-search-count"
            >
              {settingsFound(count.settings, count.pages)}
            </p>
          ) : (
            <div
              className="px-2.5 py-2 text-[13px]"
              role="status"
              data-testid="settings-search-none"
            >
              <p className="text-text-2">{W.noMatch(q.trim())}</p>
              <p className="mt-1 text-xs text-text-3">{W.noMatchHelp}</p>
            </div>
          )}
          {groups.map((g) => (
            <div key={g.label} className="flex flex-col">
              <div
                role="presentation"
                className="px-2.5 pb-1 pt-2.5 text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3"
              >
                {g.label}
              </div>
              {g.pages.map((p) => {
                const addon = p.key.startsWith('addon:');
                const PageIcon = addon ? null : icons[p.key as SettingsPageKey];
                const pageRow = rows.find((r) => r.id === `${id}-page-${p.key}`);
                return (
                  <Fragment key={p.key}>
                    {pageRow ? (
                      <div
                        id={pageRow.id}
                        role="option"
                        aria-selected={activeRow?.id === pageRow.id}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => go(pageRow)}
                        className={rowClass(
                          pageRow,
                          'h-9 items-center gap-2.5 px-2.5 text-sm font-medium text-text',
                        )}
                        data-testid={`settings-search-page-${p.key}`}
                      >
                        {PageIcon ? (
                          <PageIcon className="h-4 w-4 flex-none" strokeWidth={1.5} />
                        ) : null}
                        <span className="min-w-0 truncate">
                          {p.page ? <Marked text={p.label} marks={p.page.marks} /> : p.label}
                        </span>
                      </div>
                    ) : null}
                    {p.hits.map((hit) => {
                      const row = rowOfHit(hit);
                      const note =
                        hit.entry.kind === 'addon' && hit.entry.path === 'add-ons'
                          ? W.opensAddOns
                          : hit.entry.section;
                      return (
                        <div
                          key={hit.entry.key}
                          id={row.id}
                          role="option"
                          aria-selected={activeRow?.id === row.id}
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => go(row)}
                          className={rowClass(
                            row,
                            cn(
                              'flex-col gap-px py-1.5 pr-2.5 text-[13px] text-text-2',
                              addon
                                ? 'px-2.5'
                                : 'ml-4 rounded-l-none border-l border-border pl-2.5',
                            ),
                          )}
                          data-testid={`settings-search-hit-${hit.entry.key}`}
                        >
                          <span className="min-w-0">
                            <Marked text={hit.entry.label} marks={hit.marks} />
                          </span>
                          {note ? <span className="text-xs text-text-3">{note}</span> : null}
                        </div>
                      );
                    })}
                  </Fragment>
                );
              })}
            </div>
          ))}
          <div className="mx-1 mb-1.5 mt-2.5 h-px bg-border" />
          <button
            type="button"
            onClick={() => change('')}
            className="block px-2.5 pb-1.5 pt-1 text-left text-[13px] font-medium text-accent-text hover:underline"
            data-testid="settings-search-show-all"
          >
            {W.showEvery}
          </button>
        </div>
      )}
    </div>
  );
}
