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
];
