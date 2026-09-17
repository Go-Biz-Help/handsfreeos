import * as React from 'react';
import { View } from 'react-native';

import { CHANGE_ICONS } from '@/components/changes/change-parts';
import { LogOut } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { changes } from '@/changes';
import { describe, loadNames, type ChangeWords } from '@/changes/describe';
import type { OutboxRow } from '@/changes/outbox';
import { session } from '@/lib/auth';
import { lock } from '@/lib/lock';
import { changesWord, useWaitingCount } from '@/lib/sync-status';
import { pushBeforeSignOut } from '@/push/device';

/** The changes shown by name in the sheet; the rest are counted. */
const LISTED = 3;

/**
 * "Sign out?" Signing out never throws work away: changes that haven't gone stay on the phone, locked to this person,
 * and go when they sign back in here (someone else signing in first deletes them). The sheet names the first few.
 */
export function SignOutSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const waiting = useWaitingCount();
  const [busy, setBusy] = React.useState(false);
  const [listed, setListed] = React.useState<ChangeWords[]>([]);

  React.useEffect(() => {
    const db = changes.open?.db;
    if (!open || waiting === 0 || !db) {
      setListed([]);
      return;
    }
    let alive = true;
    void (async () => {
      const rows = await db.getAll<OutboxRow>(
        `SELECT * FROM outbox WHERE state != 'sent' ORDER BY seq LIMIT ${LISTED}`,
      );
      const names = await loadNames(db, rows);
      if (alive) setListed(rows.map((row) => describe(row, names)));
    })().catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [open, waiting]);

  const signOut = async () => {
    setBusy(true);
    // Off the list of phones that get this person's notifications, while HandsFreeOS still knows who they are.
    await pushBeforeSignOut().catch(() => undefined);
    await session.signOut();
    lock.unlock();
    setBusy(false);
    onClose();
  };
  return (
    <Sheet open={open} onClose={onClose} testID="sign-out-sheet">
      <View className="flex-row items-start gap-3">
        <View className="size-10 items-center justify-center rounded-menu bg-warning-soft">
          <Icon as={LogOut} className="size-5 text-warning-text" />
        </View>
        <View className="min-w-0 flex-1 gap-0.5">
          <Text variant="sheetTitle">Sign out?</Text>
          <Text className="text-sm leading-5 text-text-2" testID="sign-out-summary">
            {waiting > 0
              ? `${changesWord(waiting)} ${waiting === 1 ? 'hasn’t' : 'haven’t'} been sent. They stay safely on this phone for you.`
              : 'You’ll sign in again with your email next time.'}
          </Text>
        </View>
      </View>
      {listed.length > 0 ? (
        <View
          className="mt-3.5 overflow-hidden rounded-card border border-border"
          testID="sign-out-changes"
        >
          {listed.map((words, i) => (
            <View
              key={i}
              className={`min-h-[50px] flex-row items-center gap-3 px-3.5 py-2.5 ${i > 0 ? 'border-t border-border' : ''}`}
            >
              <Icon as={CHANGE_ICONS[words.icon]} className="size-[18px] text-text-2" />
              <Text className="min-w-0 flex-1 text-[15px]" numberOfLines={1}>
                {words.title}
              </Text>
            </View>
          ))}
          {waiting > listed.length ? (
            <View className="border-t border-border px-3.5 py-2.5">
              <Text className="text-[13px] text-text-3">{`and ${changesWord(waiting - listed.length)} more`}</Text>
            </View>
          ) : null}
        </View>
      ) : null}
      {waiting > 0 ? (
        <Text className="mt-3 text-[12.5px] leading-[18px] text-text-3">
          They go when you sign back in on this phone. If someone else signs in here first, they are
          deleted.
        </Text>
      ) : null}
      <View className="mt-4 gap-2">
        <Button onPress={onClose} testID="stay-signed-in">
          Stay signed in
        </Button>
        <Button
          variant="dangerOutline"
          loading={busy}
          onPress={() => void signOut()}
          testID="confirm-sign-out"
        >
          Sign out
        </Button>
      </View>
    </Sheet>
  );
}
