import { fmtTime, SAFETY_PHONE_WORDS } from '@hfos/core';
import * as React from 'react';
import { View } from 'react-native';

import { CircleAlert, Clock, MapPin, ShieldCheck } from '@/components/icons';
import { useOptionalBusiness } from '@/components/shell/business-context';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { errorMessage } from '@/lib/api';
import { addTime, checkOut } from '@/safety/actions';
import type { ActiveCheckIn } from '@/safety/check-in';
import { useActiveCheckIn, useFollowedCheckIn, useFollowEnds } from '@/safety/use-check-in';
import { useMyContacts, type MyContact } from '@/safety/use-check-in-context';

import { HelpSheet } from './help-sheet';

/**
 * The banner on every screen while the person is checked in (board 90): where, until when, who's told if they don't
 * check out, and Check out, +15 min and Help. Past the planned end it asks "Are you OK?". All of it works with no
 * signal; Help leads to the phone's own calling and texting.
 */
export function CheckInBanner() {
  const business = useOptionalBusiness();
  if (!business) return null;
  return (
    <Banner
      workspaceId={business.business.id}
      userId={business.userId}
      timeZone={business.business.timezone || 'UTC'}
    />
  );
}

function Banner({
  workspaceId,
  userId,
  timeZone,
}: {
  workspaceId: string;
  userId: string;
  timeZone: string;
}) {
  const active = useActiveCheckIn(workspaceId, userId);
  const contacts = useMyContacts(workspaceId, userId);
  const followed = useFollowedCheckIn();
  useFollowEnds(workspaceId, userId);
  if (!active) return null;
  return (
    <CheckInStrip
      active={active}
      contacts={contacts}
      timeZone={timeZone}
      sharing={followed === active.id}
    />
  );
}

const firstOf = (name: string) => name.trim().split(/\s+/)[0] ?? name;

export function CheckInStrip({
  active,
  contacts,
  timeZone,
  sharing = false,
}: {
  active: ActiveCheckIn;
  contacts: readonly MyContact[];
  timeZone: string;
  /** This phone is sharing where it is until the check-out (round seven). */
  sharing?: boolean;
}) {
  const [help, setHelp] = React.useState(false);
  const [busy, setBusy] = React.useState<'out' | 'add' | null>(null);
  const until = fmtTime(Date.parse(active.plannedEndAt), timeZone);
  const told = contacts.filter((c) => c.told).map((c) => firstOf(c.name));
  const ref = { workspaceId: active.workspaceId, checkInId: active.id };

  const run = async (which: 'out' | 'add') => {
    setBusy(which);
    try {
      if (which === 'out') {
        await checkOut(ref);
        toast.show(SAFETY_PHONE_WORDS.checkedOut);
      } else {
        await addTime(ref, 15);
        toast.show(
          SAFETY_PHONE_WORDS.added(
            fmtTime(Math.max(Date.parse(active.plannedEndAt), Date.now()) + 15 * 60_000, timeZone),
          ),
        );
      }
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <View
      className={`gap-2 border-b px-4 py-2.5 ${active.overdue ? 'border-warning-soft bg-warning-soft' : 'border-success-soft bg-success-soft'}`}
      testID="check-in-banner"
    >
      <View className="flex-row items-center gap-2.5">
        <Icon
          as={active.overdue ? CircleAlert : ShieldCheck}
          className={`size-[18px] ${active.overdue ? 'text-warning-text' : 'text-success-text'}`}
        />
        <View className="min-w-0 flex-1">
          <Text
            className={`text-[13.5px] ${active.overdue ? 'text-warning-text' : 'text-success-text'}`}
            numberOfLines={1}
          >
            <Text className="font-semibold">{SAFETY_PHONE_WORDS.checkedIn}</Text> · {active.place}
          </Text>
          <Text
            className={`text-[12.5px] leading-[17px] ${active.overdue ? 'text-warning-text' : 'text-success-text'}`}
            testID="check-in-banner-line"
          >
            {active.overdue
              ? SAFETY_PHONE_WORDS.overdue(until)
              : SAFETY_PHONE_WORDS.until(until, told)}
          </Text>
          {sharing ? (
            <View className="flex-row items-center gap-1" testID="check-in-banner-sharing">
              <Icon
                as={MapPin}
                className={`size-[13px] ${active.overdue ? 'text-warning-text' : 'text-success-text'}`}
              />
              <Text
                className={`text-[12.5px] leading-[17px] ${active.overdue ? 'text-warning-text' : 'text-success-text'}`}
              >
                {SAFETY_PHONE_WORDS.followingTitle}
              </Text>
            </View>
          ) : null}
        </View>
        <Button
          variant="secondary"
          size="sm"
          loading={busy === 'out'}
          onPress={() => void run('out')}
          testID="check-in-out"
        >
          {active.overdue ? SAFETY_PHONE_WORDS.imOk : SAFETY_PHONE_WORDS.checkOut}
        </Button>
      </View>
      <View className="flex-row gap-2">
        <Button
          variant="secondary"
          size="sm"
          icon={Clock}
          className="flex-1"
          loading={busy === 'add'}
          onPress={() => void run('add')}
          testID="check-in-add-15"
        >
          {SAFETY_PHONE_WORDS.add15}
        </Button>
        <Button
          variant="danger"
          size="sm"
          icon={CircleAlert}
          className="flex-1"
          onPress={() => setHelp(true)}
          testID="check-in-help"
        >
          {SAFETY_PHONE_WORDS.help}
        </Button>
      </View>
      <HelpSheet
        open={help}
        onClose={() => setHelp(false)}
        workspaceId={active.workspaceId}
        checkInId={active.id}
        place={active.place}
        contacts={contacts}
      />
    </View>
  );
}
