'use client';
import { DEFAULT_MENU, menuOf, sameMenu, storedMenu, type Menu } from '@hfos/core';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { toast } from 'sonner';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';

const CHANGED = 'hfos:my-settings-changed';

/** Tells the menu that the person's own settings were saved from elsewhere on the page (the Assistant). */
export function mySettingsChanged(): void {
  window.dispatchEvent(new Event(CHANGED));
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

/**
 * The person's own side menu. Seeded from their settings on the server, so the
 * first paint is already their menu; a save sends `settings.menu` whole (user.update_profile replaces a top-level
 * key) and every menu on the page — the sidebar, the phone's drawer and the editor — follows at once. It reads
 * the saved menu again when the Assistant changes their settings, and before every save, so a menu saved
 * elsewhere is never overwritten with an older one. The editor itself (menu-editor.tsx) is rendered by the
 * workspace layout inside this provider.
 */
export function MenuProvider({ settings, children }: { settings: unknown; children: ReactNode }) {
  const [menu, setMenu] = useState<Menu>(() => menuOf(settings));
  const [editorOpen, setEditorOpen] = useState(false);

  /** The menu as saved now, drawn if it differs. */
  const reload = useCallback(async () => {
    const me = unwrap(await apiBrowser().POST('/v1/queries/account.me', { body: {} }));
    const saved = menuOf(me.user.settings);
    setMenu((now) => (sameMenu(now, saved) ? now : saved));
    return saved;
  }, []);

  useEffect(() => {
    // The next page load reads it anyway, so a failed read changes nothing here.
    const onChanged = () => void reload().catch(() => undefined);
    window.addEventListener(CHANGED, onChanged);
    return () => window.removeEventListener(CHANGED, onChanged);
  }, [reload]);

  const save = useCallback(
    async (next: Menu) => {
      const before = menu;
      if (sameMenu(before, next)) return true;
      let saved: Menu;
      try {
        saved = await reload();
      } catch (e) {
        toast.error(errorMessage(e));
        throw e;
      }
      // Saved from the Assistant or another device since this menu was drawn: the whole menu is replaced on
      // save, so saving now would undo that.
      if (!sameMenu(saved, before)) return false;
      setMenu(next);
      try {
        unwrap(
          await apiBrowser().POST('/v1/commands/user.update_profile', {
            body: { settings: { menu: storedMenu(next) } },
          }),
        );
        return true;
      } catch (e) {
        setMenu(before);
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
