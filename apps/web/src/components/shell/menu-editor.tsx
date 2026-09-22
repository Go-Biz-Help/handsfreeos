'use client';
import {
  DEFAULT_MENU,
  MENU_ALWAYS_SHOWN,
  MENU_GROUPS_MAX,
  MENU_GROUP_LABEL_MAX,
  FLAT_MENU,
  MENU_WORDS,
  addGroup,
  moveEntry,
  moveInGroup,
  moveKey,
  renameGroup,
  sameMenu,
  ungroup,
  type Menu,
  type MenuKey,
  type MenuTarget,
} from '@hfos/core';
import { ChevronDown, ChevronUp, FolderPlus, Ungroup } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/input';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import { useMenu } from './menu-provider';
import { navItemOf } from './nav-links';

const pinned = (key: MenuKey) => MENU_ALWAYS_SHOWN.includes(key);

/** A row of controls, the same for a place and for a group. */
function RowButtons({
  onUp,
  onDown,
  canUp,
  canDown,
  children,
}: {
  onUp: () => void;
  onDown: () => void;
  canUp: boolean;
  canDown: boolean;
  children?: ReactNode;
}) {
  return (
    <span className="ml-auto flex flex-none items-center gap-1">
      {children}
      <button
        type="button"
        aria-label={MENU_WORDS.moveUp}
        disabled={!canUp}
        onClick={onUp}
        className="flex h-8 w-8 items-center justify-center rounded-control text-text-2 hover:bg-card-2 hover:text-text disabled:opacity-30 disabled:hover:bg-transparent"
      >
        <ChevronUp className="h-4 w-4" strokeWidth={1.75} />
      </button>
      <button
        type="button"
        aria-label={MENU_WORDS.moveDown}
        disabled={!canDown}
        onClick={onDown}
        className="flex h-8 w-8 items-center justify-center rounded-control text-text-2 hover:bg-card-2 hover:text-text disabled:opacity-30 disabled:hover:bg-transparent"
      >
        <ChevronDown className="h-4 w-4" strokeWidth={1.75} />
      </button>
    </span>
  );
}

/** One place: where it is (which doubles as where to send it), and which way to nudge it. */
function PlaceRow({
  workspaceId,
  itemKey,
  where,
  groups,
  onMove,
  onUp,
  onDown,
  canUp,
  canDown,
  indented,
}: {
  workspaceId: string;
  itemKey: MenuKey;
  where: 'menu' | 'hidden' | string;
  groups: readonly { readonly id: string; readonly label: string }[];
  onMove: (target: MenuTarget) => void;
  onUp?: () => void;
  onDown?: () => void;
  canUp?: boolean;
  canDown?: boolean;
  indented?: boolean;
}) {
  const item = navItemOf(workspaceId, itemKey);
  const Icon = item.icon;
  const full = groups.length >= MENU_GROUPS_MAX;
  return (
    <li
      data-testid={`menu-row-${itemKey}`}
      className={cn('flex items-center gap-2.5 rounded-control px-2 py-1.5', indented && 'ml-5')}
    >
      <Icon className="h-[18px] w-[18px] flex-none text-text-2" strokeWidth={1.5} />
      <span className="min-w-0 flex-1 truncate text-sm font-medium">{item.label}</span>
      <Select
        selectSize="sm"
        aria-label={`${MENU_WORDS.moveTo} — ${item.label}`}
        className="w-[136px] flex-none"
        value={where}
        onChange={(e) => {
          const v = e.target.value;
          onMove(v === 'menu' || v === 'hidden' || v === 'new' ? v : { group: v });
        }}
      >
        <option value="menu">{MENU_WORDS.inMenu}</option>
        {groups.map((g) => (
          <option key={g.id} value={g.id}>
            {g.label}
          </option>
        ))}
        {full ? null : <option value="new">{MENU_WORDS.addGroup}</option>}
        {pinned(itemKey) ? null : <option value="hidden">{MENU_WORDS.hidden}</option>}
      </Select>
      {onUp && onDown ? (
        <RowButtons onUp={onUp} onDown={onDown} canUp={!!canUp} canDown={!!canDown} />
      ) : null}
    </li>
  );
}

/**
 * Arranging the side menu: move a place, fold the ones rarely opened into a group that opens on hover, or take
 * one out of the menu altogether. Nothing is sent until Save, so a half-finished arrangement never reaches the
 * sidebar; Cancel puts the editor back to what is saved.
 */
