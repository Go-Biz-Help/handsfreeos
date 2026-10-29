import { SENDER_WORDS, matchesSearch } from '@hfos/core';
import * as React from 'react';
import { Pressable, View } from 'react-native';

import { useCustomers, type CustomerChoice } from '@/calendar/use-calendar';
import { Avatar } from '@/components/ui/avatar';
import { Input } from '@/components/ui/input';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';

/** How many customers the sheet lists at once: a search narrows it, as New appointment's does. */
const SHOWN = 8;

/**
 * Linking a conversation from somebody not in Contacts to a customer who already is (the web's Link to an existing
 * customer): a search over the business's customers on this phone, by name, number or email, and a tap on who it is.
 * Before anything is typed, whoever already has the thread's number or address comes first.
 */
export function LinkPersonSheet({
  open,
  onClose,
  counterpart,
  note = null,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  /** The number or address this conversation is with, which joins their record. */
  counterpart: string;
  /** What else linking them does: someone's own mail is shared with the team too (M19). */
  note?: string | null;
  onPick: (customer: CustomerChoice) => Promise<boolean>;
}) {
  const customers = useCustomers();
  const [typed, setTyped] = React.useState('');
  const [busy, setBusy] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (open) setTyped('');
  }, [open]);
  const found = React.useMemo(() => {
    const wanted = typed.trim();
    if (wanted) return customers.filter((c) => matchesSearch(c.searchText, wanted)).slice(0, SHOWN);
    const theirs = customers.filter((c) => matchesSearch(c.searchText, counterpart));
    return [...theirs, ...customers.filter((c) => !theirs.includes(c))].slice(0, SHOWN);
  }, [customers, typed, counterpart]);
  const pick = (customer: CustomerChoice) => {
    if (busy) return;
    setBusy(customer.id);
    void onPick(customer)
      .then((ok) => ok && onClose())
      .finally(() => setBusy(null));
  };
  const description = SENDER_WORDS.linkDescription(counterpart);
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={SENDER_WORDS.linkTitle}
      description={note ? `${description} ${note}` : description}
      scroll
      testID="link-person-sheet"
    >
      <Input
        value={typed}
        onChangeText={setTyped}
        placeholder={SENDER_WORDS.search}
        accessibilityLabel={SENDER_WORDS.search}
        autoCorrect={false}
        autoCapitalize="none"
        className="mt-3"
        testID="link-person-search"
      />
      <View className="mt-2 gap-0.5">
        {found.map((c) => (
          <Pressable
            key={c.id}
            role="button"
            disabled={!!busy}
            onPress={() => pick(c)}
            className="min-h-12 flex-row items-center gap-3 rounded-menu px-2 active:bg-card-2"
            testID={`link-person-${c.id}`}
          >
            <Avatar name={c.name || '?'} seed={c.id} size="md" />
            <View className="min-w-0 flex-1">
              <Text numberOfLines={1} className="text-[15px]">
                {c.name}
              </Text>
              {c.address ? (
                <Text numberOfLines={1} className="text-[13px] text-text-3">
                  {c.address}
                </Text>
              ) : null}
            </View>
            {busy === c.id ? <Text className="text-[13px] text-text-3">…</Text> : null}
          </Pressable>
        ))}
        {typed.trim() && found.length === 0 ? (
          <Text className="px-2 py-3 text-[13px] text-text-2" testID="link-person-nobody">
            {SENDER_WORDS.nobody(typed.trim())}
          </Text>
        ) : null}
      </View>
    </Sheet>
  );
}
