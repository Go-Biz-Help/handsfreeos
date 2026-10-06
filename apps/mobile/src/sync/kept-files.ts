/**
 * Files this phone keeps for a person (round seven, core; Chris 2026-10-05), in a second SQLCipher database beside
 * their copy (`hfos-<userId>.files.db`, the same key), so nothing they hold is ever a plain file on the phone:
 *
 * - **waiting:** photos and voice notes taken here, kept until HandsFreeOS confirms them (`changes/photos.ts`);
 * - **document:** files an add-on's phone rows bring (`offline.files`): Real Estate's current documents on the
 *   person's deals, and any they pinned, up to 1 GB (`kept-documents.ts`).
 *
 * Each file is kept in pieces of 1 MB, so an upload reads 6 MB at a time and a download writes as it arrives, without
 * the whole file in memory. Opening one writes a decrypted copy for the phone's viewer and deletes it after.
 */

/** A connection that runs SQL at once: op-sqlite's `executeSync` on the phone, node:sqlite in tests. */
export interface SyncSql {
  run(sql: string, params?: readonly SqlValue[]): void;
  all<T>(sql: string, params?: readonly SqlValue[]): T[];
}

export type SqlValue = string | number | null | Uint8Array;

/** The size of each piece a file is kept in. */
export const PIECE_BYTES = 1024 * 1024;

export type KeptKind = 'waiting' | 'document';

export interface KeptFile {
  readonly name: string;
  readonly kind: KeptKind;
  readonly workspaceId: string | null;
  readonly fileId: string | null;
  readonly sizeBytes: number;
  readonly mimeType: string | null;
  /** What it's called, for the viewer ("Purchase agreement.pdf"). */
  readonly fileName: string | null;
  /** Every byte is here. */
  readonly complete: boolean;
  /** Kept whatever the limit, and when its row no longer asks for it (while its deal is still on the phone). */
  readonly pinned: boolean;
  readonly openedAt: number | null;
  readonly keptAt: number;
}

export interface KeptMeta {
  readonly workspaceId?: string | null;
  readonly fileId?: string | null;
  readonly mimeType?: string | null;
  readonly fileName?: string | null;
  readonly pinned?: boolean;
}

