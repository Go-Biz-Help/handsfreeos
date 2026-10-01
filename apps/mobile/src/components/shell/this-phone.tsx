import * as React from 'react';
import { Linking, View } from 'react-native';

import { BellRing } from '@/components/icons';
import { List, ListRow } from '@/components/shell/list';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { pushRegistration } from '@/push/device';
import type { RegistrationSnapshot } from '@/push/registration';

/** Whether this phone gets notifications, and the way to turn them on. */
export function ThisPhone({ registration }: { registration: RegistrationSnapshot }) {
  const [asking, setAsking] = React.useState(false);
  const { status, permission, canAskAgain } = registration;
  const [label, detail] =
    status === 'no-project'
      ? [
          'Not in this build',
          'This build of the app isn’t set up for notifications, so this phone gets none.',
        ]
      : permission === 'denied' || (permission !== 'granted' && !canAskAgain)
        ? ['Off', 'Notifications for HandsFreeOS are turned off in this phone’s settings.']
        : permission !== 'granted'
          ? [
              'Not turned on',
              'Turn them on to hear about customers, urgent items and approvals here.',
            ]
          : status === 'registered'
            ? ['On', 'This phone gets the notifications you have on below.']
            : status === 'waiting-for-signal'
              ? ['Waiting for signal', 'This phone is added to your phones once there’s signal.']
              : status === 'failed'
                ? [
                    'Not added',
                    registration.message ?? 'HandsFreeOS couldn’t add this phone. Try again.',
                  ]
                : ['Setting up', 'Adding this phone to your phones…'];

  const turnOn = async () => {
    setAsking(true);
    try {
      const answer = await pushRegistration.ask();
      if (answer !== 'granted') toast.show('Notifications stay off on this phone.');
    } finally {
      setAsking(false);
    }
  };

  const action =
    status === 'failed' ? (
      <Button
        variant="secondary"
        onPress={() => void pushRegistration.sync()}
        testID="add-this-phone"
      >
        Try again
      </Button>
    ) : status === 'no-project' ||
      permission === 'granted' ||
      permission === null ? null : canAskAgain && permission !== 'denied' ? (
      <Button
        variant="secondary"
        loading={asking}
        onPress={() => void turnOn()}
        testID="turn-on-notifications"
      >
        Turn on notifications
      </Button>
    ) : (
      <Button
        variant="secondary"
        onPress={() => void Linking.openSettings()}
        testID="open-phone-settings"
      >
        Open the phone’s settings
      </Button>
    );

  return (
    <List>
      <View>
        <ListRow
          icon={BellRing}
          label="Notifications on this phone"
          detail={detail}
          end={
            <Text className="text-sm text-text-3" testID="this-phone-notifications">
              {label}
            </Text>
          }
          testID="this-phone-row"
        />
        {action ? <View className="px-4 pb-3">{action}</View> : null}
      </View>
    </List>
  );
}
