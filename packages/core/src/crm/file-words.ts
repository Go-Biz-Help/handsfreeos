/**
 * Files and photos on a record (M10 step 15). Browser-safe: the web's grid and the phone's list name a file the same
 * way, and agree on what counts as a picture.
 */
import { relativeTimeAgo } from '../workflows/approval-words';
import { formatBytes, timeOfDay } from './format';

/** The web's grid can draw these itself; anything else gets its badge. */
export const BROWSER_IMAGES: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
]);

const LABELS: Readonly<Record<string, string>> = {
  'application/pdf': 'PDF',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'DOC',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'XLS',
  'text/plain': 'TXT',
  'text/csv': 'CSV',
  'image/heic': 'HEIC',
  'image/heif': 'HEIF',
};

/** The short badge on a file's tile: "PDF", "XLS", "IMG", "FILE". */
export function fileKindLabel(mimeType: string | null | undefined, isImage: boolean): string {
  return LABELS[mimeType ?? ''] ?? (isImage ? 'IMG' : 'FILE');
}

/** Whether a file is a picture, from its type. */
export function isImageFile(mimeType: string | null | undefined): boolean {
  return !!mimeType && mimeType.startsWith('image/');
}

/** The web's line under a file's name: "2.4 MB · Dale Ramsey · 20 min ago". */
export function fileLine(
  file: {
    readonly sizeBytes: number | null;
    readonly uploadedBy: { readonly fullName: string } | null;
    readonly createdAt: string;
  },
  now = Date.now(),
): string {
  return [
    formatBytes(file.sizeBytes),
    file.uploadedBy?.fullName ?? 'Former member',
    relativeTimeAgo(file.createdAt, now),
  ]
    .filter(Boolean)
    .join(' · ');
}

/** The phone's line, in the canvas's order: "Dale · 9:24 AM · 2.4 MB". */
export function filePhoneLine(file: {
  readonly by: string | null;
  readonly createdAt: string;
  readonly sizeBytes: number | null;
}): string {
  return [
    file.by?.trim() || 'Former member',
    timeOfDay(file.createdAt),
    formatBytes(file.sizeBytes),
  ]
    .filter(Boolean)
    .join(' · ');
}

export const FILE_WORDS = {
  emptyTitle: 'No files yet',
  emptyBody: 'Photos, estimates and signed paperwork live here.',
  download: 'Download',
  remove: 'Remove',
  removed: 'File removed.',
  /** The phone's own words, from the canvas. */
  takePhoto: 'Take a photo',
  chooseFromLibrary: 'Or choose from your library',
  otherFiles: 'Other files',
  addAFile: 'Add a file',
  limits: 'PDFs, documents and photos, up to 25 MB',
  photos: 'Photos',
  /** Opening a file needs the network; the list itself does not. */
  needsSignal: 'Opening a file needs signal.',
  uploading: 'Uploading on its own',
  /** A locked file (Real Estate, step 3): signed, and never deleted or renamed. */
  locked: 'Signed · kept',
  lockedDetail: 'Signed and kept for good. Nobody can remove it; add a newer version instead.',
} as const;

/** "Remove old-unit.jpg? The stored file is deleted afterwards and the removal is recorded." */
export function removeFileConfirm(name: string): string {
  return `Remove ${name}? The stored file is deleted afterwards and the removal is recorded.`;
}
