import { DELETE_ACCOUNT_WORDS, deleteBlockedLine, handsOverLine, onlyOwnerLine } from '@hfos/core';
import { router } from 'expo-router';
import * as React from 'react';
import { View } from 'react-native';

import { Building, CloudOff, Globe, Trash, TriangleAlert, UserX } from '@/components/icons';
import { businessHref, useBusiness } from '@/components/shell/business-context';
import { Screen } from '@/components/shell/screen';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Text } from '@/components/ui/text';
import { api, errorMessage, unwrap } from '@/lib/api';
import { session } from '@/lib/auth';
import { lock } from '@/lib/lock';
import { useNetwork } from '@/lib/network';
import { openWeb } from '@/lib/open-web';
import { pushBeforeSignOut } from '@/push/device';
import { stopFollowing } from '@/safety/follow';

/**
 * Delete my account, as the canvas draws it on a phone (design/m10/More.dc.html): what goes, what the business
 * keeps, and your email address typed to confirm. It runs the same `account.delete` the web runs, and needs signal:
 * deleting an account is never queued. A business or agency you own alone is named here, and handing it over is
 * done at a desk, so that opens the web.
 */

type Check = Awaited<ReturnType<typeof loadCheck>>;

const loadCheck = async () =>
  unwrap(await api.POST('/v1/queries/account.deletion_check', { body: {} }));

