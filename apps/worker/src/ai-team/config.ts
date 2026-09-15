import {
  APPROVALS_NEEDED_MAX,
  APPROVALS_NEEDED_MIN,
  emptyTeammateConfig,
  parseTeammateConfig,
  type TeammateChannel,
  type TeammateConfig,
} from '@hfos/core/server';

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The teammate's settings as the runtime reads them. How many approvals it needs doesn't change how it replies
 * (the database counts them), so a threshold outside the builder's range (the browser suite uses 3) is brought
 * into range before reading, instead of every other setting falling back to its default.
 */
export function runtimeConfigOf(raw: unknown): TeammateConfig {
  try {
    return parseTeammateConfig(raw);
  } catch {
    // Read again below with the threshold in range.
  }
  if (isRecord(raw) && isRecord(raw['autonomy'])) {
    const n = Number(raw['autonomy']['approvalsNeeded']);
    const approvalsNeeded = Math.min(
      APPROVALS_NEEDED_MAX,
      Math.max(APPROVALS_NEEDED_MIN, Number.isFinite(n) ? Math.round(n) : APPROVALS_NEEDED_MIN),
    );
    try {
      return parseTeammateConfig({ ...raw, autonomy: { ...raw['autonomy'], approvalsNeeded } });
    } catch {
      // Unreadable for another reason: the defaults.
    }
  }
  return emptyTeammateConfig();
}

/** Whether the teammate answers this channel. */
export function answersChannel(
  config: TeammateConfig,
  channel: string,
): channel is TeammateChannel {
  return (
    (channel === 'sms' || channel === 'email' || channel === 'chat') && config.channels[channel]
  );
}