interface Row {
  name: string;
  kind: KeptKind;
  workspace_id: string | null;
  file_id: string | null;
  size_bytes: number;
  mime_type: string | null;
  file_name: string | null;
  complete: number;
  pinned: number;
  opened_at: number | null;
  kept_at: number;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS kept_files (
     name TEXT PRIMARY KEY NOT NULL,
     kind TEXT NOT NULL,
     workspace_id TEXT,
     file_id TEXT,
     size_bytes INTEGER NOT NULL,
     mime_type TEXT,
     file_name TEXT,
     complete INTEGER NOT NULL DEFAULT 0,
     pinned INTEGER NOT NULL DEFAULT 0,
     opened_at INTEGER,
     kept_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS kept_pieces (
     name TEXT NOT NULL,
     seq INTEGER NOT NULL,
     bytes BLOB NOT NULL,
     PRIMARY KEY (name, seq))`,
  `CREATE INDEX IF NOT EXISTS kept_files_kind ON kept_files (kind, complete)`,
];

const fileOf = (r: Row): KeptFile => ({
  name: r.name,
  kind: r.kind,
  workspaceId: r.workspace_id,
  fileId: r.file_id,
  sizeBytes: Number(r.size_bytes),
  mimeType: r.mime_type,
  fileName: r.file_name,
  complete: !!r.complete,
  pinned: !!r.pinned,
  openedAt: r.opened_at === null ? null : Number(r.opened_at),
  keptAt: Number(r.kept_at),
});

/** A blob as op-sqlite (ArrayBuffer) or node:sqlite (Uint8Array) gives it. */
const bytesOf = (value: unknown): Uint8Array =>
  value instanceof Uint8Array ? value : new Uint8Array(value as ArrayBuffer);

function join(parts: readonly Uint8Array[], length?: number): Uint8Array<ArrayBuffer> {
  const total = length ?? parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(new ArrayBuffer(total));
  let at = 0;
  for (const p of parts) {
    if (at >= total) break;
    const take = Math.min(p.length, total - at);
    out.set(take === p.length ? p : p.subarray(0, take), at);
    at += take;
  }
  return out;
}

export class KeptFiles {
  constructor(
    private readonly db: SyncSql,
    private readonly now: () => number = Date.now,
  ) {
    for (const statement of SCHEMA) db.run(statement);
  }

  private inTransaction<T>(step: () => T): T {
    this.db.run('BEGIN IMMEDIATE');
    try {
      const out = step();
      this.db.run('COMMIT');
      return out;
    } catch (error) {
      this.db.run('ROLLBACK');
      throw error;
    }
  }

  private writePieces(name: string, firstSeq: number, bytes: Uint8Array) {
    for (let at = 0, seq = firstSeq; at < bytes.length; at += PIECE_BYTES, seq++)
      this.db.run('INSERT OR REPLACE INTO kept_pieces (name, seq, bytes) VALUES (?, ?, ?)', [
        name,
        seq,
        bytes.subarray(at, Math.min(at + PIECE_BYTES, bytes.length)),
      ]);
  }

  private upsert(
    name: string,
    kind: KeptKind,
    sizeBytes: number,
    complete: boolean,
    meta: KeptMeta,
  ) {
    this.db.run(
      `INSERT INTO kept_files (name, kind, workspace_id, file_id, size_bytes, mime_type, file_name, complete, pinned,
         kept_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (name) DO UPDATE SET kind = excluded.kind, workspace_id = excluded.workspace_id,
         file_id = excluded.file_id, size_bytes = excluded.size_bytes, mime_type = excluded.mime_type,
         file_name = excluded.file_name, complete = excluded.complete,
         pinned = max(kept_files.pinned, excluded.pinned), kept_at = excluded.kept_at`,
      [
        name,
        kind,
        meta.workspaceId ?? null,
        meta.fileId ?? null,
        sizeBytes,
        meta.mimeType ?? null,
        meta.fileName ?? null,
        complete ? 1 : 0,
        meta.pinned ? 1 : 0,
        this.now(),
      ],
    );
  }

  /** Keeps a whole file at once (a photo just taken), in place of anything kept under its name. */
  put(name: string, kind: KeptKind, bytes: Uint8Array, meta: KeptMeta = {}): void {
    this.inTransaction(() => {
      this.db.run('DELETE FROM kept_pieces WHERE name = ?', [name]);
      this.writePieces(name, 0, bytes);
      this.upsert(name, kind, bytes.length, true, meta);
    });
  }

  /** Starts keeping a file that arrives in pieces (a download); what was kept under its name goes. */
  begin(name: string, kind: KeptKind, sizeBytes: number, meta: KeptMeta = {}): void {
    this.inTransaction(() => {
      this.db.run('DELETE FROM kept_pieces WHERE name = ?', [name]);
      this.upsert(name, kind, sizeBytes, sizeBytes === 0, meta);
    });
  }

  /** Remembers a file to keep before any of it is here (a document pinned to download): never complete. */
  reserve(name: string, kind: KeptKind, meta: KeptMeta = {}): void {
    if (this.info(name)) return;
    this.upsert(name, kind, 0, false, meta);
  }

  /**
   * Adds the bytes that start at `offset`, which is a whole number of pieces in (a download asks for ranges that
   * are). Once every byte is here the file is complete.
   */
  append(name: string, offset: number, bytes: Uint8Array): void {
    if (offset % PIECE_BYTES !== 0) throw new Error(`Pieces start every ${PIECE_BYTES} bytes.`);
    this.inTransaction(() => {
      const [row] = this.db.all<{ size_bytes: number }>(
        'SELECT size_bytes FROM kept_files WHERE name = ?',
        [name],
      );
      if (!row) throw new Error('Nothing is being kept under that name.');
      this.writePieces(name, offset / PIECE_BYTES, bytes);
      if (this.storedBytes(name) >= Number(row.size_bytes))
        this.db.run('UPDATE kept_files SET complete = 1 WHERE name = ?', [name]);
    });
  }

  /** How many bytes of a file are here so far. */
  storedBytes(name: string): number {
    const [row] = this.db.all<{ n: number | null }>(
      'SELECT sum(length(bytes)) AS n FROM kept_pieces WHERE name = ?',
      [name],
    );
    return Number(row?.n ?? 0);
  }

  info(name: string): KeptFile | null {
    const [row] = this.db.all<Row>('SELECT * FROM kept_files WHERE name = ?', [name]);
    return row ? fileOf(row) : null;
  }

  /** Whether the whole file is here. */
  has(name: string): boolean {
    return this.info(name)?.complete ?? false;
  }

  list(kind?: KeptKind): KeptFile[] {
    return (
      kind
        ? this.db.all<Row>('SELECT * FROM kept_files WHERE kind = ? ORDER BY kept_at', [kind])
        : this.db.all<Row>('SELECT * FROM kept_files ORDER BY kept_at')
    ).map(fileOf);
  }

  /** The whole file, or null when it isn't all here. */
  read(name: string): Uint8Array<ArrayBuffer> | null {
    const file = this.info(name);
    if (!file?.complete) return null;
    const pieces = this.db.all<{ bytes: unknown }>(
      'SELECT bytes FROM kept_pieces WHERE name = ? ORDER BY seq',
      [name],
    );
    return join(
      pieces.map((p) => bytesOf(p.bytes)),
      file.sizeBytes,
    );
  }

  /** `length` bytes from `offset` (fewer at the end): an upload's next piece. */
  readRange(name: string, offset: number, length: number): Uint8Array<ArrayBuffer> {
    const first = Math.floor(offset / PIECE_BYTES);
    const last = Math.floor((offset + Math.max(length, 1) - 1) / PIECE_BYTES);
    const pieces = this.db.all<{ seq: number; bytes: unknown }>(
      'SELECT seq, bytes FROM kept_pieces WHERE name = ? AND seq BETWEEN ? AND ? ORDER BY seq',
      [name, first, last],
    );
    const joined = join(pieces.map((p) => bytesOf(p.bytes)));
    const skip = offset - first * PIECE_BYTES;
    return join([joined.subarray(skip, skip + length)]);
  }

  remove(name: string): void {
    this.inTransaction(() => {
      this.db.run('DELETE FROM kept_pieces WHERE name = ?', [name]);
      this.db.run('DELETE FROM kept_files WHERE name = ?', [name]);
    });
  }

  /** Removes every file of a kind: the documents, when the person signs out. */
  removeKind(kind: KeptKind): number {
    const names = this.list(kind).map((f) => f.name);
    for (const name of names) this.remove(name);
    return names.length;
  }

  /** It was just opened: the limit lets the least recently opened go first. */
  touch(name: string): void {
    this.db.run('UPDATE kept_files SET opened_at = ? WHERE name = ?', [this.now(), name]);
  }

  setPinned(name: string, pinned: boolean): void {
    this.db.run('UPDATE kept_files SET pinned = ? WHERE name = ?', [pinned ? 1 : 0, name]);
  }

  /** Bytes the complete files of a kind take. */
  usedBytes(kind: KeptKind): number {
    const [row] = this.db.all<{ n: number | null }>(
      'SELECT sum(size_bytes) AS n FROM kept_files WHERE kind = ? AND complete = 1',
      [kind],
    );
    return Number(row?.n ?? 0);
  }
}

/** A kept document's name: one per file. */
export const documentName = (fileId: string) => `doc-${fileId}`;
