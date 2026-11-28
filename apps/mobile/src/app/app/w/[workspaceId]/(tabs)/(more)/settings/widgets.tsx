import { relativeTimeAgo, WIDGET_GALLERY, WIDGET_SCREEN_WORDS, type WidgetKind } from '@hfos/core';
import * as React from 'react';
import { Platform, View } from 'react-native';

import { EyeOff, Info, LayoutGrid, RefreshCw } from '@/components/icons';
import { businessHref, useBusiness } from '@/components/shell/business-context';
import { Screen } from '@/components/shell/screen';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { useLens } from '@/view-as/use-lens';
import {
  readStoredWidgets,
  refreshWidgets,
  setWidgetsHideNames,
  useWidgetsStatus,
  widgetsHideNames,
} from '@/widgets/store';

const W = WIDGET_SCREEN_WORDS;

/** The widgets each phone offers: the lock screen's is an iPhone's. */
const KINDS: readonly WidgetKind[] = [
  'myday',
  'today',
  'needs',
  'quick',
  'money',
  'outreach',
  'ask',
];

/**
 * Settings → Home-screen widgets (docs/phone-widgets.md): how to add HandsFreeOS to the home screen (and an iPhone's
 * lock screen), which widgets there are, Hide names on widgets, what they show now and Update now. Everything on it is
 * about this phone, so nothing here is a command, and the Assistant can only explain it.
 */
export default function WidgetsSettings() {
  const { business, me } = useBusiness();
  const lens = useLens();
  const status = useWidgetsStatus();
  const ios = Platform.OS === 'ios';
  const userId = me.user.id;
  const hideNames = React.useMemo(() => widgetsHideNames(userId), [userId, status.version]);
  const stored = React.useMemo(() => readStoredWidgets(), [status.version]);
  const kinds: readonly WidgetKind[] = ios ? [...KINDS, 'lock'] : KINDS;

  const update = async () => {
    await refreshWidgets();
    toast.show(W.updatedToast);
  };

  return (
    <Screen
      title={W.title}
      leading="back"
      back={businessHref(business.id, 'settings')}
      testID="widgets-settings"
      contentClassName="gap-3"
    >
      <Text variant="lead">{W.intro}</Text>

      <Text variant="group" className="mt-2 px-1">
        {ios ? W.howIphoneTitle : W.howAndroidTitle}
      </Text>
      <Card className="gap-2.5 px-4 py-3.5" testID="widgets-steps">
        {(ios ? W.howIphone : W.howAndroid).map((step, i) => (
          <View key={step} className="flex-row gap-2.5">
            <Text className="w-5 text-[14px] font-semibold text-text-2">{i + 1}.</Text>
            <Text className="min-w-0 flex-1 text-[14px] leading-[20px]">{step}</Text>
          </View>
        ))}
      </Card>

      <Card className="gap-2 px-4 py-3.5">
        <View className="flex-row items-center gap-3">
          <Icon as={EyeOff} className="size-[18px] text-text-2" />
          <Text className="min-w-0 flex-1 text-[15px] font-medium">{W.hideNames}</Text>
          <Switch
            label={W.hideNames}
            testID="widgets-hide-names"
            checked={hideNames}
            onCheckedChange={(next) => setWidgetsHideNames(userId, next)}
          />
        </View>
        <Text className="text-[13px] leading-[19px] text-text-2">{W.hideNamesHelp}</Text>
      </Card>

      <Card className="gap-1.5 px-4 py-3.5" testID="widgets-status">
        <Text className="text-[14px] leading-[20px]">
          {stored
            ? W.status(stored.business.name, relativeTimeAgo(stored.updatedAt))
            : W.statusNone}
        </Text>
        {lens ? (
          <Text className="text-[13px] leading-[18px] text-text-2">{W.viewingAs}</Text>
        ) : (
          <Button
            variant="secondary"
            size="md"
            icon={RefreshCw}
            className="mt-1.5 self-start"
            loading={status.refreshing}
            onPress={() => void update()}
            testID="widgets-update"
          >
            {status.refreshing ? W.updating : W.updateNow}
          </Button>
        )}
      </Card>

      <Text variant="group" className="mt-2 px-1">
        {W.kindsTitle}
      </Text>
      <Card className="gap-3 px-4 py-3.5" testID="widgets-kinds">
        {kinds.map((kind) => (
          <View key={kind} className="flex-row items-start gap-3">
            <Icon as={LayoutGrid} className="mt-0.5 size-4 text-accent-text" />
            <View className="min-w-0 flex-1">
              <Text className="text-[14px] font-medium">{WIDGET_GALLERY[kind].name}</Text>
              <Text className="text-[13px] leading-[18px] text-text-2">
                {WIDGET_GALLERY[kind].description}
              </Text>
            </View>
          </View>
        ))}
      </Card>

      <Text variant="group" className="mt-2 px-1">
        {W.whenTitle}
      </Text>
      <View className="flex-row items-start gap-2 px-1">
        <Icon as={Info} className="mt-0.5 size-4 text-text-3" />
        <Text className="min-w-0 flex-1 text-[13px] leading-[19px] text-text-2">{W.when}</Text>
      </View>
    </Screen>
  );
}
