/**
 * Round six's words for keeping a deal (board 93): Deal settings → Keeping records, a deal's legal holds, and the
 * whole transaction exported. Browser-safe, so the web and the phone say the same thing; the work is core's holds
 * (commands/record-hold.ts) and the add-on's export (ops/export.ts, and the worker's export.ts).
 */

/** Deal settings → Keeping records. */
export const KEEPING_WORDS = {
  tab: 'Keeping records',
  description: 'How long closed deals are kept, and the deals on legal hold',
  keepTitle: 'Keep closed deals at least',
  yearsAfter: 'years after they end',
  keepAbout:
    'Until then nobody can delete Real Estate’s data. Nothing is ever deleted on its own; after that, an owner may. Open deals are always kept. Signed documents are kept for good.',
  keepSaved: (years: number) =>
    `Saved. Closed deals are kept ${years === 1 ? '1 year' : `${years} years`} after they end.`,
  holdsTitle: (n: number) => `Legal holds · ${n}`,
  holdsAbout:
    'Lifting needs a reason, kept in the deal’s history. A hold also stops anyone deleting the business.',
  noHolds:
    'No deal is on legal hold. To place one, open the deal and choose More → Place a legal hold…',
  holdsOnlyOwners:
    'Owners and admins place and lift legal holds. Ask one of them to lift a hold you think should end.',
} as const;

export type ExportState = 'building' | 'ready' | 'failed';

/** Exporting the whole transaction, on a deal and its Documents. */
export const EXPORT_WORDS = {
  title: 'Export the whole transaction',
  menu: 'Export the whole transaction…',
  about:
    'Every document and version, dates, duties and their proof, approvals, messages and the history, in one file with a manifest a computer can read.',
  submit: 'Make the file',
  told: 'You’re told when it’s ready; it stays on the deal’s Documents, under Exports.',
  asked: 'Making it now. You’re told when it’s ready; it stays on the deal’s Documents.',
  needsSignal:
    'Making one needs signal. You’re told when it’s ready; it stays on the deal’s Documents.',
  listTitle: 'Exports',
  none: 'No exports yet. Each one holds every file on the deal with its fingerprint, and every record, in one zip.',
  making: 'Making the file…',
  makingLine: 'It’s usually ready in a minute or two.',
  failedLine: 'Try again. If it fails again, ask HandsFreeOS support.',
  download: 'Download',
  states: {
    building: 'Making',
    ready: 'Ready',
    failed: 'Couldn’t be made',
  } satisfies Readonly<Record<ExportState, string>>,
} as const;

/** "31 MB", "820 KB", "4.2 MB". */
export function exportSizeWords(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  const mb = bytes / (1024 * 1024);
  return mb >= 10 ? `${Math.round(mb)} MB` : `${mb.toFixed(1)} MB`;
}

/** Under a ready export's name: "48 files · 31 MB · every file’s fingerprint checked". */
export function exportLine(x: {
  readonly files: number | null;
  readonly sizeBytes: number | null;
}) {
  return [
    x.files === null ? null : x.files === 1 ? '1 file' : `${x.files} files`,
    x.sizeBytes ? exportSizeWords(x.sizeBytes) : null,
    'every file’s fingerprint checked',
  ]
    .filter(Boolean)
    .join(' · ');
}
