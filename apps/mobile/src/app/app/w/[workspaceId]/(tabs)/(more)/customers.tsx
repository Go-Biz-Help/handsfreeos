import { useQuery } from '@powersync/react-native';
import { View } from 'react-native';

import { Users } from '@/components/icons';
import { useBusiness } from '@/components/shell/business-context';
import { Placeholder } from '@/components/shell/placeholder';
import { Screen } from '@/components/shell/screen';
import { Text } from '@/components/ui/text';
import type { PeopleRow } from '@/sync/app-schema';

/** Customers arrives in M10 step 15. Until then it says how many are on the phone, read live from the copy. */
export default function Customers() {
  const { business } = useBusiness();
  const { data: count } = useQuery<{ n: number }>(
    'SELECT count(*) AS n FROM people WHERE workspace_id = ? AND archived_at IS NULL',
    [business.id],
  );
  const { data: newest } = useQuery<Pick<PeopleRow, 'first_name' | 'last_name'>>(
    `SELECT first_name, last_name FROM people WHERE workspace_id = ? AND archived_at IS NULL
       ORDER BY created_at DESC LIMIT 1`,
    [business.id],
  );
  const n = count[0]?.n ?? 0;
  const name = [newest[0]?.first_name, newest[0]?.last_name].filter(Boolean).join(' ');
  return (
    <Screen title="Customers" leading="back" testID="customers">
      <Placeholder
        icon={Users}
        title="Customers on the phone"
        body="People and companies, with their timeline, notes, tags, files and photos."
        webPath={`/app/w/${business.id}/customers`}
        webLabel="Open Customers on the web"
      />
      <View className="px-1">
        <Text className="text-center text-[13.5px] text-text-3" testID="customers-on-phone">
          {n === 0
            ? 'No customers are on this phone yet.'
            : `${n === 1 ? '1 customer is' : `${n} customers are`} on this phone${name ? `, the newest ${name}` : ''}.`}
        </Text>
      </View>
    </Screen>
  );
}
