import {
  SENDS_SOURCE,
  waitingOfCopy,
  type PhoneWaiting,
} from '@hfos/core/addons/outreach/views/waiting';
import type { SyncedPhoneRow } from '@hfos/core/addons/phone-rows';
import { useQuery } from '@powersync/react-native';
import * as React from 'react';

/**
 * Social Outreach's part of the phone's copy (decision 44): the person's own messages waiting for their OK, and
 * nothing else. HandsFreeOS seals each to its person (`addon_phone_own_table`, 20261027001800), so the rows reach
 * their phone alone, through records_v1, and leave it once OK'd, skipped or sent. Core's `waitingOfCopy` works out
 * what `outreach.waiting` answers of them, so the list reads the same with no signal.
 */

/** Its rows of the messages (`SENDS_SOURCE`). */
export const OUTREACH_SENDS_SQL = `
  SELECT id, source, record_id, data FROM addon_phone_rows
  WHERE workspace_id = ? AND addon_id = 'outreach' AND source = 'sends'`;

/**
 * The OKs and skips made on this phone that haven't gone yet: still on their way, or waiting on the person ("Still
 * send?", or one refused). Their messages stay off the list meanwhile, even once HandsFreeOS's row (still waiting
 * there) comes back to the copy, so nobody OKs one twice.
 */
export const OUTREACH_PENDING_SQL = `
  SELECT name, input FROM outbox
  WHERE workspace_id = ? AND state != 'sent' AND name IN ('outreach.send.approve', 'outreach.send.skip')`;

/** The messages those changes name. */
export function pendingSendIds(changes: readonly { name: string; input: string }[]): Set<string> {
  const ids = new Set<string>();
  for (const c of changes) {
    try {
      const input = JSON.parse(c.input) as { sendId?: unknown; sends?: unknown };
      if (typeof input.sendId === 'string') ids.add(input.sendId);
      if (Array.isArray(input.sends))
        for (const s of input.sends as { sendId?: unknown }[])
          if (typeof s?.sendId === 'string') ids.add(s.sendId);
    } catch {
      // Not one of ours to read: it shows in Changes on this phone.
    }
  }
  return ids;
}

/** The person's messages waiting, from the phone's copy, re-read whenever the rows change. */
export function useOutreachWaiting(workspaceId: string, userId: string): PhoneWaiting {
  const rows = useQuery<SyncedPhoneRow>(OUTREACH_SENDS_SQL, [workspaceId]).data;
  const pending = useQuery<{ name: string; input: string }>(OUTREACH_PENDING_SQL, [
    workspaceId,
  ]).data;
  return React.useMemo(() => {
    const gone = new Set([...pendingSendIds(pending)].map((sendId) => `${SENDS_SOURCE}:${sendId}`));
    const shown = gone.size ? rows.filter((r) => !gone.has(String(r.id))) : rows;
    return waitingOfCopy(shown, userId);
  }, [rows, pending, userId]);
}
