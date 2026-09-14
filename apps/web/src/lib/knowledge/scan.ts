import type { KnowledgeScan } from '@/lib/api/types';

/** One page a website scan recorded (apps/worker/src/knowledge/scan.ts ScanPage). */
export interface ScanPageView {
  readonly url: string;
  readonly title: string;
  /** new, changed or unchanged since the last scan; error when it couldn't be read; removed when it's gone. */
  readonly status: 'new' | 'changed' | 'unchanged' | 'error' | 'removed';
  readonly suggestions: number;
  readonly truncated: boolean;
  readonly error: string | null;
}

/** One problem on knowledge_scans.errors: a page (with its url) or the whole scan (without). */
export interface ScanProblemView {
  readonly url: string | null;
  readonly code: string;
  readonly message: string;
}

const STATUSES = new Set(['new', 'changed', 'unchanged', 'error', 'removed']);
const str = (v: unknown) => (typeof v === 'string' ? v : '');

export function scanPages(scan: KnowledgeScan | null): ScanPageView[] {
  if (!scan) return [];
  return scan.pages.flatMap((raw) => {
    const url = str(raw.url);
    const status = str(raw.status);
    if (!url || !STATUSES.has(status)) return [];
    return [
      {
        url,
        title: str(raw.title),
        status: status as ScanPageView['status'],
        suggestions: typeof raw.suggestions === 'number' ? raw.suggestions : 0,
        truncated: raw.truncated === true,
        error: str(raw.error) || null,
      },
    ];
  });
}

export function scanProblems(scan: KnowledgeScan | null): ScanProblemView[] {
  if (!scan) return [];
  return scan.errors.flatMap((raw) => {
    if (!raw || typeof raw !== 'object') return [];
    const r = raw as Record<string, unknown>;
    const message = str(r.message);
    if (!message) return [];
    return [{ url: str(r.url) || null, code: str(r.code) || 'error', message }];
  });
}

/** Whether a scan is still reading (the page refreshes itself until it's done). */
export const scanLive = (scan: KnowledgeScan | null) =>
  !!scan && (scan.status === 'queued' || scan.status === 'running');
