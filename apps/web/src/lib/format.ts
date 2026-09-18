/**
 * Display helpers shared by the CRM screens. Money is stored in integer cents (USD).
 *
 * The formatting itself lives in `@hfos/core` (M10 step 15), so the phone's record page, pipeline, tasks and files
 * read exactly as the web's. This file keeps the names every component here already imports.
 */
export {
  addressLine,
  daysLabel,
  daysSince,
  formatBytes,
  formatDate,
  formatDateOnly,
  monthYear,
  smsHref,
  telHref,
} from '@hfos/core';
import { money } from '@hfos/core';

/** $18,500 · $18,500.50. Core's `money`, under the name the CRM screens have always used. */
export const formatMoney = money;

export function parseMoney(input: string): number | null {
  const cleaned = input.replace(/[^0-9.]/g, '');
  if (!cleaned) return 0;
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

/** The inbox's wait words live in core (shared with the phone app); re-exported for existing imports. */
export { minutesSince, waitingFor } from '@hfos/core';

/** "Today, 10:24 AM" style value for datetime-local inputs, in the browser's zone. */
export function toLocalInputValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
export function toLocalDateValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
