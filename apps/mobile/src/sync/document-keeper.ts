import { ADDON_CATALOG } from '@hfos/core';
import type { AbstractPowerSyncDatabase } from '@powersync/common';
import { useQuery } from '@powersync/react-native';
import * as Crypto from 'expo-crypto';
import { Directory, File, Paths } from 'expo-file-system';
import * as React from 'react';
import { AppState } from 'react-native';

import { api, unwrap } from '@/lib/api';
import { deviceStore } from '@/lib/device-store';
import { appFetch, isTestOffline, networkSnapshot, subscribeNetwork } from '@/lib/network';
import { signedUrl } from '@/inbox/storage';
import HfosPhone from '../../modules/hfos-phone';

import {
  DOCUMENT_LIMIT_BYTES,
  keepDocuments,
  type FetchRange,
  type FileRow,
  type KeeperDeps,
  type PhoneRow,
} from './kept-documents';
import { documentName, type KeptFile } from './kept-files';
import { keptStore } from './kept-store';

/**
 * Keeps the documents an add-on's phone rows bring (`kept-documents.ts`) on this phone: whenever the person's copy
 * opens or its rows or files change, signal comes back, or they change what they allow. One run at a time; asked again
 * while running, it runs once more after. Opening one writes a decrypted copy to the cache for the phone's viewer and
 * deletes it as soon as it's closed (iPhone), or when the app is back in front (Android).
 */

const MOBILE_DATA_KEY = 'files.mobileData';

/** What the kept documents are now changes after each run, a pin, and the person's store opening or closing. */
let version = 0;
const changeListeners = new Set<() => void>();
function changed() {
  version++;
  for (const listener of changeListeners) listener();
}
keptStore.subscribe(changed);
const subscribeKept = (listener: () => void) => {
  changeListeners.add(listener);
  return () => void changeListeners.delete(listener);
};
const keptVersion = () => version;

function useKeptChanges(): number {
  return React.useSyncExternalStore(subscribeKept, keptVersion, keptVersion);
}

/** A document as the phone keeps it (complete or still coming), redrawn as it changes. */
export function useKeptDocument(fileId: string | null | undefined): KeptFile | null {
  useKeptChanges();
  return fileId ? (keptStore.current()?.info(documentName(fileId)) ?? null) : null;
}

/** How much the kept documents take, redrawn as it changes. */
export function useKeptDocumentBytes(): number {
  useKeptChanges();
  return keptStore.current()?.usedBytes('document') ?? 0;
}
const OPEN_FOLDER = 'hfos-open';

/** Whether the person lets documents download on mobile data (off: Wi-Fi only). */
export function mobileDataAllowed(): boolean {
  return deviceStore.get<boolean>(MOBILE_DATA_KEY) === true;
}

export function setMobileDataAllowed(allowed: boolean): void {
  if (allowed) deviceStore.set(MOBILE_DATA_KEY, true);
  else deviceStore.remove(MOBILE_DATA_KEY);
  documentKeeper.soon();
}

export function useMobileDataAllowed(): boolean {
  return React.useSyncExternalStore(deviceStore.subscribe, mobileDataAllowed, mobileDataAllowed);
}

/** The add-ons that keep files, the tables those come from and the columns naming them: only those are read. */
const FILE_SOURCES = ADDON_CATALOG.flatMap((m) =>
  (m.offline?.files ?? []).map((f) => ({ addonId: m.id, table: f.table, column: f.column })),
);

const SOURCES_JSON = JSON.stringify(FILE_SOURCES.map((s) => `${s.addonId}.${s.table}`));

/** Whether this business brings documents to keep on the phone (or the phone keeps some): Settings shows the switch. */
export function useKeepsDocuments(workspaceId: string): boolean {
  const { data } = useQuery<{ n: number }>(
    `SELECT count(*) AS n FROM addon_phone_rows
     WHERE workspace_id = ? AND (addon_id || '.' || source) IN (SELECT value FROM json_each(?))`,
    [workspaceId, SOURCES_JSON],
  );
  const used = useKeptDocumentBytes();
  return used > 0 || Number(data[0]?.n ?? 0) > 0;
}

async function readCopy(
  db: AbstractPowerSyncDatabase,
): Promise<{ rows: PhoneRow[]; files: FileRow[] }> {
  if (!FILE_SOURCES.length) return { rows: [], files: [] };
  const rows = await db.getAll<PhoneRow>(
    `SELECT workspace_id, addon_id, source, data FROM addon_phone_rows
     WHERE (addon_id || '.' || source) IN (SELECT value FROM json_each(?))`,
    [SOURCES_JSON],
  );
  const ids = new Set<string>();
  for (const row of rows)
    try {
      const data = JSON.parse(row.data ?? '{}') as Record<string, unknown>;
      for (const s of FILE_SOURCES)
        if (
          s.addonId === row.addon_id &&
          s.table === row.source &&
          typeof data[s.column] === 'string'
        )
          ids.add(data[s.column] as string);
    } catch {
      // A row that isn't JSON brings nothing.
    }
  const files = ids.size
    ? await db.getAll<FileRow>(
        `SELECT id, workspace_id, bucket, object_path, name, mime_type, size_bytes, status, locked_at FROM files
         WHERE id IN (SELECT value FROM json_each(?))`,
        [JSON.stringify([...ids])],
      )
    : [];
  return { rows, files };
}

