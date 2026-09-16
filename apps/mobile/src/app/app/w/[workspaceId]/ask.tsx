import * as Linking from 'expo-linking';
import { View } from 'react-native';

import { CloudOff, ExternalLink } from '@/components/icons';
import { BrandMark } from '@/components/shell/brand';
import { useBusiness } from '@/components/shell/business-context';
import { Screen } from '@/components/shell/screen';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { config } from '@/lib/config';
import { useNetwork } from '@/lib/network';

/** Ask HandsFreeOS, full screen. The Assistant itself arrives in M10 step 17; it always needs signal. */
export default function Ask() {
  const { business } = useBusiness();
  const { online } = useNetwork();
  return (
    <Screen
      title="Ask HandsFreeOS"
      leading="close"
      ask={false}
      testID="ask"
      contentClassName="flex-1"
    >
      <View className="flex-1 items-center justify-center gap-3 px-5 py-10">
        {online ? (
          <BrandMark size={56} />
        ) : (
          <View className="size-14 items-center justify-center rounded-card bg-card-2">
            <Icon as={CloudOff} className="size-7 text-text-2" />
          </View>
        )}
        <Text className="text-center text-[19px] font-semibold">
          {online ? 'Ask HandsFreeOS here soon' : 'The Assistant needs signal'}
        </Text>
        <Text className="text-center leading-[22px] text-text-2">
          {online
            ? 'The Assistant arrives on the phone in a coming update, with the same answers and confirm cards as on the web.'
            : 'Ask again when you’re back online.'}
        </Text>
        {online ? (
          <Button
            variant="secondary"
            icon={ExternalLink}
            className="mt-1 self-stretch"
            onPress={() => void Linking.openURL(`${config.webUrl}/app/w/${business.id}`)}
          >
            Ask on the web
          </Button>
        ) : null}
      </View>
    </Screen>
  );
}
