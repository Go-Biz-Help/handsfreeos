import type { LucideIcon } from 'lucide-react-native';
import { router } from 'expo-router';
import * as React from 'react';
import { ActivityIndicator, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CloudDownload, CloudOff, Database, Lock, ShieldAlert } from '@/components/icons';
import { AppBar } from '@/components/shell/app-bar';
import { businessHref, useBusiness } from '@/components/shell/business-context';
import { SignOutSheet } from '@/components/shell/sign-out-sheet';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { config, testToolsEnabled } from '@/lib/config';
import { openWeb } from '@/lib/open-web';
import { cn } from '@/lib/utils';
import { phoneCopy } from '@/sync';
import { useColors } from '@/theme';

/** A whole screen that says one thing: an icon, a heading, what it means, and what can be done. */
export function StateScreen({
  icon,
  tone = 'accent',
  title,
  body,
  children,
  actions,
  testID,
  bar,
}: {
  icon: LucideIcon;
  tone?: 'accent' | 'warning' | 'danger';
  title: string;
  body: string;
  children?: React.ReactNode;
  actions?: React.ReactNode;
  testID: string;
  /** The business's top bar, so the switcher is still one tap away. */
  bar?: boolean;
}) {
  const insets = useSafeAreaInsets();
  const tile = {
    accent: ['bg-accent-soft', 'text-accent-text'],
    warning: ['bg-warning-soft', 'text-warning-text'],
    danger: ['bg-danger-soft', 'text-danger-text'],
  }[tone];
  return (
    <View className="flex-1 bg-bg" testID={testID}>
      {bar ? <AppBar /> : <View style={{ height: insets.top }} />}
      <View className="flex-1 justify-center gap-3 px-7">
        <View className={cn('size-14 items-center justify-center rounded-card', tile[0])}>
          <Icon as={icon} className={cn('size-7', tile[1])} />
        </View>
        <Text variant="heading" testID={`${testID}-title`}>
          {title}
        </Text>
        <Text className="text-[15px] leading-[22px] text-text-2" testID={`${testID}-body`}>
          {body}
        </Text>
        {children}
      </View>
      <View className="gap-2 px-5" style={{ paddingBottom: Math.max(insets.bottom, 16) + 8 }}>
        {actions}
      </View>
    </View>
  );
}

/** The copy opens in a moment with the raw key; this shows only while it does. */
export function CopyOpening() {
  const colors = useColors();
  return (
    <View className="flex-1 items-center justify-center bg-bg" testID="copy-opening">
      <ActivityIndicator color={colors.accent} />
    </View>
  );
}

function SignOutButton() {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button variant="ghost" onPress={() => setOpen(true)} testID="copy-sign-out">
        Sign out
      </Button>
      <SignOutSheet open={open} onClose={() => setOpen(false)} />
    </>
  );
}

/**
 * The startup check failed: this build's SQLite isn't encrypting, so nothing about the business is stored on the phone.
 * Never falls back to plain SQLite.
 */
export function CantProtectCopy() {
  return (
    <StateScreen
      icon={ShieldAlert}
      tone="danger"
      title="This phone can’t keep a protected copy"
      body="HandsFreeOS keeps a business on a phone only when it’s locked to you, and this copy of the app can’t lock it. Nothing was saved. Use HandsFreeOS on the web, and install the app again from the App Store or Google Play."
      testID="copy-refused"
      actions={
        <>
          <Button onPress={() => void openWeb('/app')}>Open HandsFreeOS on the web</Button>
          <SignOutButton />
        </>
      }
    />
  );
}

export function CopyDidNotOpen({ message }: { message: string }) {
  const [busy, setBusy] = React.useState(false);
  return (
    <StateScreen
      icon={Database}
      tone="warning"
      title="Your businesses didn’t open"
      body="Something on this phone stopped HandsFreeOS opening what it keeps here. Try again, or sign out and back in."
      testID="copy-failed"
      actions={
        <>
          <Button
            loading={busy}
            onPress={() => {
              setBusy(true);
              void phoneCopy.retry().finally(() => setBusy(false));
            }}
            testID="copy-retry"
          >
            Try again
          </Button>
          <SignOutButton />
        </>
      }
    >
      {__DEV__ || config.e2e ? (
        <Text className="font-mono text-xs text-text-3">{message}</Text>
      ) : null}
    </StateScreen>
  );
}

function CopyScreenLink() {
  const { business } = useBusiness();
  if (!testToolsEnabled) return null;
  return (
    <Button
      variant="ghost"
      onPress={() => router.push(businessHref(business.id, 'phone-copy'))}
      testID="copy-open-tools"
    >
      This phone’s copy
    </Button>
  );
}

/** A business's first copy is still coming down: "Getting Lone Star HVAC & Roofing onto this phone… 40%". */
export function GettingCopy({
  percent,
  online,
  kept,
}: {
  percent: number | null;
  online: boolean;
  kept: boolean;
}) {
  const { business, openSwitcher } = useBusiness();
  const colors = useColors();
  if (!online)
    return (
      <StateScreen
        bar
        icon={CloudOff}
        tone="warning"
        title={`${business.name} isn’t on this phone yet`}
        body="It comes down as soon as this phone has signal. Until then it can’t open here."
        testID="copy-progress"
        actions={
          <>
            <Button variant="secondary" onPress={openSwitcher} testID="copy-switch">
              Switch business
            </Button>
            <CopyScreenLink />
          </>
        }
      />
    );
  return (
    <StateScreen
      bar
      icon={CloudDownload}
      title={`Getting ${business.name} onto this phone…${percent === null ? '' : ` ${percent}%`}`}
      body={
        kept
          ? 'It stays here, locked to you, and works with no signal once it’s done.'
          : 'It’s here while it’s open and leaves soon after. Keep it on this phone to use it with no signal.'
      }
      testID="copy-progress"
      actions={<CopyScreenLink />}
    >
      <View className="mt-2 h-1.5 overflow-hidden rounded-full bg-card-3">
        {percent === null ? (
          <ActivityIndicator size="small" color={colors.accent} />
        ) : (
          <View className="h-full rounded-full bg-accent" style={{ width: `${percent}%` }} />
        )}
      </View>
    </StateScreen>
  );
}

/** Thirty days without a completed sync: locked until it connects, with every waiting change kept. */
export function CopyLocked({ online }: { online: boolean }) {
  const colors = useColors();
  return (
    <StateScreen
      bar
      icon={Lock}
      tone="warning"
      title="Connect to bring this phone up to date"
      body="This phone hasn’t reached HandsFreeOS in more than 30 days, so what it keeps is locked until it does. Changes made on it are kept and go once it connects."
      testID="copy-locked"
      actions={
        <>
          <CopyScreenLink />
          <SignOutButton />
        </>
      }
    >
      <View className="mt-1 flex-row items-center gap-2" testID="copy-locked-status">
        {online ? (
          <ActivityIndicator size="small" color={colors.accent} />
        ) : (
          <Icon as={CloudOff} className="size-4 text-warning-text" />
        )}
        <Text className="text-[13.5px] text-text-2">
          {online ? 'Bringing this phone up to date…' : 'No signal right now.'}
        </Text>
      </View>
    </StateScreen>
  );
}
