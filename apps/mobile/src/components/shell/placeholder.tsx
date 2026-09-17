import type { LucideIcon } from 'lucide-react-native';
import { View } from 'react-native';

import { ExternalLink } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { openWeb } from '@/lib/open-web';

/**
 * An honest stand-in for a screen a later step builds: what will be here, and the same page on the web until then.
 */
export function Placeholder({
  icon,
  title,
  body,
  webPath,
  webLabel,
  testID,
}: {
  icon: LucideIcon;
  title: string;
  body: string;
  /** The page on the web, from the web app's root ("/app/w/<id>/inbox"). */
  webPath?: string;
  webLabel?: string;
  testID?: string;
}) {
  return (
    <Card className="items-center gap-3 px-5 py-8" testID={testID}>
      <View className="size-12 items-center justify-center rounded-card bg-accent-soft">
        <Icon as={icon} className="size-6 text-accent-text" />
      </View>
      <Text className="text-center text-[17px] font-semibold">{title}</Text>
      <Text className="text-center text-[14.5px] leading-[21px] text-text-2">{body}</Text>
      {webPath ? (
        <Button
          variant="secondary"
          icon={ExternalLink}
          className="mt-1 self-stretch"
          onPress={() => void openWeb(webPath)}
        >
          {webLabel ?? 'Open on the web'}
        </Button>
      ) : null}
    </Card>
  );
}
