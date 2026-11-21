import { ADD_CONTACT_WORDS as W } from '@hfos/core';
import * as React from 'react';
import { Pressable, View } from 'react-native';

import { ContactRound, Keyboard, ScanLine } from '@/components/icons';
import { Icon } from '@/components/ui/icon';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';

export type AddContactWay = 'scan' | 'type' | 'pick';

/** Contacts' + button: scan a business card, type someone in, or pick them from the phone's own contacts. */
export function AddContactSheet({
  open,
  onClose,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (way: AddContactWay) => void;
}) {
  const rows = [
    { way: 'scan', icon: ScanLine, title: W.scan, hint: W.scanHint },
    { way: 'type', icon: Keyboard, title: W.type, hint: W.typeHint },
    { way: 'pick', icon: ContactRound, title: W.pick, hint: W.pickHint },
  ] as const;
  return (
    <Sheet open={open} onClose={onClose} title={W.title} testID="add-contact-sheet">
      <View className="gap-1">
        {rows.map((row) => (
          <Pressable
            key={row.way}
            role="button"
            onPress={() => onPick(row.way)}
            className="min-h-16 flex-row items-center gap-3 rounded-menu px-2 py-2 active:bg-card-2"
            testID={`add-contact-${row.way}`}
          >
            <View className="size-10 items-center justify-center rounded-full bg-accent-soft">
              <Icon as={row.icon} className="size-5 text-accent-text" />
            </View>
            <View className="min-w-0 flex-1 gap-0.5">
              <Text className="text-[15px] font-semibold">{row.title}</Text>
              <Text className="text-[13px] text-text-2">{row.hint}</Text>
            </View>
          </Pressable>
        ))}
      </View>
    </Sheet>
  );
}
