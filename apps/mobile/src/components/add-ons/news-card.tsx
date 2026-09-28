import { router } from 'expo-router';
import * as React from 'react';
import { View } from 'react-native';

import { PartyPopper, Rocket } from '@/components/icons';
import { businessHref, useBusiness } from '@/components/shell/business-context';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { useAddonGrants, useAddonNews } from '@/add-ons/use-add-ons';
import { ADDON_PHONE_WORDS } from '@/add-ons/words';
import { errorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';

/**
 * Home's note to an owner or admin whose business voted for an add-on (0109, `addon.news`): it's coming soon, or it's
 * ready to add. See it opens Settings → Add-ons (the add-on's own screen once it can be added); Got it sets the note
 * aside for this person. Nobody who can't vote ever sees one.
 */
export function AddonNewsCard({ className }: { className?: string }) {
  const { business, userId } = useBusiness();
  const { manage } = useAddonGrants();
  const { news, gotIt } = useAddonNews(business.id, userId, manage);
  if (!news) return null;
  const shipped = news.kind === 'shipped';

  return (
    <Card className={cn('gap-3 px-3.5 py-3', className)} testID="addon-news">
      <View className="flex-row items-start gap-3">
        <View className="size-9 items-center justify-center rounded-[10px] bg-accent-soft">
          <Icon as={shipped ? PartyPopper : Rocket} className="size-[18px] text-accent-text" />
        </View>
        <View className="min-w-0 flex-1 gap-0.5">
          <Text className="text-[15px] font-semibold" testID="addon-news-title">
            {shipped
              ? ADDON_PHONE_WORDS.newsShipped(news.name)
              : ADDON_PHONE_WORDS.newsPicked(news.name)}
          </Text>
          <Text className="text-[13.5px] leading-[19px] text-text-2">
            {shipped ? ADDON_PHONE_WORDS.newsShippedDetail : ADDON_PHONE_WORDS.newsPickedDetail}
          </Text>
        </View>
      </View>
      <View className="flex-row flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          onPress={() =>
            router.push(
              businessHref(
                business.id,
                shipped ? `settings/add-ons/${news.addonId}` : 'settings/add-ons',
              ),
            )
          }
          testID="addon-news-see"
        >
          {ADDON_PHONE_WORDS.seeIt}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onPress={() => void gotIt().catch((e: unknown) => toast.error(errorMessage(e)))}
          testID="addon-news-got-it"
        >
          {ADDON_PHONE_WORDS.gotIt}
        </Button>
      </View>
    </Card>
  );
}
