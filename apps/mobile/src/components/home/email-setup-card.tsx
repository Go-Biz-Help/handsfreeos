import {
  EMAIL_SETUP_WORDS as W,
  emailSetupHomeOf,
  holds,
  onboardingSetupHomeOf,
  onboardingSetupOf,
  type EmailSetupHome,
} from '@hfos/core';
import { router } from 'expo-router';
import * as React from 'react';
import { View } from 'react-native';

import { Mail } from '@/components/icons';
import { businessHref, useBusiness } from '@/components/shell/business-context';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { emailSetupCalls } from '@/email-setup/calls';
import { useWorkspaceRow } from '@/home/use-home';
import { deviceStore } from '@/lib/device-store';
import { useGrants } from '@/lib/grants';
import { useNetwork } from '@/lib/network';
import { cn } from '@/lib/utils';

const REST_MS = 7 * 24 * 60 * 60 * 1000;
const keyOf = (workspaceId: string, kind: EmailSetupHome['kind']) =>
  `emailSetupNotNow.${workspaceId}.${kind}`;

/**
 * Home's "Set up your business email" (the owner's 7a), as on the web: for someone who can change the business's
 * email, outside the guided setup (which asks it as its own stop), while it still sends from the address it was made
 * with, or "Finish your email records" while its domain's records are on their way (emailSetupHomeOf). Asked of
 * HandsFreeOS as Home opens, since the phone's copy doesn't keep email addresses. Set it up opens the email
 * screens on a screen of their own; Not now sets the card aside on this phone for a week.
 */
export function EmailSetupCard({ className }: { className?: string }) {
  const { business, userId } = useBusiness();
  const { online } = useNetwork();
  const grants = useGrants();
  const { settings } = useWorkspaceRow();
  const outsideSetup = React.useMemo(() => {
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = settings ? (JSON.parse(settings) as Record<string, unknown>) : null;
    } catch {
      parsed = null;
    }
    const s = onboardingSetupHomeOf(onboardingSetupOf(parsed), userId);
    return s.finished || !s.started;
  }, [settings, userId]);
  const allowed = holds(grants, 'channels.manage') && outsideSetup;
  const [home, setHome] = React.useState<EmailSetupHome | null>(null);
  const [rested, setRested] = React.useState(0);

  React.useEffect(() => {
    if (!allowed || !online) return;
    let cancelled = false;
    emailSetupCalls(business.id)
      .get()
      .then((got) => {
        if (!cancelled) setHome(emailSetupHomeOf(got.state));
      })
      .catch(() => {
        // A nicety: Home carries on without it.
      });
    return () => {
      cancelled = true;
    };
  }, [allowed, online, business.id]);

  if (!allowed || !home) return null;
  const at = deviceStore.get<number>(keyOf(business.id, home.kind)) ?? 0;
  if (Date.now() - at < REST_MS || rested) return null;
  const records = home.kind === 'records';

  return (
    <Card className={cn('gap-3 px-3.5 py-3', className)} testID="email-setup-card">
      <View className="flex-row items-start gap-3">
        <View className="size-8 items-center justify-center rounded-menu bg-accent-soft">
          <Icon as={Mail} className="size-4 text-accent-text" />
        </View>
        <View className="min-w-0 flex-1 gap-0.5">
          <Text className="text-[15px] font-semibold">
            {records ? W.homeRecordsTitle : W.homeStartTitle}
          </Text>
          <Text className="text-[13.5px] leading-[19px] text-text-2">
            {home.kind === 'records'
              ? W.homeRecordsBody(home.found, home.of, home.host, home.from, home.to)
              : W.homeStartBody(home.address)}
          </Text>
        </View>
      </View>
      <View className="flex-row flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          onPress={() =>
            router.push(businessHref(business.id, `email-setup${records ? '?at=records' : ''}`))
          }
          testID="email-setup-card-open"
        >
          {records ? W.homeRecords : W.homeStart}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onPress={() => {
            deviceStore.set(keyOf(business.id, home.kind), Date.now());
            setRested(Date.now());
          }}
          testID="email-setup-card-not-now"
        >
          {W.notNow}
        </Button>
      </View>
    </Card>
  );
}
