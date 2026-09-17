import {
  cardChipsOf,
  handleButtonOf,
  letHandleOffReason,
  type AttentionListOutput,
} from '@hfos/core';
import { usePowerSync } from '@powersync/react-native';
import { File, Paths } from 'expo-file-system';
import * as React from 'react';
import { View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { change } from '@/changes';
import type { OutboxRow } from '@/changes/outbox';
import { config } from '@/lib/config';

import { homeChangesOf } from './build';

/** What Home shows, for comparing with the web's `attention.list` at the same moment: order, counts and words. */
export function homeDump(list: AttentionListOutput, now: number, timeZone: string) {
  return {
    now: new Date(now).toISOString(),
    scope: list.scope,
    affectedCents: list.affectedCents,
    counts: list.counts,
    handledToday: list.handledToday,
    items: list.items.map((i) => ({
      id: i.id,
      kind: i.kind,
      title: i.title,
      detail: i.detail,
      urgent: i.urgent,
      assignee: i.assignee?.fullName ?? null,
      chips: cardChipsOf(i, now, timeZone).map((c) => c.text),
      handle: i.actions.handle ? handleButtonOf(i, true).label : null,
      letHandleOff: letHandleOffReason(i),
      actions: i.actions,
    })),
    handled: list.handled.map((i) => i.id),
  };
}

/**
 * Test builds only, at the foot of Home: put back what this phone snoozed and dismissed on Home, so a Maestro flow
 * leaves the seeded items as it found them (`attention.restore`, the web's Undo); and write what Home shows to the
 * log (`HFOS_HOME_DUMP`), for comparing with the web's list.
 */
export function HomeTestTools({
  workspaceId,
  list,
  timeZone,
}: {
  workspaceId: string;
  list: AttentionListOutput;
  timeZone: string;
}) {
  const db = usePowerSync();
  const [said, setSaid] = React.useState<string | null>(null);
  if (!config.e2e) return null;
  const putBack = async () => {
    const rows = await db.getAll<OutboxRow>(
      `SELECT * FROM outbox WHERE workspace_id = ? AND name IN ('attention.snooze', 'attention.dismiss', 'attention.restore')
       ORDER BY seq`,
      [workspaceId],
    );
    const latest = new Map<string, string>();
    for (const c of homeChangesOf(rows)) latest.set(c.itemId, c.name);
    const items = [...latest].filter(([, name]) => name !== 'attention.restore').map(([id]) => id);
    for (const itemId of items) await change('attention.restore', { workspaceId, itemId });
    setSaid(`Put back ${items.length}.`);
  };
  return (
    <View className="mt-6 gap-1.5" testID="home-test-tools">
      <Button variant="secondary" onPress={() => void putBack()} testID="home-test-put-back">
        Test: put back what this phone snoozed and dismissed
      </Button>
      <Button
        variant="secondary"
        onPress={() => {
          const at = Date.now();
          // One line per item, so a phone's log never cuts one short.
          const dump = homeDump(list, at, timeZone);
          const lines = [
            `HFOS_HOME_DUMP ${JSON.stringify({ ...dump, items: dump.items.length })}`,
            ...dump.items.map((item, i) => `HFOS_HOME_ITEM ${i} ${JSON.stringify(item)}`),
          ];
          lines.forEach((line) => console.log(line));
          // The iPhone simulator's release builds don't send console lines to its log: a file in the app's documents too.
          try {
            const file = new File(Paths.document, 'hfos-home-dump.txt');
            if (file.exists) file.delete();
            file.create();
            file.write(lines.join('\n'));
          } catch {
            // The log has it.
          }
          setSaid(`Wrote ${dump.items.length} items to the log.`);
        }}
        testID="home-test-dump"
      >
        Test: write Home to the log
      </Button>
      {said ? (
        <Text className="text-center text-xs text-text-3" testID="home-test-said">
          {said}
        </Text>
      ) : null}
    </View>
  );
}
