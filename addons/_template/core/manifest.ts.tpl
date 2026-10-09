/**
 * __NAME__: its manifest (docs/addon-architecture.md). Browser-safe: the screens, the API, the worker and the AI
 * all read it, so it holds no server code. Everything it declares starts with its id, `__ID__`.
 *
 * It starts in `development`: offered nowhere and installable nowhere. Move it to `beta` (HandsFreeOS staff can hand
 * it to a business), then `available` (anyone who manages add-ons can install it) as it's ready.
 */
import { defineAddon } from '../manifest';

export const __CONST__ = defineAddon({
  id: '__ID__',
  name: '__NAME__',
  summary: '__SUMMARY__',
  description: '__SUMMARY__',
  category: '__CATEGORY__',
  version: '0.1.0',
  // One more whenever its data changes shape; the worker brings each business's data up a step at a time
  // (apps/worker/src/addons/__ID__/index.ts, `dataMigrations`).
  dataVersion: 1,
  catalog: {
    status: 'development',
    // The words someone uses when they need it: what recommendations and the AI's search match on.
    keywords: ['__ID__'],
  },
  capabilities: [
    {
      id: '__ID__.use',
      label: '__NAME__',
      description: '__SUMMARY__',
      permission: '__ID__.use',
    },
  ],
  // Exist only while it runs in a business. Its migration registers the same list (the parity test checks).
  permissions: [
    {
      key: '__ID__.use',
      label: 'Use __NAME__',
      description: 'Everything __NAME__ does.',
      defaultRoles: ['admin', 'member'],
    },
  ],
  billing: { model: 'free' },
  // Its pages. The side menu shows the add-on as one row, named after it, that these open from (one page: straight
  // there), only while it runs and to people who may open them.
  ui: { nav: [{ key: '__ID__', label: '__NAME__', icon: 'box', path: '' }] },
  ai: { directory: '__DIRECTORY__' },
});
