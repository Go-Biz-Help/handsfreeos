import { fmtTime, SAFETY_PHONE_WORDS } from '@hfos/core';
import * as React from 'react';
import { View } from 'react-native';

import { ShieldCheck, Users } from '@/components/icons';
import { useBusiness } from '@/components/shell/business-context';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Sheet } from '@/components/ui/sheet';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { errorMessage } from '@/lib/api';
import { hereOrNull } from '@/lib/location';
import { checkIn } from '@/safety/actions';
import { checkOutChoices, laterChoices } from '@/safety/check-in';
import { useMyContacts, type MyContact } from '@/safety/use-check-in-context';

/**
 * Checking in (board 90, first panel): where, when they'll check out, who's told if they don't, and whether to share
 * where they are. It works with no signal: the check-in is written on the phone at once, the reminder is set for the
 * planned end, and HandsFreeOS hears of it when it can. Offered from an appointment (a showing, a tour stop, an open
 * house), prefilled from it, or on its own.
 */
export function CheckInSheet({
  open,
  onClose,
  workspaceId,
  appointmentId,
  place,
  about,
  startsAt,
  endsAt,
}: {
  open: boolean;
  onClose: () => void;
  workspaceId: string;
  appointmentId?: string;
  /** Where: an address, or what it is. Asked for when left out. */
  place?: string;
  /** What it is, over the time: "Showing at 2207 Juniper Trail". */
  about?: string;
  startsAt?: string;
  endsAt?: string;
}) {
  const { business, userId } = useBusiness();
  const contacts = useMyContacts(workspaceId, userId);
  const tz = business.timezone || 'UTC';
  // The choices are fixed when the sheet opens, so they don't move under a finger.
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (open) setNow(Date.now());
  }, [open]);
  const choices = React.useMemo(() => checkOutChoices(endsAt ?? null, now), [endsAt, now]);
  const later = React.useMemo(() => laterChoices(now), [now]);
  const [picked, setPicked] = React.useState<string>('1');
  const [other, setOther] = React.useState<string | null>(null);
  const [where, setWhere] = React.useState(place ?? '');
  const [share, setShare] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => {
    if (!open) return;
    setPicked('1');
    setOther(null);
    setWhere(place ?? '');
  }, [open, place]);

  const plannedEnd = picked === 'other' ? (other ?? later[0]!) : choices[Number(picked)]!;
  const placeWords = where.trim();

  const go = async () => {
    if (!placeWords) {
      toast.error(SAFETY_PHONE_WORDS.needsPlace);
      return;
    }
    setBusy(true);
    try {
      const here = share ? await hereOrNull(5000) : null;
      await checkIn({
        workspaceId,
        userId,
        place: placeWords,
        plannedEndAt: plannedEnd,
        ...(appointmentId ? { appointmentId } : {}),
        ...(here ? { latitude: here.lat, longitude: here.lng, follow: true } : {}),
      });
      toast.show(SAFETY_PHONE_WORDS.checkedInToast(fmtTime(Date.parse(plannedEnd), tz)));
      onClose();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const timeOf = (iso: string) => fmtTime(Date.parse(iso), tz);
  const span =
    startsAt && endsAt
      ? `${timeOf(startsAt)}–${timeOf(endsAt)}`
      : startsAt
        ? timeOf(startsAt)
        : null;

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={SAFETY_PHONE_WORDS.checkInTitle}
      testID="check-in-sheet"
    >
      <View className="gap-4">
        {place ? (
          <Text className="text-[14.5px] text-text-2" testID="check-in-about">
            {[about ?? place, span].filter(Boolean).join(' · ')}
          </Text>
        ) : (
          <View className="gap-1.5">
            <Text className="text-[13px] text-text-2">{SAFETY_PHONE_WORDS.whereLabel}</Text>
            <Input
              value={where}
              onChangeText={setWhere}
              placeholder={SAFETY_PHONE_WORDS.wherePlaceholder}
              testID="check-in-place"
            />
          </View>
        )}
        <View className="gap-1.5">
          <Text className="text-[13px] text-text-2">{SAFETY_PHONE_WORDS.checkOutBy}</Text>
          <Segmented
            label={SAFETY_PHONE_WORDS.checkOutBy}
            value={picked}
            onChange={setPicked}
            options={[
              ...choices.map((c, i) => ({
                value: String(i),
                label: timeOf(c),
                testID: `check-in-end-${i}`,
              })),
              { value: 'other', label: SAFETY_PHONE_WORDS.other, testID: 'check-in-end-other' },
            ]}
          />
          {picked === 'other' ? (
            <Segmented
              label={SAFETY_PHONE_WORDS.other}
              value={other ?? later[0]!}
              onChange={setOther}
              options={later.map((c, i) => ({
                value: c,
                label: timeOf(c),
                testID: `check-in-later-${i}`,
              }))}
            />
          ) : null}
        </View>
        <ToldList contacts={contacts} />
        <View className="flex-row items-center gap-3">
          <Text className="flex-1 text-[15px]">{SAFETY_PHONE_WORDS.shareWhere}</Text>
          <Switch
            checked={share}
            onCheckedChange={setShare}
            label={SAFETY_PHONE_WORDS.shareWhere}
            testID="check-in-share"
          />
        </View>
        <Button icon={ShieldCheck} onPress={() => void go()} loading={busy} testID="check-in-go">
          {SAFETY_PHONE_WORDS.checkIn}
        </Button>
      </View>
    </Sheet>
  );
}

/** "If you don't, HandsFreeOS tells": the contacts who'd be told, or the business's safety person. */
export function ToldList({ contacts }: { contacts: readonly MyContact[] }) {
  const told = contacts.filter((c) => c.told);
  return (
    <View className="gap-1.5" testID="check-in-told">
      <Text className="text-[13px] text-text-2">{SAFETY_PHONE_WORDS.ifYouDont}</Text>
      {told.length === 0 ? (
        <Text className="text-[13.5px] leading-[19px] text-text-3">
          {SAFETY_PHONE_WORDS.nobodySet}
        </Text>
      ) : (
        <View className="overflow-hidden rounded-card border border-border">
          {told.map((c, i) => (
            <View
              key={c.id}
              className={`flex-row items-center gap-3 px-3.5 py-2.5 ${i > 0 ? 'border-t border-border' : ''}`}
            >
              <Icon as={Users} className="size-[18px] text-text-2" />
              <View className="min-w-0 flex-1">
                <Text className="text-[15px]">{c.name}</Text>
                <Text className="text-[12.5px] text-text-3">{c.line}</Text>
              </View>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}
