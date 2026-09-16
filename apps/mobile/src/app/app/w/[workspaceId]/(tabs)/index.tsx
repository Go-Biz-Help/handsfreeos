import { View } from 'react-native';

import { House } from '@/components/icons';
import { useBusiness } from '@/components/shell/business-context';
import { Placeholder } from '@/components/shell/placeholder';
import { Screen } from '@/components/shell/screen';
import { UpToDate } from '@/components/shell/up-to-date';
import { Text } from '@/components/ui/text';
import { useSession } from '@/lib/auth';
import { greeting } from '@/lib/greeting';

/** Home: the Action Center arrives in M10 step 13. For now, the top band and what will be here. */
export default function Home() {
  const { me, business } = useBusiness();
  const state = useSession();
  const fullName =
    me.user.fullName || (state.status === 'signedIn' ? (state.person.name ?? '') : '');
  return (
    <Screen
      title="Home"
      testID="home"
      contentClassName="p-0"
      header={
        <View className="gap-0.5 border-b border-border bg-card px-4 pb-3 pt-3">
          <View className="flex-row items-center justify-between gap-2">
            <Text
              className="flex-1 text-[13px] text-text-3"
              numberOfLines={1}
              testID="home-greeting"
            >
              {greeting(fullName.split(' ')[0] ?? '', business.timezone)}
            </Text>
            <UpToDate />
          </View>
          <Text
            className="text-[22px] font-semibold tracking-[-0.2px]"
            numberOfLines={2}
            testID="home-business"
          >
            {business.name}
          </Text>
        </View>
      }
    >
      <View className="p-3">
        <Placeholder
          icon={House}
          title="What needs you shows here"
          body="Home will list the same cards as Home on the web: hot leads, customers waiting, approvals and money owed, with Handle and Let HandsFreeOS Handle."
          webPath={`/app/w/${business.id}`}
          webLabel="Open Home on the web"
          testID="home-placeholder"
        />
      </View>
    </Screen>
  );
}
