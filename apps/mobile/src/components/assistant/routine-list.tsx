import { dayTime, routineStatusWords, type AssistantRoutineOut } from '@hfos/core';
import * as React from 'react';
import { View } from 'react-native';

import { deleteRoutine, pauseRoutine, useRoutines } from '@/assistant/routines';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { errorMessage } from '@/lib/api';

const deviceZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

/**
 * Settings → Notifications, under the switches: each question the Assistant asks for you on a schedule and each alert
 * you asked for, with Pause (or Turn on again) and Delete. Asking the Assistant ("every Monday, tell me who owes
 * money") is how one is made.
 */
export function RoutineList({ workspaceId }: { workspaceId: string }) {
  const list = useRoutines(workspaceId);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [deleting, setDeleting] = React.useState<string | null>(null);

  const pause = async (r: AssistantRoutineOut, paused: boolean) => {
    setBusy(r.id);
    try {
      const nextRunAt = await pauseRoutine(workspaceId, r.id, paused);
      list.patch(r.id, { paused, nextRunAt });
      toast.show(paused ? 'Paused.' : 'Turned on again.');
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const remove = async (r: AssistantRoutineOut) => {
    setBusy(r.id);
    try {
      await deleteRoutine(workspaceId, r.id);
      list.patch(r.id, null);
      toast.show('Deleted.');
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
      setDeleting(null);
    }
  };

  const items = list.items ?? [];
  return (
    <View className="gap-2" testID="assistant-routines">
      <Text variant="group" className="px-1 pt-2">
        What you asked the Assistant for
      </Text>
      <View className="overflow-hidden rounded-card border border-border bg-card">
        {list.items === null ? (
          <Text className="px-3.5 py-[11px] text-[13.5px] text-text-3">Loading…</Text>
        ) : items.length === 0 ? (
          <Text className="px-3.5 py-[11px] text-[13.5px] leading-[19px] text-text-2">
            {list.error ??
              'Nothing yet. Ask the Assistant something like “Every Monday at 8, tell me who owes money” or “Tell me when Bob writes back.”'}
          </Text>
        ) : (
          items.map((r, i) => (
            <View
              key={r.id}
              className={
                i === 0 ? 'gap-2 px-3.5 py-[11px]' : 'gap-2 border-t border-border px-3.5 py-[11px]'
              }
              testID={`routine-${r.id}`}
            >
              <View className="gap-0.5">
                <Text className="text-[15px] font-medium leading-5">
                  {r.kind === 'question' ? (r.question ?? '') : r.when}
                </Text>
                <Text className="text-[12.5px] leading-[17px] text-text-3">
                  {r.kind === 'question' ? `${r.when} · ` : ''}
                  {routineStatusWords(r, (iso) => dayTime(iso, deviceZone()))}
                  {r.kind === 'question' && r.email ? ' · By email too' : ''}
                </Text>
              </View>
              {deleting === r.id ? (
                <View className="flex-row gap-2">
                  <Button
                    size="sm"
                    variant="danger"
                    loading={busy === r.id}
                    onPress={() => void remove(r)}
                    testID={`routine-delete-yes-${r.id}`}
                  >
                    Delete it
                  </Button>
                  <Button size="sm" variant="ghost" onPress={() => setDeleting(null)}>
                    Keep it
                  </Button>
                </View>
              ) : (
                <View className="flex-row gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={busy === r.id}
                    onPress={() => void pause(r, !r.paused)}
                    testID={`routine-pause-${r.id}`}
                  >
                    {r.paused ? 'Turn on again' : 'Pause'}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghostDanger"
                    disabled={busy === r.id}
                    onPress={() => setDeleting(r.id)}
                    testID={`routine-delete-${r.id}`}
                  >
                    Delete
                  </Button>
                </View>
              )}
            </View>
          ))
        )}
      </View>
    </View>
  );
}