export default function DeleteAccount() {
  const { me, business } = useBusiness();
  const { online } = useNetwork();
  const email = me.user.email;
  const [check, setCheck] = React.useState<Check | null>(null);
  const [failed, setFailed] = React.useState(false);
  const [typed, setTyped] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [deleting, setDeleting] = React.useState(false);
  const matches = typed.trim().toLowerCase() === email.toLowerCase();

  const load = React.useCallback(() => {
    setFailed(false);
    loadCheck()
      .then(setCheck)
      .catch(() => setFailed(true));
  }, []);
  React.useEffect(load, [load]);

  const blockers = [
    ...(check?.businesses.map((b) => b.name) ?? []),
    ...(check?.agencies.map((a) => a.name) ?? []),
  ];

  const remove = async () => {
    setError(null);
    if (!matches) {
      setError(DELETE_ACCOUNT_WORDS.mismatch);
      return;
    }
    setDeleting(true);
    try {
      unwrap(
        await api.POST('/v1/commands/account.delete', { body: { confirmEmail: typed.trim() } }),
      );
      // HandsFreeOS ends every session in a moment; this phone lets go of its own now.
      await pushBeforeSignOut().catch(() => undefined);
      await stopFollowing().catch(() => undefined);
      await session.signOut();
      lock.unlock();
    } catch (e) {
      setDeleting(false);
      setError(errorMessage(e));
      load();
    }
  };

  return (
    <Screen
      leading="back"
      back={businessHref(business.id, 'settings')}
      testID="delete-account"
      contentClassName="gap-3.5"
    >
      <View className="gap-1.5 px-0.5 pt-1">
        <Text variant="heading">{DELETE_ACCOUNT_WORDS.title}</Text>
        <Text className="leading-[22px] text-text-2">{DELETE_ACCOUNT_WORDS.phoneIntro}</Text>
      </View>

      <View className="overflow-hidden rounded-card border border-border bg-card">
        <View className="flex-row items-start gap-3 px-3.5 py-3">
          <Icon as={UserX} className="mt-0.5 size-5 text-danger-text" />
          <View className="min-w-0 flex-1 gap-0.5">
            <Text className="font-medium">{DELETE_ACCOUNT_WORDS.removedTitle}</Text>
            <Text className="text-[13px] leading-[18px] text-text-3">
              {DELETE_ACCOUNT_WORDS.removedDetail(business.name)}
            </Text>
          </View>
        </View>
        <View className="flex-row items-start gap-3 border-t border-border px-3.5 py-3">
          <Icon as={Building} className="mt-0.5 size-5 text-text-2" />
          <View className="min-w-0 flex-1 gap-0.5">
            <Text className="font-medium">{DELETE_ACCOUNT_WORDS.keptTitle}</Text>
            <Text className="text-[13px] leading-[18px] text-text-3">
              {DELETE_ACCOUNT_WORDS.keptDetail}
            </Text>
          </View>
        </View>
      </View>

      {!online || failed ? (
        <View
          className="flex-row items-start gap-2.5 rounded-menu bg-warning-soft px-3 py-[11px]"
          testID="delete-account-needs-signal"
        >
          <Icon as={CloudOff} className="mt-0.5 size-[18px] text-warning-text" />
          <Text className="min-w-0 flex-1 text-[13.5px] leading-5 text-warning-text">
            Deleting your account needs signal. Try again when you’re back online.
          </Text>
        </View>
      ) : null}

      {(check?.businesses ?? []).map((b) => (
        <View
          key={b.workspaceId}
          className="gap-2 rounded-menu bg-warning-soft px-3 py-[11px]"
          testID={`only-owner-${b.workspaceId}`}
        >
          <View className="flex-row items-start gap-2.5">
            <Icon as={TriangleAlert} className="mt-0.5 size-[18px] text-warning-text" />
            <Text className="min-w-0 flex-1 text-[13.5px] leading-5 text-warning-text">
              <Text className="text-[13.5px] font-semibold text-warning-text">
                You’re the only owner of {b.name}.
              </Text>{' '}
              {onlyOwnerLine(b.suggestion ? firstName(b.suggestion) : null)}
            </Text>
          </View>
          <Button
            variant="secondary"
            size="sm"
            icon={Globe}
            className="self-start"
            onPress={() => void openWeb(`/app/w/${b.workspaceId}/members`)}
          >
            {DELETE_ACCOUNT_WORDS.openOnWeb}
          </Button>
        </View>
      ))}

      {(check?.agencies ?? []).map((a) => (
        <View
          key={a.organizationId}
          className="gap-2 rounded-menu bg-warning-soft px-3 py-[11px]"
          testID={`only-owner-${a.organizationId}`}
        >
          <View className="flex-row items-start gap-2.5">
            <Icon as={TriangleAlert} className="mt-0.5 size-[18px] text-warning-text" />
            <Text className="min-w-0 flex-1 text-[13.5px] leading-5 text-warning-text">
              <Text className="text-[13.5px] font-semibold text-warning-text">
                You’re the only owner of the agency {a.name}.
              </Text>{' '}
              {DELETE_ACCOUNT_WORDS.handOverOnWeb}
            </Text>
          </View>
          <Button
            variant="secondary"
            size="sm"
            icon={Globe}
            className="self-start"
            onPress={() => void openWeb('/delete-account')}
          >
            {DELETE_ACCOUNT_WORDS.openOnWeb}
          </Button>
        </View>
      ))}

      {check?.ready && check.handsOver.length > 0 ? (
        <View className="rounded-menu bg-accent-soft px-3 py-[11px]" testID="hands-over">
          <Text className="text-[13.5px] leading-5 text-accent-text">
            {check.handsOver
              .map((h) =>
                handsOverLine(
                  h.name,
                  h.to.map((p) => p.fullName || p.email),
                ),
              )
              .join(' ')}
          </Text>
        </View>
      ) : null}

      {check && !check.ready ? (
        <Text className="px-0.5 text-[13px] text-text-3" testID="delete-account-blocked">
          {deleteBlockedLine(blockers)}
        </Text>
      ) : null}

      <View className="gap-2">
        <Text className="px-0.5 text-[13px] font-medium">{DELETE_ACCOUNT_WORDS.confirmLabel}</Text>
        <Input
          value={typed}
          onChangeText={setTyped}
          placeholder={email}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          textContentType="emailAddress"
          invalid={!!error}
          editable={!deleting}
          aria-label={DELETE_ACCOUNT_WORDS.confirmLabel}
          testID="delete-confirm-email"
        />
        {error ? (
          <Text className="px-0.5 text-[13px] text-danger-text" testID="delete-account-error">
            {error}
          </Text>
        ) : null}
      </View>

      <View className="gap-2">
        <Button
          variant="danger"
          icon={Trash}
          loading={deleting}
          disabled={!matches || !online || !check?.ready}
          onPress={() => void remove()}
          testID="delete-my-account"
        >
          {DELETE_ACCOUNT_WORDS.button}
        </Button>
        <Button variant="ghost" onPress={() => router.back()} testID="delete-keep">
          {DELETE_ACCOUNT_WORDS.keep}
        </Button>
      </View>
      <Text className="px-1 text-[12.5px] leading-[18px] text-text-3">
        {DELETE_ACCOUNT_WORDS.alsoOnWeb}
      </Text>
    </Screen>
  );
}

const firstName = (person: { fullName: string; email: string }) =>
  person.fullName.trim().split(/\s+/)[0] || person.email;
