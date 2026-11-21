import {
  ComputerRenameInput,
  COMPUTER_NAME_MOST,
  isOffline,
  seenWords,
  type ComputerShown,
} from '@hfos/core/addons/outreach/live';
import { SETTINGS_PAGE_WORDS as SP } from '@hfos/core/addons/outreach/settings-pages';
import { OUTREACH_WORDS as W } from '@hfos/core/addons/outreach/words';
import * as React from 'react';
import { View } from 'react-native';

import { Laptop, Pencil, Trash } from '@/components/icons';
import { useKeyboardHeight } from '@/components/shell/keyboard';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';

import { Part } from './kit';
import { PHONE_WORDS } from './phone-words';

/**
 * The person's computers the extension runs on, on the Live screen, where Settings → Your computer opens, as the web's
 * Settings has them (live-view.tsx's `ComputerMain`, decision 170, part 2): the one that works first, whether it's
 * online, its build and when it was last seen, and the others standing by folded under it. Each is to rename
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
  const [others, setOthers] = React.useState(false);
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
  // The one that works first, as on the web (decision 170, part 2); the others fold under it.
  const main = computers.find((c) => c.working) ?? computers[0]!;
  const rest = computers.filter((c) => c.id !== main.id);
  const signedOut = main.state === 'signed_out';
  const offline = !signedOut && isOffline(main.lastSeenAt, now);
  const good = !signedOut && !offline;
  const removeButton = (c: ComputerShown) => (
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
  );
  const renameButton = (c: ComputerShown, variant: 'ghost' | 'secondary' = 'ghost') => (
    <Button
      size="sm"
      variant={variant}
      icon={Pencil}
      disabled={off}
      onPress={() => setRenaming(c)}
      accessibilityLabel={`${P.rename} ${c.name}`}
      testID="live-computer-rename"
    >
      {P.rename}
    </Button>
  );
  return (
    <Part title={P.title} about={P.about} testID="live-computers">
      <Card className="gap-3 px-4 py-3.5" testID="live-computer-main">
        <View className="flex-row items-start gap-3">
          <View
            className={cn(
              'size-9 items-center justify-center rounded-[10px]',
              good ? 'bg-success-soft' : 'bg-warning-soft',
            )}
          >
            <Icon
              as={Laptop}
              className={cn('size-5', good ? 'text-success-text' : 'text-warning-text')}
            />
          </View>
          <View className="min-w-0 flex-1 gap-1">
            <View className="flex-row flex-wrap items-center justify-between gap-x-3 gap-y-1">
              <Text className="shrink text-[16px] font-semibold" testID="live-computer-main-title">
                {signedOut
                  ? SP.signedOut(main.name)
                  : offline
                    ? SP.offline(main.name)
                    : SP.working(main.name)}
              </Text>
              <Badge variant={good ? 'ok' : 'pending'} testID="live-computer-main-chip">
                {signedOut ? SP.chips.signedOut : offline ? SP.chips.offline : SP.chips.online}
              </Badge>
            </View>
            <Text
              className="text-[13px] leading-[18px] text-text-2"
              testID="live-computer-main-line"
            >
              {SP.computerLine(main.version, seenWords(main.lastSeenAt, timeZone, now))}
            </Text>
          </View>
        </View>
        <View className="flex-row gap-1.5">
          {renameButton(main, 'secondary')}
          {main.working ? null : removeButton(main)}
        </View>
        {rest.length ? (
          <View className="gap-3 border-t border-border pt-3">
            <View className="flex-row items-center justify-between gap-3">
              <Text className="flex-1 text-[13px] text-text-2">{SP.standingBy(rest.length)}</Text>
              <Button
                size="sm"
                variant="ghost"
                aria-expanded={others}
                onPress={() => setOthers((o) => !o)}
                testID="live-computers-others"
              >
                {others ? SP.hide : SP.show}
              </Button>
            </View>
            {others ? (
              <>
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
                {rest.map((c) => (
                  <View
                    key={c.id}
                    className="gap-1.5 rounded-menu bg-card-2 px-3 py-2.5"
                    testID="live-computer-row"
                  >
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
                    <View className="flex-row gap-1.5">
                      {renameButton(c)}
                      {c.working ? null : removeButton(c)}
                    </View>
                  </View>
                ))}
              </>
            ) : null}
          </View>
        ) : null}
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
