/**
 * Unit tests for the app: the kit's own components and the rules for signing in, locking and keeping businesses.
 * jest-expo stays on Jest 29 (expo/expo#48808). pnpm keeps packages under node_modules/.pnpm, so the packages
 * shipped as untranspiled ES modules are named here for Babel to transform.
 * @type {import('jest').Config}
 */
module.exports = {
  preset: 'jest-expo',
  setupFiles: ['<rootDir>/jest.setup.ts'],
  testMatch: ['<rootDir>/src/**/__tests__/**/*.test.ts?(x)'],
  transformIgnorePatterns: [
    '/node_modules/(?!(\\.pnpm|react-native|@react-native|@react-native-community|expo|@expo|@expo-google-fonts|react-navigation|@react-navigation|standard-navigation|@rn-primitives|lucide-react-native|uniwind|culori|@supabase|openapi-fetch|zustand))',
    '/node_modules/react-native-reanimated/plugin/',
    '/node_modules/@react-native/babel-preset/',
  ],
  moduleNameMapper: {
    // The per-icon imports resolve to ES modules under the react-native condition; Jest takes the CommonJS build.
    '^lucide-react-native/icons/(.*)$':
      '<rootDir>/node_modules/lucide-react-native/dist/cjs/icons/$1.js',
    '^@/assets/(.*)$': '<rootDir>/assets/$1',
    '^@/(.*)$': '<rootDir>/src/$1',
  },
};
