import { ClipboardPen } from '@/components/icons';
import { router } from 'expo-router';
import * as React from 'react';
import { View } from 'react-native';

import { businessHref, useBusiness } from '@/components/shell/business-context';
import { List, ListRow } from '@/components/shell/list';
import { Screen } from '@/components/shell/screen';
import { Text } from '@/components/ui/text';
import { usePhoneForms } from '@/forms/use-forms';

/**
 * The forms this phone can fill in (M17), reached from More.
 *
 * Only the live ones, from the phone's own copy, so the list is there in a basement. A business with no
 * published form sees why the screen is empty rather than an empty screen.
 */
export default function Forms() {
  const { business } = useBusiness();
  const { forms, loading } = usePhoneForms();
  return (
    <Screen title="Forms" testID="forms">
      {forms.length === 0 ? (
        <View className="gap-1 px-1 py-6">
          <Text className="text-[15px] font-medium">
            {loading ? 'Looking…' : 'No forms to fill in'}
          </Text>
          {loading ? null : (
            <Text className="text-[13px] text-text-2">
              Forms your business has published show up here, and you can fill one in with no
              signal. Build them on the web.
            </Text>
          )}
        </View>
      ) : (
        <List>
          {forms.map((form) => (
            <ListRow
              key={form.id}
              icon={ClipboardPen}
              label={form.name}
              onPress={() => router.push(businessHref(business.id, `forms/${form.id}`))}
              testID={`form-${form.id}`}
            />
          ))}
        </List>
      )}
    </Screen>
  );
}
