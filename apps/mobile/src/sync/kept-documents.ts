import type { AddonManifest } from '@hfos/core';

import { documentName, PIECE_BYTES, type KeptFile, type KeptFiles } from './kept-files';

/**
 * Documents kept on the phone (round seven, core; Chris 2026-10-05): the files an add-on's phone rows bring
 * (`offline.files`; Real Estate's current documents on the deals the person works), kept encrypted in their kept files
 * (`kept-files.ts`) so they open with no signal.
 *
 * - Downloaded on Wi-Fi, or on mobile data when the person allows it, a few megabytes at a time, so nothing big sits
 *   in memory and a download stopped halfway carries on.
 * - A signed (locked) file is checked against the fingerprint HandsFreeOS took when it arrived, and thrown away if it
 *   doesn't match.
 * - Up to 1 GB: pinned ones always, then the newest and the most recently opened; the rest aren't kept.
 * - A file goes when its row leaves the phone (the deal did) or stops asking for it (replaced, void), unless pinned
 *   while its deal is still here. Signing out removes them all (`kept-store.ts`).
 */

/** How much the phone keeps of documents. */
export const DOCUMENT_LIMIT_BYTES = 1024 * 1024 * 1024;
/** How much one download request asks for: a few pieces. */
export const DOWNLOAD_BYTES = 4 * PIECE_BYTES;

/** A phone row of an add-on's, as the copy holds it. */
export interface PhoneRow {
  readonly workspace_id: string;
  readonly addon_id: string;
  readonly source: string;
  readonly data: string | null;
}

/** A file's row in the copy. */
export interface FileRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly bucket: string;
  readonly object_path: string;
  readonly name: string | null;
  readonly mime_type: string | null;
  readonly size_bytes: number | null;
  readonly status: string | null;
  readonly locked_at: string | null;
}

export interface WantedFile {
  readonly workspaceId: string;
  readonly fileId: string;
  readonly bucket: string;
  readonly objectPath: string;
  readonly sizeBytes: number;
  readonly mimeType: string | null;
  readonly fileName: string | null;
  readonly locked: boolean;
}

