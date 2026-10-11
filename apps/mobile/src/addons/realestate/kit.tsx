import { RE_PHONE_WORDS } from '@hfos/core/addons/realestate/phone-words';
import { router, type Href } from 'expo-router';
import * as React from 'react';
import { View } from 'react-native';

import { CloudOff } from '@/components/icons';
import { businessHref, useBusiness } from '@/components/shell/business-context';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { useGrants } from '@/lib/grants';
import { useNetwork } from '@/lib/network';

import { useBusinessToday } from './copy';

/**
 * What every Real Estate screen on the phone shares (round six): who is looking and when, where its screens live, and
 * how a screen says what the phone holds and what waits for signal. Screens read the phone's copy (`copy.ts`) and
 * hand it to core's views; this is the rest.
 */

/** Real Estate's permissions, as its manifest names them. */
export const RE_USE = 'realestate.use';
export const RE_ALL_DEALS = 'realestate.all_deals';
export const RE_EXCEPT = 'realestate.except';
export const RE_MANAGE = 'realestate.manage';
export const RE_EXPORT = 'realestate.export';

/** A Real Estate screen's address on the phone: the web's own, `/app/w/<business>/a/realestate/<path>`. */
export const reHref = (workspaceId: string, path = ''): Href =>
  businessHref(workspaceId, `a/realestate${path ? `/${path}` : ''}`) as Href;

/** Opens one of Real Estate's screens. */
export const openRe = (workspaceId: string, path = '') => router.push(reHref(workspaceId, path));

export interface ReContext {
  readonly workspaceId: string;
  /** Who the screens are for (the teammate, while viewing as one). */
  readonly userId: string;
  /** The minute now, moving on by itself, so "due today" and "late" turn over while a screen stays open. */
  readonly now: number;
  /** The business's today, where the business is (YYYY-MM-DD). */
  readonly today: string;
  readonly timeZone: string;
  /** Sees every deal (`realestate.all_deals`): their own in full, the rest as summary. */
  readonly seesEveryDeal: boolean;
  /** Whether the person holds one of the add-on's permissions here. */
  holds(permission: string): boolean;
}

function useMinute(): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

export function useReContext(): ReContext {
  const { business, me } = useBusiness();
  const grants = useGrants();
  const now = useMinute();
  const today = useBusinessToday(business.id, business.timezone, now);
  const permissions = grants.permissions;
  return React.useMemo(() => {
    const holds = (p: string) => permissions?.includes(p) ?? false;
    return {
      workspaceId: business.id,
      userId: me.user.id,
      now,
      today,
      timeZone: business.timezone || 'UTC',
      seesEveryDeal: holds(RE_ALL_DEALS),
      holds,
    };
  }, [business.id, business.timezone, me.user.id, now, today, permissions]);
}

/** "Summary, duties and dates on this phone": a deal the person sees only as whoever sees every deal. */
export function SummaryChip() {
  return (
    <Badge variant="gray" testID="re-summary-chip">
      <Text>{RE_PHONE_WORDS.summaryChip}</Text>
    </Badge>
  );
}

/** A page of a deal kept as its summary, or of the server's alone, with no signal: what it is and to try again. */
export function NeedsSignalCard({
  words,
  onRetry,
  testID,
}: {
  words: string;
  onRetry?: () => void;
  testID?: string;
}) {
  return (
    <Card className="items-center gap-3 px-5 py-8" testID={testID ?? 're-needs-signal'}>
      <Icon as={CloudOff} className="size-6 text-text-3" />
      <Text className="text-center text-[14.5px] leading-[21px] text-text-2">{words}</Text>
      {onRetry ? (
        <Button variant="secondary" className="self-stretch" onPress={onRetry} testID="re-retry">
          {RE_PHONE_WORDS.tryAgain}
        </Button>
      ) : null}
    </Card>
  );
}

/**
 * A button for something that needs signal (a draft the AI writes, an exception, a term confirmed): with no signal it
 * says "Needs signal" and doesn't press, and the line under it says why.
 */
export function SignalButton({
  label,
  why,
  onPress,
  variant = 'primary',
  disabled,
  testID,
}: {
  label: string;
  /** "Writing a draft needs signal (the AI)." */
  why?: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'danger';
  disabled?: boolean;
  testID?: string;
}) {
  const { online } = useNetwork();
  return (
    <View className="gap-1.5">
      <Button
        variant={variant}
        disabled={disabled || !online}
        onPress={onPress}
        testID={testID}
        accessibilityHint={online ? undefined : RE_PHONE_WORDS.needsSignal}
      >
        {online ? label : RE_PHONE_WORDS.needsSignal}
      </Button>
      {!online && why ? (
        <Text
          className="text-[12.5px] leading-[17px] text-text-3"
          testID={testID && `${testID}-why`}
        >
          {why}
        </Text>
      ) : null}
    </View>
  );
}

/** One answer from HandsFreeOS for what the phone doesn't keep: shared with Social Outreach, in `@/lib/live-answer`. */
export { useLiveAnswer, type LiveAnswer } from '@/lib/live-answer';
