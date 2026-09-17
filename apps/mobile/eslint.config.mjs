import root from '../../eslint.config.js';

export default [
  ...root,
  // Generated: the native projects (prebuild), Expo's cache and Uniwind's class-name types.
  { ignores: ['ios/**', 'android/**', '.expo/**', 'src/uniwind-types.d.ts'] },
  {
    // Metro loads its config as CommonJS.
    files: ['*.config.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { require: 'readonly', module: 'writable', __dirname: 'readonly' },
    },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    // Maestro runs these scripts itself, with its own globals and the flow's env as variables.
    files: ['maestro/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: {
        http: 'readonly',
        json: 'readonly',
        output: 'writable',
        maestro: 'readonly',
        EMAIL: 'readonly',
        MAILPIT_URL: 'readonly',
        FROM: 'readonly',
        BODY: 'readonly',
        TO: 'readonly',
        WORKER_URL: 'readonly',
        SIGNED_URL: 'readonly',
      },
    },
  },
];
