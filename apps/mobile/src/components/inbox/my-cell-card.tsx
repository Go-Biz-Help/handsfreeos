import {
  CALL_SHEET_WORDS,
  cellVerifiedOn,
  formatPhone,
  MY_CELL_WORDS,
  normalizePhone,
} from '@hfos/core';
import * as React from 'react';
import { View } from 'react-native';

import { Check, PhoneCall, ShieldCheck, Smartphone } from '@/components/icons';
import { useBusiness } from '@/components/shell/business-context';
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
import { useBusinessNumber, useMyCell } from '@/inbox/cell';
import { useNetwork } from '@/lib/network';

/**
 * Your cell, and verifying it: HandsFreeOS calls it from the business's number, and pressing 1 on that call confirms
 * it; the phone's copy shows the moment it's verified. My cell phone (Settings) and quick setup's "Stay in the loop"
 * both show it, each with its own title and the line under it.
 */
export function MyCellCard({
  title = MY_CELL_WORDS.title,
  intro = MY_CELL_WORDS.intro.phone,
}: {
  title?: string;
  intro?: string;
}) {
  const { business } = useBusiness();
  const { online } = useNetwork();
  const { cell, loading } = useMyCell();
  const number = useBusinessNumber(business.id);
  const [editing, setEditing] = React.useState(false);
  const [typed, setTyped] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  /** The number a verification call just went to, while the card waits for the press of 1. */
  const [calling, setCalling] = React.useState<string | null>(null);

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

  return (
    <>
      <Card className="gap-3.5 p-3.5" testID="my-cell-card">
        <View className="flex-row items-start gap-3">
          <View className="size-9 items-center justify-center rounded-[9px] bg-accent-soft">
            <Icon as={Smartphone} className="size-[18px] text-accent-text" />
          </View>
          <View className="min-w-0 flex-1 gap-0.5">
            <Text className="text-base font-semibold">{title}</Text>
            <Text className="text-[13px] leading-[18px] text-text-2">{intro}</Text>
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
    </>
  );
}
