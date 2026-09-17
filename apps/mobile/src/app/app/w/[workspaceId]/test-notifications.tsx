import { PUSH_BUTTONS } from '@hfos/core';
import { useQuery } from '@powersync/react-native';
import * as Notifications from 'expo-notifications';
import * as React from 'react';
import { ScrollView, View } from 'react-native';

import { useBusiness } from '@/components/shell/business-context';
import { Screen } from '@/components/shell/screen';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { testToolsEnabled } from '@/lib/config';
import { pendingLinks } from '@/links/pending';
import { isPushButton } from '@/push/categories';
import { presenter, pushPlatform } from '@/push/device';
import { usePushRegistration } from '@/push/hooks';
import { outcomeWords } from '@/push/press';
import { setPretendLocked, useLastPress, usePretendLocked } from '@/push/test-flags';
import {
  dataWithWords,
  readyCustomerTexts,
  runDuePushes,
  sentToThisPhone,
  type PushCustomer,
  type SentPush,
} from '@/push/test-tools';

type Part = 'sent' | 'buttons' | 'links';

const PARTS = [
  { value: 'sent', label: 'Sent here', testID: 'tn-part-sent' },
  { value: 'buttons', label: 'Buttons', testID: 'tn-part-buttons' },
  { value: 'links', label: 'Links', testID: 'tn-part-links' },
] as const;

/**
 * Test builds only: the pushes the worker's stand-in sent this phone (`GET /test/push/sent`), shown through the same
 * code a real push goes through, so a flow can press their buttons in the notification shade; pretending the phone is
 * locked, for the unlock rule; the categories and buttons the phone registered; and links opened through the app's
 * route map (the iOS simulator asks before it opens a link from outside).
 *
 * In short parts that don't scroll, as Test changes is: flows tap these buttons, and on the iOS simulator a button
 * scrolled under the fixed top still counts as on screen.
 */
export default function TestNotifications() {
  const { business, userId } = useBusiness();
  const registration = usePushRegistration();
  const locked = usePretendLocked();
  const lastPress = useLastPress();
  const [part, setPart] = React.useState<Part>('sent');
  const [sent, setSent] = React.useState<SentPush[] | null>(null);
  const [customer, setCustomer] = React.useState<PushCustomer | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<string | null>(null);

  const newest = sent?.[0] ?? null;
  const conversationId = newest?.data.refs.conversationId ?? '';
  const { data: replies } = useQuery<{ n: number }>(
    `SELECT count(*) AS n FROM messages WHERE conversation_id = ? AND direction = 'outbound'`,
    [conversationId],
  );

  if (!testToolsEnabled) return null;

  const act = (id: string, work: () => Promise<string>) => {
    setBusy(id);
    setResult(null);
    void work()
      .then(setResult)
      .catch((error: unknown) => setResult(error instanceof Error ? error.message : String(error)))
      .finally(() => setBusy(null));
  };

  const refresh = () =>
    act('refresh', async () => {
      if (!registration.token) return 'This phone has no push token yet.';
      await runDuePushes(business.id);
      const found = await sentToThisPhone(business.id, registration.token);
      setSent(found);
      return found.length === 0
        ? 'Nothing sent to this phone yet.'
        : `${found.length} sent to this phone.`;
    });

  const press = lastPress
    ? `${'button' in lastPress.outcome && isPushButton(lastPress.outcome.button) ? PUSH_BUTTONS[lastPress.outcome.button].title : 'Tap'} · ${lastPress.outcome.kind} · ${outcomeWords(lastPress.outcome)}`
    : 'No press yet';

  return (
    <Screen
      title="Test notifications"
      leading="back"
      testID="test-notifications-screen"
      scroll={false}
    >
      <View className="gap-2 border-b border-border px-3 pb-3 pt-2.5">
        <Text className="px-1 text-[13px] leading-[19px] text-text-3" testID="tn-registration">
          {`This phone: ${registration.status}${registration.permission ? ` · ${registration.permission}` : ''}`}
        </Text>
        <Text className="px-1 text-[13px] leading-[19px] text-text-2" testID="tn-last-press">
          {press}
        </Text>
        <Text className="px-1 text-[13px] leading-[19px] text-text-2" testID="tn-result">
          {result ?? ''}
        </Text>
        <View className="flex-row items-center gap-3">
          <View className="min-w-0 flex-1 flex-row items-center justify-between rounded-card border border-border bg-card px-4 py-2">
            <Text className="text-base">Phone locked</Text>
            <Switch
              label="Pretend this phone is locked"
              checked={locked}
              onCheckedChange={setPretendLocked}
              testID="tn-locked"
            />
          </View>
          <Button
            variant="secondary"
            className="flex-1"
            loading={busy === 'refresh'}
            onPress={refresh}
            testID="tn-refresh"
          >
            Refresh
          </Button>
        </View>
        <Segmented value={part} onChange={setPart} options={PARTS} label="Test notifications" />
      </View>
      <ScrollView
        key={part}
        className="flex-1"
        contentContainerClassName="gap-3 p-3 pb-8"
        keyboardShouldPersistTaps="handled"
      >
        {part === 'sent' ? (
          <SentPart
            sent={sent}
            replies={conversationId ? (replies[0]?.n ?? 0) : null}
            customer={customer}
            onReadyCustomer={() =>
              act('customer', async () => {
                const ready = await readyCustomerTexts(business.id, userId);
                setCustomer(ready);
                return `${ready.name}’s texts come to you.`;
              })
            }
            busy={busy}
            act={act}
          />
        ) : null}
        {part === 'buttons' ? <ButtonsPart /> : null}
        {part === 'links' ? <LinksPart workspaceId={business.id} /> : null}
      </ScrollView>
    </Screen>
  );
}

