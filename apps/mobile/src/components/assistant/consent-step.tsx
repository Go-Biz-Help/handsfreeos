import { assistantConsentWords, type ConsentPointIcon } from '@hfos/core';
import type { LucideIcon } from 'lucide-react-native';
import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Check, MessageCircle, ShieldCheck } from '@/components/icons';
import { BrandMark } from '@/components/shell/brand';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { errorMessage } from '@/lib/api';

const WORDS = assistantConsentWords('phone');
const ICONS: Record<ConsentPointIcon, LucideIcon> = {
  chat: MessageCircle,
  shield: ShieldCheck,
  check: Check,
};

/**
 * Before the first question, on the phone as on the web: what someone asks about goes to an AI service. "OK,
 * continue" keeps the OK with their account, so it's asked once for both; "Not now" closes the screen and it asks
 * again next time (design/m10/Assistant.dc.html, "The first time").
 */
export function ConsentStep({
  onAccept,
  onDecline,
}: {
  onAccept: () => Promise<void>;
  onDecline: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [busy, setBusy] = React.useState(false);
  return (
    <ScrollView
      className="flex-1"
      contentContainerClassName="gap-3.5 px-5 pt-6"
      contentContainerStyle={{ paddingBottom: insets.bottom + 20 }}
      testID="assistant-consent"
    >
      <View className="size-[52px] items-center justify-center rounded-[14px] bg-accent-soft">
        <BrandMark size={30} />
      </View>
      <Text className="text-xl font-semibold leading-[26px] tracking-[-0.2px]">{WORDS.title}</Text>
      <Text className="text-[14.5px] leading-[21px]">{WORDS.lead}</Text>
      <View className="gap-3">
        {WORDS.points.map((point) => (
          <View key={point.text} className="flex-row items-start gap-3">
            <Icon as={ICONS[point.icon]} className="mt-0.5 size-[18px] shrink-0 text-text-2" />
            <Text className="min-w-0 flex-1 text-sm leading-[20px]">{point.text}</Text>
          </View>
        ))}
      </View>
      <View className="gap-2 pt-2">
        <Button
          loading={busy}
          testID="assistant-consent-ok"
          onPress={() => {
            setBusy(true);
            void onAccept()
              .catch((e: unknown) => toast.error(errorMessage(e)))
              .finally(() => setBusy(false));
          }}
        >
          {WORDS.ok}
        </Button>
        <Button variant="ghost" onPress={onDecline} testID="assistant-consent-not-now">
          {WORDS.notNow}
        </Button>
      </View>
    </ScrollView>
  );
}
