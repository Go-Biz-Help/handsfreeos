import { router } from 'expo-router';
import { View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { isKept, keepChoices, rememberOpened, type Business, type Me } from '@/lib/businesses';
import { useNetwork } from '@/lib/network';
import { useWorksOffline } from '@/sync/hooks';

import { BusinessList, KeepNote } from './business-list';
import { businessHref } from './business-context';

/** The business switcher, opened from the business mark at the top left of every screen. */
export function BusinessSwitcher({
  open,
  onClose,
  userId,
  me,
  currentId,
}: {
  open: boolean;
  onClose: () => void;
  userId: string;
  me: Me;
  currentId: string;
}) {
  const { online } = useNetwork();
  const worksOffline = useWorksOffline(userId);
  const openBusiness = (business: Business) => {
    if (business.id === currentId) return onClose();
    if (!online && !worksOffline(business.id)) {
      toast.show(
        isKept(keepChoices(userId), business.id)
          ? `${business.name} isn’t on this phone yet.`
          : `${business.name} opens only with signal.`,
      );
      return;
    }
    rememberOpened(userId, business.id);
    onClose();
    router.replace(businessHref(business.id));
  };
  return (
    <Sheet open={open} onClose={onClose} scroll testID="business-switcher">
      <Text variant="sheetTitle">Businesses</Text>
      <Text className="mb-3 mt-1 text-sm text-text-2" numberOfLines={1}>
        {me.user.fullName ? `${me.user.fullName} · ${me.user.email}` : me.user.email}
      </Text>
      <BusinessList
        userId={userId}
        businesses={me.businesses}
        currentId={currentId}
        onOpen={openBusiness}
        offline={!online}
      />
      <View className="mt-3">
        <KeepNote />
      </View>
      <Button
        variant="secondary"
        className="mt-3"
        onPress={onClose}
        testID="business-switcher-close"
      >
        Close
      </Button>
    </Sheet>
  );
}