function SentPart({
  sent,
  replies,
  customer,
  onReadyCustomer,
  busy,
  act,
}: {
  sent: SentPush[] | null;
  replies: number | null;
  customer: PushCustomer | null;
  onReadyCustomer: () => void;
  busy: string | null;
  act: (id: string, work: () => Promise<string>) => void;
}) {
  return (
    <>
      <View className="gap-1.5 rounded-card border border-border bg-card p-3">
        <Text className="text-[13px] leading-[19px] text-text-2">
          A customer’s texts reach this phone when a person here answers them (not the AI teammate).
        </Text>
        {customer ? (
          <View className="flex-row items-center justify-between gap-2">
            <Text className="text-[15px] font-medium">{customer.name}</Text>
            <Text className="font-mono text-[13px] text-text-2" testID="tn-customer-phone">
              {customer.phone}
            </Text>
          </View>
        ) : null}
        <Button
          variant="secondary"
          size="sm"
          loading={busy === 'customer'}
          onPress={onReadyCustomer}
          testID="tn-ready-customer"
        >
          Answer Maria Lopez’s texts yourself
        </Button>
      </View>
      {sent ? null : (
        <Text className="px-1 text-[13.5px] leading-5 text-text-2">
          Refresh to see what the worker’s stand-in sent this phone.
        </Text>
      )}
      {replies !== null ? (
        <Text className="px-1 text-[13px] text-text-2" testID="tn-replies">
          {`Texts sent in the newest push’s conversation: ${replies}`}
        </Text>
      ) : null}
      {(sent ?? []).slice(0, 3).map((push, i) => (
        <View
          key={`${push.data.notificationId}-${i}`}
          className="gap-1.5 rounded-card border border-border bg-card p-3"
        >
          <Text className="text-[15px] font-medium" numberOfLines={1} testID={`tn-sent-${i}-title`}>
            {push.data.title ?? push.title ?? ''}
          </Text>
          <Text className="text-[13px] text-text-2" numberOfLines={2} testID={`tn-sent-${i}-body`}>
            {push.data.body ?? push.body ?? ''}
          </Text>
          <Text className="text-xs text-text-3" testID={`tn-sent-${i}-category`}>
            {`${push.data.category}${push.data.quiet ? ' · quiet' : ''} · ${new Date(push.at).toLocaleTimeString('en-US')}`}
          </Text>
          <Button
            variant="secondary"
            size="sm"
            loading={busy === `show-${i}`}
            onPress={() =>
              act(`show-${i}`, async () => {
                const shown = await presenter.present(dataWithWords(push), { again: true });
                return shown === 'shown' ? `Showing “${push.data.title ?? push.title}”.` : shown;
              })
            }
            testID={`tn-show-${i}`}
          >
            Show it
          </Button>
        </View>
      ))}
    </>
  );
}

