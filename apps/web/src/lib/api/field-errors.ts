import { ApiError } from './errors';

/** Maps a validation error's details onto form fields (last path segment → message). */
export function fieldErrors(e: unknown): Record<string, string> {
  if (!(e instanceof ApiError) || e.code !== 'validation' || !Array.isArray(e.details)) return {};
  const out: Record<string, string> = {};
  for (const d of e.details as { path?: unknown; message?: unknown }[]) {
    const path = Array.isArray(d.path) ? d.path.join('.') : String(d.path ?? '');
    const key = path.replace(/^\//, '').split(/[./]/).filter(Boolean).pop() ?? '';
    if (typeof d.message === 'string' && !(key in out)) out[key] = d.message;
  }
  return out;
}
