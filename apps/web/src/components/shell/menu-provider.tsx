'use client';
import { DEFAULT_MENU, menuOf, sameMenu, storedMenu, type Menu } from '@hfos/core';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { toast } from 'sonner';
import { ApiError, apiBrowser, errorMessage, unwrap } from '@/lib/api/client';

export const MY_SETTINGS_CHANGED = 'hfos:my-settings-changed';

/**
 * Tells the menu and the theme that the person's own settings were saved from elsewhere on the page (the
 * Assistant).
 */
export function mySettingsChanged(): void {
  window.dispatchEvent(new Event(MY_SETTINGS_CHANGED));
}

interface MenuValue {
  /** The menu as it is drawn now. */
  readonly menu: Menu;
  /**
   * Save an arrangement made on the menu as drawn now: the sidebar changes at once, and goes back if the save is
   * refused. False, with nothing saved, when a newer menu was saved in the meantime; that one is drawn instead.
   */
  readonly save: (next: Menu) => Promise<boolean>;
  readonly editorOpen: boolean;
  readonly openEditor: () => void;
  readonly closeEditor: () => void;
}

const MenuContext = createContext<MenuValue>({
  menu: DEFAULT_MENU,
  save: async () => false,
  editorOpen: false,
  openEditor: () => {},
  closeEditor: () => {},
});

export const useMenu = (): MenuValue => useContext(MenuContext);

/** `settings.menu` exactly as saved, or null when the person never arranged it. */
const savedMenuOf = (settings: unknown): unknown =>
  typeof settings === 'object' && settings !== null && !Array.isArray(settings)
    ? ((settings as Record<string, unknown>)['menu'] ?? null)
    : null;

/**
 * The person's own side menu. Seeded from their settings on the server, so the
 * first paint is already their menu; a save sends `settings.menu` whole (user.update_profile replaces a top-level
 * key) and every menu on the page — the sidebar, the phone's drawer and the editor — follows at once. It reads
 * the saved menu again when the Assistant changes their settings. Each save also says which saved menu it was
 * arranged on, and the server refuses it if a newer one was saved elsewhere since, so an older menu never
 * overwrites it. The editor itself (menu-editor.tsx) is rendered by the workspace layout inside this provider.
 */
export function MenuProvider({ settings, children }: { settings: unknown; children: ReactNode }) {
  const [menu, setMenu] = useState<Menu>(() => menuOf(settings));
  const [editorOpen, setEditorOpen] = useState(false);
  // What the drawn menu was read from, exactly as saved: the save sends it back for the server to check.
  const savedAs = useRef<unknown>(savedMenuOf(settings));

  /** The menu as saved now, drawn if it differs. */
  const reload = useCallback(async () => {
    const me = unwrap(await apiBrowser().POST('/v1/queries/account.me', { body: {} }));
    savedAs.current = savedMenuOf(me.user.settings);
    const saved = menuOf(me.user.settings);
    setMenu((now) => (sameMenu(now, saved) ? now : saved));
    return saved;
  }, []);

  useEffect(() => {
    // The next page load reads it anyway, so a failed read changes nothing here.
    const onChanged = () => void reload().catch(() => undefined);
    window.addEventListener(MY_SETTINGS_CHANGED, onChanged);
    return () => window.removeEventListener(MY_SETTINGS_CHANGED, onChanged);
  }, [reload]);

  const save = useCallback(
    async (next: Menu) => {
      const before = menu;
      if (sameMenu(before, next)) return true;
      const stored = storedMenu(next);
      setMenu(next);
      try {
        unwrap(
          await apiBrowser().POST('/v1/commands/user.update_profile', {
            body: { settings: { menu: stored }, expectedSettings: { menu: savedAs.current } },
          }),
        );
        savedAs.current = stored;
        return true;
      } catch (e) {
        setMenu(before);
        // Saved from the Assistant or another device since this menu was drawn: nothing was saved, and that
        // menu is drawn instead.
        if (e instanceof ApiError && e.rule === 'settings_changed') {
          try {
            await reload();
            return false;
          } catch (again) {
            toast.error(errorMessage(again));
            throw again;
          }
        }
        toast.error(errorMessage(e));
        throw e;
      }
    },
    [menu, reload],
  );

  const value = useMemo<MenuValue>(
    () => ({
      menu,
      save,
      editorOpen,
      openEditor: () => setEditorOpen(true),
      closeEditor: () => setEditorOpen(false),
    }),
    [menu, save, editorOpen],
  );

  return <MenuContext.Provider value={value}>{children}</MenuContext.Provider>;
}