/** The categories this phone registered, with each button's options, as the phone reports them. */
function ButtonsPart() {
  const [categories, setCategories] = React.useState<Notifications.NotificationCategory[] | null>(
    null,
  );
  React.useEffect(() => {
    void Notifications.getNotificationCategoriesAsync().then(setCategories);
  }, []);
  if (!categories) return null;
  return (
    <View className="gap-2" testID="tn-categories">
      <Text className="px-1 text-[13px] text-text-3">{`${categories.length} categories on this ${pushPlatform === 'ios' ? 'iPhone' : 'phone'}`}</Text>
      {[...categories]
        .sort((a, b) => a.identifier.localeCompare(b.identifier))
        .map((category) => (
          <View
            key={category.identifier}
            className="gap-0.5 rounded-card border border-border bg-card px-3 py-2"
          >
            <Text className="text-sm font-medium" testID={`tn-category-${category.identifier}`}>
              {category.identifier}
            </Text>
            <Text className="text-xs leading-[17px] text-text-2">
              {category.actions
                .map(
                  (a) =>
                    `${a.buttonTitle}${a.textInput ? ' (typed)' : ''}${a.options?.isAuthenticationRequired ? ' · unlock' : ''}${a.options?.opensAppToForeground ? ' · opens app' : ''}`,
                )
                .join(' | ')}
            </Text>
          </View>
        ))}
    </View>
  );
}

/** Links opened through the route map, the way a notification's tap or an email's link opens one. */
function LinksPart({ workspaceId }: { workspaceId: string }) {
  // Empty, and emptied once opened: a flow types a whole link into it (a tap puts the cursor mid-text on an iPhone).
  const [link, setLink] = React.useState('');
  const [opened, setOpened] = React.useState<string | null>(null);
  // Through the same gate as a link from outside: a screen opens, anything else leaves this screen where it is.
  const open = (value: string) => {
    setOpened(value);
    pendingLinks.open(value);
  };
  return (
    <View className="gap-2">
      <Text className="px-1 font-mono text-xs text-text-3" testID="tn-business-id">
        {workspaceId}
      </Text>
      {opened ? (
        <Text className="px-1 text-xs text-text-3" numberOfLines={2} testID="tn-opened-link">
          {`Opened ${opened}`}
        </Text>
      ) : null}
      <Input
        value={link}
        onChangeText={setLink}
        placeholder={`https://app.handsfreeos.com/app/w/${workspaceId}/inbox`}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        returnKeyType="done"
        aria-label="Link"
        testID="tn-link"
      />
      <Button
        variant="secondary"
        disabled={!link.trim()}
        onPress={() => {
          open(link.trim());
          setLink('');
        }}
        testID="tn-open-link"
      >
        Open this link
      </Button>
      <Button
        variant="secondary"
        onPress={() =>
          open(
            `handsfreeos://app/w/${workspaceId}/money/invoices/00000000-0000-4000-8000-000000000000`,
          )
        }
        testID="tn-open-scheme"
      >
        Open an invoice through handsfreeos://
      </Button>
      <Button
        variant="secondary"
        onPress={() =>
          open('https://app.handsfreeos.com/app/w/00000000-0000-4000-8000-000000000001/inbox')
        }
        testID="tn-open-not-yours"
      >
        Open another business’s link
      </Button>
      <Button
        variant="secondary"
        onPress={() => open('https://app.handsfreeos.com/i/test-invoice-code')}
        testID="tn-open-customer-page"
      >
        Open a customer’s invoice link
      </Button>
    </View>
  );
}