export function MenuEditor({ workspaceId }: { workspaceId: string }) {
  const { menu, save, editorOpen, closeEditor } = useMenu();
  const [draft, setDraft] = useState<Menu>(menu);
  const [busy, setBusy] = useState(false);

  // Each opening starts from what is saved now (another tab, or Cancel, may have changed it).
  useEffect(() => {
    if (editorOpen) setDraft(menu);
  }, [editorOpen, menu]);

  const groups = draft.entries
    .filter((e) => e.kind === 'group')
    .map((g) => ({ id: g.id, label: g.label }));
  const dirty = !sameMenu(menu, draft);

  // Every change is one of core's menu edits, so the arrangement can only ever be one a menu could hold.
  const nudge = (at: number, by: -1 | 1) => setDraft((d) => moveEntry(d, at, by));
  const nudgeIn = (groupId: string, at: number, by: -1 | 1) =>
    setDraft((d) => moveInGroup(d, groupId, at, by));
  const move = (key: MenuKey, target: MenuTarget) => setDraft((d) => moveKey(d, key, target));
  const rename = (groupId: string, label: string) =>
    setDraft((d) => renameGroup(d, groupId, label));

  async function onSave() {
    setBusy(true);
    try {
      await save(draft);
      toast.success(MENU_WORDS.saved);
      closeEditor();
    } catch {
      // The provider said so and put the sidebar back; the editor keeps the arrangement to try again.
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open={editorOpen} onOpenChange={(open) => (open ? null : closeEditor())}>
      <SheetContent title={MENU_WORDS.title} description={MENU_WORDS.intro}>
        <div className="flex flex-wrap gap-2" data-testid="menu-editor-tools">
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setDraft(addGroup)}
            disabled={groups.length >= MENU_GROUPS_MAX}
            title={groups.length >= MENU_GROUPS_MAX ? MENU_WORDS.groupsFull : undefined}
          >
            <FolderPlus className="h-4 w-4" strokeWidth={1.75} />
            {MENU_WORDS.addGroup}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            data-testid="menu-flatten"
            onClick={() => setDraft(FLAT_MENU)}
            title={MENU_WORDS.flattenHint}
          >
            {MENU_WORDS.flatten}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            data-testid="menu-reset"
            onClick={() => setDraft(DEFAULT_MENU)}
            title={MENU_WORDS.resetHint}
          >
            {MENU_WORDS.reset}
          </Button>
        </div>

        <h3 className="mb-1 mt-5 text-xs font-medium uppercase tracking-wide text-text-3">
          {MENU_WORDS.inMenu}
        </h3>
        <ul className="flex flex-col" data-testid="menu-editor-list">
          {draft.entries.map((entry, at) =>
            entry.kind === 'link' ? (
              <PlaceRow
                key={entry.key}
                workspaceId={workspaceId}
                itemKey={entry.key}
                where="menu"
                groups={groups}
                onMove={(t) => move(entry.key, t)}
                onUp={() => nudge(at, -1)}
                onDown={() => nudge(at, 1)}
                canUp={at > 0}
                canDown={at < draft.entries.length - 1}
              />
            ) : (
              <li key={entry.id} data-testid={`menu-group-row-${entry.id}`} className="mt-1.5">
                <div className="flex items-center gap-2 rounded-control bg-card-2 px-2 py-1.5">
                  <Input
                    inputSize="sm"
                    aria-label={MENU_WORDS.groupName}
                    maxLength={MENU_GROUP_LABEL_MAX}
                    value={entry.label}
                    onChange={(e) => rename(entry.id, e.target.value)}
                    className="w-[150px] flex-none bg-card"
                  />
                  <span className="truncate text-xs text-text-3">
                    {entry.keys.length === 1 ? '1 place' : `${entry.keys.length} places`}
                  </span>
                  <RowButtons
                    onUp={() => nudge(at, -1)}
                    onDown={() => nudge(at, 1)}
                    canUp={at > 0}
                    canDown={at < draft.entries.length - 1}
                  >
                    <button
                      type="button"
                      aria-label={`${MENU_WORDS.ungroup} ${entry.label}`}
                      onClick={() => setDraft((d) => ungroup(d, entry.id))}
                      className="flex h-8 w-8 items-center justify-center rounded-control text-text-2 hover:bg-card hover:text-text"
                    >
                      <Ungroup className="h-4 w-4" strokeWidth={1.75} />
                    </button>
                  </RowButtons>
                </div>
                {entry.keys.length === 0 ? (
                  <p className="ml-5 px-2 py-2 text-[13px] text-text-3">{MENU_WORDS.groupEmpty}</p>
                ) : (
                  <ul className="flex flex-col">
                    {entry.keys.map((key, i) => (
                      <PlaceRow
                        key={key}
                        workspaceId={workspaceId}
                        itemKey={key}
                        where={entry.id}
                        groups={groups}
                        indented
                        onMove={(t) => move(key, t)}
                        onUp={() => nudgeIn(entry.id, i, -1)}
                        onDown={() => nudgeIn(entry.id, i, 1)}
                        canUp={i > 0}
                        canDown={i < entry.keys.length - 1}
                      />
                    ))}
                  </ul>
                )}
              </li>
            ),
          )}
        </ul>

        <h3 className="mb-1 mt-5 text-xs font-medium uppercase tracking-wide text-text-3">
          {MENU_WORDS.hidden}
        </h3>
        {draft.hidden.length === 0 ? (
          <p className="px-2 text-[13px] text-text-3">{MENU_WORDS.hiddenEmpty}</p>
        ) : (
          <ul className="flex flex-col" data-testid="menu-hidden-list">
            {draft.hidden.map((key) => (
              <PlaceRow
                key={key}
                workspaceId={workspaceId}
                itemKey={key}
                where="hidden"
                groups={groups}
                onMove={(t) => move(key, t)}
              />
            ))}
          </ul>
        )}
        <p className="mt-1.5 px-2 text-xs text-text-3">{MENU_WORDS.hiddenHint}</p>

        {/* Pinned to the foot of the sheet: on a phone, Save is never fifteen rows away. */}
        <div className="sticky bottom-0 -mx-5 -mb-5 mt-6 flex flex-none gap-2 border-t border-border bg-card px-5 py-4 sm:-mx-6 sm:-mb-6 sm:px-6">
          <Button data-testid="menu-save" loading={busy} disabled={!dirty} onClick={onSave}>
            {busy ? MENU_WORDS.saving : MENU_WORDS.save}
          </Button>
          <Button variant="secondary" data-testid="menu-cancel" onClick={closeEditor}>
            {MENU_WORDS.cancel}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
