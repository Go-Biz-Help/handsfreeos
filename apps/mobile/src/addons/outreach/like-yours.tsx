import { whenWords } from '@hfos/core/addons/outreach/setup';
import {
  LIKE_YOURS_WORDS as L,
  likeYoursLine,
  usernameOf,
  type LikeYoursAccount,
  type LikeYoursListOutput,
} from '@hfos/core/addons/outreach/like-yours';
import * as React from 'react';
import { View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';

import { Note, openOutside } from './kit';
import { Section } from './settings-bits';

/**
 * Settings → Instagram's **Accounts like yours** on the phone (docs/outreach.md, decision 110), as the web's: up to 5
 * Instagram accounts whose followers are the business's kind of customer, each with who added it, why, and when the
 * person's computer last read it. Owners and admins add one by its username or address, and remove one, with signal;
 * everyone else sees the list. The words are core's (`LIKE_YOURS_WORDS`).
 */
export interface LikeYoursProps {
  readonly list: LikeYoursListOutput | null;
  readonly timeZone: string;
  /** Adds an account by what was typed: the problem's words, or null once added. */
  readonly onAdd: (account: string) => Promise<string | null>;
  /** Removes one: the problem's words, or null once removed. */
  readonly onRemove: (id: string) => Promise<string | null>;
}

export function LikeYoursSection({
  likeYours,
  boxed,
  disabled,
  testID,
}: {
  likeYours: LikeYoursProps;
  boxed: boolean;
  disabled: boolean;
  testID: string;
}) {
  const { list, timeZone, onAdd, onRemove } = likeYours;
  const [typed, setTyped] = React.useState('');
  const [busy, setBusy] = React.useState<string | null>(null);
  if (!list) return null;
  const full = list.accounts.length >= list.most;
  const run = async (key: string, go: () => Promise<string | null>, done: string) => {
    setBusy(key);
    try {
      const problem = await go();
      if (problem) toast.error(problem);
      else toast.show(done);
      return !problem;
    } finally {
      setBusy(null);
    }
  };
  const add = async () => {
    const account = typed.trim();
    const added = await run(
      'add',
      () => onAdd(account),
      L.added(usernameOf(account) ?? account.replace(/^@/, '')),
    );
    if (added) setTyped('');
  };
  const remove = (a: LikeYoursAccount) =>
    run(`remove:${a.id}`, () => onRemove(a.id), L.removed(a.username));
  return (
    <Section boxed={boxed} title={L.title} about={L.about} testID={`${testID}-like-yours`}>
      {list.accounts.length ? (
        list.accounts.map((a) => (
          <View
            key={a.id}
            className="flex-row items-start justify-between gap-3 border-t border-border pt-2.5"
            testID={`${testID}-like-yours-account`}
          >
            <View className="min-w-0 flex-1 gap-0.5">
              <Text
                className="text-[15px] font-semibold text-accent-text"
                onPress={() => openOutside(a.url)}
              >
                @{a.username}
              </Text>
              {a.name ? <Note>{a.name}</Note> : null}
              <Note>{likeYoursLine(a, (at) => whenWords(at, Date.now(), timeZone))}</Note>
              {a.why ? <Note>{a.why}</Note> : null}
            </View>
            {list.canManage ? (
              <Button
                size="sm"
                variant="secondary"
                disabled={disabled || busy !== null}
                loading={busy === `remove:${a.id}`}
                onPress={() => void remove(a)}
                testID={`${testID}-like-yours-remove`}
              >
                {L.remove}
              </Button>
            ) : null}
          </View>
        ))
      ) : (
        <Note testID={`${testID}-like-yours-none`}>{L.none}</Note>
      )}
      {!list.canManage ? (
        <Note>{L.manageOnly}</Note>
      ) : full ? (
        <Note testID={`${testID}-like-yours-full`}>{L.full}</Note>
      ) : (
        <View className="gap-2">
          <Input
            value={typed}
            onChangeText={setTyped}
            placeholder={L.addPlaceholder}
            accessibilityLabel={L.addLabel}
            autoCapitalize="none"
            autoCorrect={false}
            editable={!disabled}
            testID={`${testID}-like-yours-input`}
          />
          <Button
            size="sm"
            disabled={disabled || busy !== null || !typed.trim()}
            loading={busy === 'add'}
            onPress={() => void add()}
            testID={`${testID}-like-yours-add`}
          >
            {L.add}
          </Button>
        </View>
      )}
    </Section>
  );
}
