import {
  ComputerRenameInput,
  COMPUTER_NAME_MOST,
  seenWords,
  type ComputerShown,
} from '@hfos/core/addons/outreach/live';
import { OUTREACH_WORDS as W } from '@hfos/core/addons/outreach/words';
import * as React from 'react';
import { View } from 'react-native';

import { Laptop, Pencil, Trash } from '@/components/icons';
import { useKeyboardHeight } from '@/components/shell/keyboard';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';

import { Part } from './kit';
import { PHONE_WORDS } from './phone-words';

/**
 * The person's computers the extension runs on, on the Live screen, where Settings → Your computer opens, as the web's
 * Settings has them (live-view.tsx's `ComputersCard`): each with how it stands and when it was last seen, to rename
 * (`outreach.computer.rename`) or, for one standing by, to remove (`outreach.computer.remove`); with more than one
 * standing by, all of them at once, after asking. The one that works stays: HandsFreeOS refuses it too. Both need
 * signal.
 */

const P = PHONE_WORDS.computers;

/** Why a name won't do, in the rename's own words, before it's sent; null when it will. */
export function computerNameProblem(name: string): string | null {
  const checked = ComputerRenameInput.shape.name.safeParse(name);
  return checked.success ? null : (checked.error.issues[0]?.message ?? null);
}

export interface ComputerActions {
  /** Renames one: null once it's kept, else the problem's words. */
  readonly rename: (computerId: string, name: string) => Promise<string | null>;
  /** Removes some: whether they went. `done` is what's said once they have. */
  readonly remove: (computerIds: readonly string[], done: string) => Promise<boolean>;
}

export function ComputersPart({
  computers,
  timeZone,
  now,
  online,
  actions,
}: {
  computers: readonly ComputerShown[];
  timeZone: string;
  now: number;
  online: boolean;
  actions: ComputerActions;
}) {
  const [renaming, setRenaming] = React.useState<ComputerShown | null>(null);
  const [clearing, setClearing] = React.useState(false);
  const [busy, setBusy] = React.useState<string | null>(null);
  if (!computers.length) return null;
  const standingBy = computers.filter((c) => !c.working);
  const remove = async (key: string, ids: readonly string[], done: string) => {
    setBusy(key);
    try {
      if (await actions.remove(ids, done)) setClearing(false);
    } finally {
      setBusy(null);
    }
  };
  const off = !online || busy !== null;
  return (
    <Part title={P.title} about={P.about} testID="live-computers">
      {standingBy.length > 1 ? (
        clearing ? (
          <Card
            className="gap-2.5 bg-card-2 px-4 py-3"
            accessibilityRole="alert"
            testID="live-computers-clearing"
          >
            <Text className="text-[14px] leading-[20px]">
              {P.removeStandingByAsk(standingBy.length)}
            </Text>
            <View className="flex-row gap-2">
              <Button
                size="sm"
                variant="danger"
                loading={busy === 'remove:standing'}
                disabled={off}
                onPress={() =>
                  void remove(
                    'remove:standing',
                    standingBy.map((c) => c.id),
                    P.removedMany(standingBy.length),
                  )
                }
                testID="live-computers-clear-yes"
              >
                {P.removeThem}
              </Button>
              <Button size="sm" variant="ghost" onPress={() => setClearing(false)}>
                {P.cancel}
              </Button>
            </View>
          </Card>
        ) : (
          <Button
            size="sm"
            variant="secondary"
            className="self-start"
            disabled={off}
            onPress={() => setClearing(true)}
            testID="live-computers-clear"
          >
            {P.removeStandingBy(standingBy.length)}
          </Button>
        )
      ) : null}
      <Card className="px-0 py-0">
        {computers.map((c, i) => (
          <View
            key={c.id}
            className={i ? 'gap-1.5 border-t border-border px-4 py-3' : 'gap-1.5 px-4 py-3'}
            testID="live-computer-row"
          >
            <View className="flex-row items-center gap-3">
              <Icon as={Laptop} className="size-5 text-text-2" />
              <View className="min-w-0 flex-1">
                <Text className="text-[15px] font-medium" numberOfLines={1}>
                  {c.name}
                </Text>
                <Text className="text-[13px] leading-[18px] text-text-3">
                  {P.line(
                    c.state === 'signed_out'
                      ? W.computerStates.signedOut
                      : c.working
                        ? W.computerStates.working
                        : W.computerStates.standingBy,
                    seenWords(c.lastSeenAt, timeZone, now),
                  )}
                </Text>
              </View>
            </View>
            <View className="flex-row gap-1.5 pl-8">
              <Button
                size="sm"
                variant="ghost"
                icon={Pencil}
                disabled={off}
                onPress={() => setRenaming(c)}
                accessibilityLabel={`${P.rename} ${c.name}`}
                testID="live-computer-rename"
              >
                {P.rename}
              </Button>
              {c.working ? null : (
                <Button
                  size="sm"
                  variant="ghostDanger"
                  icon={Trash}
                  loading={busy === `remove:${c.id}`}
                  disabled={off}
                  onPress={() => void remove(`remove:${c.id}`, [c.id], P.removed(c.name))}
                  accessibilityLabel={`${P.remove} ${c.name}`}
                  testID="live-computer-remove"
                >
                  {P.remove}
                </Button>
              )}
            </View>
          </View>
        ))}
      </Card>
      <RenameSheet
        computer={renaming}
        onClose={() => setRenaming(null)}
        onSave={(name) => actions.rename(renaming!.id, name)}
      />
    </Part>
  );
}

/** Renaming one: its name to change, checked as the rename checks it, and Save. */
function RenameSheet({
  computer,
  onClose,
  onSave,
}: {
  computer: ComputerShown | null;
  onClose: () => void;
  onSave: (name: string) => Promise<string | null>;
}) {
  const [name, setName] = React.useState('');
  const [problem, setProblem] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const keyboard = useKeyboardHeight();
  React.useEffect(() => {
    if (computer) {
      setName(computer.name);
      setProblem(null);
    }
  }, [computer]);
  const save = async () => {
    const wrong = computerNameProblem(name);
    if (wrong) {
      setProblem(wrong);
      return;
    }
    setBusy(true);
    const refused = await onSave(name.trim());
    setBusy(false);
    if (refused) setProblem(refused);
    else onClose();
  };
  return (
    <Sheet open={computer !== null} onClose={onClose} title={P.rename} testID="live-computer-sheet">
      <View style={keyboard ? { paddingBottom: keyboard } : undefined} className="gap-3">
        <Text className="text-[14px] font-medium">{P.nameLabel}</Text>
        <Input
          value={name}
          accessibilityLabel={P.nameLabel}
          maxLength={COMPUTER_NAME_MOST}
          autoFocus
          invalid={problem !== null}
          returnKeyType="done"
          onChangeText={(t) => {
            setName(t);
            setProblem(null);
          }}
          onSubmitEditing={() => void save()}
          testID="live-computer-name"
        />
        {problem ? (
          <Text className="text-[13.5px] text-danger" testID="live-computer-problem">
            {problem}
          </Text>
        ) : null}
        <Button loading={busy} onPress={() => void save()} testID="live-computer-save">
          {W.save}
        </Button>
      </View>
    </Sheet>
  );
}
