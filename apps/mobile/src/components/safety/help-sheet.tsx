import { SAFETY_PHONE_WORDS } from '@hfos/core';
import * as React from 'react';
import { Linking, Platform, View } from 'react-native';

import { change } from '@/changes';
import { MessageSquare, Phone } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { hereOrNull } from '@/lib/location';
import { useNetwork } from '@/lib/network';
import type { MyContact } from '@/safety/use-check-in-context';

/**
 * Help (board 90, last panel): the emergency path never depends on HandsFreeOS. The phone's own calling and texting
 * are always here (911, and the person's contacts with a number); with signal, HandsFreeOS also tells their contacts
 * at once with where they are (`safety.help`). It never calls 911 for them.
 */

const firstOf = (name: string) => name.trim().split(/\s+/)[0] ?? name;

/** The phone's own texting app, with the words written: `sms:` takes the body after `&` on iPhones, `?` elsewhere. */
export function smsLink(phone: string, body: string, os: string = Platform.OS): string {
  return `sms:${phone}${os === 'ios' ? '&' : '?'}body=${encodeURIComponent(body)}`;
}

/** The contacts to reach from the phone itself: outside ones by text, teammates by a call, each with a number. */
export function reachable(
  contacts: readonly MyContact[],
): { contact: MyContact; how: 'text' | 'call' }[] {
  return contacts
    .filter((c) => c.phone && c.status !== 'stopped')
    .slice(0, 3)
    .map((c) => ({ contact: c, how: c.teammateUserId ? ('call' as const) : ('text' as const) }));
}

export function HelpSheet({
  open,
  onClose,
  workspaceId,
  checkInId,
  place,
  contacts,
}: {
  open: boolean;
  onClose: () => void;
  workspaceId: string;
  checkInId: string | null;
  place: string;
  contacts: readonly MyContact[];
}) {
  const { online } = useNetwork();
  const told = contacts.filter((c) => c.told).map((c) => firstOf(c.name));
  const [sent, setSent] = React.useState(false);

  // Opening Help with signal tells the contacts at once; with none, the phone's own buttons are all there is.
  React.useEffect(() => {
    if (!open || !online || sent) return;
    let cancelled = false;
    void (async () => {
      const here = await hereOrNull(5000);
      if (cancelled) return;
      try {
        await change('safety.help', {
          workspaceId,
          ...(checkInId ? { checkInId } : { place }),
          ...(here ? { latitude: here.lat, longitude: here.lng } : {}),
        });
        if (!cancelled) setSent(true);
      } catch {
        // The phone's own buttons below still work; nothing more to say here.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, online, sent, workspaceId, checkInId, place]);
  React.useEffect(() => {
    if (!open) setSent(false);
  }, [open]);

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={SAFETY_PHONE_WORDS.helpTitle}
      description={sent ? SAFETY_PHONE_WORDS.helpSent(told) : SAFETY_PHONE_WORDS.helpNoSignal}
      testID="help-sheet"
    >
      <View className="gap-2.5">
        <Button
          variant="danger"
          icon={Phone}
          onPress={() => void Linking.openURL('tel:911')}
          testID="help-911"
        >
          {SAFETY_PHONE_WORDS.call911}
        </Button>
        {reachable(contacts).map(({ contact, how }) => (
          <Button
            key={contact.id}
            variant="secondary"
            icon={how === 'text' ? MessageSquare : Phone}
            onPress={() =>
              void Linking.openURL(
                how === 'text'
                  ? smsLink(contact.phone!, SAFETY_PHONE_WORDS.helpText(place))
                  : `tel:${contact.phone!}`,
              )
            }
            testID={`help-${how}-${contact.id}`}
          >
            {how === 'text'
              ? SAFETY_PHONE_WORDS.textFromPhone(contact.name)
              : SAFETY_PHONE_WORDS.call(contact.name)}
          </Button>
        ))}
        <Text className="text-[12.5px] leading-[17px] text-text-3">
          {SAFETY_PHONE_WORDS.helpNote(told)}
        </Text>
      </View>
    </Sheet>
  );
}
