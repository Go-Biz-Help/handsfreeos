import { deskSectionsFor, STAFF_ROLE_WORDS } from '@hfos/core';
import { router, type Href } from 'expo-router';
import * as React from 'react';
import { View } from 'react-native';

import { desk, useLive, useReloadOnReturn } from '@/admin/live';
import { DESK_PHONE_WORDS } from '@/admin/words';
import { DESK_ICONS } from '@/components/admin/desk-icons';
import { deskHref, useDesk } from '@/components/admin/staff-context';
import { ArrowLeft, BellRing, Globe, LogOut } from '@/components/icons';
import { List, ListRow } from '@/components/shell/list';
import { Screen } from '@/components/shell/screen';
import { SignOutSheet } from '@/components/shell/sign-out-sheet';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Text } from '@/components/ui/text';
import { useMe } from '@/lib/businesses';
import { openWeb } from '@/lib/open-web';

/**
 * The support desk's front page on the phone: the web's side menu as a list. Like the web's, it is deliberately unlike
 * a business's More, with "HandsFreeOS" and the person's support role where a business's name would be, so nobody
 * answers a ticket thinking they are inside somebody's account. Only the sections the person's role opens are listed.
 */
export default function DeskHome() {
  const { userId, staff } = useDesk();
  const { me } = useMe(userId);
  const [signingOut, setSigningOut] = React.useState(false);
  const hasBusiness = (me?.businesses.length ?? 0) > 0;
  const queue = useLive(() => desk('/v1/queries/support.queue.summary', {}), 'queue-summary');
  useReloadOnReturn(queue.reload);
  const unanswered = queue.data?.unanswered ?? 0;
  const name = staff.displayName || me?.user.fullName || me?.user.email || '';

  return (
    <Screen
      title={DESK_PHONE_WORDS.title}
      leading={hasBusiness ? 'back' : 'none'}
      back="/app"
      testID="desk-home"
    >
      <Card className="flex-row items-center gap-3 px-3.5 py-3">
        <Avatar name={name} seed={userId} size="lg" />
        <View className="min-w-0 flex-1 gap-px">
          <Text className="text-base font-semibold" numberOfLines={1}>
            {DESK_PHONE_WORDS.brand}
          </Text>
          <Text className="text-[12.5px] text-text-3" numberOfLines={1}>
            {name}
          </Text>
        </View>
        <Badge variant="admin" testID="desk-role">
          <Text>{STAFF_ROLE_WORDS[staff.role]}</Text>
        </Badge>
      </Card>
      <List testID="desk-sections">
        {deskSectionsFor(staff.permissions).map((s) => (
          <ListRow
            key={s.key}
            icon={DESK_ICONS[s.key]}
            label={s.label}
            end={
              s.key === 'tickets' && unanswered > 0 ? (
                <Badge variant="accent" testID="desk-unanswered">
                  <Text>{String(unanswered)}</Text>
                </Badge>
              ) : undefined
            }
            onPress={() => router.push(deskHref(s.key) as Href)}
            testID={`desk-nav-${s.key}`}
          />
        ))}
      </List>
      <List>
        <ListRow
          icon={BellRing}
          label={DESK_PHONE_WORDS.notifications}
          detail={DESK_PHONE_WORDS.notificationsDetail}
          onPress={() => router.push(deskHref('notifications') as Href)}
          testID="desk-nav-notifications"
        />
        {hasBusiness ? (
          <ListRow
            icon={ArrowLeft}
            label={DESK_PHONE_WORDS.backToBusiness}
            onPress={() => router.replace('/app')}
            testID="desk-back-to-business"
          />
        ) : null}
        <ListRow
          icon={Globe}
          label={DESK_PHONE_WORDS.openOnWeb}
          external
          onPress={() => void openWeb('/admin')}
          testID="desk-open-on-web"
        />
        {hasBusiness ? null : (
          <ListRow
            icon={LogOut}
            label={DESK_PHONE_WORDS.signOut}
            onPress={() => setSigningOut(true)}
            chevron={false}
            testID="desk-sign-out"
          />
        )}
      </List>
      <SignOutSheet open={signingOut} onClose={() => setSigningOut(false)} />
    </Screen>
  );
}
