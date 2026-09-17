import {
  CALL_SHEET_WORDS,
  cellVerifiedOn,
  CONTACT_CARD_WORDS,
  CONVERSATION_ACTIONS,
  formatPhone,
  MY_CELL_WORDS,
  normalizePhone,
} from '@hfos/core';
import { useQuery } from '@powersync/react-native';
import { useLocalSearchParams } from 'expo-router';
import * as React from 'react';
import { Platform, View } from 'react-native';

import { Check, ContactRound, PhoneCall, Plus, ShieldCheck, Smartphone } from '@/components/icons';
import { businessHref, useBusiness } from '@/components/shell/business-context';
import { Screen } from '@/components/shell/screen';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { change, ChangeError, NEEDS_SIGNAL } from '@/changes';
import { refusalOf } from '@/changes/rules';
import { startCall, type CallTarget } from '@/inbox/calls';
import { useBusinessNumber, useMyCell } from '@/inbox/cell';
import { addBusinessContact, setContactCardState, useContactCardState } from '@/inbox/contact-card';
import { useNetwork } from '@/lib/network';
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
  const { online } = useNetwork();
  const { cell, loading } = useMyCell();
  const number = useBusinessNumber(business.id);
  const [editing, setEditing] = React.useState(false);
  const [typed, setTyped] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  /** The number a verification call just went to, while the screen waits for the press of 1. */
  const [calling, setCalling] = React.useState<string | null>(null);
  const card = useContactCardState(userId, number?.e164 ?? null);

  const target: CallTarget | null = params.callConversation
    ? { conversationId: params.callConversation }
    : params.callPerson
      ? { personId: params.callPerson }
      : null;
  const customer = useCallCustomer(target);

  // The press of 1 arrives as the synced row's verified_at.
  const verified = cell?.verifiedAt ? cell : null;
  React.useEffect(() => {
    if (calling && verified && verified.e164 === calling) {
      setCalling(null);
      toast.show(MY_CELL_WORDS.isVerified(calling));
    }
  }, [calling, verified]);

  const showForm = editing || (!loading && !cell);
  const typedE164 = normalizePhone(typed);

  const verify = async (phone: string) => {
    setError(null);
    if (!phone.trim()) {
      setError(MY_CELL_WORDS.enterNumber);
      return;
    }
    setBusy(true);
    try {
      const result = await change('user_phone.start_verification', {
        workspaceId: business.id,
        phone: normalizePhone(phone) ?? phone.trim(),
      });
      if (result.output.status === 'verified')
        toast.show(MY_CELL_WORDS.alreadyVerified(result.output.e164));
      else setCalling(result.output.e164);
      setEditing(false);
    } catch (e) {
      const body = e instanceof ChangeError ? refusalOf(e.body) : null;
      const field = Array.isArray(body?.details)
        ? (body.details as { path?: string; message?: string }[]).find((d) => d.path === 'phone')
        : undefined;
      const message = field?.message ?? (e instanceof Error ? e.message : String(e));
      if (e instanceof ChangeError && e.kind === 'needs-signal') toast.error(NEEDS_SIGNAL);
      else setError(message);
    } finally {
      setBusy(false);
    }
  };

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

      <Card className="gap-3.5 p-3.5">
        <View className="flex-row items-start gap-3">
          <View className="size-9 items-center justify-center rounded-[9px] bg-accent-soft">
            <Icon as={Smartphone} className="size-[18px] text-accent-text" />
          </View>
          <View className="min-w-0 flex-1 gap-0.5">
            <Text className="text-base font-semibold">{MY_CELL_WORDS.title}</Text>
            <Text className="text-[13px] leading-[18px] text-text-2">
              {MY_CELL_WORDS.intro.phone}
            </Text>
          </View>
        </View>

        {showForm ? (
          <>
            <View className="gap-1.5">
              <Label nativeID="my-cell-number-label">{MY_CELL_WORDS.numberLabel}</Label>
              <Input
                value={typed}
                onChangeText={(t) => {
                  setTyped(t);
                  setError(null);
                }}
                keyboardType="phone-pad"
                autoComplete="tel"
                textContentType="telephoneNumber"
                placeholder={MY_CELL_WORDS.placeholder}
                invalid={!!error}
                aria-labelledby="my-cell-number-label"
                testID="my-cell-input"
              />
              {error ? (
                <Text role="alert" className="text-[13px] text-danger-text" testID="my-cell-error">
                  {error}
                </Text>
              ) : null}
            </View>
            {!number ? (
              <Text className="text-[13px] leading-[18px] text-text-2" testID="my-cell-no-number">
                {MY_CELL_WORDS.noNumber(business.name)}
              </Text>
            ) : null}
            <Button
              icon={PhoneCall}
              loading={busy}
              disabled={!number || !online}
              onPress={() => void verify(typed)}
              testID="verify-my-cell"
            >
              {MY_CELL_WORDS.verify}
            </Button>
            <Text className="text-center text-[13px] text-text-3" testID="my-cell-hint">
              {!online
                ? CALL_SHEET_WORDS.needsSignal
                : typedE164
                  ? MY_CELL_WORDS.calling(typedE164)
                  : ' '}
            </Text>
            {cell ? (
              <Button variant="ghost" onPress={() => setEditing(false)} testID="my-cell-cancel">
                {MY_CELL_WORDS.cancel}
              </Button>
            ) : null}
          </>
        ) : cell ? (
          <View className="min-h-[60px] flex-row items-center gap-3 rounded-menu bg-card-2 px-3.5 py-2.5">
            <View className="min-w-0 flex-1 gap-0.5">
              <Text className="text-[16px] font-medium" testID="my-cell-number">
                {formatPhone(cell.e164)}
              </Text>
              <Text className="text-xs text-text-3" testID="my-cell-status">
                {cell.verifiedAt
                  ? cellVerifiedOn(cell.verifiedAt)
                  : calling
                    ? MY_CELL_WORDS.waiting
                    : MY_CELL_WORDS.notVerified}
              </Text>
            </View>
            {cell.verifiedAt ? (
              <Badge
                variant="ok"
                className="h-6 flex-row items-center gap-1 rounded-full px-2.5"
                testID="my-cell-verified"
              >
                <Icon as={Check} className="size-3" strokeWidth={2} />
                <Text className="text-[12.5px] font-medium">{MY_CELL_WORDS.verified}</Text>
              </Badge>
            ) : null}
            <Button
              variant="secondary"
              size="sm"
              onPress={() => {
                setTyped(formatPhone(cell.e164));
                setCalling(null);
                setEditing(true);
              }}
              testID="my-cell-change"
            >
              {MY_CELL_WORDS.change}
            </Button>
          </View>
        ) : null}

        {cell && !cell.verifiedAt && !showForm ? (
          <>
            {calling ? (
              <Text className="text-[13px] leading-[18px] text-text-2" testID="my-cell-calling">
                {MY_CELL_WORDS.calling(calling)}
              </Text>
            ) : null}
            <Button
              icon={PhoneCall}
              variant={calling ? 'secondary' : 'primary'}
              loading={busy}
              disabled={!number || !online}
              onPress={() => void verify(cell.e164)}
              testID="verify-again"
            >
              {MY_CELL_WORDS.verify}
            </Button>
          </>
        ) : null}
      </Card>

      {!verified && number ? (
        <View className="flex-row items-start gap-2 rounded-card bg-card-2 px-3.5 py-3">
          <Icon as={ShieldCheck} className="mt-0.5 size-4 text-text-3" />
          <Text
            className="min-w-0 flex-1 text-[13px] leading-[19px] text-text-2"
            testID="my-cell-calls-from"
          >
            {MY_CELL_WORDS.callsFrom(business.name, number.e164)}
          </Text>
        </View>
      ) : null}

      {verified && target ? (
        <Button icon={PhoneCall} onPress={() => startCall(target)} testID="my-cell-call">
          {customer ? `${CONVERSATION_ACTIONS.call} ${customer}` : CONVERSATION_ACTIONS.call}
        </Button>
      ) : null}

      {verified && number && card === null ? (
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
          <Button
            variant="ghost"
            onPress={() => setContactCardState(userId, number.e164, 'dismissed')}
            testID="contact-not-now"
          >
            {CONTACT_CARD_WORDS.notNow}
          </Button>
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
