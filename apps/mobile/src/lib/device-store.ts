import { File, Paths } from 'expo-file-system';

/**
 * Small settings this phone keeps that aren't secret: the appearance, which businesses each person keeps on the phone
 * and opened last, whether Face ID unlocks the app, and each person's list of businesses for when there's no signal.
 * One JSON file in the app's documents folder, read once and written on every change. It's deleted with the app,
 * which is also how the app notices a fresh install (see `secure-storage.ts`).
 */
export interface DeviceStore {
  get<T>(key: string): T | undefined;
  set(key: string, value: unknown): void;
  remove(key: string): void;
}

type Listener = () => void;

export function createDeviceStore(backend: {
  read(): string | null;
  write(text: string): void;
}): DeviceStore & { subscribe(listener: Listener): () => void } {
  let values: Record<string, unknown> | null = null;
  const listeners = new Set<Listener>();

  const load = (): Record<string, unknown> => {
    if (values) return values;
    try {
      const text = backend.read();
      const parsed: unknown = text ? JSON.parse(text) : {};
      values = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    } catch {
      // A damaged file starts again: nothing in it is precious.
      values = {};
    }
    return values;
  };
  const save = () => {
    backend.write(JSON.stringify(load()));
    for (const listener of listeners) listener();
  };

  return {
    get<T>(key: string) {
      return load()[key] as T | undefined;
    },
    set(key, value) {
      load()[key] = value;
      save();
    },
    remove(key) {
      if (!(key in load())) return;
      delete load()[key];
      save();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

const file = () => new File(Paths.document, 'handsfreeos-device.json');

export const deviceStore = createDeviceStore({
  read: () => {
    const f = file();
    return f.exists ? f.textSync() : null;
  },
  write: (text) => {
    const f = file();
    if (!f.exists) f.create();
    f.write(text);
  },
});
