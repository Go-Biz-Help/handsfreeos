import {
  BIN_WORDS,
  binContentsTotal,
  binDeleteBox,
  binDeletedWords,
  type BinKind,
} from '@hfos/core';
import * as React from 'react';
import { View } from 'react-native';

import { previewBin, putInBin, type BinPreviewItem } from '@/bin/calls';
import { Button } from '@/components/ui/button';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { errorMessage } from '@/lib/api';

/**
 * "Delete … for good?" on the phone (the Deleted bin, 20261027000400), saying what the web's delete box says: it asks
 * HandsFreeOS what goes with it, names what can't go yet and why, and deletes the rest. It needs signal, so whoever
 * opens it checks first and says `BIN_WORDS.offline` instead. A booking still to come is cancelled first, telling
 * its customer or not, as the Cancel sheet asks.
 */
export function DeleteSheet({
  open,
  onClose,
  workspaceId,
  kind,
  ids,
  names: given,
  tellFirst,
  onDeleted,
}: {
  open: boolean;
  onClose: () => void;
  workspaceId: string;
  kind: BinKind;
  ids: readonly string[];
  /** Their names (a conversation's customer), for the title while it asks what goes with them. */
  names: readonly string[];
  /**
   * A booking with someone on it: the first name to tell it's cancelled, or null for "them". Left out when there's
   * nobody to tell.
   */
  tellFirst?: string | null;
  /** Once it's in the bin and the sheet has gone: leave the screen of what was deleted. */
  onDeleted: () => void;
}) {
  const [items, setItems] = React.useState<BinPreviewItem[] | null>(null);
  const [failed, setFailed] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const done = React.useRef(false);
  const key = ids.join(',');

  React.useEffect(() => {
    if (!open || ids.length === 0) return;
    let stale = false;
    done.current = false;
    setItems(null);
    setFailed(null);
    previewBin(workspaceId, kind, ids).then(
      (found) => !stale && setItems(found),
      (e: unknown) => !stale && setFailed(errorMessage(e)),
    );
    return () => {
      stale = true;
    };
    // `key` stands for `ids`, which callers make afresh on every render.
  }, [open, workspaceId, kind, key]);

  const blocked = items?.filter((i) => i.rule) ?? [];
  const going = items?.filter((i) => !i.rule) ?? [];
  const names =
    items === null ? given : (going.length > 0 ? going : items).map((i) => i.name ?? '');
  const box = binDeleteBox(kind, names, binContentsTotal(going.map((i) => i.contents)));
  const upcoming = kind === 'appointment' && (going[0]?.contents.upcoming ?? 0) > 0;
  const tellable = upcoming && tellFirst !== undefined;
  const several = ids.length > 1;

  const run = async (notify: boolean) => {
    setBusy(true);
    try {
      await putInBin(
        workspaceId,
        kind,
        going.map((i) => i.id),
        notify,
      );
      toast.show(
        notify
          ? BIN_WORDS.cancelledTold
          : binDeletedWords(
              kind,
              going.map((i) => i.name ?? ''),
            ),
      );
      done.current = true;
      onClose();
    } catch (e) {
      toast.error(errorMessage(e));
      // Something changed since it was asked (someone else deleted one, a plan started billing): ask again.
      previewBin(workspaceId, kind, ids).then(setItems, () => undefined);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      onClosed={() => {
        if (!done.current) return;
        done.current = false;
        onDeleted();
      }}
      title={box.title}
      scroll
      testID="delete-sheet"
    >
      <View className="mt-2 gap-2">
        {failed ? (
          <Text className="text-[13px] leading-[1.45] text-danger-text">{failed}</Text>
        ) : items === null ? (
          <Text className="text-[13px] text-text-3">{BIN_WORDS.checking(several)}</Text>
        ) : (
          <>
            {going.length > 0
              ? box.lines.map((line) => (
                  <Text key={line} className="text-[13px] leading-[1.45] text-text-2">
                    {line}
                  </Text>
                ))
              : null}
            {blocked.length > 0 ? (
              <View className="rounded-card bg-warning-soft px-3.5 py-3" testID="delete-blocked">
                {several ? (
                  <Text className="text-[13px] font-semibold text-warning-text">
                    {BIN_WORDS.blocked(blocked.length)}
                  </Text>
                ) : null}
                {blocked.map((b) => (
                  <Text key={b.id} className="mt-1 text-[12.5px] leading-[1.45] text-warning-text">
                    {b.message}
                  </Text>
                ))}
              </View>
            ) : null}
          </>
        )}
      </View>
      <View className="mt-4 gap-2">
        {going.length > 0 ? (
          tellable ? (
            <>
              <Button
                variant="danger"
                loading={busy}
                onPress={() => void run(true)}
                testID="delete-confirm"
              >
                {BIN_WORDS.deleteAndTell(tellFirst ?? null)}
              </Button>
              <Button
                variant="secondary"
                loading={busy}
                onPress={() => void run(false)}
                testID="delete-quietly"
              >
                {BIN_WORDS.deleteQuietly}
              </Button>
            </>
          ) : (
            <Button
              variant="danger"
              loading={busy}
              onPress={() => void run(false)}
              testID="delete-confirm"
            >
              {blocked.length > 0 ? BIN_WORDS.submitRest(going.length) : BIN_WORDS.submit}
            </Button>
          )
        ) : null}
        <Button variant="ghost" onPress={onClose} testID="delete-keep">
          {BIN_WORDS.keep(several)}
        </Button>
      </View>
    </Sheet>
  );
}
