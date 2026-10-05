import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { BUILT_ADDONS } from '@hfos/core';

import { ADDON_SCREENS } from '../addon-screens';

/**
 * Every add-on screen the build says it draws is one its add-on declares (`ui.phone`), and has its route file, inside
 * More (`app/app/w/[workspaceId]/(tabs)/(more)/a/<id>/…`), so a link never opens a screen that isn't there.
 */

const MORE = join(__dirname, '..', '..', 'app', 'app', 'w', '[workspaceId]', '(tabs)', '(more)');

/** `a/realestate/deals/:dealId` → `a/realestate/deals/[dealId]`. */
const fileOf = (route: string) => route.replace(/:([A-Za-z]+)/g, '[$1]');

describe('the add-on screens this build draws', () => {
  it('are each declared by their add-on and have their screen', () => {
    for (const route of ADDON_SCREENS) {
      const [, addonId, ...page] = route.split('/');
      const declared = BUILT_ADDONS.find((m) => m.id === addonId)?.ui?.phone ?? [];
      expect([route, declared.map((p) => p.path).includes(page.join('/'))]).toEqual([route, true]);
      const base = join(MORE, fileOf(route));
      expect([route, existsSync(`${base}.tsx`) || existsSync(join(base, 'index.tsx'))]).toEqual([
        route,
        true,
      ]);
    }
  });

  it('starts every route at an add-on', () => {
    for (const route of ADDON_SCREENS) expect(route).toMatch(/^a\/[a-z]+(\/|$)/);
  });
});
