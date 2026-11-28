import { KEYBOARD_SETUP_WORDS, relativeTimeAgo } from '@hfos/core';
import * as React from 'react';
import { AppState, Linking, Platform, View } from 'react-native';

import { CircleCheck, Info, Keyboard, RefreshCw } from '@/components/icons';
import { businessHref, useBusiness } from '@/components/shell/business-context';
import { Screen } from '@/components/shell/screen';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import {
  keyboardState,
  openKeyboardSettings,
  showKeyboardPicker,
  type KeyboardState,
} from '@/keyboard/device';
import {
  readKeyboardSeenStamp,
  readStoredKeyboard,
  refreshKeyboard,
  useKeyboardStatus,
} from '@/keyboard/store';

const W = KEYBOARD_SETUP_WORDS;

/**
 * Settings → Phone keyboard (docs/phone-keyboard.md): whether the HandsFreeOS keyboard is on, the steps to turn it on
 * (iOS's Settings, Android's keyboard list), what's on it, and why the phone's warning about keyboards is safe here.
 * Everything on it is about this phone, so nothing here is a command, and the Assistant can only explain it.
 */
export default function KeyboardSettings() {
  const { business, me } = useBusiness();
  const status = useKeyboardStatus();
  const ios = Platform.OS === 'ios';
  const [state, setState] = React.useState<KeyboardState | null>(() => keyboardState());
  const [seen, setSeen] = React.useState(() => readKeyboardSeenStamp());

  // Back from the phone's settings: read where the keyboard stands again.
  React.useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next !== 'active') return;
      setState(keyboardState());
      setSeen(readKeyboardSeenStamp());
    });
    return () => sub.remove();
  }, []);

  // Read again whenever the copy is saved.
  const stored = React.useMemo(() => readStoredKeyboard(), [status.version]);
  const onIt = stored?.businesses.find((b) => b.id === business.id) ?? null;

  const working = ios ? !!seen?.fullAccess : !!state?.enabled;
  const statusLine = ios
    ? seen?.fullAccess
      ? W.status.iosWorking
      : W.status.iosNotSeen
    : state?.current
      ? W.status.androidCurrent
      : state?.enabled
        ? W.status.androidOn
        : W.status.androidOff;

  const steps = ios ? W.iosSteps : W.androidSteps;

  const update = async () => {
    await refreshKeyboard();
    toast.show(W.updatedToast);
  };

  return (
    <Screen
      title={W.title}
      leading="back"
      back={businessHref(business.id, 'settings')}
      testID="keyboard-settings"
      contentClassName="gap-3"
    >
      <Text variant="lead">{W.intro}</Text>

      <View
        className={`flex-row items-start gap-2 rounded-card px-3.5 py-3 ${working ? 'bg-success-soft' : 'bg-accent-soft'}`}
        testID="keyboard-status"
      >
        <Icon
          as={working ? CircleCheck : Keyboard}
          className={`mt-0.5 size-4 ${working ? 'text-success-text' : 'text-accent-text'}`}
        />
        <Text
          className={`min-w-0 flex-1 text-[14px] leading-[20px] ${working ? 'text-success-text' : 'text-accent-text'}`}
        >
          {statusLine}
        </Text>
      </View>

      <Card className="gap-2.5 px-4 py-3.5">
        {steps.map((step, i) => (
          <View key={step} className="flex-row gap-2.5">
            <Text className="w-5 text-[14px] font-semibold text-text-2">{i + 1}.</Text>
            <Text className="min-w-0 flex-1 text-[14px] leading-[20px]">{step}</Text>
          </View>
        ))}
      </Card>

      {ios ? (
        <Button onPress={() => void Linking.openSettings()} testID="keyboard-open-settings">
          {W.openSettings}
        </Button>
      ) : (
        <View className="gap-2">
          <Button
            variant={state?.enabled ? 'secondary' : 'primary'}
            onPress={() => {
              openKeyboardSettings();
            }}
            testID="keyboard-turn-on"
          >
            {W.turnOn}
          </Button>
          {state?.enabled ? (
            <Button
              onPress={() => {
                showKeyboardPicker();
              }}
              testID="keyboard-switch"
            >
              {W.switchKeyboard}
            </Button>
          ) : null}
        </View>
      )}

      <Text variant="group" className="mt-2 px-1">
        {W.onItTitle}
      </Text>
      <Card className="gap-1.5 px-4 py-3.5" testID="keyboard-on-it">
        <Text className="text-[14px] leading-[20px]">
          {onIt ? W.onIt(onIt.templates.length, onIt.links.length, onIt.name) : W.nothingYet}
        </Text>
        {onIt ? <Text variant="small">{W.updated(relativeTimeAgo(onIt.updatedAt))}</Text> : null}
        {status.problem === 'signal' ? (
          <Text className="text-[13px] leading-[18px] text-warning-text">
            {W.templatesNeedSignal}
          </Text>
        ) : status.problem === 'not_yours' ? (
          <Text className="text-[13px] leading-[18px] text-text-2">{W.templatesNotYours}</Text>
        ) : null}
        {me.businesses.length > 1 ? (
          <Text className="text-[13px] leading-[18px] text-text-2">{W.otherBusinesses}</Text>
        ) : null}
        <Button
          variant="secondary"
          size="md"
          icon={RefreshCw}
          className="mt-1.5 self-start"
          loading={status.refreshing}
          onPress={() => void update()}
          testID="keyboard-update"
        >
          {status.refreshing ? W.updating : W.update}
        </Button>
      </Card>

      <Text variant="group" className="mt-2 px-1">
        {W.privacyTitle}
      </Text>
      <View className="flex-row items-start gap-2 px-1">
        <Icon as={Info} className="mt-0.5 size-4 text-text-3" />
        <Text className="min-w-0 flex-1 text-[13px] leading-[19px] text-text-2">
          {ios ? W.privacyIos : W.privacyAndroid}
        </Text>
      </View>
    </Screen>
  );
}
