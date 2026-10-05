/**
 * Stand-ins for the native parts the unit tests reach: Uniwind (styles come from Metro, which Jest doesn't run), secure
 * storage, the documents folder, the microphone and speaker, signal, Face ID, safe areas, random bytes, taking and
 * shrinking photos, playing videos, the backups and phone modules, notifications and the background task manager, and op-sqlite and PowerSync's React Native module (the copy's rules are tested through `PhoneCopy` with a
 * stand-in database, and the queue's on Node's own SQLite; PowerSync's own `@powersync/common` is real). Each keeps state
 * in memory so a test can read what the app wrote.
 */

// Where a test build points (the tests never reach them).
process.env.EXPO_PUBLIC_SUPABASE_URL = 'http://supabase.test';
process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_test';
process.env.EXPO_PUBLIC_API_URL = 'http://api.test';
process.env.EXPO_PUBLIC_SYNC_URL = 'http://sync.test';

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
  class Directory {
    readonly uri: string;
    constructor(...parts: (string | { uri: string })[]) {
      this.uri = parts.map((p) => (typeof p === 'string' ? p : p.uri)).join('/');
    }
    get exists() {
      return false;
    }
    create() {}
    list() {
      return [];
    }
    delete() {}
  }
  return {
    File,
    Directory,
    UploadType: { BINARY_CONTENT: 0, MULTIPART: 1 },
    Paths: { document: { uri: 'file:///documents' }, cache: { uri: 'file:///cache' } },
    __files: files,
  };
});

// The microphone and the speaker, for talking out loud. The recorder's meter reads whatever `__recorder.meter` says for
// the moment since recording started (dBFS), and a clip that plays says it finished a moment later.
jest.mock('expo-audio', () => {
  let recordings = 0;
  const recorder = {
    uri: null as string | null,
    recording: false,
    startedAt: 0,
    meter: (_ms: number): number => -160,
    prepareToRecordAsync: jest.fn(async () => undefined),
    record: jest.fn(() => {
      recorder.recording = true;
      recorder.startedAt = Date.now();
      recorder.uri = `file:///cache/recording-${++recordings}.m4a`;
    }),
    stop: jest.fn(async () => {
      recorder.recording = false;
    }),
    getStatus: () => ({
      canRecord: true,
      isRecording: recorder.recording,
      durationMillis: Date.now() - recorder.startedAt,
      mediaServicesDidReset: false,
      metering: recorder.recording ? recorder.meter(Date.now() - recorder.startedAt) : undefined,
      url: recorder.uri,
    }),
  };
  const played: string[] = [];
  type MockListener = (mockStatus: { didJustFinish: boolean }) => void;
  class Player {
    private readonly listeners = new Set<MockListener>();
    readonly source: { uri?: string } | null;
    constructor(mockSource: { uri?: string } | null) {
      this.source = mockSource;
    }
    addListener(_event: string, fn: MockListener) {
      this.listeners.add(fn);
      return { remove: () => this.listeners.delete(fn) };
    }
    play() {
      if (this.source?.uri) played.push(this.source.uri);
      setTimeout(() => {
        for (const fn of [...this.listeners]) fn({ didJustFinish: true });
      }, 5);
    }
    pause() {}
    remove() {}
  }
  const preset = {
    extension: '.m4a',
    sampleRate: 44100,
    numberOfChannels: 2,
    bitRate: 128000,
    android: { outputFormat: 'mpeg4', audioEncoder: 'aac' },
    ios: { outputFormat: 'aac ', audioQuality: 127 },
    web: { mimeType: 'audio/webm', bitsPerSecond: 128000 },
  };
  return {
    RecordingPresets: { HIGH_QUALITY: preset, LOW_QUALITY: preset },
    useAudioRecorder: () => recorder,
    createAudioPlayer: jest.fn((mockSource: { uri?: string } | null) => new Player(mockSource)),
    useAudioPlayer: jest.fn(() => new Player(null)),
    useAudioPlayerStatus: jest.fn(() => ({
      playing: false,
      isLoaded: false,
      currentTime: 0,
      duration: 0,
    })),
    requestRecordingPermissionsAsync: jest.fn(async () => ({
      granted: true,
      status: 'granted',
      canAskAgain: true,
      expires: 'never',
    })),
    setAudioModeAsync: jest.fn(async () => undefined),
    __recorder: recorder,
    __played: played,
  };
});

