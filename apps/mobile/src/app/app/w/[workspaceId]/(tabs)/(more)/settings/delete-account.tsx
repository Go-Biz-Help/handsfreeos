import { router } from 'expo-router';
import { View } from 'react-native';

import { Building, Trash, UserX } from '@/components/icons';
import { businessHref, useBusiness } from '@/components/shell/business-context';
import { Screen } from '@/components/shell/screen';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';

/**
 * Delete my account. What it does is settled (the plan's "Account deletion"); the command that does it arrives with
 * the worker's account deletion (M10 step 6), so the button waits for it. Typing your email to confirm comes with it.
 */
export default function DeleteAccount() {
  const { business } = useBusiness();
  return (
    <Screen
      leading="back"
      back={businessHref(business.id, 'settings')}
      testID="delete-account"
      contentClassName="gap-3.5"
    >
      <View className="gap-1.5 px-0.5 pt-1">
        <Text variant="heading">Delete my account</Text>
        <Text className="leading-[22px] text-text-2">
          Your sign-in and your name are removed, and you’re signed out everywhere.
        </Text>
      </View>
      <View className="overflow-hidden rounded-card border border-border bg-card">
        <View className="flex-row items-start gap-3 px-3.5 py-3">
          <Icon as={UserX} className="mt-0.5 size-5 text-danger-text" />
          <View className="min-w-0 flex-1 gap-0.5">
            <Text className="font-medium">Removed</Text>
            <Text className="text-[13px] leading-[18px] text-text-3">
              Your sign-in, your name and photo, and your place at {business.name}
            </Text>
          </View>
        </View>
        <View className="flex-row items-start gap-3 border-t border-border px-3.5 py-3">
          <Icon as={Building} className="mt-0.5 size-5 text-text-2" />
          <View className="min-w-0 flex-1 gap-0.5">
            <Text className="font-medium">Kept by the business</Text>
            <Text className="text-[13px] leading-[18px] text-text-3">
              The customers, messages, jobs and notes you worked on, shown as from a former teammate
            </Text>
          </View>
        </View>
      </View>
      <View className="rounded-menu bg-card-2 px-3 py-[11px]" testID="delete-account-waiting">
        <Text className="text-[13.5px] leading-5 text-text-2">
          Deleting an account isn’t switched on yet. It arrives in a coming update, on the phone and
          on the web.
        </Text>
      </View>
      <View className="gap-2">
        <Button variant="danger" icon={Trash} disabled>
          Delete my account
        </Button>
        <Button variant="ghost" onPress={() => router.back()}>
          Keep my account
        </Button>
      </View>
    </Screen>
  );
}
