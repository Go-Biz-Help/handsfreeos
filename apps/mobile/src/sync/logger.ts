import type { LogRecord, PowerSyncLogger } from '@powersync/common';

/**
 * PowerSync's log and the copy's own, warnings and worse: to the console (never `console.error` or `console.warn`, which
 * cover the app in development builds for a sync that's only waiting for signal), and the last few kept for This
 * phone's copy. Anything shaped like a token is cut out first.
 */
const KEEP = 12;
const recent: string[] = [];

const redact = (text: string) =>
  text
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[token]')
    .replace(/Expo(nent)?PushToken\[[^\]]*\]/g, '[push token]')
    .replace(/x'[0-9a-fA-F]+'/g, "x'[key]'")
    .replace(/\b[0-9a-f]{64}\b/g, '[key]');

export const copyLogger: PowerSyncLogger & { recent(): readonly string[] } = {
  log(record: LogRecord) {
    if (record.level < 40) return;
    const detail =
      record.error instanceof Error
        ? `: ${record.error.message}`
        : record.error
          ? `: ${String(record.error)}`
          : '';
    const line = redact(`${new Date().toISOString().slice(11, 19)} ${record.message}${detail}`);
    recent.unshift(line);
    recent.length = Math.min(recent.length, KEEP);
    console.log(`[copy] ${line}`);
  },
  recent: () => recent,
};