// Playing a video (the inbox's viewer): a player that plays whatever it's given, or, with `__videos.playable` false,
// one that can't (an iPhone handed a carrier's 3GP). `__videos.played` is every video asked to play.
jest.mock('expo-video', () => {
  const React = jest.requireActual('react') as {
    useState: <T>(init: () => T) => [T, unknown];
    createElement: (type: unknown, props: object) => unknown;
  };
  const { View } = jest.requireActual('react-native') as { View: unknown };
  const videos = { playable: true, played: [] as string[] };
  type MockStatusListener = (mockEvent: { status: string }) => void;
  class Player {
    status = 'loading';
    private readonly listeners = new Set<MockStatusListener>();
    readonly source: string;
    constructor(mockSource: string) {
      this.source = mockSource;
    }
    addListener(_event: string, fn: MockStatusListener) {
      this.listeners.add(fn);
      return { remove: () => this.listeners.delete(fn) };
    }
    play() {
      videos.played.push(this.source);
      setTimeout(() => {
        this.status = videos.playable ? 'readyToPlay' : 'error';
        for (const fn of [...this.listeners]) fn({ status: this.status });
      }, 5);
    }
    pause() {}
    release() {}
  }
  return {
    useVideoPlayer: (mockSource: string, setup?: (player: Player) => void) => {
      const [player] = React.useState(() => {
        const made = new Player(mockSource);
        setup?.(made);
        return made;
      });
      return player;
    },
    VideoView: (props: { testID?: string; accessibilityLabel?: string }) =>
      React.createElement(View, {
        testID: props.testID,
        accessibilityLabel: props.accessibilityLabel,
      }),
    __videos: videos,
  };
});

jest.mock('expo-image-picker', () => ({
  requestCameraPermissionsAsync: jest.fn(async () => ({ granted: true })),
  launchCameraAsync: jest.fn(async () => ({ canceled: true, assets: null })),
  launchImageLibraryAsync: jest.fn(async () => ({ canceled: true, assets: null })),
}));

jest.mock('expo-image-manipulator', () => ({
  ImageManipulator: { manipulate: jest.fn() },
  SaveFormat: { JPEG: 'jpeg', PNG: 'png', WEBP: 'webp' },
}));

jest.mock('./modules/hfos-backup', () => ({
  __esModule: true,
  default: {
    keepOutOfBackups: jest.fn(() => true),
    isKeptOutOfBackups: jest.fn(() => true),
    appBackupAllowed: jest.fn(() => false),
  },
}));

jest.mock('./modules/hfos-phone', () => ({
  __esModule: true,
  default: {
    isDeviceLocked: jest.fn(() => false),
    openInBrowser: jest.fn(async () => true),
    addContact: jest.fn(async () => 'added'),
  },
}));

