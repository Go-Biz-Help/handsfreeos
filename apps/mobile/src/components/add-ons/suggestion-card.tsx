import type { SuggestionChoice } from '@hfos/core';
import { router } from 'expo-router';
import * as React from 'react';
import { View } from 'react-native';

import { businessHref, useBusiness } from '@/components/shell/business-context';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { useAddonGrants, useAddonSuggestion } from '@/add-ons/use-add-ons';
import { ADDON_PHONE_WORDS } from '@/add-ons/words';
import { errorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';

import { AddonTile } from './addon-bits';

/** How many of what it would let the business do the card names; the add-on's own screen has the rest. */
const DOES_SHOWN = 3;

/**
 * Now and then, on Home, a small card for an owner or an admin: an add-on that fits what the business does
 * (`addon.suggestion`, which decides whether there is one and keeps it rare). See it opens the add-on's own screen;
 * Not now and Not interested set it aside at once. Nobody who can't add add-ons is ever asked about one, and with
 * nothing to suggest (always, until the first add-on ships) there's nothing here at all.
 */
export function AddonSuggestionCard({ className }: { className?: string }) {
  const { business, userId } = useBusiness();
  const { manage } = useAddonGrants();
  const { suggestion, dismiss } = useAddonSuggestion(business.id, userId, manage);
  if (!suggestion) return null;

  const setAside = (choice: SuggestionChoice) => {
    dismiss(choice)
      .then(() =>
        toast.show(
          choice === 'not_now'
            ? ADDON_PHONE_WORDS.notNowDone
            : ADDON_PHONE_WORDS.notInterestedDone(suggestion.name),
        ),
      )
      .catch((e: unknown) => toast.error(errorMessage(e)));
  };
  const does = suggestion.does.slice(0, DOES_SHOWN);

  return (
    <Card className={cn('gap-3 px-3.5 py-3', className)} testID="addon-suggestion">
      <View className="flex-row items-start gap-3">
        <AddonTile state={null} />
        <View className="min-w-0 flex-1 gap-0.5">
          <Text className="text-[11.5px] font-semibold uppercase tracking-[0.5px] text-text-3">
            {ADDON_PHONE_WORDS.suggested}
          </Text>
          <Text className="text-[15px] font-semibold" testID="addon-suggestion-name">
            {suggestion.name}
          </Text>
          {suggestion.summary ? (
            <Text className="text-[13.5px] leading-[19px] text-text-2">{suggestion.summary}</Text>
          ) : null}
          {does.length ? (
            <Text className="text-xs leading-[17px] text-text-3" testID="addon-suggestion-does">
              {does.join(' · ')}
            </Text>
          ) : null}
        </View>
      </View>
      <View className="flex-row flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          onPress={() => router.push(businessHref(business.id, `add-ons/${suggestion.addonId}`))}
          testID="addon-suggestion-see"
        >
          {ADDON_PHONE_WORDS.seeIt}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onPress={() => setAside('not_now')}
          testID="addon-suggestion-not-now"
        >
          {ADDON_PHONE_WORDS.notNow}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onPress={() => setAside('not_interested')}
          testID="addon-suggestion-not-interested"
        >
          {ADDON_PHONE_WORDS.notInterested}
        </Button>
      </View>
    </Card>
  );
}
