import js from '@eslint/js';
import tseslint from 'typescript-eslint';

// `Promise.all([unwrap(await a), unwrap(await b)])` waits for a before it even sends b. Pass the promises.
const promiseAllAwaits = [
  'ArrayExpression > AwaitExpression',
  'ArrayExpression > CallExpression > AwaitExpression',
  'ArrayExpression > ConditionalExpression > AwaitExpression',
  'ArrayExpression > ConditionalExpression > CallExpression > AwaitExpression',
].map((path) => ({
  selector: `CallExpression[callee.object.name='Promise'][callee.property.name='all'] > ${path}`,
  message:
    'An await inside Promise.all([...]) runs the calls one after another. Pass the promise (e.g. `api.POST(...).then(unwrap)`).',
}));

// An add-on's screens and panels live in apps/web/src/addons/<id>/, and the rest of the web reaches them only
// through the web's registry of add-ons (apps/web/src/addons/registry.ts), which loads each one lazily and only
// while it runs: imported anywhere else, an add-on would ship to every business and leave something behind when
// it is turned off or taken out. The registry and the gate (addons/gate.tsx) sit beside the add-ons' folders.
const addonFolderImport = '^(?:@/|\\./|(?:\\.\\./)+)addons/(?!(?:registry|gate)$)[^/]+';
const addonFolderMessage =
  'Only the registry (apps/web/src/addons/registry.ts, apps/mobile/src/addons/registry.ts) imports from an add-on’s folder: put the panel in the registry and draw it with <AddonSlot> (on the phone, its place in More). Inside an add-on’s own folder, import its files relatively.';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/.turbo/**',
      '**/coverage/**',
      'design/**',
      'supabase/**',
      'packages/api-client/src/schema.d.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.mjs', '**/*.cjs', '**/scripts/**/*.js'],
    languageOptions: {
      globals: { console: 'readonly', process: 'readonly', URL: 'readonly', fetch: 'readonly' },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-restricted-syntax': [
        'error',
        {
          // Each `await` finishes before the next element is even built, so the requests run one after
          // another and the Promise.all does nothing: this put a customer's page at 14 round trips.
          selector:
            "CallExpression[callee.object.name='Promise'] > ArrayExpression CallExpression[callee.name=/^unwrap(Page)?$/] > AwaitExpression",
          message:
            'This await makes Promise.all run its requests one at a time. Write `api.POST(...).then(unwrap)` instead.',
        },
      ],
    },
  },
  {
    // (Matched from any cwd: packages lint with this config from their own directory.)
    files: ['**/*.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': ['error', ...promiseAllAwaits],
    },
  },
  {
    // Add-ons' UI (0108): the web's and the phone's screens, shell and helpers, and add-ons' folders themselves,
    // never import an add-on's folder, statically or with import(). An add-on's own pages are its code and may: the
    // web's app/app/w/[workspaceId]/a/<id>/, and the phone's, which sit in More so the tab bar stays
    // (app/app/w/[workspaceId]/(tabs)/(more)/a/<id>/, round six). Matched from any cwd too.
    files: [
      '**/src/app/**/*.{ts,tsx}',
      '**/src/components/**/*.{ts,tsx}',
      '**/src/lib/**/*.{ts,tsx}',
      '**/src/addons/*/**/*.{ts,tsx}',
    ],
    ignores: ['**/src/app/app/w/*/a/**', '**/src/app/app/w/*/(tabs)/(more)/a/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ regex: addonFolderImport, message: addonFolderMessage }] },
      ],
      'no-restricted-syntax': [
        'error',
        ...promiseAllAwaits,
        {
          // The same, for `import('…')`: esquery can't hold a slash in a pattern, so `.` stands for one.
          selector:
            'ImportExpression[source.value=/^(@.|\\..|(\\.\\..)+)addons.(?!(registry|gate)$)[a-z]/]',
          message: addonFolderMessage,
        },
      ],
    },
  },
);
