'use client';
import { DEFAULT_MENU, menuOf, sameMenu, storedMenu, type Menu } from '@hfos/core';
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';

interface MenuValue {
  /** The menu as it is drawn now. */
  readonly menu: Menu;
  /** Save an arrangement: the sidebar changes at once, and goes back if the save is refused. */
  readonly save: (next: Menu) => Promise<void>;
  readonly editorOpen: boolean;
  readonly openEditor: () => void;
  readonly closeEditor: () => void;
}

const MenuContext = createContext<MenuValue>({
  menu: DEFAULT_MENU,
  save: async () => {},
  editorOpen: false,
  openEditor: () => {},
  closeEditor: () => {},
});

export const useMenu = (): MenuValue => useContext(MenuContext);

/**
 * The person's own side menu. Seeded from their settings on the server, so the
 * first paint is already their menu; a save sends `settings.menu` whole (user.update_profile replaces a top-level
 * key) and every menu on the page — the sidebar, the phone's drawer and the editor — follows at once. The editor
 * itself (menu-editor.tsx) is rendered by the workspace layout inside this provider.
 */
export function MenuProvider({ settings, children }: { settings: unknown; children: ReactNode }) {
  const [menu, setMenu] = useState<Menu>(() => menuOf(settings));
  const [editorOpen, setEditorOpen] = useState(false);

  const save = useCallback(
    async (next: Menu) => {
      const before = menu;
      if (sameMenu(before, next)) return;
      setMenu(next);
      try {
        unwrap(
          await apiBrowser().POST('/v1/commands/user.update_profile', {
            body: { settings: { menu: storedMenu(next) } },
          }),
        );
      } catch (e) {
        setMenu(before);
        toast.error(errorMessage(e));
        throw e;
      }
    },
    [menu],
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
