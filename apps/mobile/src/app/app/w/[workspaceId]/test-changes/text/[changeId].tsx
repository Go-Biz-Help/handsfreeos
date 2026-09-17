import { useQuery } from '@powersync/react-native';
import { router, useLocalSearchParams } from 'expo-router';
import * as React from 'react';
import { View } from 'react-native';

import { Send, Trash } from '@/components/icons';
import { Screen } from '@/components/shell/screen';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from '@/components/ui/toast';
import { changes } from '@/changes';
import { describe, loadNames } from '@/changes/describe';
import type { OutboxRow } from '@/changes/outbox';
import { clockTime } from '@/lib/sync-status';

/**
 * Edit, from "Still send?" or the quiet-hours question (test builds, standing in for the conversation screen step 14
 * builds): the text as written, and Send, which sends the edited words under the change's own id as a yes.
 */
export default function EditText() {
  const { changeId } = useLocalSearchParams<{ changeId: string }>();
  const { data } = useQuery<OutboxRow>('SELECT * FROM outbox WHERE id = ?', [changeId]);
  const row = data[0] ?? null;
  const [body, setBody] = React.useState<string | null>(null);
  const [to, setTo] = React.useState('a customer');
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (!row) return;
    if (body === null) setBody((JSON.parse(row.input) as { body?: string }).body ?? '');
    const db = changes.open?.db;
    if (db)
      void loadNames(db, [row]).then((names) =>
        setTo(describe(row, names).about?.name ?? 'a customer'),
      );
  }, [row, body]);

  if (!row || body === null)
    return <Screen title="Edit the text" leading="close" testID="edit-text" />;

  const send = async () => {
    setBusy(true);
    try {
      await changes.fix(row.id, { ...(JSON.parse(row.input) as object), body: body.trim() });
      toast.show('Sending the text.');
      router.back();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen
      title="Edit the text"
      subtitle={`To ${to} · written ${clockTime(Date.parse(row.made_at))}`}
      leading="close"
      testID="edit-text"
      contentClassName="gap-3.5 px-4 pt-3.5"
    >
      <View className="gap-1.5">
        <Label nativeID="edit-text-label">Text</Label>
        <Input
          value={body}
          onChangeText={setBody}
          multiline
          className="h-auto min-h-[120px] py-2.5"
          aria-labelledby="edit-text-label"
          testID="edit-text-body"
        />
      </View>
      <View className="gap-2">
        <Button
          icon={Send}
          loading={busy}
          disabled={!body.trim()}
          onPress={() => void send()}
          testID="edit-text-send"
        >
          Send
        </Button>
        <Button
          variant="ghostDanger"
          icon={Trash}
          onPress={() =>
            void changes.discard([row.id]).then(() => {
              toast.show('Discarded. Nothing was sent.');
              router.back();
            })
          }
          testID="edit-text-discard"
        >
          Discard
        </Button>
      </View>
    </Screen>
  );
}
