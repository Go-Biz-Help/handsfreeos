import { View } from 'react-native';

import { BusinessList, KeepNote } from '@/components/shell/business-list';
import { businessHref, useBusiness } from '@/components/shell/business-context';
import { Screen } from '@/components/shell/screen';
import { useNetwork } from '@/lib/network';

/** Settings → Businesses on this phone: the "Keep on this phone" switch for each business. */
export default function BusinessesOnThisPhone() {
  const { me, business, userId } = useBusiness();
  const { online } = useNetwork();
  return (
    <Screen
      title="Businesses on this phone"
      leading="back"
      back={businessHref(business.id, 'settings')}
      testID="businesses-on-this-phone"
    >
      <BusinessList
        userId={userId}
        businesses={me.businesses}
        currentId={business.id}
        offline={!online}
      />
      <View>
        <KeepNote />
      </View>
    </Screen>
  );
}
