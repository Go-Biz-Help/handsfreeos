import { MORE_WORDS } from '@hfos/core';
import { router } from 'expo-router';
import { View } from 'react-native';

import {
  CircleDollarSign,
  ClipboardList,
  CloudCheck,
  Globe,
  Settings2,
  Sparkles,
  Users,
} from '@/components/icons';
import { ApprovalsCount } from '@/components/home/approvals-count';
import { businessHref, useBusiness } from '@/components/shell/business-context';
import { List, ListRow } from '@/components/shell/list';
import { Screen } from '@/components/shell/screen';
import { UpToDate } from '@/components/shell/up-to-date';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Text } from '@/components/ui/text';
import { ROLE_LABELS } from '@/lib/businesses';
import { openWeb } from '@/lib/open-web';

/** More: Customers, Tasks, Money, Approvals and Settings, then Open on the web for the desk work. */
export default function More() {
  const { me, business, userId, openSwitcher } = useBusiness();
  const name = me.user.fullName || me.user.email;
  const go = (path: string) => router.push(businessHref(business.id, path));
  return (
    <Screen title={MORE_WORDS.title} testID="more">
      <Card className="flex-row items-center gap-3 px-3.5 py-3">
        <Avatar name={name} seed={userId} size="lg" />
        <View className="min-w-0 flex-1 gap-px">
          <Text className="text-base font-semibold" numberOfLines={1}>
            {name}
          </Text>
          <Text className="text-[12.5px] text-text-3" numberOfLines={1}>
            {ROLE_LABELS[business.role]} · {business.name}
          </Text>
        </View>
        <Button variant="secondary" size="sm" onPress={openSwitcher} testID="more-switch-business">
          {MORE_WORDS.switch}
        </Button>
      </Card>
      <List>
        <ListRow
          icon={CloudCheck}
          label={MORE_WORDS.changes}
          end={<UpToDate compact />}
          onPress={() => go('changes')}
          testID="more-changes"
        />
      </List>
      <List>
        <ListRow
          icon={Users}
          label={MORE_WORDS.customers}
          onPress={() => go('customers')}
          testID="more-customers"
        />
        <ListRow
          icon={ClipboardList}
          label={MORE_WORDS.tasks}
          onPress={() => go('tasks')}
          testID="more-tasks"
        />
        <ListRow
          icon={CircleDollarSign}
          label={MORE_WORDS.money}
          onPress={() => go('money')}
          testID="more-money"
        />
        <ListRow
          icon={Sparkles}
          label={MORE_WORDS.approvals}
          end={<ApprovalsCount />}
          onPress={() => go('approvals')}
          testID="more-approvals"
        />
        <ListRow
          icon={Settings2}
          label={MORE_WORDS.settings}
          onPress={() => go('settings')}
          testID="more-settings"
        />
      </List>
      <List>
        <ListRow
          icon={Globe}
          label={MORE_WORDS.openOnWeb}
          detail={MORE_WORDS.openOnWebDetail}
          external
          onPress={() => void openWeb(`/app/w/${business.id}`)}
          testID="more-open-on-web"
        />
      </List>
    </Screen>
  );
}