const fetchRange: FetchRange = async (url, start, end) => {
  try {
    const response = await appFetch(url, { headers: { range: `bytes=${start}-${end}` } });
    return { status: response.status, bytes: new Uint8Array(await response.arrayBuffer()) };
  } catch {
    return null;
  }
};

const hex = (buffer: ArrayBuffer) =>
  Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, '0')).join('');

class DocumentKeeper {
  private db: AbstractPowerSyncDatabase | null = null;
  private stopWatching: (() => void) | null = null;
  private running: Promise<void> | null = null;
  private again = false;
  private started = false;

  private deps(): KeeperDeps {
    return {
      kept: () => keptStore.current(),
      read: async () => (this.db ? readCopy(this.db) : null),
      catalog: ADDON_CATALOG,
      mayDownload: () => {
        const net = networkSnapshot();
        return net.online && !isTestOffline() && (net.wifi || mobileDataAllowed());
      },
      signedUrl,
      fetchRange,
      fingerprints: async (workspaceId, fileIds) => {
        const out = unwrap(
          await api.POST('/v1/queries/file.fingerprints', {
            body: { workspaceId, fileIds: [...fileIds] },
          }),
        );
        return new Map(out.files.map((f) => [f.id, f.sha256]));
      },
      sha256: async (bytes) =>
        hex(
          await Crypto.digest(
            Crypto.CryptoDigestAlgorithm.SHA256,
            bytes as Uint8Array<ArrayBuffer>,
          ),
        ),
      log: (message, error) => console.warn(message, error),
    };
  }

  /** Follows signal and the app coming back from now on. */
  start(): void {
    if (this.started) return;
    this.started = true;
    subscribeNetwork(() => this.soon());
    AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        removeOpenedCopies();
        this.soon();
      }
    });
    removeOpenedCopies();
  }

  /** The person's copy opened: watch its rows and files. */
  opened(db: AbstractPowerSyncDatabase): void {
    this.closed();
    this.db = db;
    this.stopWatching = db.onChangeWithCallback(
      { onChange: () => this.soon() },
      { tables: ['addon_phone_rows', 'files'], throttleMs: 5_000 },
    );
    this.soon();
  }

  closed(): void {
    this.stopWatching?.();
    this.stopWatching = null;
    this.db = null;
  }

  /** Runs now, or once more after the run going on. */
  soon(): void {
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = (async () => {
      do {
        this.again = false;
        await keepDocuments(this.deps()).catch((error: unknown) =>
          console.warn('Keeping documents on the phone', error),
        );
        changed();
      } while (this.again);
    })().finally(() => {
      this.running = null;
    });
  }
}

export const documentKeeper = new DocumentKeeper();

export { DOCUMENT_LIMIT_BYTES };

/** A kept document, if the phone has all of it. */
export function keptDocument(fileId: string): KeptFile | null {
  const info = keptStore.current()?.info(documentName(fileId)) ?? null;
  return info?.complete ? info : null;
}

/** Keeps a document whatever the limit, while its deal is on the phone (or lets it go back to the usual rules). */
export function pinDocument(fileId: string, pinned: boolean): void {
  const kept = keptStore.current();
  if (!kept) return;
  const name = documentName(fileId);
  if (kept.info(name)) kept.setPinned(name, pinned);
  else if (pinned) kept.reserve(name, 'document', { fileId, pinned: true });
  changed();
  documentKeeper.soon();
}

const openFolder = () => new Directory(Paths.cache, OPEN_FOLDER);
const trimmed = (uri: string) => uri.replace(/\/+$/, '');
/** The copies a viewer inside the app has open now (Quick Look): never deleted under it. */
const showing = new Set<string>();

/** Deletes every decrypted copy left for a viewer, except one on screen now. */
export function removeOpenedCopies(): void {
  try {
    const folder = openFolder();
    if (!folder.exists) return;
    for (const entry of folder.list()) if (!showing.has(trimmed(entry.uri))) entry.delete();
  } catch {
    // Nothing there.
  }
}

/** A name the viewer shows, safe as a file name. */
const safeName = (name: string | null, fileId: string) =>
  (name ?? fileId).replace(/[^\p{L}\p{N} ._()-]+/gu, '_').slice(0, 120) || fileId;

/**
 * Opens a kept document: a decrypted copy in the cache for the phone's viewer, deleted once it's closed. False when
 * the phone doesn't have all of it, or nothing on the phone can show it.
 */
export async function openKeptDocument(fileId: string): Promise<boolean> {
  const kept = keptStore.current();
  const info = keptDocument(fileId);
  const bytes = info ? kept?.read(info.name) : null;
  if (!kept || !info || !bytes) return false;
  kept.touch(info.name);
  const folder = new Directory(openFolder(), Crypto.randomUUID());
  folder.create({ intermediates: true, idempotent: true });
  const copy = new File(folder, safeName(info.fileName, fileId));
  copy.write(bytes);
  let shown: 'closed' | 'opened' | 'unavailable' = 'unavailable';
  showing.add(trimmed(folder.uri));
  try {
    shown = await HfosPhone.viewFile(copy.uri, info.mimeType ?? 'application/octet-stream');
  } finally {
    showing.delete(trimmed(folder.uri));
    // iPhone says when it's closed; Android doesn't, so its copy goes when the app is back in front.
    if (shown !== 'opened') folder.delete();
  }
  return shown !== 'unavailable';
}
