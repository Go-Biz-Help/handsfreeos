import { VIEW_AS_WORDS } from '@hfos/core';
import { router } from 'expo-router';
import * as React from 'react';
import { Pressable, View } from 'react-native';

import { UserRoundSearch } from '@/components/icons';
import { businessHref, useOptionalBusiness } from '@/components/shell/business-context';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { useNetwork } from '@/lib/network';
import { refreshView, stopView } from '@/view-as/actions';
import type { PhoneView } from '@/view-as/state';

/**
 * Under the top bar of every business screen while viewing as a teammate (20261018000100): whose view it is, that it's
 * read-only, and the way back to the person's own.
 */
export function ViewStrip() {
  const view = useOptionalBusiness()?.viewing;
  const [busy, setBusy] = React.useState(false);
  if (!view) return null;
  const stop = async () => {
    setBusy(true);
    await stopView(view);
    setBusy(false);
    router.replace(businessHref(view.workspaceId));
  };
  return (
    <View
      className="min-h-10 flex-row items-center gap-2 border-b border-accent-soft bg-accent-soft pl-3.5 pr-2"
      testID="view-strip"
    >
      <Icon as={UserRoundSearch} className="size-[17px] text-accent-text" />
      <Text
        className="flex-1 text-[13.5px] font-semibold text-accent-text"
        numberOfLines={1}
        testID="view-strip-text"
      >
        {VIEW_AS_WORDS.bannerShort(view.person)}
      </Text>
      <Pressable
        role="button"
        onPress={() => void stop()}
        disabled={busy}
        className="min-h-10 justify-center px-2"
        testID="view-strip-stop"
      >
        <Text className="text-[13.5px] font-semibold text-accent-text underline">
          {busy ? VIEW_AS_WORDS.stopping : VIEW_AS_WORDS.stop}
        </Text>
      </Pressable>
    </View>
  );
}

/**
 * Keeps what the teammate sees up to date whenever signal comes back, and drops a view that has ended elsewhere (or that
 * the person may no longer see through), saying so once.
 */
export function KeepViewFresh({ view }: { view: PhoneView }) {
  const { online } = useNetwork();
  const viewId = view.viewId;
  const latest = React.useRef(view);
  latest.current = view;
  React.useEffect(() => {
    if (!online) return;
    let cancelled = false;
    void refreshView(latest.current).then((outcome) => {
      if (!cancelled && outcome === 'ended') toast.show(VIEW_AS_WORDS.ended);
    });
    return () => {
      cancelled = true;
    };
  }, [online, viewId]);
  return null;
}