jest.mock('expo-notifications', () => {
  const presented: { identifier: string; content: unknown; trigger: unknown }[] = [];
  const categories = new Map<string, unknown[]>();
  return {
    AndroidImportance: { MAX: 7, HIGH: 6, DEFAULT: 5 },
    DEFAULT_ACTION_IDENTIFIER: 'expo.modules.notifications.actions.DEFAULT',
    setNotificationHandler: jest.fn(),
    setNotificationChannelAsync: jest.fn(async () => null),
    setNotificationCategoryAsync: jest.fn(async (id: string, actions: unknown[]) => {
      categories.set(id, actions);
      return { identifier: id, actions };
    }),
    getNotificationCategoriesAsync: jest.fn(async () =>
      [...categories].map(([identifier, actions]) => ({ identifier, actions })),
    ),
    getPermissionsAsync: jest.fn(async () => ({ status: 'granted', canAskAgain: true })),
    requestPermissionsAsync: jest.fn(async () => ({ status: 'granted', canAskAgain: true })),
    getExpoPushTokenAsync: jest.fn(async () => ({ type: 'expo', data: 'ExponentPushToken[test]' })),
    addPushTokenListener: jest.fn(() => ({ remove: jest.fn() })),
    addNotificationReceivedListener: jest.fn(() => ({ remove: jest.fn() })),
    addNotificationResponseReceivedListener: jest.fn(() => ({ remove: jest.fn() })),
    getLastNotificationResponse: jest.fn(() => null),
    clearLastNotificationResponse: jest.fn(),
    registerTaskAsync: jest.fn(async () => null),
    scheduleNotificationAsync: jest.fn(
      async (request: { identifier: string; content: unknown; trigger: unknown }) => {
        presented.push(request);
        return request.identifier;
      },
    ),
    // A notification set for later (a check-in's reminder) is kept with the shown ones, so a test sees what's set.
    SchedulableTriggerInputTypes: { DATE: 'date' },
    cancelScheduledNotificationAsync: jest.fn(async (identifier: string) => {
      const i = presented.findIndex((request) => request.identifier === identifier);
      if (i >= 0) presented.splice(i, 1);
    }),
    getPresentedNotificationsAsync: jest.fn(async () =>
      presented.map((request) => ({ date: 0, request })),
    ),
    dismissNotificationAsync: jest.fn(async () => undefined),
    dismissAllNotificationsAsync: jest.fn(async () => undefined),
    __presented: presented,
  };
});

jest.mock('expo-task-manager', () => ({
  defineTask: jest.fn(),
  isTaskDefined: jest.fn(() => false),
  isTaskRegisteredAsync: jest.fn(async () => false),
}));

// Location updates while a check-in follows the phone (safety/follow.ts): started and stopped, never delivered here.
jest.mock('expo-location', () => ({
  Accuracy: { Lowest: 1, Low: 2, Balanced: 3, High: 4, Highest: 5, BestForNavigation: 6 },
  ActivityType: { Other: 1 },
  startLocationUpdatesAsync: jest.fn(async () => undefined),
  stopLocationUpdatesAsync: jest.fn(async () => undefined),
  hasStartedLocationUpdatesAsync: jest.fn(async () => false),
  getForegroundPermissionsAsync: jest.fn(async () => ({ status: 'undetermined', granted: false })),
  requestForegroundPermissionsAsync: jest.fn(async () => ({ status: 'denied', granted: false })),
  getCurrentPositionAsync: jest.fn(async () => {
    throw new Error('No location in tests.');
  }),
}));

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

jest.mock('expo-crypto', () => {
  const { randomBytes } = jest.requireActual('node:crypto') as {
    randomBytes: (count: number) => Uint8Array;
  };
  const { randomUUID } = jest.requireActual('node:crypto') as { randomUUID: () => string };
  return { getRandomBytes: (count: number) => new Uint8Array(randomBytes(count)), randomUUID };
});

jest.mock('@op-engineering/op-sqlite', () => ({
  open: jest.fn(() => {
    throw new Error('op-sqlite is native: tests use a stand-in database');
  }),
  isSQLCipher: () => true,
  IOS_LIBRARY_PATH: '/library',
  ANDROID_DATABASE_PATH: '/databases/',
}));

jest.mock('@powersync/react-native', () => {
  const React = jest.requireActual('react') as { createContext: (value: unknown) => unknown };
  return {
    ...(jest.requireActual('@powersync/common') as object),
    PowerSyncDatabase: jest.fn(() => {
      throw new Error('PowerSync is native: tests use a stand-in database');
    }),
    PowerSyncContext: React.createContext(null),
    useQuery: jest.fn(() => ({ data: [], isLoading: false, isFetching: false })),
  };
});

jest.mock(
  'react-native-safe-area-context',
  () =>
    (jest.requireActual('react-native-safe-area-context/jest/mock') as { default: object }).default,
);
