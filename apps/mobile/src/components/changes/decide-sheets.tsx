import { formatClock } from '@hfos/core';
import { useQuery } from '@powersync/react-native';
import * as React from 'react';
import { View } from 'react-native';

import { CircleAlert, Clock, Moon, Pencil, Send, Trash } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { changes } from '@/changes';
import type { ChangeWords } from '@/changes/describe';
import type { OutboxRow } from '@/changes/outbox';
import { quietHoursWindow, refusalOf } from '@/changes/rules';

import { SheetTile, Well } from './change-parts';

/**
 * The questions a change waiting on the phone asks the person, as the canvas draws them: "Still send?" (Send now, Edit,
 * Discard), the quiet-hours question (Send at 8:00 AM, Send now, Edit), and anything else the API asked (do it anyway).
 * Discarding a change that others wait for asks about them first.
 */

export interface Decided {
  readonly row: OutboxRow;
  readonly words: ChangeWords;
}

/** "45 minutes", "2 hours", "3 days". */
export function agoWords(ms: number): string {
  const minutes = Math.max(1, Math.floor(ms / 60_000));
  if (minutes < 90) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours} hours`;
  return `${Math.round(hours / 24)} days`;
}

function useAct(onDone: () => void) {
  const [busy, setBusy] = React.useState<string | null>(null);
  const act = (id: string, work: () => Promise<void>, done?: string) => {
    setBusy(id);
    void work()
      .then(() => {
        onDone();
        if (done) toast.show(done);
      })
      .catch((error: unknown) =>
        toast.error(error instanceof Error ? error.message : String(error)),
      )
      .finally(() => setBusy(null));
  };
  return { busy, act };
}

export function StillSendSheet({
  decided,
  onClose,
  onEdit,
  onDiscard,
}: {
  decided: Decided | null;
  onClose: () => void;
  onEdit: ((row: OutboxRow) => void) | null;
  onDiscard: (decided: Decided) => void;
}) {
  const { busy, act } = useAct(onClose);
  const row = decided?.row;
  const words = decided?.words;
  const text = words?.icon === 'text';
  const email = words?.icon === 'email';
  const ago = row ? agoWords(Date.now() - Date.parse(row.made_at)) : '';
  const to = words?.about?.name ?? 'a customer';
  const description = text
    ? `You wrote this to ${to} ${ago} ago, with no signal. A text that waits more than 30 minutes checks with you first.`
    : email
      ? `You wrote this to ${to} ${ago} ago, with no signal. An email that waits more than 30 minutes checks with you first.`
      : `You did this ${ago} ago, with no signal. Anything that reaches a customer and waits more than 30 minutes checks with you first.`;
  return (
    <Sheet open={decided !== null} onClose={onClose} testID="still-send-sheet">
      {row && words ? (
        <>
          <View className="flex-row items-start gap-3">
            <SheetTile icon={Clock} tone="accent" />
            <View className="min-w-0 flex-1 gap-0.5">
              <Text variant="sheetTitle">Still send?</Text>
              <Text className="text-sm leading-5 text-text-2" testID="still-send-description">
                {description}
              </Text>
            </View>
          </View>
          <Well testID="still-send-words">{words.quote ?? words.title}</Well>
          <View className="mt-4 gap-2">
            <Button
              icon={Send}
              loading={busy === 'send'}
              onPress={() => act('send', () => changes.stillSend(row.id))}
              testID="still-send-now"
            >
              Send now
            </Button>
            {onEdit ? (
              <Button
                variant="secondary"
                icon={Pencil}
                onPress={() => {
                  onClose();
                  onEdit(row);
                }}
                testID="still-send-edit"
              >
                Edit
              </Button>
            ) : null}
            <Button
              variant="ghostDanger"
              icon={Trash}
              onPress={() => onDiscard({ row, words })}
              testID="still-send-discard"
            >
              Discard
            </Button>
          </View>
        </>
      ) : null}
    </Sheet>
  );
}

/** The business's time and when quiet hours end: the phone's own question, or the API's. */
function quietTimes(row: OutboxRow): { localTime: string; endsAt: string } | null {
  try {
    const answer = row.answer ? (JSON.parse(row.answer) as unknown) : null;
    const phone = (answer as { phone?: { localTime?: string; endsAt?: string } } | null)?.phone;
    if (phone?.localTime && phone.endsAt)
      return { localTime: phone.localTime, endsAt: phone.endsAt };
    const details = refusalOf(answer)?.details as
      { localTime?: string; endsAt?: string } | undefined;
    if (details?.localTime && details.endsAt)
      return { localTime: details.localTime, endsAt: details.endsAt };
  } catch {
    return null;
  }
  return null;
}

export function QuietHoursSheet({
  decided,
  onClose,
  onEdit,
}: {
  decided: Decided | null;
  onClose: () => void;
  onEdit: ((row: OutboxRow) => void) | null;
}) {
  const { busy, act } = useAct(onClose);
  const row = decided?.row;
  const { data } = useQuery<{ settings: string | null }>(
    'SELECT settings FROM workspaces WHERE id = ?',
    [row?.workspace_id ?? ''],
  );
  const window = quietHoursWindow(data[0]?.settings ?? null);
  const times = row ? quietTimes(row) : null;
  const ends = formatClock(times?.endsAt ?? window.end);
  return (
    <Sheet open={decided !== null} onClose={onClose} testID="quiet-hours-sheet">
      {row && decided ? (
        <>
          <View className="flex-row items-start gap-3">
            <SheetTile icon={Moon} tone="warning" />
            <View className="min-w-0 flex-1 gap-0.5">
              <Text variant="sheetTitle" testID="quiet-hours-title">
                {times
                  ? `It’s ${formatClock(times.localTime)}, inside quiet hours.`
                  : 'It’s inside quiet hours.'}
              </Text>
              <Text className="text-sm leading-5 text-text-2">
                {`Send now, or at ${ends} when quiet hours end?`}
              </Text>
            </View>
          </View>
          <Well testID="quiet-hours-words">{decided.words.quote ?? decided.words.title}</Well>
          <Text className="mt-2.5 text-xs leading-[17px] text-text-3">
            {`Quiet hours for texts are ${formatClock(window.start)} to ${formatClock(window.end)}, set in Texting & calls.`}
          </Text>
          <View className="mt-4 gap-2">
            <Button
              icon={Clock}
              loading={busy === 'later'}
              onPress={() =>
                act(
                  'later',
                  () => changes.answerQuietHours(row.id, 'when-quiet-hours-end'),
                  `It goes at ${ends}.`,
                )
              }
              testID="quiet-hours-later"
            >
              {`Send at ${ends}`}
            </Button>
            <Button
              variant="secondary"
              icon={Send}
              loading={busy === 'now'}
              onPress={() => act('now', () => changes.answerQuietHours(row.id, 'now'))}
              testID="quiet-hours-now"
            >
              Send now
            </Button>
            {onEdit ? (
              <Button
                variant="ghost"
                icon={Pencil}
                onPress={() => {
                  onClose();
                  onEdit(row);
                }}
                testID="quiet-hours-edit"
              >
                Edit
              </Button>
            ) : null}
          </View>
        </>
      ) : null}
    </Sheet>
  );
}

const ANYWAY_WORDS: Record<string, { title: string; button: string }> = {
  duplicate: { title: 'Add them anyway?', button: 'Add anyway' },
  needs_confirmation: { title: 'Book it anyway?', button: 'Book anyway' },
  has_open_work: { title: 'Archive anyway?', button: 'Archive anyway' },
};

/** Anything else HandsFreeOS asked before it would do a change. */
export function AskSheet({
  decided,
  onClose,
  onEdit,
  onDiscard,
}: {
  decided: Decided | null;
  onClose: () => void;
  onEdit: ((row: OutboxRow) => void) | null;
  onDiscard: (decided: Decided) => void;
}) {
  const { busy, act } = useAct(onClose);
  const row = decided?.row;
  const words = ANYWAY_WORDS[row?.rule ?? ''] ?? { title: 'Do it anyway?', button: 'Do it anyway' };
  return (
    <Sheet open={decided !== null} onClose={onClose} testID="ask-sheet">
      {row && decided ? (
        <>
          <View className="flex-row items-start gap-3">
            <SheetTile icon={CircleAlert} tone="accent" />
            <View className="min-w-0 flex-1 gap-0.5">
              <Text variant="sheetTitle">{words.title}</Text>
              <Text className="text-sm leading-5 text-text-2">{row.reason ?? ''}</Text>
            </View>
          </View>
          <Well>{decided.words.quote ?? decided.words.title}</Well>
          <View className="mt-4 gap-2">
            <Button
              loading={busy === 'anyway'}
              onPress={() => act('anyway', () => changes.doItAnyway(row.id))}
              testID="ask-anyway"
            >
              {words.button}
            </Button>
            {onEdit ? (
              <Button
                variant="secondary"
                icon={Pencil}
                onPress={() => {
                  onClose();
                  onEdit(row);
                }}
              >
                Edit
              </Button>
            ) : null}
            <Button
              variant="ghostDanger"
              icon={Trash}
              onPress={() => onDiscard(decided)}
              testID="ask-discard"
            >
              Discard
            </Button>
          </View>
        </>
      ) : null}
    </Sheet>
  );
}

/** "Don't add Rosa?", naming what waits for the change and would go with it. */
export function DiscardSheet({
  decided,
  dependants,
  onClose,
  onDiscarded,
}: {
  decided: Decided | null;
  dependants: readonly ChangeWords[];
  onClose: () => void;
  onDiscarded?: () => void;
}) {
  const { busy, act } = useAct(() => {
    onClose();
    onDiscarded?.();
  });
  const row = decided?.row;
  const newCustomer = row?.name === 'person.create' ? firstNameOf(row) : null;
  const title = newCustomer ? `Don’t add ${newCustomer}?` : 'Discard this change?';
  const body =
    dependants.length === 1
      ? `${dependants[0]!.title} waits for it, so it would be discarded too.`
      : `These wait for it, so they would be discarded too:`;
  return (
    <Sheet open={decided !== null} onClose={onClose} testID="discard-sheet">
      {row && decided ? (
        <>
          <View className="flex-row items-start gap-3">
            <SheetTile icon={Trash} tone="danger" />
            <View className="min-w-0 flex-1 gap-0.5">
              <Text variant="sheetTitle">{title}</Text>
              <Text className="text-sm leading-5 text-text-2" testID="discard-body">
                {body}
              </Text>
            </View>
          </View>
          {dependants.length > 1 ? (
            <View className="mt-3 gap-1">
              {dependants.map((d, i) => (
                <Text key={i} className="text-sm text-text">
                  {`· ${d.title}`}
                </Text>
              ))}
            </View>
          ) : null}
          <View className="mt-4 gap-2">
            <Button
              variant="danger"
              loading={busy === 'discard'}
              onPress={() =>
                act('discard', async () => {
                  const all = await changes.dependantsOf(row.id);
                  await changes.discard([row.id, ...all.map((d) => d.id)]);
                })
              }
              testID="discard-confirm"
            >
              {newCustomer
                ? `Don’t add ${newCustomer}`
                : dependants.length > 0
                  ? 'Discard them all'
                  : 'Discard'}
            </Button>
            <Button variant="secondary" onPress={onClose} testID="discard-keep">
              Keep it
            </Button>
          </View>
        </>
      ) : null}
    </Sheet>
  );
}

export function firstNameOf(row: Pick<OutboxRow, 'input'>): string | null {
  try {
    const input = JSON.parse(row.input) as { firstName?: unknown; lastName?: unknown };
    return typeof input.firstName === 'string' && input.firstName.trim()
      ? input.firstName.trim()
      : typeof input.lastName === 'string' && input.lastName.trim()
        ? input.lastName.trim()
        : null;
  } catch {
    return null;
  }
}