const parse = (text: string | null): Record<string, unknown> => {
  try {
    const value: unknown = text ? JSON.parse(text) : null;
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

const wantedOf = (f: FileRow): WantedFile | null =>
  f.status === 'ready' && f.size_bytes !== null && Number(f.size_bytes) >= 0
    ? {
        workspaceId: f.workspace_id,
        fileId: f.id,
        bucket: f.bucket,
        objectPath: f.object_path,
        sizeBytes: Number(f.size_bytes),
        mimeType: f.mime_type,
        fileName: f.name,
        locked: f.locked_at !== null,
      }
    : null;

/**
 * What the phone's rows ask for: `wanted`, the files their add-ons' `offline.files` keep; and `present`, every file a
 * kept row names at all (current or not), which a pinned file needs to stay.
 */
export function filesAskedFor(
  catalog: readonly AddonManifest[],
  rows: readonly PhoneRow[],
  files: readonly FileRow[],
): { readonly wanted: WantedFile[]; readonly present: Map<string, WantedFile> } {
  const byId = new Map(files.map((f) => [f.id, f]));
  const wanted = new Map<string, WantedFile>();
  const present = new Map<string, WantedFile>();
  for (const row of rows) {
    const declared = catalog
      .find((m) => m.id === row.addon_id)
      ?.offline?.files?.filter((f) => f.table === row.source);
    if (!declared?.length) continue;
    const data = parse(row.data);
    for (const d of declared) {
      const fileId = data[d.column];
      if (typeof fileId !== 'string') continue;
      const file = byId.get(fileId);
      const w = file && file.workspace_id === row.workspace_id ? wantedOf(file) : null;
      if (!w) continue;
      present.set(fileId, w);
      const skipped = d.skip && d.skip.values.includes(String(data[d.skip.column] ?? ''));
      if (!skipped) wanted.set(fileId, w);
    }
  }
  return { wanted: [...wanted.values()], present };
}

export interface KeepPlan {
  /** Files to download, most wanted first. */
  readonly download: WantedFile[];
  /** Names of kept files to remove. */
  readonly remove: string[];
}

/**
 * What to download and what to let go: pinned files the rows still name come first and always stay; then, within the
 * limit, the most recently opened or kept, with files not here yet counted as newest (a new document on a deal is
 * likelier wanted than one nobody opened in weeks).
 */
export function planKept(input: {
  readonly wanted: readonly WantedFile[];
  readonly present: ReadonlyMap<string, WantedFile>;
  readonly kept: readonly KeptFile[];
  readonly limitBytes?: number;
}): KeepPlan {
  const limit = input.limitBytes ?? DOCUMENT_LIMIT_BYTES;
  const keptById = new Map(
    input.kept.filter((k) => k.kind === 'document' && k.fileId).map((k) => [k.fileId!, k]),
  );
  const candidates = new Map<string, { file: WantedFile; pinned: boolean; recency: number }>();
  for (const k of keptById.values())
    if (k.pinned && input.present.has(k.fileId!))
      candidates.set(k.fileId!, { file: input.present.get(k.fileId!)!, pinned: true, recency: 0 });
  for (const w of input.wanted) {
    if (candidates.has(w.fileId)) continue;
    const k = keptById.get(w.fileId);
    candidates.set(w.fileId, {
      file: w,
      pinned: false,
      recency: k?.complete ? Math.max(k.openedAt ?? 0, k.keptAt) : Number.POSITIVE_INFINITY,
    });
  }
  const ranked = [...candidates.values()].sort(
    (a, b) => Number(b.pinned) - Number(a.pinned) || b.recency - a.recency,
  );
  const kept = new Set<string>();
  let used = 0;
  for (const c of ranked) {
    if (!c.pinned && used + c.file.sizeBytes > limit) continue;
    kept.add(c.file.fileId);
    used += c.file.sizeBytes;
  }
  const remove = [...keptById.values()].filter((k) => !kept.has(k.fileId!)).map((k) => k.name);
  const download = ranked
    .filter((c) => kept.has(c.file.fileId) && !keptById.get(c.file.fileId)?.complete)
    .map((c) => c.file);
  return { download, remove };
}

/** What a download asks of Storage: one range of a file, by a link that's good for a while. */
export type FetchRange = (
  url: string,
  start: number,
  end: number,
) => Promise<{ readonly status: number; readonly bytes: Uint8Array } | null>;

export interface KeeperDeps {
  readonly kept: () => KeptFiles | null;
  /** The phone's rows and files, read from the open copy. */
  readonly read: () => Promise<{ rows: PhoneRow[]; files: FileRow[] } | null>;
  readonly catalog: readonly AddonManifest[];
  /** Whether downloading is allowed now: signal, and Wi-Fi unless the person allows mobile data. */
  readonly mayDownload: () => boolean;
  readonly signedUrl: (bucket: string, path: string) => Promise<string | null>;
  readonly fetchRange: FetchRange;
  /** The fingerprints HandsFreeOS took of these files, by id (null when it hasn't yet). */
  readonly fingerprints: (
    workspaceId: string,
    fileIds: readonly string[],
  ) => Promise<Map<string, string | null>>;
  readonly sha256: (bytes: Uint8Array) => Promise<string>;
  readonly limitBytes?: number;
  readonly log?: (message: string, error?: unknown) => void;
}

export type DownloadResult = 'kept' | 'later' | 'mismatch' | 'gone';

/** Downloads one file into the kept files, carrying on from what's already there. */
export async function downloadInto(
  kept: KeptFiles,
  file: WantedFile,
  deps: Pick<KeeperDeps, 'signedUrl' | 'fetchRange' | 'mayDownload'>,
): Promise<DownloadResult> {
  const name = documentName(file.fileId);
  const info = kept.info(name);
  if (!info || info.sizeBytes !== file.sizeBytes)
    kept.begin(name, 'document', file.sizeBytes, {
      workspaceId: file.workspaceId,
      fileId: file.fileId,
      mimeType: file.mimeType,
      fileName: file.fileName,
      pinned: info?.pinned ?? false,
    });
  if (kept.has(name)) return 'kept';
  const url = await deps.signedUrl(file.bucket, file.objectPath);
  if (!url) return 'gone';
  // Whole pieces only, so a stopped download carries on from the last piece that arrived.
  let offset = Math.floor(kept.storedBytes(name) / PIECE_BYTES) * PIECE_BYTES;
  while (offset < file.sizeBytes) {
    if (!deps.mayDownload()) return 'later';
    const end = Math.min(offset + DOWNLOAD_BYTES, file.sizeBytes) - 1;
    const got = await deps.fetchRange(url, offset, end);
    if (!got) return 'later';
    if (got.status === 404 || got.status === 400 || got.status === 403) return 'gone';
    if (got.status !== 206 && !(got.status === 200 && offset === 0)) return 'later';
    // A server that ignores the range sends it all: keep the part asked for.
    const part = got.status === 200 ? got.bytes.subarray(offset, end + 1) : got.bytes;
    if (part.length !== end - offset + 1) return 'later';
    kept.append(name, offset, part);
    offset = end + 1;
  }
  return kept.has(name) ? 'kept' : 'later';
}

/** Brings the kept documents in line with the phone's rows: removes, then downloads what's missing. */
export async function keepDocuments(deps: KeeperDeps): Promise<{
  readonly kept: number;
  readonly removed: number;
  readonly waiting: number;
}> {
  const kept = deps.kept();
  const copy = await deps.read();
  if (!kept || !copy) return { kept: 0, removed: 0, waiting: 0 };
  const asked = filesAskedFor(deps.catalog, copy.rows, copy.files);
  const plan = planKept({
    ...asked,
    kept: kept.list('document'),
    limitBytes: deps.limitBytes,
  });
  for (const name of plan.remove) kept.remove(name);
  let done = 0;
  let waiting = 0;
  for (const file of plan.download) {
    if (!deps.mayDownload()) {
      waiting++;
      continue;
    }
    const name = documentName(file.fileId);
    let result: DownloadResult;
    try {
      result = await downloadInto(kept, file, deps);
      if (result === 'kept' && file.locked) {
        // Never kept unchecked: one that can't be checked now downloads again later.
        const checked = await checkFingerprint(kept, file, deps).catch(() => 'later' as const);
        if (checked !== 'kept') {
          kept.remove(name);
          result = checked;
        }
      }
    } catch (error) {
      deps.log?.('A document didn’t download', error);
      result = 'later';
    }
    if (result === 'kept') done++;
    else if (result === 'later') waiting++;
    else kept.remove(name);
  }
  return { kept: done, removed: plan.remove.length, waiting };
}

/** A signed file is kept only if it's what HandsFreeOS stored; one it hasn't fingerprinted yet waits. */
async function checkFingerprint(
  kept: KeptFiles,
  file: WantedFile,
  deps: Pick<KeeperDeps, 'fingerprints' | 'sha256' | 'log'>,
): Promise<DownloadResult> {
  const known = (await deps.fingerprints(file.workspaceId, [file.fileId])).get(file.fileId);
  if (!known) return 'later';
  const bytes = kept.read(documentName(file.fileId));
  if (bytes && (await deps.sha256(bytes)) === known) return 'kept';
  deps.log?.('A signed document didn’t match its fingerprint, so it wasn’t kept');
  return 'mismatch';
}
