import js from '@eslint/js';
import tseslint from 'typescript-eslint';

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
    // `Promise.all([unwrap(await a), unwrap(await b)])` waits for a before it even sends b. Pass the promises.
    // (Matched from any cwd: packages lint with this config from their own directory.)
    files: ['**/*.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...[
          'ArrayExpression > AwaitExpression',
          'ArrayExpression > CallExpression > AwaitExpression',
          'ArrayExpression > ConditionalExpression > AwaitExpression',
          'ArrayExpression > ConditionalExpression > CallExpression > AwaitExpression',
        ].map((path) => ({
          selector: `CallExpression[callee.object.name='Promise'][callee.property.name='all'] > ${path}`,
          message:
            'An await inside Promise.all([...]) runs the calls one after another. Pass the promise (e.g. `api.POST(...).then(unwrap)`).',
        })),
      ],
    },
  },
);
