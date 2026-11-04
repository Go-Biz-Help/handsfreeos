/**
 * The demo player's made-up ids (src/demo), the web's prefix (apps/web/src/lib/demo/world.ts): real version 4 ids,
 * so every check a push or a change goes through takes them, and never one HandsFreeOS made.
 */
export const DEMO_PREFIX = 'de300000-0000-4000-8000-';

/** The made-up id numbered `n`: 5401 → de300000-0000-4000-8000-000000005401. */
export const demoId = (n: number): string => `${DEMO_PREFIX}${String(n).padStart(12, '0')}`;

export const isDemoId = (value: unknown): value is string =>
  typeof value === 'string' && value.startsWith(DEMO_PREFIX);

/** Whether anything in a change's input (or a push's data) is made up, however deep. */
export function mentionsDemo(value: unknown, depth = 0): boolean {
  if (depth > 5) return false;
  if (isDemoId(value)) return true;
  if (Array.isArray(value)) return value.some((v) => mentionsDemo(v, depth + 1));
  if (value && typeof value === 'object')
    return Object.values(value as Record<string, unknown>).some((v) => mentionsDemo(v, depth + 1));
  return false;
}
