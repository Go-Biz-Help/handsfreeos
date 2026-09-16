/**
 * Stand-ins for the native parts the unit tests reach: Uniwind (styles come from Metro, which Jest doesn't run), secure
 * storage, the documents folder, signal, Face ID and safe areas. Each keeps state in memory so a test can read what
 * the app wrote.
 */

// Where a test build points (the tests never reach them).
process.env.EXPO_PUBLIC_SUPABASE_URL = 'http://supabase.test';
process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_test';
process.env.EXPO_PUBLIC_API_URL = 'http://api.test';

jest.mock('uniwind', () => ({
  Uniwind: { setTheme: jest.fn(), currentTheme: 'light' },
  useUniwind: () => ({ theme: 'light', hasAdaptiveThemes: true }),
  useCSSVariable: () => undefined,
  useResolveClassNames: () => ({}),
  withUniwind: (component: unknown) => component,
}));

jest.mock('expo-secure-store', () => {
  const values = new Map<string, string>();
  return {
    AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 3,
    getItemAsync: jest.fn(async (key: string) => values.get(key) ?? null),
    setItemAsync: jest.fn(async (key: string, value: string) => void values.set(key, value)),
    deleteItemAsync: jest.fn(async (key: string) => void values.delete(key)),
    __values: values,
  };
});

jest.mock('expo-file-system', () => {
  const files = new Map<string, string>();
  class File {
    readonly uri: string;
    constructor(...parts: (string | { uri: string })[]) {
      this.uri = parts.map((p) => (typeof p === 'string' ? p : p.uri)).join('/');
    }
    get exists() {
      return files.has(this.uri);
    }
    textSync() {
      return files.get(this.uri) ?? '';
    }
    create() {
      files.set(this.uri, '');
    }
    write(text: string) {
      files.set(this.uri, text);
    }
    delete() {
      files.delete(this.uri);
    }
  }
  return { File, Paths: { document: { uri: 'file:///documents' } }, __files: files };
});

jest.mock('expo-network', () => ({
  addNetworkStateListener: jest.fn(() => ({ remove: jest.fn() })),
  getNetworkStateAsync: jest.fn(async () => ({ isConnected: true, isInternetReachable: true })),
}));

jest.mock('expo-local-authentication', () => ({
  AuthenticationType: { FINGERPRINT: 1, FACIAL_RECOGNITION: 2, IRIS: 3 },
  SecurityLevel: { NONE: 0, SECRET: 1, BIOMETRIC_WEAK: 2, BIOMETRIC_STRONG: 3 },
  getEnrolledLevelAsync: jest.fn(async () => 3),
  supportedAuthenticationTypesAsync: jest.fn(async () => [2]),
  authenticateAsync: jest.fn(async () => ({ success: true })),
}));

jest.mock(
  'react-native-safe-area-context',
  () =>
    (jest.requireActual('react-native-safe-area-context/jest/mock') as { default: object }).default,
);
