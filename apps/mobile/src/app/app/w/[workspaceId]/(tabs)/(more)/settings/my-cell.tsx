import { CONTACT_CARD_WORDS, CONVERSATION_ACTIONS, formatPhone, MY_CELL_WORDS } from '@hfos/core';
import { useQuery } from '@powersync/react-native';
import { useLocalSearchParams } from 'expo-router';
import { Platform, View } from 'react-native';

import { ContactRound, PhoneCall, Plus } from '@/components/icons';
import { MyCellCard } from '@/components/inbox/my-cell-card';
import { businessHref, useBusiness } from '@/components/shell/business-context';
import { Screen } from '@/components/shell/screen';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { startCall, type CallTarget } from '@/inbox/calls';
import { useBusinessNumber, useMyCell } from '@/inbox/cell';
import { addBusinessContact, setContactCardState, useContactCardState } from '@/inbox/contact-card';
import { businessMark } from '@/lib/utils';

/**
 * My cell phone (the Calls canvas): the number HandsFreeOS rings first when you press Call. Verify my cell has
 * HandsFreeOS call it from the business's number, and pressing 1 on that call confirms it; the phone's copy shows the
 * moment it's verified. Then the contacts card offers to add the business's number to Contacts. Opened from Call with
 * no verified cell, it offers that call once the cell is verified.
 */
export default function MyCell() {
  const params = useLocalSearchParams<{ callConversation?: string; callPerson?: string }>();
  const { business, userId } = useBusiness();
  const { cell } = useMyCell();
  const number = useBusinessNumber(business.id);
  const card = useContactCardState(userId, number?.e164 ?? null);

  const target: CallTarget | null = params.callConversation
    ? { conversationId: params.callConversation }
    : params.callPerson
      ? { personId: params.callPerson }
      : null;
  const customer = useCallCustomer(target);

  const verified = cell?.verifiedAt ? cell : null;

  const addContact = async () => {
    if (!number) return;
    const result = await addBusinessContact(business.name, number.e164);
    if (result === 'added') {
      setContactCardState(userId, number.e164, 'added');
      toast.show(CONTACT_CARD_WORDS.added(business.name));
    } else if (result === 'opened') setContactCardState(userId, number.e164, 'added');
    else if (result === 'unavailable') toast.error(CONTACT_CARD_WORDS.noContactsApp);
  };

  return (
    <Screen
      title={MY_CELL_WORDS.title}
      leading="back"
      back={businessHref(business.id, 'settings')}
      testID="my-cell"
      contentClassName="gap-3"
    >
      {target && !verified ? (
        <View
          className="flex-row items-start gap-2 rounded-card bg-accent-soft px-3.5 py-3"
          testID="verify-first"
        >
          <Icon as={PhoneCall} className="mt-0.5 size-4 text-accent-text" />
          <Text className="min-w-0 flex-1 text-[13.5px] leading-[19px] text-accent-text">
            {MY_CELL_WORDS.verifyFirst(customer)}
          </Text>
        </View>
      ) : null}

      <MyCellCard />

      {verified && target ? (
        <Button icon={PhoneCall} onPress={() => startCall(target)} testID="my-cell-call">
          {customer ? `${CONVERSATION_ACTIONS.call} ${customer}` : CONVERSATION_ACTIONS.call}
        </Button>
      ) : null}

      {verified && number ? (
        <Card className="gap-3 border-accent-soft-2 p-3.5" testID="contact-card">
          <View className="flex-row items-start gap-3">
            <View className="size-9 items-center justify-center rounded-[9px] bg-accent-soft">
              <Icon as={ContactRound} className="size-[18px] text-accent-text" />
            </View>
            <View className="min-w-0 flex-1 gap-1">
              <Text className="text-base font-semibold leading-[22px]">
                {Platform.OS === 'ios'
                  ? CONTACT_CARD_WORDS.title(business.name)
                  : CONTACT_CARD_WORDS.titleAndroid(business.name)}
              </Text>
              <Text className="text-[13px] leading-[19px] text-text-2">
                {Platform.OS === 'ios'
                  ? CONTACT_CARD_WORDS.body(number.e164)
                  : CONTACT_CARD_WORDS.bodyAndroid(number.e164)}
              </Text>
            </View>
          </View>
          <View className="flex-row items-center gap-3 rounded-menu bg-card-2 px-3 py-2.5">
            <View className="size-8 items-center justify-center rounded-full bg-accent">
              <Text className="text-[11px] font-bold text-white">
                {businessMark(business.name)}
              </Text>
            </View>
            <View className="min-w-0 flex-1">
              <Text numberOfLines={1} className="text-[14px] font-medium">
                {business.name}
              </Text>
              <Text className="text-xs text-text-3">
                {CONTACT_CARD_WORDS.contactLine(number.e164)}
              </Text>
            </View>
          </View>
          <Button icon={Plus} onPress={() => void addContact()} testID="contact-add">
            {CONTACT_CARD_WORDS.add}
          </Button>
          {card === 'added' ? (
            <Text className="text-center text-[12.5px] text-text-3" testID="contact-added">
              {CONTACT_CARD_WORDS.added(business.name)}
            </Text>
          ) : null}
        </Card>
      ) : null}
    </Screen>
  );
}

/** The customer a call waits for, by name, from the copy. */
function useCallCustomer(target: CallTarget | null): string | null {
  const { data } = useQuery<{
    first_name: string | null;
    last_name: string | null;
    counterpart: string | null;
  }>(
    target?.conversationId
      ? `SELECT p.first_name, p.last_name, c.counterpart FROM conversations c
         LEFT JOIN people p ON p.id = c.person_id WHERE c.id = ?`
      : 'SELECT first_name, last_name, NULL AS counterpart FROM people WHERE id = ?',
    [target?.conversationId ?? target?.personId ?? ''],
  );
  const row = data[0];
  if (!row) return null;
  const name = `${row.first_name ?? ''} ${row.last_name ?? ''}`.trim();
  return name || (row.counterpart ? formatPhone(row.counterpart) : null);
}
